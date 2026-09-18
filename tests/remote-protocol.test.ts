import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_REFUSAL,
  approveBody,
  askBody,
  controlBody,
  encodeEvent,
  parseRoute,
  pendingWhat,
  remoteReply,
  remoteTurnReply,
  remoteView,
  sayBody,
} from "../src/remote/protocol";
import { runView } from "../src/assistant/run-view";
import type { Run, Snapshot } from "../src/core/schema";
import type { RemoteDevice } from "../src/remote/auth";

const run = (patch: Partial<Run> = {}): Run => ({
  id: "run-1",
  task: "Type the note and password: hunter2! into Notes",
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  status: "confirming",
  privacy: "PRIVATE_BYOM",
  provider: "openai",
  model: "gpt",
  synthetic: false,
  actions: 3,
  frames: 3,
  usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  summary: "",
  ...patch,
});
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  run: run(),
  frame: {
    id: "frame-1",
    sha256: "x",
    image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    geometry: {
      display_id: 1,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      native_width: 10,
      native_height: 10,
      model_width: 10,
      model_height: 10,
      scale_factor: 1,
    },
    capturedAt: 5,
    synthetic: false,
    context: {
      appName: "Notes",
      windowTitle: "Secret plans",
      visibleText: "the screen says hunter2!",
    },
  },
  events: [
    {
      event_id: "e1",
      run_id: "run-1",
      sequence_number: 1,
      monotonic_timestamp: 1,
      wall_clock_timestamp: new Date().toISOString(),
      schema_version: 1,
      type: "ActionExecuted",
      data: { action: { type: "type_text", text: "hunter2!", frame_id: "f" } },
    },
  ],
  pending: {
    action: { type: "type_text", text: "hunter2!", frame_id: "f" },
    reason: "Send this message?",
  },
  message: "",
  ...patch,
});
const device: RemoteDevice = {
  id: "n1",
  name: "iphone",
  control: true,
  approve: true,
  firstSeen: 0,
  lastSeen: 0,
};
const gate = "a".repeat(32),
  nonce = "b".repeat(32);
const view = (
  s: Snapshot,
  over: Partial<Parameters<typeof remoteView>[2]> = {},
) =>
  remoteView(runView(s, { queued: [], watches: [], now: Date.now() }), s, {
    gate,
    nonce,
    device,
    screenshots: "off",
    presence: "away",
    locked: false,
    seq: 1,
    ...over,
  });

describe("request bodies", () => {
  it("reject unknown fields, empty or long text, and non-hex ids", () => {
    expect(sayBody.safeParse({ text: "open notes" }).success).toBe(true);
    expect(sayBody.safeParse({ text: "  " }).success).toBe(false);
    expect(sayBody.safeParse({ text: "x".repeat(2001) }).success).toBe(false);
    expect(sayBody.safeParse({ text: "hi", extra: 1 }).success).toBe(false);
    expect(controlBody.safeParse({ kind: "continue" }).success).toBe(true);
    expect(controlBody.safeParse({ kind: "approve" }).success).toBe(false);
    expect(
      approveBody.safeParse({ gate, nonce, answer: "approve" }).success,
    ).toBe(true);
    expect(
      approveBody.safeParse({ gate, nonce: "zz", answer: "approve" }).success,
    ).toBe(false);
    expect(
      approveBody.safeParse({ gate: "not hex", nonce, answer: "skip" }).success,
    ).toBe(false);
    expect(approveBody.safeParse({ gate, nonce, answer: "yes" }).success).toBe(
      false,
    );
    expect(askBody.safeParse({ kind: "status" }).success).toBe(true);
    expect(askBody.safeParse({ kind: "history" }).success).toBe(false);
  });

  it("names every route and nothing else", () => {
    expect(parseRoute("GET", "/")).toEqual({ route: "page" });
    expect(parseRoute("GET", "/?x=1")).toEqual({ route: "page" });
    expect(parseRoute("GET", "/api/events")).toEqual({ route: "events" });
    expect(parseRoute("POST", "/api/say")).toEqual({ route: "say" });
    expect(parseRoute("GET", "/api/say")).toBeUndefined();
    expect(parseRoute("GET", "/api/frame/frame-1.jpg")).toEqual({
      route: "frame",
      frameId: "frame-1",
    });
    expect(parseRoute("GET", "/api/frame/../x.jpg")).toBeUndefined();
    expect(parseRoute("GET", "/api/history")).toBeUndefined();
    expect(parseRoute("GET", "/settings")).toBeUndefined();
    expect(parseRoute("POST", "/api/audio")).toEqual({ route: "audio" });
  });
});

describe("the view", () => {
  it("never carries the image, typed text, screen text or credentials", () => {
    const v = view(snapshot());
    const json = JSON.stringify(v);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("base64");
    expect(json).not.toContain("iVBOR");
    expect(json).not.toContain("Secret plans");
    expect(json).not.toContain("the screen says");
    expect(v.pending?.what).toBe("typing 8 characters");
    expect(v.recent).toEqual(["typed 8 characters"]);
    expect(v.task).toBe(
      "Type the note and [Sensitive text omitted] into Notes",
    );
  });

  it("marks a restricted question as Mac-only and a routine one as allowed", () => {
    expect(view(snapshot())).toMatchObject({
      status: "waiting_for_approval",
      pending: {
        gate,
        nonce,
        tier: "never",
        allowed: false,
        reason: "Send this message?",
      },
    });
    const routine = snapshot({
      pending: {
        action: { type: "hotkey", keys: ["CMD", "Q"], frame_id: "f" },
        reason: "Quit this application?",
      },
    });
    expect(view(routine).pending).toMatchObject({
      tier: "routine",
      allowed: true,
      what: "pressing CMD+Q",
    });
    expect(
      view(routine, { device: { ...device, approve: false } }).pending?.allowed,
    ).toBe(false);
    expect(view(routine, { device: undefined }).pending?.allowed).toBe(false);
  });

  it("has no pending block without a gate and nonce, or when not confirming", () => {
    expect(view(snapshot(), { nonce: undefined }).pending).toBeUndefined();
    expect(
      view(snapshot({ run: run({ status: "executing" }) })).pending,
    ).toBeUndefined();
  });

  it("names a frame only with screenshots on and a live run, never its pixels", () => {
    expect(view(snapshot()).frame).toBeUndefined();
    const on = view(snapshot(), { screenshots: "thumbnail" });
    expect(on.frame).toEqual({ id: "frame-1", at: 5 });
    expect(JSON.stringify(on)).not.toContain("base64");
    expect(
      view(snapshot({ run: run({ status: "completed" }) }), {
        screenshots: "thumbnail",
      }).frame,
    ).toBeUndefined();
  });

  it("describes every step shape without its content", () => {
    expect(
      pendingWhat({
        type: "click_control",
        label: "Send to sk-abcdefghijklmnop",
        frame_id: "f",
      }),
    ).toBe("“Send to [omitted]”");
    expect(
      pendingWhat({
        type: "menu_item",
        path: ["File", "Export"],
        frame_id: "f",
      }),
    ).toBe("File › Export");
    expect(
      pendingWhat({ type: "type_text", text: "a\nb\nc", frame_id: "f" }),
    ).toBe("typing 5 characters over 3 lines");
    expect(pendingWhat({ type: "key", key: "ENTER", frame_id: "f" })).toBe(
      "pressing ENTER",
    );
    expect(
      pendingWhat({ type: "open_app", name: "Notes", frame_id: "f" }),
    ).toBe("opening Notes");
    expect(
      pendingWhat({
        type: "open_file",
        path: "~/Taxes/2025 return.pdf",
        frame_id: "f",
      }),
    ).toBe("opening 2025 return.pdf");
    expect(
      pendingWhat({
        type: "click",
        x: 0.5,
        y: 0.5,
        button: "left",
        frame_id: "f",
      }),
    ).toBe("a click on the screen");
    expect(pendingWhat(undefined)).toBe("a step");
  });
});

describe("events and replies", () => {
  it("encodes one record per event with newlines escaped", () => {
    const text = encodeEvent({
      type: "notice",
      text: "line one\nline two\n\nevent: status",
    });
    expect(text.startsWith("event: notice\ndata: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    // Exactly one blank line: the terminator.
    expect(text.split("\n\n")).toHaveLength(2);
    expect(JSON.parse(text.split("data: ")[1])).toEqual({
      type: "notice",
      text: "line one\nline two\n\nevent: status",
    });
  });

  it("has a fixed line for every plan and never approves", () => {
    expect(remoteReply("stop")).toBe("Stopped.");
    expect(remoteReply("approve")).toBe("Use the Approve button for that.");
    expect(remoteReply("needClick", { reason: "restricted" })).toBe(
      "Approve this one on the Mac.",
    );
    expect(remoteReply("clarify", { question: "Open what?" })).toBe(
      "Open what?",
    );
    expect(remoteReply("start")).toBe("Starting on the Mac.");
    expect(CREDENTIAL_REFUSAL).toMatch(/on the Mac/);
  });
});

describe("what the phone shows after a line it sent", () => {
  it("prefers the dialog's own answer, then the status line, then fixed lines", () => {
    expect(
      remoteTurnReply({ kind: "reply" }, { modelReply: "It's 3 PM in Tokyo." }),
    ).toBe("It's 3 PM in Tokyo.");
    expect(
      remoteTurnReply({ kind: "status" }, { statusLine: "Working on it." }),
    ).toBe("Working on it.");
    expect(
      remoteTurnReply(
        { kind: "status" },
        { modelReply: "Nearly done.", statusLine: "Working on it." },
      ),
    ).toBe("Nearly done.");
    expect(remoteTurnReply({ kind: "clarify", question: "Open what?" })).toBe(
      remoteReply("clarify", { question: "Open what?" }),
    );
    expect(remoteTurnReply({ kind: "needClick", reason: "channel" })).toBe(
      remoteReply("needClick", { reason: "channel" }),
    );
    expect(remoteTurnReply({ kind: "start" })).toBeUndefined();
  });
});
