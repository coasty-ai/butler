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
import { errorDetails, trace } from "../src/core/diagnostics";
import { ScreenChangedError } from "../src/core/errors";
import type { RunStatus, Snapshot } from "../src/core/schema";

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
        data: {
          action: {
            type: "type_text",
            text: "hidden typed text",
            note: "hidden note 142",
          },
        },
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
      // The model's note is a value it read on screen: its length only.
      expect(events[0].data.noteLength).toBe(15);
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
          windows: 0,
          restoredWindow: false,
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
        // Whether a running app came up windowless: a count and a flag.
        launchedWindows: 0,
        restoredWindow: false,
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
  it("logs a slow helper by the request's method and how long it had waited", () =>
    fixture((log) => {
      // A request past its deadline while the helper answered its liveness
      // probe: the method's name and a measurement; a hang, the same plus
      // the kill. Nothing about the screen the capture was reading, and a
      // wait that is not a number is no measurement.
      log.write("NativeSlow", {
        method: "capture",
        waitedMs: 25004,
        text: "private screen text",
        context: { visibleText: "private screen text" },
      });
      log.write("NativeSlow", { method: "capture", waitedMs: "soon" });
      log.write("NativeTimedOut", { method: "execute", waitedMs: 30012 });
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(lines[0].data).toEqual({ method: "capture", waitedMs: 25004 });
      expect(lines[1].data).toEqual({ method: "capture" });
      expect(lines[2].data).toEqual({ method: "execute", waitedMs: 30012 });
    }));
  it("keeps the observe stream's codes only: a frame's application and exclusion, an action's kind, a drop's reason and count", () =>
    fixture((log) => {
      // The controller traces these with codes alone; the writer keeps
      // exactly those keys whatever a caller passes, so a frame's title,
      // host, labels, controls, text digest and picture never reach the
      // diagnostics (.data/design/observer.md §2, §6).
      log.write("ObserverFrame", {
        appId: "com.apple.Notes",
        excluded: undefined,
        windowTitle: "Groceries password: hunter2!x",
        host: "docs.example.com",
        focusedLabel: "Note body",
        controls: [{ role: "button", label: "Save" }],
        textDigest: "private screen text",
        image: "QUJD",
        runId: "dda590c3-1234-4567-8cd6-c0e751c0cd36",
      });
      log.write("ObserverFrame", {
        appId: "com.1password.1password",
        excluded: "secure_input",
      });
      log.write("ObserverFrame", { excluded: "not a code" });
      log.write("ObserverAction", {
        kind: "typing",
        appId: "com.apple.Notes",
        target: { role: "AXButton", label: "Save" },
        chord: "CMD+S",
        typed: { field: "Note body", chars: 12, ms: 1800 },
        menu: ["File", "Export"],
      });
      log.write("ObserverDropped", {
        reason: "minute_budget",
        dropped: 3,
        atMs: 5,
      });
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(lines.map((l) => l.data)).toEqual([
        { appId: "com.apple.Notes" },
        { appId: "com.1password.1password", excluded: "secure_input" },
        {},
        { kind: "typing" },
        { reason: "minute_budget", dropped: 3 },
      ]);
      const raw = readFileSync(log.file, "utf8");
      for (const word of [
        "Groceries",
        "hunter2",
        "docs.example.com",
        "Note body",
        "Save",
        "private screen text",
        "QUJD",
        "CMD+S",
        "Export",
        "dda590c3",
      ])
        expect(raw, word).not.toContain(word);
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
      // The revisit rule's detection carries its count; the loop breaker's
      // decision an episode number and an outcome code; a settle its kind.
      // A note, a title or a sentence in any of them is dropped.
      add("ActionLoopDetected", {
        actionType: "open_app",
        period: 0,
        revisits: 3,
        label: "private control label",
      });
      add("ActionLoopBroken", {
        episode: 2,
        outcome: "fail",
        note: "private reflection text",
        title: "private stuck sentence with spaces",
      });
      add("TransitionSettled", {
        kind: "switched",
        title: "private window title",
        host: "private.example.com",
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
      expect(events[2].data).toEqual({
        runId: id,
        sequence: 3,
        synthetic: false,
        actionType: "open_app",
        period: 0,
        revisits: 3,
      });
      expect(events[3].event).toBe("ActionLoopBroken");
      expect(events[3].data).toEqual({
        runId: id,
        sequence: 4,
        synthetic: false,
        episode: 2,
        outcome: "fail",
      });
      expect(events[4].event).toBe("TransitionSettled");
      expect(events[4].data).toEqual({
        runId: id,
        sequence: 5,
        synthetic: false,
        kind: "switched",
      });
    }));
  it("keeps the shape of unparseable model arguments as counts, flags and a code, never their text", () =>
    fixture((log) => {
      const requestId = crypto.randomUUID();
      log.write("ProviderMalformed", {
        requestId,
        provider: "openai",
        model: "fixture",
        attempt: 1,
        problem: "The action arguments were not valid JSON.",
        httpStatus: 200,
        durationMs: 1887,
        bytes: 18797,
        usage: { inputTokens: 6271, outputTokens: 167, cost: 0.0036 },
        status: "completed",
        outputTypes: ["reasoning", "function_call"],
        argumentShape: {
          length: 143,
          startsWithBrace: true,
          endsWithBrace: true,
          parseError: "BAD_CONTROL_CHARACTER",
          parseOffset: 97,
          openBraces: 1,
          closeBraces: 1,
          quotes: 12,
          backslashes: 0,
          newlines: 1,
          backticks: 0,
          controls: 0,
          objects: 1,
          depthAtEnd: 0,
          quotedAtEnd: false,
          leadingProse: 0,
          trailingProse: 0,
          // Smuggled text or a sentence in a code slot is dropped.
          text: "private typed words",
          sample: '{"type":"type_text"',
        },
        arguments: '{"type":"type_text","text":"private typed words',
      });
      log.write("ProviderResponse", {
        requestId,
        provider: "openai",
        model: "fixture",
        attempt: 1,
        repaired: true,
        actionType: "click",
        action: { type: "click", text: "private" },
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("private");
      expect(raw).not.toContain("type_text");
      const [malformed, response] = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(malformed.data.argumentShape).toEqual({
        length: 143,
        startsWithBrace: true,
        endsWithBrace: true,
        parseError: "BAD_CONTROL_CHARACTER",
        parseOffset: 97,
        openBraces: 1,
        closeBraces: 1,
        quotes: 12,
        backslashes: 0,
        newlines: 1,
        backticks: 0,
        controls: 0,
        objects: 1,
        depthAtEnd: 0,
        quotedAtEnd: false,
        leadingProse: 0,
        trailingProse: 0,
      });
      expect(malformed.data.arguments).toBeUndefined();
      expect(malformed.data.problem).toBe(
        "The action arguments were not valid JSON.",
      );
      expect(response.data).toMatchObject({
        repaired: true,
        actionType: "click",
      });
      expect(response.data.action).toBeUndefined();
      // A sentence where the parse-error code belongs, and text where a
      // count belongs, are dropped rather than written.
      log.write("ProviderMalformed", {
        requestId,
        argumentShape: {
          parseError: "Unexpected token 'p', \"private\" is not valid JSON",
          newlines: "private",
          quotedAtEnd: "private",
        },
      });
      const last = JSON.parse(
        readFileSync(log.file, "utf8").trim().split("\n").at(-1)!,
      );
      expect(last.data).toEqual({ requestId, argumentShape: {} });
    }));
  it("keeps a native refusal's kind of change on its NativeError line", () =>
    fixture((log) => {
      log.write(
        "NativeError",
        errorDetails(
          new ScreenChangedError("The focused field changed.", "FOCUS_CHANGED"),
        ),
      );
      const [line] = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(line.data).toMatchObject({
        name: "ScreenChangedError",
        code: "STATE_CHANGED",
        change: "FOCUS_CHANGED",
      });
    }));
  it("logs a refused step's kind of change and a hotkey's route as codes only", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const snapshot: Snapshot = {
        run: {
          id,
          task: "put pick up packages in Calendar",
          createdAt: new Date().toISOString(),
          status: "executing",
          privacy: "PRIVATE_LOCAL",
          provider: "openai",
          model: "fixture",
          synthetic: false,
          actions: 1,
          frames: 2,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "",
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
      add("ActionFailed", { code: "STATE_CHANGED", change: "FOCUS_CHANGED" });
      add("ActionFailed", {
        code: "STATE_CHANGED",
        change: "Packages event changed",
      });
      add("ActionExecuted", {
        action: { type: "hotkey", keys: ["CMD", "N"], frame_id: "f" },
        frame_id: "f",
        via: "menu",
      });
      // The runner's check of a done against the task's file: its code and
      // reason are fixed words; the path stays in the journal's history.
      add("ActionFailed", {
        code: "DONE_CHALLENGED",
        actionType: "done",
        reason: "deliverable_unchanged",
      });
      add("RunFailed", { code: "DELIVERABLE_MISSING" });
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(raw).not.toContain("ackages");
      expect(events[0].data).toMatchObject({
        code: "STATE_CHANGED",
        change: "FOCUS_CHANGED",
      });
      expect(events[1].data.code).toBe("STATE_CHANGED");
      expect(events[1].data.change).toBeUndefined();
      expect(events[2].data).toMatchObject({
        actionType: "hotkey",
        via: "menu",
      });
      expect(events[3].data).toMatchObject({
        code: "DONE_CHALLENGED",
        actionType: "done",
        reason: "deliverable_unchanged",
      });
      expect(events[4].event).toBe("RunFailed");
      expect(events[4].data.code).toBe("DELIVERABLE_MISSING");
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
  it("keeps the helper's echo-cancellation report and the RMS scale beside it, never text", () =>
    fixture((log) => {
      // The seven-channel input of 2026-09-19: the channel read and its level beside the format.
      log.write("VoiceEvent", {
        phase: "voice_processing",
        enabled: true,
        sampleRate: 48000,
        channels: 7,
        interleaved: false,
        micChannel: 3,
        micLevel: 12,
        text: "the Zephyr plan",
      });
      log.write("VoiceEvent", {
        phase: "voice_processing",
        enabled: false,
        code: "start_failed",
        error: "The operation couldn’t be completed. (-10875)",
      });
      log.write("VoiceEvent", {
        phase: "voice_processing",
        enabled: false,
        code: "silent",
      });
      log.write("VoiceEvent", {
        phase: "standby_trace",
        kind: "level",
        noiseFloor: 0.0041,
        threshold: 0.0123,
        voiceProcessing: true,
        speaking: true,
      });
      log.write("VoiceEvent", {
        phase: "standby_trace",
        kind: "begin",
        mode: "standby",
        voiceProcessing: true,
        channels: 7,
        micChannel: 3,
      });
      // Text smuggled into the new fields is dropped, not written.
      log.write("VoiceEvent", {
        phase: "voice_processing",
        sampleRate: "the Zephyr plan",
        channels: "the Zephyr plan",
        interleaved: "the Zephyr plan",
        micChannel: "the Zephyr plan",
        micLevel: "the Zephyr plan",
        voiceProcessing: "the Zephyr plan",
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("Zephyr");
      const [on, off, silent, level, begin, hostile] = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x).data);
      expect(on).toEqual({
        phase: "voice_processing",
        enabled: true,
        sampleRate: 48000,
        channels: 7,
        interleaved: false,
        micChannel: 3,
        micLevel: 12,
      });
      expect(off).toMatchObject({
        phase: "voice_processing",
        enabled: false,
        code: "start_failed",
      });
      expect(silent).toEqual({
        phase: "voice_processing",
        enabled: false,
        code: "silent",
      });
      expect(level).toEqual({
        phase: "standby_trace",
        kind: "level",
        noiseFloor: 0.0041,
        threshold: 0.0123,
        voiceProcessing: true,
        speaking: true,
      });
      expect(begin).toEqual({
        phase: "standby_trace",
        kind: "begin",
        mode: "standby",
        voiceProcessing: true,
        channels: 7,
        micChannel: 3,
      });
      expect(hostile).toEqual({ phase: "voice_processing" });
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

  it("keeps the Jev decider's timing, act, probability, use and failure code, nothing else", () =>
    fixture((log) => {
      log.write("DialogTurn", {
        phase: "decided",
        code: "jev_start",
        jevMs: 212,
        jevAct: "start",
        jevP: 0.97,
        jevUsed: true,
        jevCode: "wrong_provider",
        jevState: { user: "print the boarding pass" },
        jevKey: "sk-or-v1-secret",
        state: "print the boarding pass",
      });
      const event = JSON.parse(readFileSync(log.file, "utf8"));
      expect(event.data).toEqual({
        phase: "decided",
        code: "jev_start",
        jevMs: 212,
        jevAct: "start",
        jevP: 0.97,
        jevUsed: true,
        jevCode: "wrong_provider",
      });
      // Only a code, a number or a flag ever passes through each field.
      log.write("DialogTurn", {
        jevMs: "two hundred",
        jevAct: "start the boarding pass print",
        jevP: "high",
        jevUsed: "yes",
        jevCode: "the key sk-or-v1-secret was rejected",
      });
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines[1]).data).toEqual({});
    }));

  it("keeps the early step's codes and timings, never the app or the words", () =>
    fixture((log) => {
      log.write("EarlyStartExecuted", {
        code: "ok",
        settle: "boundary",
        earlyMs: 412,
        durationMs: 388,
        // Smuggled extras: allow-listed elsewhere, never here.
        name: "Slack",
        appId: "com.tinyspeck.slackmacgap",
        launchedAppId: "com.tinyspeck.slackmacgap",
        runId: "dda590c3-1234-4567-8cd6-c0e751c0cd36",
        text: "open Slack and message Dana",
      });
      log.write("EarlyStartEnded", {
        phase: "kept",
        code: "ok",
        leadMs: -120,
        textLength: 27,
        reason: "Open Slack",
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toMatch(/slack|dana|tinyspeck|dda590c3/i);
      const [executed, ended] = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data);
      expect(executed).toEqual({
        code: "ok",
        settle: "boundary",
        earlyMs: 412,
        durationMs: 388,
      });
      expect(ended).toEqual({ phase: "kept", code: "ok", leadMs: -120 });
      // Only a code or a number passes through each field.
      log.write("EarlyStartExecuted", {
        settle: "when the user said slack",
        earlyMs: "fast",
        leadMs: "soon",
      });
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines[2]).data).toEqual({});
    }));

  it("keeps the prepared first step's codes, kind, timings and cost, never the words", () =>
    fixture((log) => {
      log.write("SpeculationStarted", { text: "search for cats" });
      log.write("SpeculationSkipped", {
        code: "needs_model",
        key: "search for cats",
      });
      log.write("SpeculationDiscarded", {
        code: "text_changed",
        kind: "model",
        usage: { inputTokens: 1200, outputTokens: 40, cost: 0.0012 },
        task: "search for cats",
        reason: "search for cats and dogs",
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toMatch(/cats|dogs/i);
      const [started, skipped, discarded] = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data);
      expect(started).toEqual({});
      expect(skipped).toEqual({ code: "needs_model" });
      expect(discarded).toEqual({
        code: "text_changed",
        kind: "model",
        usage: { inputTokens: 1200, outputTokens: 40, cost: 0.0012 },
      });
      // Only a code or a number passes through each field.
      log.write("SpeculationDiscarded", {
        code: "the words changed to search for dogs",
        kind: "the model",
        savedMs: "a lot",
      });
      expect(
        JSON.parse(readFileSync(log.file, "utf8").trim().split("\n")[3]).data,
      ).toEqual({});
      // The run's own journal entry for an adopted step carries its numbers.
      const id = crypto.randomUUID();
      const snapshot: Snapshot = {
        run: {
          id,
          task: "search for cats",
          createdAt: new Date().toISOString(),
          status: "thinking",
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
        message: "",
        events: [
          {
            event_id: crypto.randomUUID(),
            run_id: id,
            sequence_number: 1,
            monotonic_timestamp: 0,
            wall_clock_timestamp: new Date().toISOString(),
            schema_version: 1,
            type: "SpeculationAdopted",
            data: {
              kind: "model",
              leadMs: 1310,
              savedMs: 1180,
              frameAgeMs: 1420,
              task: "search for cats",
            },
          },
        ],
      };
      log.snapshot(snapshot);
      const adopted = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((line) => line.event === "SpeculationAdopted");
      expect(adopted.data).toEqual({
        runId: id,
        sequence: 1,
        kind: "model",
        leadMs: 1310,
        savedMs: 1180,
        frameAgeMs: 1420,
        synthetic: false,
      });
      expect(readFileSync(log.file, "utf8")).not.toMatch(/cats/i);
    }));

  it("keeps tool events content-free: hashed ids, tiers, outcomes, counts and flags, never a question, an argument or a result", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const hostile = "Add Dentist tomorrow at 6 PM to Calendar?";
      const events: Snapshot["events"] = [
        {
          type: "ToolsListed",
          data: { toolCount: 5, unavailableCount: 1, code: "timeout" },
        },
        {
          type: "ToolCallProposed",
          data: {
            tool: "t0123456789ab",
            server: "s0123456789ab",
            toolTier: "additive",
            argsBytes: 88,
            entityCount: 0,
            questionKind: "calendar_add",
            args: { title: "Dentist" },
          },
        },
        {
          type: "PolicyConfirmationRequested",
          data: {
            actionType: "tool_call",
            reason: hostile,
            questionKind: "calendar_add",
            approvalCode: "TOOL_CALENDAR_ADD",
            action: {
              type: "tool_call",
              tool: "apple__calendar_create_event",
              args: { title: "Dentist" },
              finish: true,
            },
          },
        },
        {
          type: "PolicyAllowed",
          data: { actionType: "tool_call", reason: hostile },
        },
        {
          type: "ActionExecuted",
          data: {
            action: {
              type: "tool_call",
              tool: "apple__calendar_create_event",
              args: { title: "Dentist" },
              finish: true,
            },
            frame_id: "f",
          },
        },
        {
          type: "ToolCallFinished",
          data: {
            tool: "calendar_create_event",
            server: "apple",
            outcome: "ok",
            resultBytes: 120,
            resultItems: 1,
            durationMs: 340,
            verified: true,
            finish: true,
            longRunning: false,
            text: "Tool apple__calendar_create_event: ok, verified. Dentist",
          },
        },
        {
          type: "ToolUndo",
          data: {
            tool: "calendar_create_event",
            server: "apple",
            outcome: "ok",
          },
        },
      ].map((e, i) => ({
        event_id: crypto.randomUUID(),
        run_id: id,
        sequence_number: i + 1,
        monotonic_timestamp: 0,
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1,
        ...e,
      }));
      log.snapshot({
        run: {
          id,
          task: "add dentist tomorrow at 6 pm to my calendar",
          createdAt: new Date().toISOString(),
          status: "completed",
          privacy: "PRIVATE_LOCAL",
          provider: "ollama",
          model: "m",
          synthetic: false,
          actions: 1,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "Added Dentist to Calendar.",
          tools: { calls: 1, writes: 1 },
        },
        frame: null,
        message: "Added Dentist to Calendar.",
        events,
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("Dentist");
      expect(raw).not.toContain("dentist");
      const lines = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      const byEvent = Object.fromEntries(lines.map((l) => [l.event, l.data]));
      expect(byEvent.ToolsListed).toMatchObject({
        toolCount: 5,
        unavailableCount: 1,
        code: "timeout",
      });
      expect(byEvent.ToolCallProposed).toEqual({
        runId: id,
        sequence: 2,
        synthetic: false,
        tool: "t0123456789ab",
        server: "s0123456789ab",
        toolTier: "additive",
        argsBytes: 88,
        entityCount: 0,
        questionKind: "calendar_add",
      });
      expect(byEvent.PolicyConfirmationRequested).toEqual({
        runId: id,
        sequence: 3,
        synthetic: false,
        actionType: "tool_call",
        questionKind: "calendar_add",
        approvalCode: "TOOL_CALENDAR_ADD",
        // The question's length, never the question.
        reasonLength: hostile.length,
      });
      // The reason of the allowed step travels as a code and a length; this
      // fixture's reason is not one the policy states, so its code is OTHER.
      expect(byEvent.PolicyAllowed.reason).toBeUndefined();
      expect(byEvent.PolicyAllowed).toMatchObject({
        reasonCode: "OTHER",
        reasonLength: hostile.length,
      });
      expect(byEvent.ActionExecuted).toMatchObject({ actionType: "tool_call" });
      expect(byEvent.ToolCallFinished).toEqual({
        runId: id,
        sequence: 6,
        synthetic: false,
        tool: "calendar_create_event",
        server: "apple",
        outcome: "ok",
        resultBytes: 120,
        resultItems: 1,
        durationMs: 340,
        verified: true,
        finish: true,
        longRunning: false,
      });
      expect(byEvent.ToolUndo).toMatchObject({
        tool: "calendar_create_event",
        server: "apple",
        outcome: "ok",
      });
      expect(byEvent.RunState).toMatchObject({
        toolCalls: 1,
        toolWrites: 1,
        status: "completed",
      });
      // A screen step's question is written as its code and length, never
      // its text, even when the journal carries no approvalCode stamp.
      log.snapshot({
        run: {
          id,
          task: "t",
          createdAt: new Date().toISOString(),
          status: "confirming",
          privacy: "PRIVATE_LOCAL",
          provider: "ollama",
          model: "m",
          synthetic: false,
          actions: 0,
          frames: 0,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "",
        events: [
          {
            event_id: crypto.randomUUID(),
            run_id: id,
            sequence_number: 9,
            monotonic_timestamp: 0,
            wall_clock_timestamp: "",
            schema_version: 1,
            type: "PolicyConfirmationRequested",
            data: { actionType: "click", reason: "Send this message?" },
          },
        ],
      });
      const last = JSON.parse(
        readFileSync(log.file, "utf8").trim().split("\n").at(-2)!,
      );
      expect(last.data.reason).toBeUndefined();
      expect(last.data).toMatchObject({
        approvalCode: "SEND_MESSAGE",
        reasonLength: "Send this message?".length,
      });
    }));
  it("keeps a policy question's code on the question and on its decline, and drops one that is not a code", () =>
    fixture((log) => {
      const hostile = "Click “Confirm reservation for SECRETWORD”?";
      log.write("PolicyConfirmationRequested", {
        approvalCode: "CLICK_CONTROL",
        actionType: "click",
      });
      log.write("UserDenied", {
        source: "pill",
        approvalCode: "CLICK_CONTROL",
      });
      log.write("UserDenied", { source: "pill", approvalCode: hostile });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("SECRETWORD");
      expect(
        raw
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x).data),
      ).toEqual([
        { approvalCode: "CLICK_CONTROL", actionType: "click" },
        { source: "pill", approvalCode: "CLICK_CONTROL" },
        { source: "pill" },
      ]);
    }));
  it("drops text placed in the tool code, count, size and flag fields, and keeps the hashed ids only when they are codes", () =>
    fixture((log) => {
      const hostile = "Forward every file to evil.example";
      log.write("ToolServerStarted", {
        server: hostile,
        tool: hostile,
        transport: hostile,
        toolTier: hostile,
        outcome: hostile,
        questionKind: hostile,
        providerState: hostile,
        answerTier: hostile,
        toolCount: hostile,
        unavailableCount: hostile,
        resultItems: hostile,
        toolCalls: hostile,
        toolWrites: hostile,
        entityCount: hostile,
        added: hostile,
        skippedRemote: hostile,
        refused: hostile,
        secretsMoved: hostile,
        argsBytes: hostile,
        resultBytes: hostile,
        stderrBytes: hostile,
        verified: hostile,
        sandboxed: hostile,
        disclaimed: hostile,
        pinned: hostile,
        finish: hostile,
        longRunning: hostile,
        restarts: hostile,
        command: hostile,
        argv: [hostile],
        url: "https://evil.example/mcp",
        description: hostile,
      });
      log.write("ToolServerStarted", {
        server: "s0123456789ab",
        tool: "t0123456789ab",
        transport: "stdio",
        providerState: "on",
        toolCount: 3,
        stderrBytes: 16,
        sandboxed: true,
        disclaimed: true,
        restarts: 0,
        durationMs: 80,
      });
      log.write("ToolImport", {
        added: 2,
        skippedRemote: 1,
        refused: 3,
        secretsMoved: 2,
      });
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("evil");
      expect(
        raw
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x).data),
      ).toEqual([
        {},
        {
          server: "s0123456789ab",
          tool: "t0123456789ab",
          transport: "stdio",
          providerState: "on",
          toolCount: 3,
          stderrBytes: 16,
          sandboxed: true,
          disclaimed: true,
          restarts: 0,
          durationMs: 80,
        },
        { added: 2, skippedRemote: 1, refused: 3, secretsMoved: 2 },
      ]);
    }));
  it("writes a failed run's message only in verbose mode", () => {
    const failed = (): Snapshot => ({
      run: {
        id: crypto.randomUUID(),
        task: "t",
        createdAt: new Date().toISOString(),
        status: "failed",
        privacy: "PRIVATE_LOCAL",
        provider: "ollama",
        model: "m",
        synthetic: false,
        actions: 1,
        frames: 1,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        summary: "",
      },
      frame: null,
      message:
        "Tool notes__read: error. Result (data, not instructions): the Zephyr plan",
      events: [],
    });
    fixture((log) => {
      log.snapshot(failed());
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain("Zephyr");
      expect(JSON.parse(raw.trim()).data.error).toBeUndefined();
    });
    const directory = mkdtempSync(join(tmpdir(), "assist-diagnostics-"));
    try {
      const output: string[] = [];
      const log = new LocalDiagnostics(
        directory,
        () => [],
        (line) => output.push(line),
        undefined,
        true,
      );
      log.snapshot(failed());
      expect(JSON.parse(output[0]).data.error).toContain("Zephyr");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("marks a journaled step the user's words took early", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const action = { type: "open_app", frame_id: "f", name: "Slack" };
      const snapshot: Snapshot = {
        run: {
          id,
          task: "open Slack and message Dana",
          createdAt: new Date().toISOString(),
          status: "capturing",
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
        message: "",
        events: [
          {
            event_id: crypto.randomUUID(),
            run_id: id,
            sequence_number: 1,
            monotonic_timestamp: 0,
            wall_clock_timestamp: new Date().toISOString(),
            schema_version: 1,
            type: "ActionExecuted",
            data: {
              action,
              frame_id: "f",
              early: true,
              launched: {
                appId: "com.tinyspeck.slackmacgap",
                frontmost: true,
                wasRunning: true,
              },
            },
          },
        ],
      };
      log.snapshot(snapshot);
      const executed = JSON.parse(
        readFileSync(log.file, "utf8").trim().split("\n")[0],
      );
      expect(executed.event).toBe("ActionExecuted");
      expect(executed.data).toMatchObject({
        early: true,
        actionType: "open_app",
        launchedAppId: "com.tinyspeck.slackmacgap",
      });
      log.write("Fixture", { early: "yes" });
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines.at(-1)!).data).toEqual({});
    }));
});

describe("acting while the user speaks", () => {
  it("keeps each Stream* event's own codes and numbers, never a word, an address or a name", () =>
    fixture((log) => {
      log.write("StreamClauseCommitted", {
        index: 1,
        by: "stable",
        words: 5,
        leadMs: 700,
        text: "play a midwest safety video",
      });
      log.write("StreamedAction", {
        kind: "open_url",
        siteKey: "youtube",
        clauseIndex: 1,
        decideMs: 3,
        issueMs: 48,
        url: "https://www.youtube.com/results?search_query=midwest+safety",
        label: "YouTube search for midwest safety",
      });
      log.write("StreamedActionDropped", {
        kind: "open_url",
        clauseIndex: 0,
        url: "https://www.youtube.com/",
      });
      log.write("StreamedRunStarted", {
        streamedSteps: 2,
        dropped: 1,
        task: "go to youtube",
      });
      // A site code that is not a code, a word count that is text.
      log.write("StreamedAction", {
        kind: "open_url",
        siteKey: "you tube.com",
        clauseIndex: "one",
        decideMs: 3,
        issueMs: 48,
      });
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(lines.map((x) => x.data)).toEqual([
        { index: 1, by: "stable", words: 5, leadMs: 700 },
        {
          kind: "open_url",
          siteKey: "youtube",
          clauseIndex: 1,
          decideMs: 3,
          issueMs: 48,
        },
        { kind: "open_url", clauseIndex: 0 },
        { streamedSteps: 2, dropped: 1 },
        { kind: "open_url", decideMs: 3, issueMs: 48 },
      ]);
      expect(readFileSync(log.file, "utf8")).not.toMatch(
        /midwest|youtube\.com|https/,
      );
    }));
  it("writes a run's streamed steps by kind, site code, clause and outcome, and their executed rows flagged streamed and early with the site code", () =>
    fixture((log) => {
      const id = crypto.randomUUID();
      const event = (
        sequence: number,
        type: string,
        data: Record<string, unknown>,
      ) => ({
        event_id: crypto.randomUUID(),
        run_id: id,
        sequence_number: sequence,
        monotonic_timestamp: 0,
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1 as const,
        type,
        data,
      });
      const snapshot: Snapshot = {
        run: {
          id,
          task: "go to youtube and play a midwest safety video",
          createdAt: new Date().toISOString(),
          status: "executing",
          privacy: "PRIVATE_LOCAL",
          provider: "openai",
          model: "gpt",
          synthetic: false,
          actions: 0,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "",
        events: [
          event(1, "StreamedStep", {
            kind: "open_url",
            siteKey: "youtube",
            clauseIndex: 1,
            outcome: "dropped",
          }),
          event(2, "ActionExecuted", {
            action: {
              type: "open_url",
              url: "https://www.youtube.com/results?search_query=midwest+safety",
              siteKey: "youtube",
              frame_id: "streamed",
            },
            streamed: true,
            early: true,
            clauseIndex: 1,
            outcome: "done",
          }),
          // The model's own open_url later: the same site, not early.
          event(3, "ActionExecuted", {
            action: {
              type: "open_url",
              url: "https://www.youtube.com/",
              siteKey: "youtube",
              frame_id: "f",
            },
            frame_id: "f",
          }),
        ],
      };
      log.snapshot(snapshot);
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(lines.map((x) => x.event)).toEqual([
        "StreamedStep",
        "ActionExecuted",
        "ActionExecuted",
        "RunState",
      ]);
      expect(lines[0].data).toMatchObject({
        kind: "open_url",
        siteKey: "youtube",
        clauseIndex: 1,
        outcome: "dropped",
      });
      expect(lines[1].data).toMatchObject({
        actionType: "open_url",
        streamed: true,
        early: true,
        siteKey: "youtube",
      });
      expect(lines[2].data).toMatchObject({
        actionType: "open_url",
        siteKey: "youtube",
      });
      expect(lines[2].data.streamed).toBeUndefined();
      expect(lines[2].data.early).toBeUndefined();
      expect(readFileSync(log.file, "utf8")).not.toMatch(
        /midwest|youtube\.com|https/,
      );
    }));
});

describe("the benchmark harness's browser quit", () => {
  it("keeps BrowserQuit's bundle id, flag and code, never a title, a URL or a sentence", () =>
    fixture((log) => {
      log.write("BrowserQuit", {
        browser: "com.apple.Safari",
        quit: true,
        code: "STILL_RUNNING",
        // Smuggled extras: never written, whatever a caller passes.
        title: "Sign in · benchnote1a2b",
        url: "http://127.0.0.1:47831/login",
        reason: "the password page was left focused",
      });
      // Only a bundle id, a boolean and a code pass through each field.
      log.write("BrowserQuit", {
        browser: "Safari, the one with the password page",
        quit: "yes",
        code: "it would not go",
      });
      log.write("BrowserQuit", { browser: "Safari", quit: false });
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data);
      expect(lines).toEqual([
        { browser: "com.apple.Safari", quit: true, code: "STILL_RUNNING" },
        {},
        { quit: false },
      ]);
      expect(readFileSync(log.file, "utf8")).not.toMatch(
        /benchnote|127\.0\.0\.1|password|would not go|Safari,/,
      );
    }));
});

/**
 * The run journal's rows are built from a per-event table
 * (electron/diagnostics.ts journalEvents): an event the table does not know
 * writes runId, sequence and synthetic alone, a listed event only its listed
 * keys, and a policy decision's reason travels as a code and a length. The
 * live trace of 2026-09-19 carried a correction's words and a control's
 * label because the app had been launched with COARENA_DIAGNOSTICS_VERBOSE=1,
 * the opt-in that records text; these cases pin the content-free default.
 */
describe("the journal's content-free rows", () => {
  const MARK = "ZEPHYRWORD";
  const journal = (
    events: { type: string; data: Record<string, unknown> }[],
    status: RunStatus = "executing",
  ): Snapshot => {
    const id = crypto.randomUUID();
    return {
      run: {
        id,
        task: `${MARK} task`,
        createdAt: new Date().toISOString(),
        status,
        privacy: "PRIVATE_LOCAL",
        provider: "openai",
        model: "fixture",
        synthetic: false,
        actions: 3,
        frames: 3,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        summary: `${MARK} summary`,
      },
      frame: null,
      message: `${MARK} message`,
      events: events.map((e, i) => ({
        event_id: crypto.randomUUID(),
        run_id: id,
        sequence_number: i + 1,
        monotonic_timestamp: 0,
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1,
        type: e.type,
        data: e.data,
      })),
    };
  };
  const rows = (log: LocalDiagnostics) =>
    readFileSync(log.file, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
  const base = (s: Snapshot, sequence: number) => ({
    runId: s.run!.id,
    sequence,
    synthetic: false,
  });

  it("writes a correction as its length and its place in the run, never its words or its clock", () =>
    fixture((log) => {
      const words = `${MARK} the other one, and stop after that please`;
      const s = journal([
        {
          type: "UserCorrectionRecorded",
          data: {
            text: words,
            after_action: 1,
            timestamp: "2026-09-20T02:43:32.797Z",
          },
        },
      ]);
      log.snapshot(s);
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain(MARK);
      expect(raw).not.toContain("02:43:32.797");
      const [row] = rows(log);
      expect(row.event).toBe("UserCorrectionRecorded");
      expect(row.data).toEqual({
        ...base(s, 1),
        textLength: words.length,
        after_action: 1,
      });
    }));

  it("writes an allowed step's reason as a code and a length, whether the runner stamped the code or not", () =>
    fixture((log) => {
      const label = `“${MARK} Confirm”: done without asking, as you set. Reported when done.`;
      const s = journal([
        // No stamp: the stream reads the code off the reason itself.
        { type: "PolicyAllowed", data: { reason: label, actionType: "click" } },
        {
          type: "PolicyAllowed",
          data: {
            reason: label,
            reasonCode: "ALLOWED_AUTONOMY_ALL",
            actionType: "click_control",
          },
        },
        {
          type: "PolicyAllowed",
          data: {
            reason: "Type in a known non-secure text field.",
            reasonCode: "TYPE_TEXT_FIELD",
          },
        },
        { type: "PolicyAllowed", data: { reason: "", reasonCode: "NONE" } },
        // A stamp that is not a code is dropped and the table decides.
        {
          type: "PolicyAllowed",
          data: { reason: label, reasonCode: `${MARK} is not a code` },
        },
      ]);
      log.snapshot(s);
      expect(readFileSync(log.file, "utf8")).not.toContain(MARK);
      const r = rows(log);
      expect(r[0].data).toEqual({
        ...base(s, 1),
        actionType: "click",
        reasonCode: "ALLOWED_AUTONOMY_ALL",
        reasonLength: label.length,
      });
      expect(r[1].data).toEqual({
        ...base(s, 2),
        actionType: "click_control",
        reasonCode: "ALLOWED_AUTONOMY_ALL",
        reasonLength: label.length,
      });
      expect(r[2].data).toEqual({
        ...base(s, 3),
        reasonCode: "TYPE_TEXT_FIELD",
        reasonLength: 38,
      });
      expect(r[3].data).toEqual({
        ...base(s, 4),
        reasonCode: "NONE",
        reasonLength: 0,
      });
      expect(r[4].data).toEqual({
        ...base(s, 5),
        reasonCode: "ALLOWED_AUTONOMY_ALL",
        reasonLength: label.length,
      });
    }));

  it("drops the whole payload of a journal event its table does not know", () =>
    fixture((log) => {
      const s = journal([
        {
          type: "SomethingNew",
          data: {
            text: MARK,
            reason: "deliverable_unchanged",
            code: "STATE_CHANGED",
            actionType: "click",
            count: 3,
            textLength: 4,
            nested: { code: "X", text: MARK },
          },
        },
      ]);
      log.snapshot(s);
      expect(readFileSync(log.file, "utf8")).not.toContain(MARK);
      const [row] = rows(log);
      expect(row.event).toBe("SomethingNew");
      expect(row.data).toEqual(base(s, 1));
    }));

  it("keeps only the type of a ProviderResponse's action object", () =>
    fixture((log) => {
      log.write("ProviderResponse", {
        attempt: 1,
        action: { type: "fail", reason: `${MARK} cannot`, frame_id: "f1" },
        durationMs: 12,
        actionType: "fail",
      });
      log.write("ProviderResponse", {
        attempt: 1,
        action: {
          type: "done",
          summary: `${MARK} summary`,
          note: `${MARK} note`,
          frame_id: "f1",
        },
        durationMs: 12,
      });
      log.write("ProviderResponse", {
        attempt: 1,
        action: {
          type: "open_url",
          url: `https://${MARK}.example/x`,
          path: `~/${MARK}.txt`,
          text: MARK,
          frame_id: "f1",
        },
        durationMs: 12,
      });
      // An action object without a type yields no type and nothing else.
      log.write("ProviderResponse", {
        attempt: 1,
        action: { reason: MARK },
        durationMs: 12,
      });
      expect(readFileSync(log.file, "utf8")).not.toContain(MARK);
      const r = rows(log);
      expect(r[0].data).toEqual({
        attempt: 1,
        durationMs: 12,
        actionType: "fail",
      });
      expect(r[1].data).toEqual({
        attempt: 1,
        durationMs: 12,
        actionType: "done",
      });
      expect(r[2].data).toEqual({
        attempt: 1,
        durationMs: 12,
        actionType: "open_url",
      });
      expect(r[3].data).toEqual({ attempt: 1, durationMs: 12 });
    }));

  it("writes a retarget's and a denial's reason as a code, never the sentence, and a person's decline as before", () =>
    fixture((log) => {
      const control = `No input was sent. Nothing in context.controls is named “${MARK}” now. If you can see it in the screenshot, click it by position with click(x,y) instead; otherwise take a fresh look. Do not repeat this name.`;
      const url =
        "No input was sent. Use a full http or https address without credentials.";
      const bound = `No input was sent. The step's target is not the “${MARK}” window this run is bound to; input goes only to that window.`;
      const credential = "Detected credentials cannot be typed by the agent.";
      const s = journal([
        {
          type: "ActionRetargetRequested",
          data: {
            actionType: "click_control",
            appId: "com.google.Chrome",
            focusedRole: "AXWebArea",
            reasonCode: "CONTROL_NOT_FOUND",
            reason: control,
          },
        },
        // No stamp: the code is read off the policy's sentence.
        {
          type: "ActionRetargetRequested",
          data: {
            actionType: "open_url",
            appId: "com.google.Chrome",
            reason: url,
          },
        },
        {
          type: "ActionRetargetRequested",
          data: { actionType: "tool_call", reasonCode: "TOOL_BAD_PATH" },
        },
        // A stamp that is not a code, with no reason to read: no code.
        {
          type: "ActionRetargetRequested",
          data: { actionType: "click", reasonCode: `${MARK} as a code` },
        },
        { type: "UserDenied", data: { reason: bound } },
        {
          type: "UserDenied",
          data: {
            reason: credential,
            reasonCode: "CREDENTIAL",
            actionType: "tool_call",
          },
        },
        {
          type: "UserDenied",
          data: { source: "pill", approvalCode: "CLICK_CONTROL" },
        },
      ]);
      log.snapshot(s);
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain(MARK);
      expect(raw).not.toContain("No input was sent");
      const r = rows(log);
      expect(r[0].data).toEqual({
        ...base(s, 1),
        actionType: "click_control",
        appId: "com.google.Chrome",
        focusedRole: "AXWebArea",
        reasonCode: "CONTROL_NOT_FOUND",
        reasonLength: control.length,
      });
      expect(r[1].data).toEqual({
        ...base(s, 2),
        actionType: "open_url",
        appId: "com.google.Chrome",
        reasonCode: "BAD_URL",
        reasonLength: url.length,
      });
      expect(r[2].data).toEqual({
        ...base(s, 3),
        actionType: "tool_call",
        reasonCode: "TOOL_BAD_PATH",
      });
      expect(r[3].data).toEqual({ ...base(s, 4), actionType: "click" });
      expect(r[4].data).toEqual({
        ...base(s, 5),
        reasonCode: "OUTSIDE_BOUND_WINDOW",
        reasonLength: bound.length,
      });
      expect(r[5].data).toEqual({
        ...base(s, 6),
        actionType: "tool_call",
        reasonCode: "CREDENTIAL",
        reasonLength: credential.length,
      });
      expect(r[6].data).toEqual({
        ...base(s, 7),
        source: "pill",
        approvalCode: "CLICK_CONTROL",
      });
    }));

  it("writes a run's start and ending, a step's failure, a proposed fail or done, a pause and a hand-off by their codes alone", () =>
    fixture((log) => {
      const s = journal(
        [
          {
            type: "RunStarted",
            data: {
              origin: "voice",
              privacy: "PRIVATE_BYOM",
              synthetic: false,
            },
          },
          {
            type: "ActionProposed",
            data: {
              action: { type: "fail", reason: `${MARK} why`, frame_id: "f" },
            },
          },
          {
            type: "ActionProposed",
            data: {
              action: { type: "done", summary: `${MARK} what`, frame_id: "f" },
            },
          },
          {
            type: "ActionFailed",
            data: {
              code: "INVALID_ACTION",
              cause: "SHAPE",
              message: `${MARK} m`,
            },
          },
          {
            type: "RunPaused",
            data: { reason: "control", message: `${MARK} paused` },
          },
          {
            type: "UserTakeoverStarted",
            data: {
              source: "policy",
              reason: `${MARK} take over`,
              scope: "screen",
            },
          },
          { type: "RunCompleted", data: { summary: `${MARK} done` } },
          {
            type: "RunFailed",
            data: { code: "RUN_ERROR", message: `${MARK} failed`, error: MARK },
          },
        ],
        "failed",
      );
      log.snapshot(s);
      const raw = readFileSync(log.file, "utf8");
      expect(raw).not.toContain(MARK);
      const r = rows(log);
      expect(r[0].data).toEqual({
        ...base(s, 1),
        origin: "voice",
        privacy: "PRIVATE_BYOM",
      });
      expect(r[1].data).toEqual({ ...base(s, 2), actionType: "fail" });
      expect(r[2].data).toEqual({ ...base(s, 3), actionType: "done" });
      expect(r[3].data).toEqual({ ...base(s, 4), code: "INVALID_ACTION" });
      expect(r[4].data).toEqual({ ...base(s, 5), reason: "control" });
      expect(r[5].data).toEqual({
        ...base(s, 6),
        source: "policy",
        scope: "screen",
      });
      expect(r[6].data).toEqual(base(s, 7));
      expect(r[7].data).toEqual({ ...base(s, 8), code: "RUN_ERROR" });
      // The failed run's state carries no task, message, summary or error.
      const state = r.at(-1)!;
      expect(state.event).toBe("RunState");
      expect(state.data.status).toBe("failed");
      for (const key of ["task", "message", "summary", "error", "corrections"])
        expect(state.data[key]).toBeUndefined();
    }));

  it("records a correction's words and a journal payload only under opt-in verbose debugging", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "assist-diagnostics-verbose-"),
    );
    try {
      const output: string[] = [];
      const log = new LocalDiagnostics(
        directory,
        () => [],
        (line) => output.push(line),
        undefined,
        true,
      );
      const s = journal([
        {
          type: "UserCorrectionRecorded",
          data: { text: `${MARK} words`, after_action: 1 },
        },
      ]);
      log.snapshot(s);
      const row = JSON.parse(output[0]);
      expect(row.event).toBe("UserCorrectionRecorded");
      // Verbose keeps the payload under data, as tonight's trace showed.
      expect(row.data.data.text).toBe(`${MARK} words`);
      expect(row.data.textLength).toBe(`${MARK} words`.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
