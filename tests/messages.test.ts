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
  createMessagesHelper,
  handlesMatch,
  helperEvent,
  importEnvHandle,
  messageMoment,
  messageServiceTrust,
  messageTarget,
  normalizeHandle,
  notResumedLine,
  parseMessageCommand,
  resumeFromText,
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
// The helper's wire contract. tests/native/MessageSafetyTests.swift checks
// that the Swift side emits exactly these shapes.
import contract from "./fixtures/messages-poll.json";

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

type Row = Record<string, unknown>;
type RowField = keyof (typeof contract.poll.messages)[number];
/**
 * A coarena-messages stand-in: records requests and sends, replays queued
 * rows. Every row starts as the contract fixture's row with only its values
 * changed and never gains a field the real helper does not send: a fake that
 * added the sender's handle by itself once hid that every text to the Mac was
 * being dropped.
 */
class FakeHelper implements MessagesHelper {
  sent: string[] = [];
  methods: string[] = [];
  configures: Row[] = [];
  rows: Row[] = [];
  latestRowId = 100;
  /** The database as the helper finds it; anything but "ok" cannot be read. */
  database = "ok";
  /** Rows per poll, like the helper's page of 20; unset means no limit. */
  pageSize?: number;
  failSend?: string;
  /** Sends never answer, like a first send parked on the Automation prompt. */
  stuckSends = false;
  holdPoll?: Promise<void>;
  holdConfigure?: Promise<void>;
  onChanged?: () => void;
  closed = false;
  async call(method: string, data: Record<string, unknown> = {}) {
    this.methods.push(method);
    if (method === "configure") {
      this.configures.push(data);
      if (this.holdConfigure) await this.holdConfigure;
    }
    // Like the helper: an unreadable database reports row 0, not an error.
    if (method === "configure" || method === "status")
      return {
        automation: "granted",
        database: this.database,
        configured: true,
        latestRowId: this.database === "ok" ? this.latestRowId : 0,
      };
    if (method === "send") {
      if (this.stuckSends) return new Promise(() => {});
      if (this.failSend) throw new Error(this.failSend);
      this.sent.push(String(data.text ?? ""));
      return { sent: true };
    }
    if (method === "poll") {
      if (this.holdPoll) await this.holdPoll;
      if (this.database !== "ok")
        throw Object.assign(new Error("Messages is not running."), {
          code: "DATABASE_LOCKED",
        });
      const since = Number(data.sinceRowId ?? 0);
      // A malformed row without a rowId is replayed as it is.
      const fresh = this.rows.filter(
        (r) => !("rowId" in r) || Number(r.rowId) > since,
      );
      const page = fresh.slice(0, this.pageSize ?? fresh.length);
      return {
        ...contract.poll,
        rowId: page.reduce((max, r) => Math.max(max, Number(r.rowId)), since),
        skipped: page.length === this.pageSize ? page.length : 0,
        messages: page,
      };
    }
    throw new Error(`unexpected method ${method}`);
  }
  close() {
    this.closed = true;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function channel(patch: Partial<Settings> = {}) {
  const helper = new FakeHelper();
  let live = settings(patch);
  const clock = { now: 1_700_000_000_000 };
  const control = {
    pause: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(async () => true),
  };
  const startTask = vi.fn(async (_task: string) => {});
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const created = { count: 0 };
  const messages = new MessagesChannel({
    settings: () => live,
    helper: (onChanged) => {
      created.count++;
      helper.onChanged = onChanged;
      return helper;
    },
    startTask,
    control,
    now: () => clock.now,
    trace: (event, data = {}) => traces.push({ event, data }),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const text = (
    body: string,
    options: {
      rowId?: number;
      handle?: string;
      service?: string;
      ageMs?: number;
      drop?: RowField;
    } = {},
  ) => {
    const row: Row = {
      ...contract.poll.messages[0],
      rowId: options.rowId ?? helper.rows.length + 101,
      text: body,
      at: (clock.now - (options.ageMs ?? 0)) / 1000,
    };
    if (options.handle !== undefined) row.handle = options.handle;
    if (options.service !== undefined) row.service = options.service;
    if (options.drop) delete row[options.drop];
    helper.rows.push(row);
  };
  /** One poll, then every reply it queued. */
  const poll = async () => {
    await messages.pollOnce();
    await messages.settled();
  };
  const ignored = () =>
    traces.filter((t) => t.event === "MessageIgnored").map((t) => t.data.cause);
  return {
    messages,
    helper,
    control,
    startTask,
    clock,
    text,
    poll,
    traces,
    ignored,
    created,
    set: (next: Partial<Settings>) => (live = { ...live, ...next }),
  };
}

describe("message safety rules", () => {
  // The same handle fixtures are checked in tests/native/MessageSafetyTests.swift.
  it("accepts only the configured handle, in either format", () => {
    expect(normalizeHandle(OWNER)).toBe("15551234567");
    expect(normalizeHandle("tel:+1-555-123-4567")).toBe("15551234567");
    expect(normalizeHandle(" Owner@Example.COM ")).toBe("owner@example.com");
    for (const bad of ["", "Mom", "owner@example", "+1 555", '+1555"123'])
      expect(normalizeHandle(bad)).toBe("");
    expect(normalizeHandle("0015551234567")).toBe("15551234567");
    expect(handlesMatch(OWNER, "+15551234567")).toBe(true);
    // A number without its country code is somebody else somewhere: an Indian
    // mobile saved as "8123456789" must never admit the US +1 812 345 6789.
    expect(normalizeHandle("5551234567")).toBe("");
    expect(normalizeHandle("tel:5551234567")).toBe("");
    expect(handlesMatch("5551234567", "+15551234567")).toBe(false);
    expect(handlesMatch("8123456789", "+18123456789")).toBe(false);
    expect(handlesMatch("15512345678", "+15512345678")).toBe(false);
    expect(handlesMatch("+91 81234 56789", "+918123456789")).toBe(true);
    // A ten-digit international number is not the +1 number ending in it.
    expect(handlesMatch("+555 123 4567", "+15551234567")).toBe(false);
    expect(handlesMatch("+445551234567", "+15551234567")).toBe(false);
    expect(handlesMatch(OWNER, STRANGER)).toBe(false);
    expect(handlesMatch("owner@example.com", "+15551234567")).toBe(false);
    expect(handlesMatch("", OWNER)).toBe(false);
  });
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
  it("trusts only iMessage to act; an unlabelled row may only ask for status", () => {
    expect(messageServiceTrust("iMessage")).toBe("full");
    expect(messageServiceTrust("")).toBe("status");
    for (const other of ["SMS", "RCS", "imessage", "iMessageLite", " "])
      expect(messageServiceTrust(other)).toBe("none");
  });
});

describe("helper contract", () => {
  it("poll rows carry exactly rowId, handle, service, text and at", () => {
    const [row] = contract.poll.messages;
    expect(Object.keys(row).sort()).toEqual([
      "at",
      "handle",
      "rowId",
      "service",
      "text",
    ]);
    expect(typeof row.handle).toBe("string");
    expect(row.service).toBe("iMessage");
    expect(Object.keys(contract.poll).sort()).toEqual([
      "messages",
      "rowId",
      "skipped",
    ]);
  });
  it("acts on a row replayed from the fixture unchanged", async () => {
    const { messages, helper } = channel();
    await messages.configure();
    // The fixture's timestamp is the test clock, so the row is fresh.
    helper.rows.push({ ...contract.poll.messages[0] });
    await messages.pollOnce();
    await messages.settled();
    expect(helper.sent).toEqual(["Nothing is running."]);
  });
  it("drops and traces a row that breaks the contract", async () => {
    const { messages, helper, control, text, poll, ignored } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await messages.settled();
    helper.sent.length = 0;
    for (const field of ["handle", "service", "rowId", "at"] as const)
      text("stop", { drop: field });
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([]);
    expect(ignored()).toEqual(["shape", "shape", "shape", "shape"]);
  });
  it("configures a database watch only while replies are read", async () => {
    const { messages, helper, set } = channel();
    await messages.configure();
    expect(Object.keys(helper.configures[0]).sort()).toEqual(
      Object.keys(contract.configure).sort(),
    );
    expect(helper.configures[0]).toEqual({ handle: OWNER, watch: true });
    set({ messagesCommands: false });
    await messages.configure();
    expect(helper.configures.at(-1)).toEqual({ handle: OWNER, watch: false });
  });
  it("recognizes the changed event and swallows other events", () => {
    expect(helperEvent(contract.changed)).toBe("changed");
    expect(helperEvent({ event: "something" })).toBe("other");
    expect(helperEvent({ id: "1", result: {} })).toBeUndefined();
    expect(helperEvent(null)).toBeUndefined();
  });
  it("wakes the channel for the helper's changed line, and only for it", async () => {
    // A real helper process: the fixture's changed line and an unknown event
    // arrive before each reply, and neither may be taken for the reply.
    const root = mkdtempSync(join(tmpdir(), "butler-messages-helper-"));
    const binary = join(root, "messages.cjs");
    writeFileSync(
      binary,
      `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(${JSON.stringify(JSON.stringify(contract.changed))} + '\\n');
  process.stdout.write(JSON.stringify({event: 'other'}) + '\\n');
  process.stdout.write(JSON.stringify({id: request.id, result: {method: request.method}}) + '\\n');
});
`,
      { mode: 0o700 },
    );
    const onChanged = vi.fn();
    const helper = createMessagesHelper(binary, { onChanged });
    try {
      expect(await helper.call("status")).toEqual({ method: "status" });
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(await helper.call("poll", { sinceRowId: 0 })).toEqual({
        method: "poll",
      });
      expect(onChanged).toHaveBeenCalledTimes(2);
    } finally {
      helper.close();
      rmSync(root, { recursive: true, force: true });
    }
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
    for (const national of ["8123456789", "(555) 123-4567", "tel:5551234567"])
      expect(() =>
        validateMessageSettings(settings({ messagesHandle: national })),
      ).toThrow(/country code/i);
    expect(
      messageTarget(settings({ messagesHandle: "8123456789" })),
    ).toBeUndefined();
    expect(() => validateMessageSettings(settings())).not.toThrow();
    // A stored handle with the feature off is inert.
    expect(
      messageTarget(settings({ messages: false, messagesHandle: OWNER })),
    ).toBeUndefined();
    expect(messageTarget(settings())?.handle).toBe(OWNER);
  });
  it("imports PHONE_NO from .env as a convenience only", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-messages-"));
    try {
      const file = join(root, ".env");
      writeFileSync(file, `PHONE_NO=${OWNER}\nOPENAI_API_KEY=test\n`, {
        mode: 0o600,
      });
      expect(importEnvHandle(file)).toBe(OWNER);
      writeFileSync(file, "PHONE_NO=Mom\n");
      expect(importEnvHandle(file)).toBe("");
      // Without its country code the number could be somebody else's.
      writeFileSync(file, "PHONE_NO=5551234567\n");
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
    await messages.settled();
    expect(helper.sent).toEqual([
      "Started “file the receipts”.",
      "Done. Filed four receipts.",
    ]);
  });
  it("only texts about texted tasks by default", async () => {
    const { messages, helper, text, poll, startTask } = channel({
      messagesUpdates: "texted",
    });
    await messages.configure();
    messages.onSnapshot(snapshot("executing", { run: { id: "typed-run" } }));
    await messages.settled();
    expect(helper.sent).toEqual([]);
    text("do file the receipts");
    await poll();
    expect(startTask).toHaveBeenCalledWith("file the receipts");
    messages.onSnapshot(snapshot("executing", { run: { id: "texted-run" } }));
    messages.onSnapshot(
      snapshot("completed", {
        run: { id: "texted-run", summary: "Filed four receipts." },
      }),
    );
    await messages.settled();
    expect(helper.sent).toEqual([
      "Started “file the receipts”.",
      "Done. Filed four receipts.",
    ]);
  });
  it("treats away updates like texted ones until presence can tell", async () => {
    const { messages, helper } = channel({ messagesUpdates: "away" });
    await messages.configure();
    expect(messages.status().updates).toBe("away");
    messages.onSnapshot(snapshot("executing", { run: { id: "typed-run" } }));
    messages.onSnapshot(
      snapshot("completed", { run: { id: "typed-run", summary: "Done." } }),
    );
    await messages.settled();
    expect(helper.sent).toEqual([]);
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
    await messages.settled();
    expect(helper.sent).toHaveLength(MESSAGE_HOUR_LIMIT);
  });
});

describe("texted commands", () => {
  it("ignores every sender but the configured handle", async () => {
    const { messages, helper, control, text, poll } = channel();
    await messages.configure();
    text("stop", { handle: STRANGER });
    text("do empty the trash", { handle: "friend@example.com" });
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([]);
  });
  it("never acts on SMS or RCS, even from the owner's number", async () => {
    const { messages, helper, control, startTask, text, poll, ignored } =
      channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await messages.settled();
    helper.sent.length = 0;
    text("stop", { service: "SMS" });
    text("pause", { service: "RCS" });
    text("status", { service: "SMS" });
    text("do empty the trash", { service: "iMessageLite" });
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
    expect(control.pause).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([]);
    expect(ignored()).toEqual(["service", "service", "service", "service"]);
  });
  it("answers only status when the database cannot name the service", async () => {
    const { messages, helper, control, startTask, text, poll, ignored } =
      channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await messages.settled();
    helper.sent.length = 0;
    text("status", { service: "" });
    text("stop", { service: "" });
    text("continue", { service: "" });
    text("do empty the trash", { service: "" });
    await poll();
    expect(helper.sent).toEqual([
      "Working on “file the receipts” — 3 steps so far.",
    ]);
    expect(control.stop).not.toHaveBeenCalled();
    expect(control.resume).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
    expect(ignored()).toEqual(["service", "service", "service"]);
  });
  it("never runs a command that arrived before it was switched on", async () => {
    const { messages, helper, control, text, poll } = channel();
    text("stop", { rowId: 50 });
    await messages.configure();
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual([]);
  });
  it("takes no baseline from a configure that could not read the database", async () => {
    // Launched at login while Messages is closed: the database is locked and
    // the helper reports row 0. A command texted before launch must not run
    // once Messages opens and the database can be read from row 0.
    const { messages, helper, startTask, text, poll } = channel();
    helper.database = "locked";
    text("do empty the trash", { rowId: 120 });
    await messages.configure();
    expect(messages.status().database).toBe("locked");
    await poll();
    expect(helper.methods).not.toContain("poll");
    helper.database = "ok";
    helper.latestRowId = 150;
    await poll();
    expect(startTask).not.toHaveBeenCalled();
    expect(messages.status().database).toBe("ok");
    expect(helper.configures).toHaveLength(3);
    // From the good baseline on, new commands work.
    text("status", { rowId: 151 });
    await poll();
    expect(helper.sent).toEqual(["Nothing is running."]);
    expect(helper.configures).toHaveLength(3);
  });
  it("configures an updates-only channel once, even without Full Disk Access", async () => {
    // Nothing is read without texted control, so no baseline is needed.
    const { messages, helper } = channel({ messagesCommands: false });
    helper.database = "no_access";
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    messages.onSnapshot(snapshot("completed", { run: { summary: "Filed." } }));
    await messages.settled();
    expect(helper.sent).toHaveLength(2);
    expect(helper.configures).toHaveLength(1);
  });
  it("ignores a stale command that syncs in late", async () => {
    const { messages, control, text, poll } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    text("stop", { ageMs: 900000 });
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
  });
  it("controls the run and answers status", async () => {
    const { messages, helper, control, text, poll } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await messages.settled();
    helper.sent.length = 0;
    text("status");
    text("pause");
    text("continue");
    text("stop");
    await poll();
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
  it("says it continued only when the run really resumed", async () => {
    const { messages, helper, control, text, poll } = channel();
    await messages.configure();
    const cases: [RunStatus, boolean, string][] = [
      [
        "confirming",
        false,
        "It’s waiting for your approval on the Mac, not paused. Approve or decline it there.",
      ],
      ["executing", false, "It’s already working."],
      [
        "paused",
        false,
        "It’s still paused: something changed on the Mac. Text “status” to check.",
      ],
      ["paused", true, "Continuing."],
    ];
    for (const [status, resumed, reply] of cases) {
      messages.onSnapshot(snapshot(status));
      await messages.settled();
      helper.sent.length = 0;
      control.resume.mockResolvedValueOnce(resumed);
      text("continue");
      await poll();
      expect(helper.sent).toEqual([reply]);
    }
    expect(control.resume).toHaveBeenCalledTimes(cases.length);
    expect(notResumedLine(undefined)).toBe("Nothing is running.");
    expect(notResumedLine(snapshot("completed"))).toBe("Nothing is running.");
  });
  it("reports a texted continue only as far as the resume went", async () => {
    // What main wires in as control.resume.
    const resumeHeld = vi.fn(async (_held: () => boolean) => true);
    // An approval waiting on the Mac is not held: nothing is touched.
    expect(await resumeFromText(() => false, resumeHeld)).toBe(false);
    expect(resumeHeld).not.toHaveBeenCalled();
    // The restore or the runner found the run changed meanwhile.
    resumeHeld.mockResolvedValueOnce(false);
    expect(await resumeFromText(() => true, resumeHeld)).toBe(false);
    resumeHeld.mockResolvedValueOnce(undefined as unknown as boolean);
    expect(await resumeFromText(() => true, resumeHeld)).toBe(false);
    expect(await resumeFromText(() => true, resumeHeld)).toBe(true);
    expect(resumeHeld).toHaveBeenCalledTimes(3);
  });
  it("says nothing is running instead of guessing", async () => {
    const { messages, helper, control, text, poll } = channel();
    await messages.configure();
    text("stop");
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.sent).toEqual(["Nothing is running."]);
  });
  it("answers an unknown command once, then goes quiet", async () => {
    const { messages, helper, text, poll } = channel();
    await messages.configure();
    for (const nonsense of ["hello?", "what are you doing", "please help"])
      text(nonsense);
    await poll();
    expect(helper.sent).toEqual([
      MESSAGE_VOCABULARY,
      MESSAGE_VOCABULARY,
      MESSAGE_VOCABULARY,
    ]);
    helper.sent.length = 0;
    text("still nonsense");
    text("more nonsense");
    await poll();
    expect(helper.sent).toEqual([]);
  });
  it("never approves by text", async () => {
    const { messages, helper, control, startTask, text, poll } = channel();
    await messages.configure();
    const pending = {
      action: { type: "key" as const, key: "ENTER" as const, frame_id: "f1" },
      reason: "This sends a message. Allow it?",
    };
    messages.onSnapshot(snapshot("confirming", { pending }));
    await messages.settled();
    helper.sent.length = 0;
    text("yes");
    await poll();
    expect(helper.sent).toEqual([MESSAGE_APPROVAL_REPLY]);
    expect(control.pause).not.toHaveBeenCalled();
    expect(control.stop).not.toHaveBeenCalled();
    expect(control.resume).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
  });
  it("asks what to do on words that only point at the Mac's screen", async () => {
    const { messages, helper, startTask, text, poll } = channel();
    await messages.configure();
    // "That" is whatever a note on screen or a read-out notification says:
    // never a run in the owner's name, as the voice router refuses too.
    for (const line of [
      "do that",
      "do what she asked",
      "do: go for it",
      "do call the number in the note",
      "Do send it to them",
    ]) {
      text(line);
      await poll();
    }
    expect(startTask).not.toHaveBeenCalled();
    expect(helper.sent).toEqual(
      Array(5).fill("What would you like me to do?"),
    );
    helper.sent.length = 0;
    text("do call Dana back");
    await poll();
    expect(startTask).toHaveBeenCalledWith("call Dana back");
  });
  it("refuses a task containing credentials", async () => {
    const { messages, helper, startTask, text, poll } = channel();
    await messages.configure();
    text("do log in with password: hunter2swordfish");
    await poll();
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
      control: {
        pause: vi.fn(),
        stop: vi.fn(),
        resume: vi.fn(async () => false),
      },
      now: () => 1_700_000_000_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await failing.configure();
    await failing.pollOnce();
    await failing.settled();
    expect(helper.sent).toEqual([
      "I couldn’t start that: Stop the active run first.",
    ]);
  });
  it("throttles a burst and answers it once", async () => {
    const { messages, helper, text, poll } = channel();
    await messages.configure();
    for (let i = 0; i < 9; i++) text("status");
    await poll();
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
    const { messages, helper, control, text, poll } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    await messages.settled();
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
    await poll();
    expect(control.stop).not.toHaveBeenCalled();
    helper.latestRowId = 300;
    await poll();
    // The command that arrived while the helper was down is behind the new
    // baseline and never runs.
    expect(control.stop).not.toHaveBeenCalled();
    expect(helper.methods.filter((m) => m === "configure")).toHaveLength(2);
  });
  it("surfaces a send failure without throwing into the run", async () => {
    const { messages, helper } = channel();
    await messages.configure();
    helper.failSend = "macOS blocked Butler from using Messages.";
    messages.onSnapshot(snapshot("executing"));
    await messages.settled();
    expect(messages.status().error).toMatch(/blocked/);
  });
});

describe("polling pace", () => {
  it("polls at once when the helper says the database changed", async () => {
    const { messages, helper, text } = channel();
    await messages.configure();
    text("status");
    helper.onChanged?.();
    await flush();
    await messages.settled();
    expect(helper.methods.filter((m) => m === "poll")).toHaveLength(1);
    expect(helper.sent).toEqual(["Nothing is running."]);
  });
  it("reads the rest of a full page at once instead of on the next tick", async () => {
    const { messages, helper, text, poll } = channel();
    await messages.configure();
    helper.pageSize = 2;
    for (let i = 0; i < 5; i++) text("status");
    await poll();
    expect(helper.methods.filter((m) => m === "poll")).toHaveLength(3);
    expect(helper.sent).toHaveLength(5);
    // A helper that claims more but does not move on is not asked again.
    const call = helper.call.bind(helper);
    let stuck = 0;
    helper.call = async (method, data) => {
      if (method !== "poll") return call(method, data);
      stuck++;
      return { ...contract.poll, rowId: 0, skipped: 20, messages: [] };
    };
    await poll();
    expect(stuck).toBe(1);
  });
  it("folds hints that arrive mid-poll into one more poll", async () => {
    const { messages, helper } = channel();
    await messages.configure();
    const held = gate();
    helper.holdPoll = held.promise;
    const first = messages.pollOnce();
    for (let i = 0; i < 10; i++) helper.onChanged?.();
    helper.holdPoll = undefined;
    held.open();
    await first;
    expect(helper.methods.filter((m) => m === "poll")).toHaveLength(2);
  });
  it("ignores hints while texted control is off", async () => {
    const { messages, helper, set } = channel();
    await messages.configure();
    set({ messagesCommands: false });
    await messages.configure();
    helper.onChanged?.();
    await flush();
    expect(helper.methods).not.toContain("poll");
  });
  it("keeps polling while a reply is stuck on the Automation prompt", async () => {
    const { messages, helper, control, text } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    helper.stuckSends = true;
    text("status");
    const outcome = await Promise.race([
      messages.pollOnce().then(() => "polled"),
      flush().then(() => "blocked"),
    ]);
    expect(outcome).toBe("polled");
    text("stop");
    await messages.pollOnce();
    expect(control.stop).toHaveBeenCalled();
    expect(helper.methods.filter((m) => m === "poll")).toHaveLength(2);
  });
  it("shares one configure call between a send and a poll", async () => {
    // Each configure moves the baseline; a second one racing the first could
    // jump past a row the first poll has not read yet.
    const { messages, helper, text } = channel();
    const held = gate();
    helper.holdConfigure = held.promise;
    text("status");
    const polled = messages.pollOnce();
    messages.onSnapshot(snapshot("executing"));
    await flush();
    held.open();
    await polled;
    await messages.settled();
    expect(helper.configures).toHaveLength(1);
    expect(helper.sent).toEqual([
      "Started “file the receipts”.",
      "Working on “file the receipts” — 3 steps so far.",
    ]);
  });
  it("drops queued texts once the channel closes", async () => {
    const { messages, helper, created } = channel();
    await messages.configure();
    messages.onSnapshot(snapshot("executing"));
    messages.close();
    await messages.settled();
    expect(helper.sent).toEqual([]);
    expect(created.count).toBe(1);
  });
});
