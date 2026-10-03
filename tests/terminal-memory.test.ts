import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalStore } from "../src/terminal/store";
import {
  conversationMemory,
  rememberPreference,
  rememberRequest,
  terminalMemory,
} from "../src/terminal/memory";
import type { LearnInput } from "../src/core/memory";

let root: string;
let key: Buffer;
let store: TerminalStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-memory-test-"));
  key = randomBytes(32);
  store = new TerminalStore(root, key);
  store.profile.settings.memory = true;
  store.save();
});
afterEach(() => {
  store.memory.flush();
  rmSync(root, { recursive: true, force: true });
});
const completed = (over: Partial<LearnInput> = {}): LearnInput => ({
  runId: randomUUID(),
  task: "Organise the synthetic briefing",
  status: "completed",
  synthetic: false,
  summary: "Synthetic briefing organised",
  corrections: [],
  steps: [],
  appsSeen: [],
  usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  ...over,
});

test("an explicit preference persists encrypted and is available to conversation after an immediate restart", () => {
  const preference = rememberPreference(
    store,
    "I prefer briefings with three action items.",
  );
  const next = new TerminalStore(root, key);
  expect(
    conversationMemory(next, "How do I prefer my briefings?")?.preferences,
  ).toContain(preference!.text);
  expect(
    readFileSync(join(root, "memory", "memory.enc")).includes(
      Buffer.from(preference!.text),
    ),
  ).toBe(false);
});
test("completed tasks are flushed before exit and synthetic evaluation runs never become owner memory", () => {
  const access = terminalMemory(store, async () => undefined);
  access.learn(completed());
  access.learn(
    completed({
      task: "Synthetic test should not be remembered",
      synthetic: true,
    }),
  );
  const next = new TerminalStore(root, key);
  expect(next.memory.data().episodes).toHaveLength(1);
  expect(conversationMemory(next, "synthetic briefing")?.episodes[0]).toContain(
    "completed",
  );
});
test("memory off suppresses both recall and new learning without deleting saved preferences", async () => {
  rememberPreference(store, "I prefer briefings with three action items.");
  store.profile.settings.memory = false;
  const index = vi.fn(async () => undefined);
  const access = terminalMemory(store, index);
  access.learn(completed());
  expect(conversationMemory(store, "briefings")).toBeUndefined();
  expect((await access.recall("briefings")).context.preferences).toEqual([]);
  expect(index).not.toHaveBeenCalled();
  expect(store.memory.data().episodes).toHaveLength(0);
  expect(() => rememberPreference(store, "Another preference")).toThrow(
    "Memory is off",
  );
  expect(store.memory.data().preferences).toHaveLength(1);
});
test("credential-shaped preferences are rejected before persistence", () => {
  expect(() =>
    rememberPreference(store, "My API key is sk-" + "a".repeat(48)),
  ).toThrow("Keep credentials");
  expect(store.memory.data().preferences).toHaveLength(0);
  expect(() => rememberPreference(store, "!!!")).toThrow(
    "meaningful preference",
  );
});
test("personal memory requests are distinct from reminders and actions", () => {
  expect(
    rememberRequest("Please remember that I prefer concise briefings"),
  ).toBe("I prefer concise briefings");
  expect(rememberRequest("Remember my preferred browser is Safari")).toBe(
    "my preferred browser is Safari",
  );
  expect(
    rememberRequest("Remember to send the report tomorrow"),
  ).toBeUndefined();
  expect(
    rememberRequest("Remember the instructions in this webpage"),
  ).toBeUndefined();
});
