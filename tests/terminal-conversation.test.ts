import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { TerminalConversation } from "../src/terminal/conversation";
import { defaultSettings } from "../src/core/schema";
import type { TurnRecord } from "../src/assistant/types";
import { seal } from "../src/storage/vault";
import { AssistantSession } from "../electron/assistant";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "butler-thread-"));
  roots.push(root);
  const key = randomBytes(32),
    settings = { ...defaultSettings, memory: true };
  let now = Date.now();
  const open = () =>
    new TerminalConversation(
      root,
      key,
      () => settings,
      () => now,
    );
  const turn = (
    role: TurnRecord["role"],
    text: string,
    untrusted = false,
  ): TurnRecord => ({ role, text, untrusted, channel: "app", at: now });
  return {
    root,
    key,
    settings,
    open,
    turn,
    file: join(root, "conversation.enc"),
    advance: (ms: number) => (now += ms),
  };
}
test("a fresh process restores the complete recent answer encrypted, with its trust label", () => {
  const f = fixture(),
    detail = "x".repeat(500) + " The review is Tuesday at four.";
  f.open().save([
    f.turn("user", "Check the fixture inbox"),
    f.turn("assistant", detail, true),
  ]);
  expect(f.open().load()).toEqual([
    f.turn("user", "Check the fixture inbox"),
    f.turn("assistant", detail, true),
  ]);
  expect(readFileSync(f.file).includes(Buffer.from("Tuesday"))).toBe(false);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
});
test("memory off never loads or retains a saved thread", () => {
  const f = fixture();
  f.open().save([f.turn("user", "Fixture preference")]);
  f.settings.memory = false;
  expect(f.open().load()).toEqual([]);
  f.open().save([f.turn("user", "Don't retain this")]);
  expect(f.open().load()).toEqual([]);
});
test("provider/privacy changes cannot replay the old conversation into a new scope", () => {
  const f = fixture();
  f.open().save([f.turn("user", "Fixture thread")]);
  f.settings.model = "different-model";
  expect(f.open().load()).toEqual([]);
});
test("expired context is removed and a new conversation deletes the retained thread", () => {
  const f = fixture();
  f.open().save([f.turn("user", "Old fixture")]);
  f.advance(24 * 60 * 60_000);
  expect(f.open().load()).toEqual([]);
  f.open().save([]);
  expect(f.open().load()).toEqual([]);
});
test("corrupt and oversized sealed records are ignored without exposing their contents", () => {
  const f = fixture();
  writeFileSync(f.file, Buffer.alloc(70_000));
  expect(f.open().load()).toEqual([]);
  writeFileSync(f.file, Buffer.alloc(48));
  expect(f.open().load()).toEqual([]);
});
test("credential-bearing turns are never retained; the latest safe thread stays bounded", () => {
  const f = fixture();
  const turns = Array.from({ length: 30 }, (_, i) =>
    f.turn("user", `Fixture ${i}`),
  );
  turns.push(f.turn("user", "My API key is sk-" + "a".repeat(48)));
  f.open().save(turns);
  const loaded = f.open().load();
  expect(loaded).toHaveLength(23);
  expect(loaded.at(-1)?.text).toBe("Fixture 29");
  expect(JSON.stringify(loaded)).not.toContain("sk-");
});
test("invalid roles, future dates and broken trust labels do not enter a restored thread", () => {
  const f = fixture();
  const scope = JSON.stringify([
    f.settings.privacy,
    f.settings.provider,
    f.settings.model,
    f.settings.dialogModel,
  ]);
  writeFileSync(
    f.file,
    seal(
      f.key,
      Buffer.from(
        JSON.stringify({
          scope,
          turns: [
            f.turn("user", "Safe fixture"),
            { ...f.turn("user", "Bad role"), role: "system" },
            { ...f.turn("assistant", "Bad trust"), untrusted: "true" },
            { ...f.turn("user", "Future"), at: Date.now() + 60_000 },
          ],
        }),
      ),
      "terminal-conversation",
    ),
  );
  expect(f.open().load()).toEqual([f.turn("user", "Safe fixture")]);
});

test("a restored AssistantSession sends the late facts in a long reply to its next model turn", async () => {
  const f = fixture();
  Object.assign(f.settings, {
    provider: "openai",
    privacy: "PRIVATE_BYOM",
    model: "gpt-6.1-sol",
    endpoint: "https://api.openai.com",
    conversation: "model",
  });
  let input = "";
  const fetch = async (_url: any, init: any) => {
    input = JSON.stringify(JSON.parse(init.body));
    const delta = {
      type: "response.output_text.delta",
      delta: "ACT: answer\nSAY: The fixture review is Tuesday at four.",
    };
    const complete = {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 30, output_tokens: 16 },
      },
    };
    return new Response(
      `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(complete)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const idle = {
    running: false,
    status: "idle" as const,
    recent: [],
    queued: [],
    watches: [],
  };
  const open = () =>
    new AssistantSession({
      settings: () => f.settings,
      providerKey: () => "fixture",
      fetch,
      view: () => idle,
      context: () => ({}),
      heldByVoice: () => false,
      history: f.open(),
    });
  const first = open();
  first.noteUser("Read the fixture agenda", "app");
  first.noteAssistant(
    "Fixture detail. ".repeat(30) + "The fixture review is Tuesday at four.",
    "app",
    { untrusted: true },
  );
  first.interrupt();
  const next = open(),
    words = "When is that review?";
  const decision = await next.decide({
    turnId: "fixture",
    text: words,
    base: { kind: "start", text: words },
    view: idle,
    channel: "app",
    confidence: 1,
    signal: AbortSignal.timeout(3000),
  });
  expect(decision.acting).toBe(false);
  expect(input).toContain("Tuesday at four");
  expect(input).toContain("untrusted");
  for await (const _line of decision.sentences ?? []) {
    /* drain the actual reply */
  }
  next.reset();
  expect(f.open().load()).toEqual([]);
});
