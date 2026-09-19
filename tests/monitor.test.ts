import { describe, it, expect } from "vitest";
import {
  BACKOFF_MAX_MS,
  FORBIDDEN_ALLOW_LABEL,
  MATERIAL_CHANGE,
  PROBE_FAILURE_LIMIT,
  RELAY_POLL_MS,
  RELAY_REPEAT_MS,
  UNKNOWN_TICK_LIMIT,
  digestPanel,
  fnv1a,
  inRegion,
  materialChange,
  newWatchMemory,
  normalizeOcr,
  panelColumn,
  panelRegion,
  panelState,
  panelTail,
  redactLines,
  resolveAgent,
  watchSpec,
  watchTick,
  type AgentId,
  type PanelDigest,
  type WatchMemory,
  type WatchSpec,
} from "../src/core/monitor";
import { cleanScreenContext } from "../src/core/context";
import { buildRequest } from "../src/providers/http";
import { playbookFor } from "../src/providers/playbooks";
import { defaultSettings, type OcrLine, type Frame } from "../src/core/schema";
import fixture from "./fixtures/ide-agents.json";

/** A panel line docked on the right of the window. */
const line = (t: string, y = 0.9, h = 0.02, x = 0.7, w = 0.25): OcrLine => ({
  t,
  x,
  y,
  w,
  h,
});
const lines = (...texts: string[]) =>
  texts.map((t, i) => line(t, 0.8 + i * 0.02));
const claude = {
  working: lines("Running npm test", "Queue another message…"),
  idle: lines("I updated the endpoint.", "Ask Claude to edit…"),
  permission: lines(
    "Do you want to proceed with Bash?",
    "npm test",
    "1. Yes",
    "2. Yes, and don't ask again",
    "3. No, tell Claude what to do instead",
    "Esc to interrupt",
  ),
  plan: lines("Ready to code?", "Yes, and auto-accept", "No, keep planning"),
  error: lines("Tool interrupted", "Ask Claude to edit…"),
  done: lines("Finished", "Ask Claude to edit…"),
  unknown: lines("export function foo() {}", "main.ts"),
};
const digest = (l: OcrLine[], agent: AgentId | undefined = "claude-code") =>
  digestPanel(l, agent);

describe("OCR normalization and anchors (shared with IdeSafety.swift)", () => {
  it("normalizes the way native does", () => {
    for (const c of fixture.ocrNormalization)
      expect([c.in, normalizeOcr(c.in)]).toEqual([c.in, c.out]);
  });
  it("reads every fixture panel as native does", () => {
    for (const c of fixture.agentStates) {
      const state = panelState(
        c.agent as AgentId,
        c.lines.map((l) => ({ t: normalizeOcr(l.t), y: l.y, h: l.h })),
      );
      expect([c.agent, c.lines.map((l) => l.t), state]).toEqual([
        c.agent,
        c.lines.map((l) => l.t),
        c.state,
      ]);
    }
  });
  it("lets a question win anywhere, but reads activity from the bottom first", () => {
    // An old "interrupted" in the transcript does not outrank the spinner.
    expect(
      panelState("claude-code", [
        { t: "interrupted", y: 0.1, h: 0.02 },
        { t: "queue another message...", y: 0.95, h: 0.02 },
      ]),
    ).toBe("working");
    expect(
      panelState("claude-code", [
        { t: "interrupted", y: 0.9, h: 0.02 },
        { t: "queue another message...", y: 0.95, h: 0.02 },
      ]),
    ).toBe("error");
    expect(
      panelState("claude-code", [
        { t: "do you want to proceed?", y: 0.1, h: 0.02 },
        { t: "queue another message...", y: 0.95, h: 0.02 },
      ]),
    ).toBe("needs_permission");
  });
  it("picks the agent from its anchors", () => {
    expect(resolveAgent(claude.working)).toBe("claude-code");
    expect(resolveAgent(lines("Run `npm test` command?", "Chat Input"))).toBe(
      "copilot",
    );
    expect(resolveAgent(claude.unknown)).toBeUndefined();
    expect(resolveAgent([])).toBeUndefined();
  });
});

describe("panel column", () => {
  it("runs from a right-docked panel's margin to the window's edge", () => {
    expect(panelColumn(claude.working)).toEqual({
      x: 0.67,
      y: 0,
      w: 0.33,
      h: 1,
    });
  });
  it("covers a left-docked panel up to just past its anchors", () => {
    const left = claude.idle.map((l) => ({ ...l, x: 0.05, w: 0.3 }));
    const region = panelColumn(left);
    expect(region).toBeDefined();
    expect(region!.x).toBe(0);
    expect(region!.w).toBeCloseTo(0.4);
  });
  it("keeps a band around the anchors of a panel with no column, and nothing of a window without anchors", () => {
    // Docked at the bottom: the anchors run the window's width.
    const wide = (t: string, y: number): OcrLine => line(t, y, 0.02, 0.1, 0.8);
    const bottom = [
      wide("const token = 'editor text'", 0.2),
      wide("Running npm test", 0.85),
      wide("Queue another message…", 0.9),
    ];
    expect(panelColumn(bottom, "claude-code")).toBeUndefined();
    // A few rows above the topmost anchor (the spinner line) to just below it.
    expect(panelRegion(bottom, "claude-code")).toEqual({
      x: 0,
      y: 0.75,
      w: 1,
      h: 0.22,
    });
    expect(
      digestPanel(bottom, "claude-code", panelRegion(bottom, "claude-code"))
        .lines,
    ).toEqual(["running npm test", "queue another message..."]);
    // The band is clamped to the window.
    expect(
      panelRegion([wide("Esc to interrupt", 0.05)], "claude-code"),
    ).toEqual({ x: 0, y: 0, w: 1, h: 0.12 });
    // A side-docked panel still gets its column.
    expect(panelRegion(claude.working, "claude-code")).toEqual(
      panelColumn(claude.working, "claude-code"),
    );
    expect(panelRegion(claude.unknown, "claude-code")).toBeUndefined();
    expect(panelRegion(claude.unknown)).toBeUndefined();
  });
  it("reads the whole window when the anchors are mid-window or absent", () => {
    expect(
      panelColumn(claude.idle.map((l) => ({ ...l, x: 0.3, w: 0.35 }))),
    ).toBeUndefined();
    expect(panelColumn(claude.unknown)).toBeUndefined();
    expect(panelColumn([])).toBeUndefined();
  });
  it("keeps a line that starts inside the column and drops the editor's", () => {
    const region = panelColumn(claude.working)!;
    expect(inRegion(line("Ask Claude to edit…", 0.9, 0.02, 0.72), region)).toBe(
      true,
    );
    expect(inRegion(line("export const x = 1", 0.5, 0.02, 0.1), region)).toBe(
      false,
    );
    expect(inRegion(line("anything", 0.5, 0.02, 0.1), undefined)).toBe(true);
  });
});

describe("digest and change", () => {
  it("hashes the panel's normalized lines deterministically", () => {
    expect(fnv1a("a")).toBe(fnv1a("a"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
    expect(fnv1a("")).toMatch(/^[0-9a-f]{8}$/);
    const a = digest(claude.working),
      b = digest(claude.working.map((l) => ({ ...l, t: l.t.toUpperCase() })));
    expect(a.hash).toBe(b.hash);
    expect(digest(claude.idle).hash).not.toBe(a.hash);
  });
  it("only digests lines inside the column", () => {
    const region = panelColumn(claude.working)!;
    const withEditor = [
      line("export const secret = 1", 0.5, 0.02, 0.1),
      ...claude.working,
    ];
    const d = digestPanel(withEditor, "claude-code", region);
    expect(d.lines).toEqual(claude.working.map((l) => normalizeOcr(l.t)));
    expect(d.text).not.toContain("secret");
    expect(d.region).toEqual(region);
  });
  it("measures a material change as the share of lines that differ", () => {
    expect(materialChange([], [])).toBe(0);
    expect(materialChange(["a", "b"], ["a", "b"])).toBe(0);
    expect(materialChange(["a", "b"], ["c", "d"])).toBe(1);
    expect(materialChange(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(0.5);
    expect(MATERIAL_CHANGE).toBe(0.15);
  });
  it("reads the permission mode from the panel", () => {
    expect(
      digest(lines("Bypass permissions", "Ask Claude to edit…")).mode,
    ).toBe("auto");
    expect(digest(lines("Plan mode", "Ask Claude to edit…")).mode).toBe("ask");
    expect(digest(claude.idle).mode).toBe("unknown");
  });
  it("knows no state without an agent", () => {
    expect(digestPanel(claude.working, undefined).state).toBe("unknown");
    expect(digestPanel(claude.permission, undefined).relay).toBeUndefined();
  });
});

describe("relay candidates", () => {
  it("extracts a Claude Code command question with its one-use answer", () => {
    const relay = digest(claude.permission).relay!;
    expect(relay.kind).toBe("command");
    expect(relay.question).toBe("do you want to proceed with bash? npm test");
    expect(relay.allowLabel).toBe("Yes");
    expect(relay.decline).toEqual({ type: "key", key: "ESC" });
    expect(relay.key).toMatch(/^[0-9a-f]{8}$/);
    expect(digest(claude.permission).relay!.key).toBe(relay.key);
  });
  it("names the plan answers and Copilot's routes", () => {
    const plan = digest(claude.plan).relay!;
    expect(plan.kind).toBe("plan");
    expect(plan.allowLabel).toBe("Yes, and manually approve edits");
    expect(plan.decline).toEqual({
      type: "click_text",
      label: "No, keep planning",
    });
    const run = digestPanel(
      lines("Run `npm test` command?", "Allow", "Skip"),
      "copilot",
    ).relay!;
    expect([run.kind, run.allowLabel, run.decline]).toEqual([
      "command",
      "Allow",
      { type: "click_text", label: "Skip" },
    ]);
    const more = digestPanel(
      lines("Continue to iterate?", "Continue"),
      "copilot",
    ).relay!;
    expect([more.kind, more.allowLabel, more.decline]).toEqual([
      "continue",
      "Continue",
      { type: "none" },
    ]);
    const review = digestPanel(
      lines("Keep All Edits", "Undo All Edits"),
      "copilot",
    ).relay!;
    expect([review.kind, review.allowLabel, review.decline]).toEqual([
      "review",
      "Keep",
      { type: "none" },
    ]);
  });
  it("never offers a label that grants more than one use", () => {
    for (const label of fixture.forbiddenAllowLabels)
      expect([label, FORBIDDEN_ALLOW_LABEL.test(label.toLowerCase())]).toEqual([
        label,
        true,
      ]);
    for (const label of fixture.allowedAllowLabels)
      expect([label, FORBIDDEN_ALLOW_LABEL.test(label.toLowerCase())]).toEqual([
        label,
        false,
      ]);
    for (const l of [claude.permission, claude.plan])
      expect(
        FORBIDDEN_ALLOW_LABEL.test(digest(l).relay!.allowLabel.toLowerCase()),
      ).toBe(false);
  });
  it("redacts and bounds the question", () => {
    const relay = digest(
      lines(
        "api_key=sk-fixtureSECRET1234567890abcdef",
        "Do you want to proceed with Bash?",
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://x.test",
        "1. Yes",
      ),
    ).relay!;
    expect(relay.question).not.toContain("fixtureSECRET");
    expect(relay.question.length).toBeLessThanOrEqual(160);
    const long = digest(
      lines("x".repeat(190), "Do you want to proceed?", "1. Yes"),
    ).relay!;
    expect(long.question.length).toBe(160);
  });
  it("has no relay while the agent works or is idle", () => {
    expect(digest(claude.working).relay).toBeUndefined();
    expect(digest(claude.idle).relay).toBeUndefined();
  });
});

describe("watch spec", () => {
  it("converts the action's units and redacts the reason", () => {
    expect(
      watchSpec({
        reason: "wait for the tests password=hunter2-SECRET",
        every_s: 10,
        max_min: 20,
        until: "done",
      }),
    ).toMatchObject({ everyMs: 10000, maxMs: 1200000, until: "done" });
    expect(
      watchSpec({ reason: "x", every_s: 5, max_min: 1, until: "change" })
        .reason,
    ).toBe("x");
    expect(
      watchSpec({
        reason: "token=sk-fixtureSECRET1234567890abcdef",
        every_s: 5,
        max_min: 1,
        until: "change",
      }).reason,
    ).not.toContain("fixtureSECRET");
  });
});

describe("watch tick", () => {
  const start = 1_000_000;
  const spec: WatchSpec = {
    reason: "tests",
    everyMs: 10000,
    maxMs: 30 * 60000,
    until: "done",
  };
  const settings = {
    progressEveryMinutes: 10,
    stallMinutes: 8,
    watchMaxMinutes: 120,
  };
  /**
   * Runs digests in order, ten seconds apart, and returns every tick. A
   * continued run (from, at) picks up a memory and its clock.
   */
  function run(
    steps: (PanelDigest | undefined)[],
    o: {
      spec?: Partial<WatchSpec>;
      every?: number;
      from?: WatchMemory;
      at?: number;
    } = {},
    s = settings,
  ) {
    const full = { ...spec, ...o.spec };
    let memory = o.from ?? newWatchMemory(start);
    const ticks = [];
    let now = o.at ?? start;
    for (const d of steps) {
      now += o.every ?? full.everyMs;
      const t = watchTick(memory, d, now, full, s);
      memory = t.memory;
      ticks.push(t);
    }
    return { ticks, memory, now, last: ticks.at(-1)! };
  }
  const working = digest(claude.working),
    idle = digest(claude.idle),
    permission = digest(claude.permission),
    unknown = digest(claude.unknown);

  it("never mutates the memory it is given", () => {
    const memory = newWatchMemory(start);
    const before = structuredClone(memory);
    watchTick(memory, working, start + 10000, spec, settings);
    expect(memory).toEqual(before);
  });
  it("wakes with expired at the spec's cap or the setting's, whichever is sooner", () => {
    const memory = newWatchMemory(start);
    expect(
      watchTick(memory, working, start + spec.maxMs, spec, settings).decision,
    ).toEqual({ kind: "wake", cause: "expired" });
    expect(
      watchTick(memory, working, start + spec.maxMs - 1, spec, settings)
        .decision,
    ).not.toEqual({ kind: "wake", cause: "expired" });
    expect(
      watchTick(memory, working, start + 5 * 60000, spec, {
        ...settings,
        watchMaxMinutes: 5,
      }).decision,
    ).toEqual({ kind: "wake", cause: "expired" });
  });
  it("gives up after three failed reads in a row, and a good read resets", () => {
    expect(PROBE_FAILURE_LIMIT).toBe(3);
    const two = run([undefined, undefined]);
    expect(two.ticks.map((t) => t.decision.kind)).toEqual(["sleep", "sleep"]);
    expect(run([undefined, undefined, undefined]).last.decision).toEqual({
      kind: "wake",
      cause: "probe_failed",
    });
    expect(
      run([undefined, undefined, working, undefined, undefined]).last.decision
        .kind,
    ).toBe("sleep");
  });
  it("wakes done once the agent was seen working and then idle twice", () => {
    const one = run([working, idle]);
    expect(one.last.decision.kind).toBe("sleep");
    expect(one.last.stateChanged).toEqual({ from: "working", to: "idle" });
    expect(run([working, idle, idle]).last.decision).toEqual({
      kind: "wake",
      cause: "done",
    });
    // "until input" names the same moment differently.
    expect(
      run([working, idle, idle], { spec: { until: "input" } }).last.decision,
    ).toEqual({ kind: "wake", cause: "idle" });
  });
  it("needs a full minute of idle when the agent was never seen working", () => {
    expect(run(Array(5).fill(idle)).last.decision.kind).toBe("sleep");
    expect(run(Array(6).fill(idle)).last.decision).toEqual({
      kind: "wake",
      cause: "done",
    });
  });
  it("wakes at once on a finished or failed panel", () => {
    expect(run([working, digest(claude.done)]).last.decision).toEqual({
      kind: "wake",
      cause: "done",
    });
    expect(run([working, digest(claude.error)]).last.decision).toEqual({
      kind: "wake",
      cause: "error",
    });
  });
  it("wakes on a material change only when asked to, after a baseline", () => {
    const change = { spec: { until: "change" as const } };
    const first = run([working], change);
    expect(first.last.decision.kind).toBe("sleep");
    expect(first.last.changed).toBe(false);
    expect(run([working, idle], change).last.decision).toEqual({
      kind: "wake",
      cause: "changed",
    });
    const many = lines(...Array.from({ length: 20 }, (_, i) => `line ${i}`));
    const slight = digest([...many, line("one more line", 0.5)]);
    const small = run([digest(many), slight], change);
    expect(small.last.decision.kind).toBe("sleep");
    // Without "until change", the same change is just a change.
    const plain = run([working, idle]);
    expect(plain.last.changed).toBe(true);
    expect(plain.last.decision.kind).toBe("sleep");
  });
  it("tells the model after three unreadable panels, unless watching by the clock or for a change", () => {
    expect(UNKNOWN_TICK_LIMIT).toBe(3);
    expect(run([unknown, unknown]).last.decision.kind).toBe("sleep");
    expect(run([unknown, unknown, unknown]).last.decision).toEqual({
      kind: "wake",
      cause: "unknown",
    });
    expect(
      run(Array(10).fill(unknown), { spec: { timersOnly: true } }).last.decision
        .kind,
    ).toBe("sleep");
    // A build, a download or a render has no agent to read: only the change
    // asked for, or the clock, wakes the model.
    const change = run(Array(6).fill(digest(claude.unknown, undefined)), {
      spec: { until: "change" },
    });
    expect(change.ticks.map((t) => t.decision.kind)).toEqual(
      Array(6).fill("sleep"),
    );
    expect(
      run(Array(4).fill(unknown), { spec: { until: "change" } }).last.decision
        .kind,
    ).toBe("sleep");
  });
  it("surfaces a question once, polls it quickly, and notes when it is answered", () => {
    const asked = run([working, permission]);
    expect(asked.last.decision).toEqual({
      kind: "relay",
      relay: permission.relay,
    });
    const again = watchTick(
      asked.memory,
      permission,
      asked.now + RELAY_POLL_MS,
      spec,
      settings,
    );
    expect(again.decision).toEqual({ kind: "sleep", nextMs: RELAY_POLL_MS });
    const answered = watchTick(
      again.memory,
      working,
      asked.now + 2 * RELAY_POLL_MS,
      spec,
      settings,
    );
    expect(answered.relayGone).toBe(permission.relay!.key);
    expect(answered.decision.kind).toBe("sleep");
    // The same question soon after is not repeated; after two minutes it is.
    const soon = watchTick(
      answered.memory,
      permission,
      asked.now + RELAY_REPEAT_MS - 1,
      spec,
      settings,
    );
    expect(soon.decision.kind).toBe("sleep");
    const later = watchTick(
      answered.memory,
      permission,
      asked.now + RELAY_REPEAT_MS,
      spec,
      settings,
    );
    expect(later.decision.kind).toBe("relay");
  });
  it("keeps one question on screen as one question, however long it waits", () => {
    const asked = run([working, permission]);
    const long = run(Array(40).fill(permission), {
      from: asked.memory,
      every: RELAY_POLL_MS,
      at: asked.now,
    });
    expect(long.now - asked.now).toBeGreaterThan(RELAY_REPEAT_MS);
    expect(long.ticks.every((t) => t.decision.kind === "sleep")).toBe(true);
  });
  it("a pending question outranks the end states", () => {
    const asked = run([working, permission]);
    expect(
      watchTick(
        asked.memory,
        permission,
        asked.now + spec.maxMs,
        spec,
        settings,
      ).decision,
    ).toEqual({ kind: "wake", cause: "expired" });
    // Still asking: no done wake even after many quiet ticks.
    const quiet = run(Array(8).fill(permission), {
      from: asked.memory,
      at: asked.now,
    });
    expect(quiet.ticks.every((t) => t.decision.kind === "sleep")).toBe(true);
  });
  it("reports a stall once, then wakes after as long again, and a change resets it", () => {
    // No progress summaries here, so the only summary is the stall's.
    const quiet = { ...settings, progressEveryMinutes: 0 };
    const stallMs = settings.stallMinutes * 60000;
    const ticks = Math.ceil(stallMs / spec.everyMs);
    const stalled = run(Array(ticks + 1).fill(working), {}, quiet);
    expect(stalled.last.decision).toEqual({
      kind: "summary",
      progress: "stalled",
    });
    expect(
      stalled.ticks.filter((t) => t.decision.kind === "summary"),
    ).toHaveLength(1);
    const after = run(
      Array(ticks + 1).fill(working),
      { from: stalled.memory, at: stalled.now },
      quiet,
    );
    expect(after.ticks.some((t) => t.decision.kind === "summary")).toBe(false);
    expect(after.last.decision).toEqual({ kind: "wake", cause: "stalled" });
    // A change before the second stall starts over.
    const changed = run(
      [digest(lines("Editing users.ts", "Queue another message…"))],
      { from: stalled.memory, at: stalled.now },
      quiet,
    );
    expect(changed.memory.stalledReportedAt).toBeUndefined();
    expect(changed.memory.lastChangeAt).toBe(changed.now);
  });
  it("offers a summary at five minutes and then every progressEveryMinutes, only on a change", () => {
    const fresh = (i: number) =>
      digest(lines(`Editing file${i}.ts`, "Queue another message…"));
    // A long stall allowance, so only the progress cadence speaks here.
    const patient = { ...settings, stallMinutes: 60 };
    const step = (from: WatchMemory, at: number, d: PanelDigest) =>
      watchTick(from, d, at, spec, patient);
    let m = newWatchMemory(start);
    let t = step(m, start + 4 * 60000, fresh(1));
    expect(t.decision.kind).toBe("sleep");
    t = step(t.memory, start + 5 * 60000, fresh(2));
    expect(t.decision).toEqual({ kind: "summary", progress: "summary" });
    // Changed, but not due yet.
    t = step(t.memory, start + 9 * 60000, fresh(3));
    expect(t.decision.kind).toBe("sleep");
    // Due, and changed since the last summary.
    t = step(t.memory, start + 15 * 60000, fresh(3));
    expect(t.decision).toEqual({ kind: "summary", progress: "summary" });
    // Due again, but nothing changed since that one.
    t = step(t.memory, start + 25 * 60000, fresh(3));
    expect(t.decision.kind).toBe("sleep");
    t = step(t.memory, start + 25 * 60000 + 10000, fresh(4));
    expect(t.decision).toEqual({ kind: "summary", progress: "summary" });
    m = newWatchMemory(start);
    expect(
      watchTick(m, fresh(1), start + 5 * 60000, spec, {
        ...settings,
        progressEveryMinutes: 0,
      }).decision.kind,
    ).toBe("sleep");
  });
  it("backs off while a working panel does not change, up to 30 s, and resets on change", () => {
    expect(BACKOFF_MAX_MS).toBe(30000);
    const quiet = run(Array(6).fill(working));
    const waits = quiet.ticks.map((t) =>
      t.decision.kind === "sleep" ? t.decision.nextMs : -1,
    );
    expect(waits).toEqual([10000, 10000, 10000, 20000, 30000, 30000]);
    const moved = run(
      [digest(lines("Editing x.ts", "Queue another message…"))],
      { from: quiet.memory, at: quiet.now },
    );
    expect(moved.last.decision).toEqual({ kind: "sleep", nextMs: 10000 });
    // Idle panels are not backed off: the end may be one tick away.
    expect(run(Array(5).fill(idle)).last.decision).toEqual({
      kind: "sleep",
      nextMs: 10000,
    });
  });
});

describe("what leaves the watch", () => {
  it("bounds and redacts the panel tail", () => {
    const tail = panelTail(["password=hunter2-SECRET-value", "x".repeat(2000)]);
    expect(tail.length).toBe(1500);
    expect(tail).not.toContain("SECRET");
    expect(panelTail(["a", "b"])).toBe("a\nb");
  });
  it("bounds context.watch like the rest of the screen context", () => {
    const clean = cleanScreenContext({
      appName: "Code",
      windowTitle: "x",
      watch: {
        cause: "done",
        agent: "claude-code",
        state: "idle",
        minutes: 34,
        lastChangeMinutes: 1,
        steps: [
          "opened Code",
          "token=sk-fixtureSECRET1234567890abcdef",
          "z".repeat(300),
        ],
        panelText: "token=sk-fixtureSECRET1234567890abcdef " + "y".repeat(2000),
      },
    });
    expect(clean!.watch!.steps).toHaveLength(3);
    expect(clean!.watch!.steps![0]).toBe("opened Code");
    expect(clean!.watch!.steps![1]).not.toContain("fixtureSECRET");
    expect(clean!.watch!.steps![2]).toHaveLength(120);
    expect(clean?.watch).toMatchObject({
      cause: "done",
      agent: "claude-code",
      state: "idle",
      minutes: 34,
      lastChangeMinutes: 1,
    });
    expect(clean!.watch!.panelText!.length).toBeLessThanOrEqual(1500);
    expect(clean!.watch!.panelText).not.toContain("fixtureSECRET");
    expect(
      cleanScreenContext({
        appName: "Code",
        windowTitle: "x",
        watch: {
          cause: "done",
          state: "idle",
          minutes: 1,
          lastChangeMinutes: 0,
          extra: 1,
        },
      }),
    ).toBeUndefined();
    expect(
      cleanScreenContext({ appName: "Code", windowTitle: "x" })?.watch,
    ).toBeUndefined();
  });
  it("tells the model about monitor, context.watch and open_file's app", () => {
    const frame: Frame = {
      id: "0A1B2C3D-4e5f-6789-abcd-ef0123456789",
      sha256: "s",
      image: "data:image/png;base64,QUJD",
      geometry: {
        display_id: 1,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        native_width: 100,
        native_height: 100,
        model_width: 100,
        model_height: 100,
        scale_factor: 1,
      },
      capturedAt: 0,
      synthetic: false,
      context: {
        appName: "Code",
        windowTitle: "x",
        watch: {
          cause: "done",
          state: "idle",
          minutes: 3,
          lastChangeMinutes: 0,
        },
      },
    };
    const request = buildRequest(
      {
        ...defaultSettings,
        privacy: "PRIVATE_BYOM",
        provider: "openai",
        endpoint: "https://api.openai.com",
      },
      "K",
      { task: "watch it", frame, history: [] },
    );
    const instruction: string = request.body.instructions;
    // After the first paragraph, and the action list keeps its old entry.
    const paragraphs = instruction.split("\n");
    expect(paragraphs[1]).toContain("monitor(reason, every_s, max_min, until)");
    expect(paragraphs[1]).toContain("context.watch.panelText");
    expect(paragraphs[1]).toContain(
      "Never answer a coding agent's permission questions yourself",
    );
    expect(paragraphs[1]).toContain(
      "open_file(path) also takes an optional app",
    );
    expect(instruction).toContain("open_file(path)");
    expect(instruction).toContain(
      "monitor(reason, every_s 5-60, max_min 1-180, until 'done'|'input'|'change')",
    );
    // The watch context is a step detail: it follows the image, after the
    // workspace part.
    const context = JSON.parse(request.body.input[0].content[2].text);
    expect(context.context.watch).toEqual({
      cause: "done",
      state: "idle",
      minutes: 3,
      lastChangeMinutes: 0,
    });
    const editor = playbookFor("com.microsoft.VSCode").join(" ");
    expect(editor).toContain("monitor");
    expect(editor).toContain("open_file(path, app)");
    expect(editor).toMatch(/never press Yes, Allow/i);
    // Increment 1A's rules survive the new lines.
    expect(editor).toContain(
      "Type only into a box the editor's own command just opened",
    );
    expect(editor).toContain("save with CMD+S only when the objective asks");
    expect(editor).toContain("CMD+SHIFT+F");
    // A wake-up run hears that its objective was carried out already.
    expect(paragraphs[1]).toContain(
      "the objective quotes the earlier request, which the run that started the watch already carried out: never repeat its steps",
    );
  });
  it("redacts secrets as read, before lowercasing hides them", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const google = "AIzaSyD-fixture0123456789abcdefghijklmn";
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
      "QyNTUxOQAAACDfixturebodyline2xxxxxxxxxxxxxx",
      "-----END OPENSSH PRIVATE KEY-----",
    ];
    // The line count stays, so each line keeps its box.
    const redacted = redactLines(["ok", key, ...pem, google, "after"]);
    expect(redacted).toHaveLength(8);
    expect(redacted[0]).toBe("ok");
    expect(redacted.join("\n")).not.toMatch(/AKIA|AIza|BEGIN|b3Blbn|QyNTUx/);
    expect(redacted[7]).toBe("after");
    const panel = digest(
      lines(
        "Do you want to proceed with Bash?",
        `aws configure set aws_access_key_id ${key}`,
        pem[0],
        pem[1],
        pem[2],
        pem[3],
        `export GOOGLE_KEY=${google}`,
        "1. Yes",
        "Esc to interrupt",
      ),
    );
    const out = [
      panel.text,
      panel.relay?.question ?? "",
      panelTail(panel.lines),
    ]
      .join("\n")
      .toLowerCase();
    for (const secret of [key, google, pem[1], pem[2]])
      expect(out).not.toContain(secret.toLowerCase());
    expect(panel.relay?.question).toContain(
      "aws configure set aws_access_key_id",
    );
    expect(panel.state).toBe("needs_permission");
  });
});
