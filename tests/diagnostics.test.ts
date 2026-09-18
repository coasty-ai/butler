import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiagnostics } from "../electron/diagnostics";
import { trace } from "../src/core/diagnostics";
import type { Snapshot } from "../src/core/schema";

function fixture(
  run: (log: LocalDiagnostics, directory: string, output: string[]) => void,
  maxBytes?: number,
) {
  const directory = mkdtempSync(join(tmpdir(), "assist-diagnostics-"));
  const output: string[] = [];
  try {
    run(
      new LocalDiagnostics(
        directory,
        () => ["fixture-secret-value"],
        (line) => output.push(line),
        maxBytes,
      ),
      directory,
      output,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
describe("local diagnostic stream", () => {
  it("preserves UUID correlation IDs while redacting phone-like text", () =>
    fixture((log) => {
      const id = "dda590c3-1234-4567-8cd6-c0e751c0cd36";
      log.write("Test", { requestId: id, error: "Call 555-123-4567" });
      const event = JSON.parse(readFileSync(log.file, "utf8"));
      expect(event.data.requestId).toBe(id);
      expect(event.data.error).not.toContain("555-123-4567");
    }));
  it("redacts known keys and sensitive error text, excluding content payloads", () =>
    fixture((log, directory, output) => {
      log.write("ProviderTransportError", {
        error:
          "fixture-secret-value email person@example.com https://secret.test/path",
        cause: { error: "Bearer supersecret-token" },
        headers: { Authorization: "fixture-secret-value" },
        task: "private task",
        image: "private screenshot",
        text: "private typed text",
        durationMs: 123,
      });
      const raw = readFileSync(log.file, "utf8");
      for (const secret of [
        "fixture-secret-value",
        "person@example.com",
        "secret.test",
        "supersecret-token",
        "private task",
        "private screenshot",
        "private typed text",
      ])
        expect(raw).not.toContain(secret);
      expect(JSON.parse(raw).data.durationMs).toBe(123);
      expect(output.join("")).toBe(raw);
      expect(statSync(log.file).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }));
  it("rotates bounded files without losing the newest event", () =>
    fixture((log, directory) => {
      for (let i = 0; i < 30; i++) log.write("Tick", { attempt: i });
      expect(readdirSync(directory).length).toBeLessThanOrEqual(4);
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines.at(-1)!).data.attempt).toBe(29);
      for (const name of readdirSync(directory))
        expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }, 400));
  it("emits each journal event/state once without persisting task or typed text", () =>
    fixture((log) => {
      const snapshot: Snapshot = {
        run: {
          id: crypto.randomUUID(),
          task: "hidden task",
          createdAt: new Date().toISOString(),
          status: "executing",
          privacy: "PRIVATE_LOCAL",
          provider: "tutorial",
          model: "Scripted tutorial",
          synthetic: true,
          actions: 0,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "hidden message",
        events: [],
      };
      snapshot.events.push({
        event_id: crypto.randomUUID(),
        run_id: snapshot.run!.id,
        sequence_number: 1,
        monotonic_timestamp: 0,
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1,
        type: "ActionProposed",
        data: { action: { type: "type_text", text: "hidden typed text" } },
      });
      log.snapshot(snapshot);
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(events.map((x) => x.event)).toEqual([
        "ActionProposed",
        "RunState",
      ]);
      expect(events[0].data.textLength).toBe(17);
      expect(raw).not.toContain("hidden");
    }));
  it("records open_app outcomes without application names or typed text", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const snapshot: Snapshot = {
        run: {
          id,
          task: "open the secret project app",
          createdAt: new Date().toISOString(),
          status: "executing",
          privacy: "PRIVATE_LOCAL",
          provider: "openai",
          model: "fixture",
          synthetic: false,
          actions: 1,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "Opening Zeta Private Notes.",
        events: [],
      };
      const add = (type: string, data: Record<string, unknown>) =>
        snapshot.events.push({
          event_id: crypto.randomUUID(),
          run_id: id,
          sequence_number: snapshot.events.length + 1,
          monotonic_timestamp: 0,
          wall_clock_timestamp: new Date().toISOString(),
          schema_version: 1,
          type,
          data,
        });
      const action = {
        type: "open_app",
        frame_id: "frame",
        name: "Zeta Private Notes",
      };
      add("ActionRetargetRequested", {
        actionType: "open_app",
        launcherStatus: "ambiguous",
        launcherCandidates: ["Zeta Private Notes", "Zeta Private Notes Beta"],
        reason: "More than one installed application matches.",
      });
      add("ActionProposed", { action });
      add("ActionExecuted", {
        action,
        frame_id: "frame",
        launched: {
          appId: "com.example.zeta",
          name: "Zeta Private Notes",
          frontmost: false,
          wasRunning: true,
        },
      });
      add("ActionFailed", {
        code: "MALFORMED_RESPONSE",
        problem: "The response contained no action.",
      });
      add("ActionProposed", {
        action: {
          type: "type_text",
          frame_id: "frame",
          text: "Zeta typed secret",
        },
      });
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(raw).not.toContain("Zeta");
      expect(raw).not.toContain("secret");
      expect(events[0].data.launcherStatus).toBe("ambiguous");
      expect(events[1].data).toMatchObject({
        actionType: "open_app",
        nameLength: 18,
      });
      expect(events[2].data).toMatchObject({
        launchedAppId: "com.example.zeta",
        frontmost: false,
        wasRunning: true,
        nameLength: 18,
      });
      expect(events[3].data.problem).toBe("The response contained no action.");
      expect(events[4].data.textLength).toBe(17);
      log.write("NativeUnavailable", { exitCode: 3, signal: "SIGKILL" });
      log.write("NativeRestarted", { pid: 42, restarts: 1 });
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines.at(-2)!).data).toEqual({
        exitCode: 3,
        signal: "SIGKILL",
      });
      expect(JSON.parse(lines.at(-1)!).data).toEqual({ pid: 42, restarts: 1 });
    }));
  it("logs refusals and action loops by code and shape only", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const snapshot: Snapshot = {
        run: {
          id,
          task: "private refusal task",
          createdAt: new Date().toISOString(),
          status: "paused",
          privacy: "PRIVATE_LOCAL",
          provider: "openai",
          model: "fixture",
          synthetic: false,
          actions: 3,
          frames: 3,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "The model declined: private refusal text",
        events: [],
      };
      const add = (type: string, data: Record<string, unknown>) =>
        snapshot.events.push({
          event_id: crypto.randomUUID(),
          run_id: id,
          sequence_number: snapshot.events.length + 1,
          monotonic_timestamp: 0,
          wall_clock_timestamp: new Date().toISOString(),
          schema_version: 1,
          type,
          data,
        });
      add("ActionFailed", {
        code: "REFUSED",
        problem: "private refusal text",
        text: "private refusal text",
      });
      add("ActionLoopDetected", {
        actionType: "click",
        period: 2,
        summary: "private loop text",
      });
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(raw).not.toContain("private");
      expect(events[0]).toMatchObject({
        event: "ActionFailed",
        data: { code: "REFUSED" },
      });
      expect(events[0].data.problem).toBeUndefined();
      expect(events[1].event).toBe("ActionLoopDetected");
      expect(events[1].data).toEqual({
        runId: id,
        sequence: 2,
        synthetic: false,
        actionType: "click",
        period: 2,
      });
    }));
  it("logs memory recall and replay plans as counts and codes, never task text or paths", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const snapshot: Snapshot = {
        run: {
          id,
          task: "open the Zephyr budget spreadsheet",
          createdAt: new Date().toISOString(),
          status: "executing",
          privacy: "PRIVATE_LOCAL",
          provider: "openai",
          model: "fixture",
          synthetic: false,
          actions: 1,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "Opened Zephyr budget",
        },
        frame: null,
        message: "Opening ~/Documents/Zephyr Budget.xlsx",
        events: [],
      };
      const add = (type: string, data: Record<string, unknown>) =>
        snapshot.events.push({
          event_id: crypto.randomUUID(),
          run_id: id,
          sequence_number: snapshot.events.length + 1,
          monotonic_timestamp: 0,
          wall_clock_timestamp: new Date().toISOString(),
          schema_version: 1,
          type,
          data,
        });
      add("MemoryRecalled", {
        preferences: 2,
        episodes: 1,
        apps: 12,
        files: 3,
        plan: "intent",
        mode: "replay",
        // Hostile or future payloads must still be dropped in normal mode.
        text: "Zephyr preference text",
        outline: ["open_file ~/Documents/Zephyr Budget.xlsx"],
      });
      add("PlanStepProposed", {
        source: "intent",
        index: 0,
        action: {
          type: "open_file",
          frame_id: "frame",
          path: "~/Documents/Zephyr Budget.xlsx",
        },
      });
      add("ActionExecuted", {
        action: {
          type: "open_file",
          frame_id: "frame",
          path: "~/Documents/Zephyr Budget.xlsx",
        },
        frame_id: "frame",
        opened: {
          path: "~/Documents/Zephyr Budget.xlsx",
          kind: "document",
          appId: "com.microsoft.Excel",
        },
      });
      add("PlanAbandoned", { index: 1, reason: "STATE_CHANGED" });
      add("PlanAbandoned", {
        index: 2,
        reason: "The Zephyr button was not found.",
      });
      add("MemoryRecalled", {
        preferences: "Zephyr always uses Safari",
        episodes: ["Zephyr episode"],
        apps: { name: "Zephyr" },
        files: [{ path: "~/Zephyr" }],
        plan: "Zephyr plan text with spaces",
        mode: "none",
      });
      add("PlanCompleted", { source: "skill", summary: "Zephyr done" });
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(raw).not.toContain("Zephyr");
      expect(raw).not.toContain("Documents");
      expect(raw).not.toContain("~/");
      expect(events.map((x) => x.event)).toEqual([
        "MemoryRecalled",
        "PlanStepProposed",
        "ActionExecuted",
        "PlanAbandoned",
        "PlanAbandoned",
        "MemoryRecalled",
        "PlanCompleted",
        "RunState",
      ]);
      expect(events[0].data).toEqual({
        runId: id,
        sequence: 1,
        synthetic: false,
        preferences: 2,
        episodes: 1,
        apps: 12,
        files: 3,
        plan: "intent",
        mode: "replay",
      });
      expect(events[1].data).toEqual({
        runId: id,
        sequence: 2,
        synthetic: false,
        source: "intent",
        index: 0,
        actionType: "open_file",
      });
      expect(events[2].data).toMatchObject({
        actionType: "open_file",
        openedKind: "document",
        openedAppId: "com.microsoft.Excel",
      });
      expect(events[3].data).toMatchObject({
        index: 1,
        reason: "STATE_CHANGED",
      });
      // Free-form reasons are dropped rather than logged.
      expect(events[4].data.index).toBe(2);
      expect(events[4].data.reason).toBeUndefined();
      expect(events[5].data).toEqual({
        runId: id,
        sequence: 6,
        synthetic: false,
        mode: "none",
      });
      expect(events[6].data).toEqual({
        runId: id,
        sequence: 7,
        synthetic: false,
        source: "skill",
      });
      // Direct writes get the same count/code restrictions.
      log.write("MemoryWritten", {
        episodes: "Zephyr",
        skills: 4,
        plan: "a plan with Zephyr",
      });
      const last = JSON.parse(
        readFileSync(log.file, "utf8").trim().split("\n").at(-1)!,
      );
      expect(last.data).toEqual({ skills: 4 });
    }));
  it("logs voice turns and spoken replies as codes, counts, timings and flags, never spoken text", () =>
    fixture((log) => {
      const utteranceId = crypto.randomUUID();
      log.write("SpeechOut", {
        phase: "finished",
        kind: "approval",
        priority: "urgent",
        textLength: 41,
        durationMs: 1830,
        latencyMs: 142,
        interrupted: false,
        engine: "system",
        voiceQuality: "premium",
        fallback: true,
        status: "accepted",
        utteranceId,
        text: "Send the Zephyr invoice to the whole team?",
      });
      log.write("TurnPlanned", {
        plan: "amendTask",
        source: "followup",
        window: "continuation",
        segments: 2,
        confidence: 0.82,
        merged: true,
        textLength: 33,
        text: "Open Zephyr and check the weather",
      });
      log.write("FollowUp", {
        phase: "closed",
        window: "answer",
        endReason: "timeout",
        durationMs: 3000,
      });
      log.write("VoiceEvent", {
        phase: "turn_endpoint",
        completeness: "incomplete",
        patience: "relaxed",
        endReason: "stable_quiet",
        segments: 3,
        stableMs: 2100,
        quietMs: 1520,
        remainingMs: 700,
        noiseFloor: 0.004,
        threshold: 0.006,
        speaking: false,
        rate: 1.1,
        code: "empty",
        kind: "continuation",
        text: "open Zephyr and",
        command: "open Zephyr",
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("Zephyr");
      const [speech, turn, followUp, voice] = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x).data);
      expect(speech).toEqual({
        phase: "finished",
        kind: "approval",
        priority: "urgent",
        textLength: 41,
        durationMs: 1830,
        latencyMs: 142,
        interrupted: false,
        engine: "system",
        voiceQuality: "premium",
        fallback: true,
        status: "accepted",
        utteranceId,
      });
      expect(turn).toEqual({
        plan: "amendTask",
        source: "followup",
        window: "continuation",
        segments: 2,
        confidence: 0.82,
        merged: true,
        textLength: 33,
      });
      expect(followUp).toEqual({
        phase: "closed",
        window: "answer",
        endReason: "timeout",
        durationMs: 3000,
      });
      expect(voice).toEqual({
        phase: "turn_endpoint",
        completeness: "incomplete",
        patience: "relaxed",
        endReason: "stable_quiet",
        segments: 3,
        stableMs: 2100,
        quietMs: 1520,
        remainingMs: 700,
        noiseFloor: 0.004,
        threshold: 0.006,
        speaking: false,
        rate: 1.1,
        code: "empty",
        kind: "continuation",
      });
    }));
  it("drops text placed in voice code, count, number, flag and id fields", () =>
    fixture((log) => {
      const hostile = "the Zephyr secret plan";
      log.write("SpeechOut", {
        kind: hostile,
        priority: hostile,
        engine: hostile,
        voiceQuality: hostile,
        window: hostile,
        completeness: hostile,
        patience: hostile,
        endReason: hostile,
        source: hostile,
        phase: hostile,
        code: hostile,
        status: hostile,
        plan: hostile,
        segments: hostile,
        stableMs: hostile,
        quietMs: hostile,
        latencyMs: hostile,
        remainingMs: hostile,
        noiseFloor: hostile,
        threshold: hostile,
        rate: hostile,
        confidence: hostile,
        textLength: hostile,
        durationMs: hostile,
        interrupted: hostile,
        merged: hostile,
        speaking: hostile,
        fallback: hostile,
        utteranceId: hostile,
      });
      log.write("SpeechOut", {
        // Non-finite or wrongly typed values are dropped too; HTTP statuses
        // belong in httpStatus.
        status: 429,
        httpStatus: 429,
        latencyMs: Number.POSITIVE_INFINITY,
        segments: [2],
        interrupted: 1,
        utteranceId: "sk-proj-abcdefghijklmnopqrstuvwx",
      });
      log.write("SpeechOut", { utteranceId: "fixture-secret-value" });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("Zephyr");
      expect(raw).not.toContain("sk-proj");
      expect(raw).not.toContain("fixture-secret-value");
      expect(
        raw
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x).data),
      ).toEqual([{}, { httpStatus: 429 }, {}]);
    }));
  it("logs a task amendment by length only", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const snapshot: Snapshot = {
        run: {
          id,
          task: "Open Zephyr and check the weather",
          createdAt: new Date().toISOString(),
          status: "capturing",
          privacy: "PRIVATE_LOCAL",
          provider: "openai",
          model: "fixture",
          synthetic: false,
          actions: 0,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "Resuming with a fresh screenshot.",
        events: [],
      };
      const add = (type: string, data: Record<string, unknown>) =>
        snapshot.events.push({
          event_id: crypto.randomUUID(),
          run_id: id,
          sequence_number: snapshot.events.length + 1,
          monotonic_timestamp: 0,
          wall_clock_timestamp: new Date().toISOString(),
          schema_version: 1,
          type,
          data,
        });
      add("TaskAmended", { taskLength: 33 });
      add("TaskAmended", {
        taskLength: "Open Zephyr and check the weather",
        text: "Open Zephyr and check the weather",
      });
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("Zephyr");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(events.map((x) => x.event)).toEqual([
        "TaskAmended",
        "TaskAmended",
        "RunState",
      ]);
      expect(events[0].data).toEqual({
        runId: id,
        sequence: 1,
        synthetic: false,
        taskLength: 33,
      });
      expect(events[1].data).toEqual({
        runId: id,
        sequence: 2,
        synthetic: false,
      });
    }));
  it("records spoken text and voice fields in verbose mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "assist-diagnostics-"));
    const output: string[] = [];
    try {
      const log = new LocalDiagnostics(
        directory,
        () => [],
        (line) => output.push(line),
        undefined,
        true,
      );
      log.write("SpeechOut", {
        phase: "requested",
        kind: "result",
        text: "Opened Zephyr notes.",
      });
      const event = JSON.parse(output.join(""));
      expect(event.data).toEqual({
        phase: "requested",
        kind: "result",
        text: "Opened Zephyr notes.",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("records memory event payloads in verbose mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "assist-diagnostics-"));
    const output: string[] = [];
    try {
      const log = new LocalDiagnostics(
        directory,
        () => [],
        (line) => output.push(line),
        undefined,
        true,
      );
      log.write("MemoryRecalled", {
        preferences: 1,
        plan: "open Zephyr notes",
      });
      expect(output.join("")).toContain("open Zephyr notes");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not let a broken output sink interrupt task execution", () => {
    expect(() =>
      trace(() => {
        throw Error("Disk full");
      }, "Test"),
    ).not.toThrow();
    fixture((log) => {
      const data: Record<string, unknown> = {};
      data.cause = data;
      expect(() => log.write("Cycle", data)).not.toThrow();
    });
  });
  it("records text, actions and screenshots only in opt-in verbose mode, still redacting keys", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "assist-diagnostics-verbose-"),
    );
    const output: string[] = [];
    try {
      const log = new LocalDiagnostics(
        directory,
        () => ["fixture-secret-value"],
        (line) => output.push(line),
        undefined,
        true,
      );
      const png =
        "data:image/png;base64," +
        Buffer.from([137, 80, 78, 71]).toString("base64");
      const snapshot = {
        run: {
          id: "11111111-2222-3333-4444-555555555555",
          task: "Open Calculator and compute 12 times 7",
          createdAt: "",
          status: "executing",
          privacy: "PRIVATE_BYOM",
          provider: "openai",
          model: "m",
          synthetic: false,
          actions: 1,
          frames: 1,
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          summary: "",
        },
        frame: {
          id: "frame-verbose-1",
          sha256: "s",
          image: png,
          geometry: {},
          capturedAt: 0,
          synthetic: false,
          appId: "com.apple.calculator",
          context: { appName: "Calculator", windowTitle: "" },
        },
        events: [
          {
            event_id: "e",
            run_id: "r",
            sequence_number: 1,
            monotonic_timestamp: 0,
            wall_clock_timestamp: "",
            schema_version: 1,
            type: "ActionExecuted",
            data: {
              action: { type: "type_text", text: "12*7= fixture-secret-value" },
            },
          },
        ],
        message: "Working",
      } as unknown as Snapshot;
      log.snapshot(snapshot);
      log.write("VoiceEvent", {
        phase: "transcript_final",
        text: "open calculator",
      });
      log.write("Command", {
        text: "use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password: hunter22!",
      });
      const text = output.join("");
      expect(text).toContain("Open Calculator and compute 12 times 7");
      expect(text).toContain("12*7=");
      expect(text).toContain("open calculator");
      expect(text).not.toContain("fixture-secret-value");
      expect(text).not.toContain("base64");
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      expect(text).not.toContain("hunter22");
      expect(text).toContain("use token");
      const frames = readdirSync(join(directory, "frames"));
      expect(frames).toHaveLength(1);
      expect(statSync(join(directory, "frames", frames[0])).mode & 0o077).toBe(
        0,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("dialog and streamed-speech fields", () => {
  it("keeps the act, timings, flags and counts of a dialog turn, never its words", () =>
    fixture((log) => {
      log.write("DialogTurn", {
        phase: "decided",
        act: "answer",
        code: "model",
        channel: "voice",
        actMs: 612,
        firstAudioMs: 900,
        preempt: true,
        stream: true,
        sentences: 2,
        dropped: 1,
        plan: "reply",
        text: "what time is it",
        user: "what time is it",
        say: "It is three.",
        task: "Open Mail",
      });
      const event = JSON.parse(readFileSync(log.file, "utf8"));
      expect(event.data).toEqual({
        phase: "decided",
        act: "answer",
        code: "model",
        channel: "voice",
        actMs: 612,
        firstAudioMs: 900,
        preempt: true,
        stream: true,
        sentences: 2,
        dropped: 1,
        plan: "reply",
      });
      // A sentence smuggled into a code or count field is dropped.
      log.write("DialogTurn", {
        act: "send the deck to dana",
        channel: "voice channel",
        actMs: "fast",
        sentences: "two",
        preempt: "yes",
      });
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines[1]).data).toEqual({});
    }));
});
