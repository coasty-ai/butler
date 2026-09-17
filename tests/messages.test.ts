import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MESSAGE_APPROVAL_REPLY,
  MESSAGE_HOUR_LIMIT,
  MESSAGE_VOCABULARY,
  MessageRate,
  MessagesChannel,
  handlesMatch,
  importEnvHandle,
  messageMoment,
  messageTarget,
  normalizeHandle,
  parseMessageCommand,
  statusLine,
  validateMessageSettings,
  type MessagesHelper,
} from "../electron/messages";
import {
  defaultSettings,
  settingsSchema,
  type Run,
  type RunStatus,
  type Settings,
  type Snapshot,
} from "../src/core/schema";
import { previewBridge } from "../src/ui/preview";

const OWNER = "+1 (555) 123-4567";
const STRANGER = "+15559998888";

function settings(patch: Partial<Settings> = {}): Settings {
  return {
    ...defaultSettings,
    messages: true,
    messagesHandle: OWNER,
    messagesCommands: true,
    messagesUpdates: "all",
    ...patch,
  };
}
function run(patch: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    task: "file the receipts",
    createdAt: new Date().toISOString(),
    status: "executing",
    privacy: "PRIVATE_BYOM",
    provider: "openai",
    model: "gpt",
    synthetic: false,
    actions: 3,
    frames: 3,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    summary: "",
    ...patch,
  };
}
function snapshot(
  status: RunStatus,
  patch: Omit<Partial<Snapshot>, "run"> & { run?: Partial<Run> } = {},
): Snapshot {
  const { run: runPatch, ...rest } = patch;
  return {
    run: run({ status, ...runPatch }),
    frame: null,
    events: [],
    message: "",
    ...rest,
  };
}

/** A coarena-messages stand-in: records sends, replays queued rows. */
class FakeHelper implements MessagesHelper {
  sent: string[] = [];
  methods: string[] = [];
  rows: { rowId: number; handle: string; text: string; at: number }[] = [];
  latestRowId = 100;
  failSend?: string;
  closed = false;
  async call(method: string, data: Record<string, unknown> = {}) {
    this.methods.push(method);
    if (method === "configure" || method === "status")
      return {
        automation: "granted",
        database: "ok",
        configured: true,
        latestRowId: this.latestRowId,
      };
    if (method === "send") {
      if (this.failSend) throw new Error(this.failSend);
      this.sent.push(String(data.text ?? ""));
      return { sent: true };
    }
    if (method === "poll") {
      const since = Number(data.sinceRowId ?? 0);
      const messages = this.rows.filter((r) => r.rowId > since);
      return {
        rowId: this.rows.reduce((max, r) => Math.max(max, r.rowId), since),
        messages,
        skipped: 0,
      };
    }
    throw new Error(`unexpected method ${method}`);
  }
  close() {
    this.closed = true;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function channel(patch: Partial<Settings> = {}) {
  const helper = new FakeHelper();
  let live = settings(patch);
  const clock = { now: 1_700_000_000_000 };
  const control = {
    pause: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(async () => {}),
  };
  const startTask = vi.fn(async (_task: string) => {});
  const messages = new MessagesChannel({
    settings: () => live,
    helper: () => helper,
    startTask,
    control,
    now: () => clock.now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const text = (
    body: string,
    options: { rowId?: number; handle?: string; ageMs?: number } = {},
  ) => {
    helper.rows.push({
      rowId: options.rowId ?? helper.rows.length + 101,
      handle: options.handle ?? OWNER,
      text: body,
      at: (clock.now - (options.ageMs ?? 0)) / 1000,
    });
  };
  return {
    messages,
    helper,
    control,
    startTask,
    clock,
    text,
    set: (next: Partial<Settings>) => (live = { ...live, ...next }),
  };
}

describe("message safety rules", () => {
  it("accepts only the configured handle, in either format", () => {
    expect(normalizeHandle(OWNER)).toBe("15551234567");
    expect(normalizeHandle("tel:+1-555-123-4567")).toBe("15551234567");
    expect(normalizeHandle(" Owner@Example.COM ")).toBe("owner@example.com");
    for (const bad of ["", "Mom", "owner@example", "+1 555", '+1555"123'])
      expect(normalizeHandle(bad)).toBe("");
    expect(handlesMatch(OWNER, "+15551234567")).toBe(true);
    expect(handlesMatch("5551234567", "+15551234567")).toBe(true);
    expect(handlesMatch("+445551234567", "+15551234567")).toBe(false);
    expect(handlesMatch(OWNER, STRANGER)).toBe(false);
    expect(handlesMatch("owner@example.com", "+15551234567")).toBe(false);
    expect(handlesMatch("", OWNER)).toBe(false);
  });
  // The same fixtures are checked in tests/native/MessageSafetyTests.swift.
  it("understands a strict vocabulary and nothing else", () => {
    expect(parseMessageCommand("status").kind).toBe("status");
    expect(parseMessageCommand("  STATUS.  ").kind).toBe("status");
    expect(parseMessageCommand("stop").kind).toBe("stop");
    expect(parseMessageCommand("pause").kind).toBe("pause");
    expect(parseMessageCommand("continue").kind).toBe("resume");
    expect(parseMessageCommand("resume").kind).toBe("resume");
    expect(parseMessageCommand("do open my notes")).toEqual({
      kind: "start",
      task: "open my notes",
    });
    expect(parseMessageCommand("Do: open my notes").task).toBe("open my notes");
    expect(parseMessageCommand("do\n open  my   notes").task).toBe(
      "open my notes",
    );
    for (const other of [
      "do",
      "stop the download",
      "please stop",
      "open my notes",
    ])
      expect(parseMessageCommand(other).kind).toBe("unknown");
    expect(parseMessageCommand("   ").kind).toBe("empty");
    expect(parseMessageCommand("do " + "a".repeat(2100)).kind).toBe("too_long");
    for (const word of ["yes", "no", "ok", "approve", "deny", "Yes!"])
      expect(parseMessageCommand(word).kind).toBe("approval");
    expect(parseMessageCommand("do approve the invoice").kind).toBe("start");
  });
  it("limits commands per minute and goes quiet after repeated nonsense", () => {
    const rate = new MessageRate();
    for (let i = 0; i < 6; i++) expect(rate.admit(1000).accepted).toBe(true);
    expect(rate.admit(1000)).toEqual({ accepted: false, reply: true });
    expect(rate.admit(1000)).toEqual({ accepted: false, reply: false });
    expect(rate.admit(62000).accepted).toBe(true);
    const unknown = new MessageRate();
    expect(unknown.answerUnknown(0)).toBe(true);
    expect(unknown.answerUnknown(10000)).toBe(true);
    expect(unknown.answerUnknown(20000)).toBe(true);
    expect(unknown.answerUnknown(30000)).toBe(false);
    expect(unknown.answerUnknown(500000)).toBe(false);
    expect(unknown.answerUnknown(621000)).toBe(true);
  });
});

describe("message settings", () => {
  it("is off by default and parses a config saved before it existed", () => {
    expect(defaultSettings.messages).toBe(false);
    expect(defaultSettings.messagesHandle).toBe("");
    expect(defaultSettings.messagesUpdates).toBe("texted");
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    for (const key of [
      "messages",
      "messagesHandle",
      "messagesCommands",
      "messagesUpdates",
    ])
      delete legacy[key];
    expect(settingsSchema.parse(legacy)).toMatchObject({
      messages: false,
      messagesHandle: "",
      messagesCommands: true,
      messagesUpdates: "texted",
    });
    expect(
      settingsSchema.safeParse({ ...defaultSettings, messagesUpdates: "some" })
        .success,
    ).toBe(false);
  });
  it("refuses to switch on without a usable handle", () => {
    expect(() => validateMessageSettings(defaultSettings)).not.toThrow();
    expect(() =>
      validateMessageSettings(settings({ messagesHandle: "Mom" })),
    ).toThrow(/phone number/i);
    expect(() => validateMessageSettings(settings())).not.toThrow();
    // A stored handle with the feature off is inert.
    expect(
      messageTarget(settings({ messages: false, messagesHandle: OWNER })),
    ).toBeUndefined();
    expect(messageTarget(settings())?.handle).toBe(OWNER);
  });
  it("imports PHONE_NO from .env as a convenience only", () => {
    const root = mkdtempSync(join(tmpdir(), "open-assist-messages-"));
    try {
      const file = join(root, ".env");
      writeFileSync(file, `PHONE_NO=${OWNER}\nOPENAI_API_KEY=test\n`, {
        mode: 0o600,
      });
      expect(importEnvHandle(file)).toBe(OWNER);
      writeFileSync(file, "PHONE_NO=Mom\n");
      expect(importEnvHandle(file)).toBe("");
      expect(importEnvHandle("relative/.env")).toBe("");
      expect(importEnvHandle(join(root, "missing.env"))).toBe("");
      // Importing a number never turns the channel on.
      expect(defaultSettings.messages).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports the channel as unavailable in the browser preview", async () => {
    const info = await previewBridge().info();
    expect(info.messages).toMatchObject({
      enabled: false,
      automation: "unavailable",
      database: "off",
    });
    await expect(previewBridge().sendTestMessage()).rejects.toThrow(/preview/i);
  });
});

describe("run updates", () => {
  it("texts one bounded line per moment and never the pending text", () => {
    const pending = {
      action: {
        type: "type_text" as const,
        text: "hunter2 the secret words",
        frame_id: "f1",
      },
      reason: "This sends a message. Allow it?",
    };
    const approval = messageMoment(
      snapshot("confirming", { pending, run: { status: "confirming" } }),
      false,
    );
    expect(approval?.text).toContain("Allow it?");
    expect(approval?.text).toMatch(/approve on the Mac/i);
    expect(approval?.text).not.toContain("hunter2");
    const done = messageMoment(
      snapshot("completed", { run: { summary: "Filed four receipts." } }),
      false,
    );
    expect(done?.text).toBe("Done. Filed four receipts.");
    const failed = messageMoment(
      snapshot("failed", { message: "The window never opened." }),
      false,
    );
    expect(failed?.text).toContain("The window never opened.");
    // Narration of ordinary steps is never texted.
    expect(
      messageMoment(
        snapshot("executing", { message: "Opening Notes." }),
        false,
      ),
    ).toBeUndefined();
    expect(messageMoment(snapshot("executing"), true)?.text).toBe(
      "Started “file the receipts”.",
    );
  });
  it("answers status from the live snapshot", () => {
    expect(statusLine(undefined)).toBe("Nothing is running.");
    expect(statusLine(snapshot("executing"))).toBe(
      "Working on “file the receipts” — 3 steps so far.",
    );
    expect(statusLine(snapshot("confirming"))).toMatch(/approval on the Mac/);
    expect(
      statusLine(snapshot("completed", { run: { summary: "All done." } })),
    ).toBe("Nothing is running — All done.");
    expect(statusLine(snapshot("cancelled"))).toBe(
      "Nothing is running — the last task was stopped.",
    );
  });
  it("sends each moment once, within the per-run limit", async () => {
    const { messages, helper } = channel();
    await messages.configure();
    const working = snapshot("executing");
    messages.onSnapshot(working);
    messages.onSnapshot(working);
    messages.onSnapshot(snapshot("executing", { run: { actions: 4 } }));
    messages.onSnapshot(
      snapshot("completed", { run: { summary: "Filed four receipts." } }),
    );
    messages.onSnapshot(
      snapshot("completed", { run: { summary: "Filed four receipts." } }),
    );
    await flush();
    expect(helper.sent).toEqual([
      "Started “file the receipts”.",
      "Done. Filed four receipts.",
    ]);
  });
  it("only texts about texted tasks by default", async () => {
    const { messages, helper, text, startTask } = channel({
      messagesUpdates: "texted",
    });
    await messages.configure();
    messages.onSnapshot(snapshot("executing", { run: { id: "typed-run" } }));
    await flush();
    expect(helper.sent).toEqual([]);
    text("do file the receipts");
    await messages.pollOnce();
    expect(startTask).toHaveBeenCalledWith("file the receipts");
    messages.onSnapshot(snapshot("executing", { run: { id: "texted-run" } }));
    messages.onSnapshot(
      snapshot("completed", {
        run: { id: "texted-run", summary: "Filed four receipts." },
      }),
    );
    await flush();
    expect(helper.sent).toEqual([
      "Started “file the receipts”.",
      "Done. Filed four receipts.",
    ]);
  });
  it("stops texting after the hourly budget", async () => {
    const { messages, helper } = channel();
    await messages.configure();
    for (let i = 0; i < MESSAGE_HOUR_LIMIT + 4; i++) {
      messages.onSnapshot(snapshot("executing", { run: { id: `run-${i}` } }));
      messages.onSnapshot(
        snapshot("completed", { run: { id: `run-${i}`, summary: "Done." } }),
      );
    }
    await flush();
    expect(helper.sent).toHaveLength(MESSAGE_HOUR_LIMIT);
  });
});

describe("texted commands", () => {
  it("ignores every sender but the configured handle", async () => {
    const { messages, helper, control, text } = channel();
    await messages.configure();
    text("stop", { handle: STRANGER });
    text("do empty the trash", { handle: "friend@example.com" });
    await messages.pollOnce();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([]);
  });
  it("never runs a command that arrived before it was switched on", async () => {
    const { messages, helper, control, text } = channel();
    text("stop", { rowId: 50 });
    await messages.configure();
    await messages.pollOnce();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([]);
  });
  it("ignores a stale command that syncs in late", async () => {
    const { messages, control, text } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    text("stop", { ageMs: 900000 });
    await messages.pollOnce();
    expect(control.stop).not.toHaveBeenCalled();
  });
  it("controls the run and answers status", async () => {
    const { messages, helper, control, text } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await flush();
    helper.sent.length = 0;
    text("status");
    text("pause");
    text("continue");
    text("stop");
    await messages.pollOnce();
    expect(control.pause).toHaveBeenCalled();
    expect(control.resume).toHaveBeenCalled();
    expect(control.stop).toHaveBeenCalled();
    expect(helper.sent).toEqual([
      "Working on “file the receipts” — 3 steps so far.",
      "Paused. Text “continue” when you want it to go on.",
      "Continuing.",
      "Stopped.",
    ]);
  });
  it("says nothing is running instead of guessing", async () => {
    const { messages, helper, control, text } = channel();
    await messages.configure();
    text("stop");
    await messages.pollOnce();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual(["Nothing is running."]);
  });
  it("answers an unknown command once, then goes quiet", async () => {
    const { messages, helper, text } = channel();
    await messages.configure();
    for (const nonsense of ["hello?", "what are you doing", "please help"])
      text(nonsense);
    await messages.pollOnce();
    expect(helper.sent).toEqual([
      MESSAGE_VOCABULARY,
      MESSAGE_VOCABULARY,
      MESSAGE_VOCABULARY,
    ]);
    helper.sent.length = 0;
    text("still nonsense");
    text("more nonsense");
    await messages.pollOnce();
    expect(helper.sent).toEqual([]);
  });
  it("never approves by text", async () => {
    const { messages, helper, control, startTask, text } = channel();
    await messages.configure();
    const pending = {
      action: { type: "key" as const, key: "ENTER" as const, frame_id: "f1" },
      reason: "This sends a message. Allow it?",
    };
    messages.onSnapshot(snapshot("confirming", { pending }));
    await flush();
    helper.sent.length = 0;
    text("yes");
    await messages.pollOnce();
    expect(helper.sent).toEqual([MESSAGE_APPROVAL_REPLY]);
    expect(control.pause).not.toHaveBeenCalled();
    expect(control.stop).not.toHaveBeenCalled();
    expect(control.resume).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
  });
  it("refuses a task containing credentials", async () => {
    const { messages, helper, startTask, text } = channel();
    await messages.configure();
    text("do log in with password: hunter2swordfish");
    await messages.pollOnce();
    expect(startTask).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([
      "I can’t take passwords or keys by message. Enter those on the Mac.",
    ]);
  });
  it("reports why a task could not start", async () => {
    const { messages, helper, text } = channel();
    await messages.configure();
    text("do file the receipts");
    const failing = new MessagesChannel({
      settings: () => settings(),
      helper: () => helper,
      startTask: async () => {
        throw new Error("Stop the active run first.");
      },
      control: { pause: vi.fn(), stop: vi.fn(), resume: vi.fn(async () => {}) },
      now: () => 1_700_000_000_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await failing.configure();
    await failing.pollOnce();
    expect(helper.sent).toEqual([
      "I couldn’t start that: Stop the active run first.",
    ]);
  });
  it("throttles a burst and answers it once", async () => {
    const { messages, helper, text } = channel();
    await messages.configure();
    for (let i = 0; i < 9; i++) text("status");
    await messages.pollOnce();
    const throttle = helper.sent.filter((t) => t.includes("lot of messages"));
    expect(throttle).toHaveLength(1);
    expect(helper.sent.filter((t) => t.startsWith("Nothing is"))).toHaveLength(
      6,
    );
  });
  it("never reads messages when texted control is off", async () => {
    const { messages, helper, set } = channel({ messagesCommands: false });
    await messages.configure();
    await messages.pollOnce();
    expect(helper.methods).not.toContain("poll");
    expect(messages.status().listening).toBe(false);
    set({ messagesCommands: true });
    await messages.configure();
    expect(messages.status().listening).toBe(true);
  });
  it("stops and closes the helper when the setting is turned off", async () => {
    const { messages, helper, set } = channel();
    await messages.configure();
    set({ messages: false });
    await messages.configure();
    expect(helper.closed).toBe(true);
    expect(messages.status()).toMatchObject({
      enabled: false,
      database: "off",
    });
  });
  it("sends one test message with the saved handle", async () => {
    const { messages, helper } = channel();
    await messages.sendTest();
    expect(helper.methods[0]).toBe("configure");
    expect(helper.sent).toHaveLength(1);
    expect(helper.sent[0]).toMatch(/status/);
  });
  it("reconfigures a restarted helper and starts from the newest row", async () => {
    const { messages, helper, control, text } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await flush();
    // The helper crashed and came back empty-handed.
    const restarted = Object.assign(new Error("No handle is configured."), {
      code: "NOT_CONFIGURED",
    });
    const call = helper.call.bind(helper);
    helper.call = async (method, data) => {
      if (method === "poll") {
        helper.call = call;
        throw restarted;
      }
      return call(method, data);
    };
    text("stop", { rowId: 200 });
    await messages.pollOnce();
    expect(control.stop).not.toHaveBeenCalled();
    helper.latestRowId = 300;
    await messages.pollOnce();
    // The command that arrived while the helper was down is behind the new
    // baseline and never runs.
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.methods.filter((m) => m === "configure")).toHaveLength(2);
  });
  it("surfaces a send failure without throwing into the run", async () => {
    const { messages, helper } = channel();
    await messages.configure();
    helper.failSend = "macOS blocked Open Assist from using Messages.";
    messages.onSnapshot(snapshot("executing"));
    await flush();
    expect(messages.status().error).toMatch(/blocked/);
  });
});
