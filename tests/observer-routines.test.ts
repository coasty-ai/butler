/**
 * Replication and improvement (.data/design/observer.md §5): the pure
 * routine rules (due by weekday and hour window once a day, triggers, the
 * evidence loop's confidence moves and the two-corrections rule, the task
 * text and the offer sentence), the owner's decisions (approval → Skill /
 * schedule, Not this, Never), the scheduler with fakes (windows, the
 * presence and typing gates, one run at a time, the outcome recorded from
 * the snapshot, an undo counted), and the observer service (the setting
 * pushed to the stream, pause and resume, events to the log, the offer once
 * a day and never during a run, the menu label and status).
 */
import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  type Settings,
  type Snapshot,
} from "../src/core/schema";
import { emptyMemory, MemoryStore } from "../src/memory/store";
import type { MemoryData, Procedure, Routine } from "../src/memory/types";
import { matchSkill, replayable, toPlan } from "../src/memory/skills";
import {
  applyOutcome,
  applyOutcomeIn,
  CORRECTIONS_TO_PROPOSE,
  dueRoutines,
  inWindow,
  isDue,
  markRunIn,
  MIN_RUN_CONFIDENCE,
  offerSentence,
  OUTCOME_DELTA,
  outcomeOf,
  routineTask,
  triggeredBy,
  weekdaysPhrase,
} from "../src/observer/routines";
import {
  decideProposalIn,
  learnedProposals,
  procedureToSkill,
} from "../src/observer/proposals";
import { createRoutineScheduler } from "../electron/routines";
import { createObserver, OBSERVE_EVERY_MS } from "../electron/observer";
import type { WorkLog } from "../src/observer/log";
import type { Consolidator } from "../src/observer/consolidate";
import { emptyDayDigest } from "../src/observer/types";

const MON_9 = new Date(2026, 8, 14, 9, 15); // Monday
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "routine-1",
  kind: "routine",
  name: "Morning check-in",
  tokens: ["morning", "slack", "mail"],
  when: { weekdays: [1, 2, 3, 4, 5], hourRange: [9, 10] },
  steps: [
    { appId: "com.tinyspeck.slackmacgap", appName: "Slack" },
    { appId: "com.apple.mail", appName: "Mail" },
    { appId: "com.apple.Safari", appName: "Safari", host: "youtube.com" },
  ],
  seen: 4,
  firstSeen: "2026-09-08T00:00:00.000Z",
  lastSeen: "2026-09-11T00:00:00.000Z",
  confidence: 0.7,
  status: "approved",
  runs: { completed: 0, corrected: 0, undone: 0, declined: 0, failed: 0 },
  correctionStreak: 0,
  ...over,
});
const procedure = (over: Partial<Procedure> = {}): Procedure => ({
  id: "proc-1",
  kind: "procedure",
  trigger: "file the receipt from {slot0}",
  tokens: ["file", "receipt"],
  slots: ["slot0"],
  steps: [
    { action: { type: "open_app", name: "Finder" } },
    {
      action: { type: "click_control", label: "Receipts" },
      target: { role: "AXStaticText", label: "Receipts" },
      expectAppId: "com.apple.finder",
    },
  ],
  observedRuns: 4,
  lastSeen: "2026-09-11T00:00:00.000Z",
  confidence: 0.6,
  status: "proposed",
  ...over,
});
const withRoutines = (...routines: Routine[]): MemoryData => ({
  ...emptyMemory(),
  routines,
});

describe("due and triggered", () => {
  it("is due inside its weekday and hour window, once a day, approved and confident", () => {
    expect(inWindow(routine(), MON_9)).toBe(true);
    expect(inWindow(routine(), new Date(2026, 8, 14, 10, 0))).toBe(false);
    expect(inWindow(routine(), new Date(2026, 8, 14, 8, 59))).toBe(false);
    expect(inWindow(routine(), new Date(2026, 8, 13, 9, 30))).toBe(false); // Sunday
    expect(isDue(routine(), MON_9)).toBe(true);
    expect(isDue(routine({ status: "proposed" }), MON_9)).toBe(false);
    expect(isDue(routine({ status: "retired" }), MON_9)).toBe(false);
    expect(
      isDue(routine({ confidence: MIN_RUN_CONFIDENCE - 0.01 }), MON_9),
    ).toBe(false);
    expect(
      isDue(
        routine({ lastRunAt: new Date(2026, 8, 14, 9, 2).toISOString() }),
        MON_9,
      ),
    ).toBe(false);
    expect(
      isDue(
        routine({ lastRunAt: new Date(2026, 8, 13, 9, 2).toISOString() }),
        MON_9,
      ),
    ).toBe(true);
    const data = withRoutines(
      routine({ id: "a", confidence: 0.5 }),
      routine({ id: "b", confidence: 0.9 }),
      routine({ id: "c", status: "proposed" }),
    );
    expect(dueRoutines(data, MON_9).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("answers triggers: the name said, the Mac unlocked or the first app launched inside the window", () => {
    const r = routine();
    expect(
      triggeredBy(r, { kind: "spoken", text: "Morning check-in" }, MON_9),
    ).toBe(true);
    expect(
      triggeredBy(
        r,
        { kind: "spoken", text: "please run my morning check-in" },
        MON_9,
      ),
    ).toBe(true);
    expect(triggeredBy(r, { kind: "spoken", text: "open slack" }, MON_9)).toBe(
      false,
    );
    // Said by name outside the window still counts; the owner asked.
    expect(
      triggeredBy(
        r,
        { kind: "spoken", text: "morning check-in" },
        new Date(2026, 8, 14, 15),
      ),
    ).toBe(true);
    expect(triggeredBy(r, { kind: "unlocked" }, MON_9)).toBe(true);
    expect(
      triggeredBy(r, { kind: "unlocked" }, new Date(2026, 8, 14, 15)),
    ).toBe(false);
    expect(
      triggeredBy(
        r,
        { kind: "app_launched", appId: "com.tinyspeck.slackmacgap" },
        MON_9,
      ),
    ).toBe(true);
    expect(
      triggeredBy(r, { kind: "app_launched", appId: "com.apple.mail" }, MON_9),
    ).toBe(false);
    expect(
      triggeredBy(routine({ status: "proposed" }), { kind: "unlocked" }, MON_9),
    ).toBe(false);
    expect(
      triggeredBy(
        routine({ lastRunAt: MON_9.toISOString() }),
        { kind: "spoken", text: "morning check-in" },
        MON_9,
      ),
    ).toBe(false);
  });
});

describe("the evidence loop", () => {
  it("moves confidence by outcome and counts the replay", () => {
    const r = routine({ confidence: 0.5 });
    const done = applyOutcome(r, "completed", MON_9);
    expect(done.confidence).toBeCloseTo(0.5 + OUTCOME_DELTA.completed);
    expect(done.runs.completed).toBe(1);
    expect(r.runs.completed).toBe(0); // the input is untouched
    expect(applyOutcome(r, "corrected", MON_9).confidence).toBeCloseTo(0.35);
    expect(applyOutcome(r, "undone", MON_9).confidence).toBeCloseTo(0.2);
    expect(applyOutcome(r, "declined", MON_9).confidence).toBeCloseTo(0.4);
    expect(applyOutcome(r, "failed", MON_9).confidence).toBeCloseTo(0.35);
    expect(
      applyOutcome(routine({ confidence: 0.95 }), "completed", MON_9)
        .confidence,
    ).toBe(1);
    expect(
      applyOutcome(routine({ confidence: 0.1 }), "undone", MON_9).confidence,
    ).toBe(0);
  });

  it("sends an approved routine back to proposed after two corrections in a row, corrections attached", () => {
    let r = routine();
    r = applyOutcome(r, "corrected", MON_9, ["use Chrome, not Safari"]);
    expect(r.status).toBe("approved");
    expect(r.correctionStreak).toBe(1);
    expect(r.corrections).toEqual(["use Chrome, not Safari"]);
    // A completed replay in between resets the streak.
    const reset = applyOutcome(r, "completed", MON_9);
    expect(reset.correctionStreak).toBe(0);
    expect(applyOutcome(reset, "corrected", MON_9).status).toBe("approved");
    r = applyOutcome(r, "corrected", MON_9, [
      `token sk-${"x".repeat(40)} in the note`,
    ]);
    expect(CORRECTIONS_TO_PROPOSE).toBe(2);
    expect(r.status).toBe("proposed");
    expect(r.correctionStreak).toBe(0);
    expect(r.corrections).toHaveLength(2);
    expect(r.corrections![1]).not.toContain("sk-");
    expect(r.runs.corrected).toBe(2);
    // An undo counts toward the streak too.
    const undone = applyOutcome(
      applyOutcome(routine(), "undone", MON_9),
      "corrected",
      MON_9,
    );
    expect(undone.status).toBe("proposed");
    // In place: applyOutcomeIn and markRunIn.
    const data = withRoutines(routine());
    expect(
      applyOutcomeIn(data, "routine-1", "completed", MON_9)?.runs.completed,
    ).toBe(1);
    expect(applyOutcomeIn(data, "missing", "completed", MON_9)).toBeUndefined();
    expect(markRunIn(data, "routine-1", MON_9)?.lastRunAt).toBe(
      MON_9.toISOString(),
    );
  });

  it("reads a finished run's outcome", () => {
    expect(outcomeOf({ status: "completed" })).toBe("completed");
    expect(
      outcomeOf({ status: "completed", corrections: [{ text: "no" }] }),
    ).toBe("corrected");
    expect(outcomeOf({ status: "cancelled" })).toBe("declined");
    expect(outcomeOf({ status: "failed" })).toBe("failed");
    expect(outcomeOf({ status: "executing" })).toBeUndefined();
  });

  it("words the task text and the offer", () => {
    expect(routineTask(routine())).toBe(
      "Open Slack, then open Mail, then open Safari at youtube.com.",
    );
    expect(
      routineTask(
        routine({ steps: [{ appId: "com.linear", action: "triage issues" }] }),
      ),
    ).toBe("Triage issues in linear.");
    // A linked approved procedure without open slots is the task.
    const p = procedure({
      trigger: "check the morning inbox",
      slots: [],
      status: "approved",
    });
    expect(routineTask(routine({ procedureId: "proc-1" }), [p])).toBe(
      "check the morning inbox",
    );
    expect(
      routineTask(routine({ procedureId: "proc-1" }), [
        procedure({ status: "approved" }),
      ]),
    ).toContain("Open Slack");
    expect(
      routineTask(routine({ procedureId: "proc-1" }), [
        p && { ...p, status: "proposed" },
      ]),
    ).toContain("Open Slack");
    expect(offerSentence(routine())).toBe(
      "I noticed you open Slack, Mail and Safari weekdays around 9 in the morning. Want that as a routine? You can approve it in Settings, under Watching.",
    );
    expect(weekdaysPhrase([0, 6])).toBe("weekends");
    expect(weekdaysPhrase([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(weekdaysPhrase([2, 4])).toBe("Tuesdays, Thursdays");
  });
});

describe("the owner's decisions", () => {
  it("approves a procedure into a Skill the runner matches, and keeps its replays", () => {
    const data: MemoryData = { ...emptyMemory(), procedures: [procedure()] };
    const result = decideProposalIn(
      data,
      "procedure",
      "proc-1",
      "approve",
      MON_9,
    );
    expect(result.changed).toBe(true);
    const skill = result.skill!;
    expect(skill).toMatchObject({
      kind: "skill",
      trigger: "file the receipt from {slot0}",
      slots: ["slot0"],
      hintOnly: false,
      successes: 0,
      failures: 0,
    });
    expect(skill.steps).toHaveLength(2);
    expect(data.skills).toEqual([skill]);
    expect(data.procedures[0]).toMatchObject({
      status: "approved",
      skillId: skill.id,
    });
    expect(procedureToSkill(data.procedures[0], MON_9).id).toBe(skill.id);
    // The existing machinery: the trigger matches with its slot filled, as a hint until two successes.
    const found = matchSkill(data.skills, "file the receipt from Amazon")!;
    expect(found.slotValues).toEqual(["Amazon"]);
    expect(replayable(found.skill)).toBe(false);
    expect(toPlan(found.skill, found.slotValues).mode).toBe("hint");
    data.skills[0].successes = 2;
    expect(toPlan(found.skill, found.slotValues).mode).toBe("replay");
    expect(learnedProposals(data).procedures[0].replays).toEqual({
      successes: 2,
      failures: 0,
    });
  });

  it("approves a routine into a schedule, dismisses, refuses, and lists what the pane shows", () => {
    const data: MemoryData = {
      ...emptyMemory(),
      routines: [
        routine({
          id: "a",
          status: "proposed",
          corrections: ["x"],
          correctionStreak: 1,
        }),
        routine({ id: "b", status: "proposed" }),
        routine({ id: "c", status: "proposed" }),
        routine({ id: "d", status: "retired" }),
      ],
      preferences: [
        {
          id: "p1",
          kind: "preference",
          text: "opens PDFs in Preview",
          tokens: [],
          weight: 3,
          source: "observed",
          status: "proposed",
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
        {
          id: "p2",
          kind: "preference",
          text: "a correction",
          tokens: [],
          weight: 1,
          source: "correction",
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      ],
    };
    expect(
      decideProposalIn(data, "routine", "a", "approve", MON_9).changed,
    ).toBe(true);
    expect(data.routines[0]).toMatchObject({
      status: "approved",
      correctionStreak: 0,
    });
    expect(data.routines[0].corrections).toBeUndefined();
    expect(isDue(data.routines[0], MON_9)).toBe(true);
    expect(
      decideProposalIn(data, "routine", "b", "dismiss", MON_9).changed,
    ).toBe(true);
    expect(data.routines.map((r) => r.id)).toEqual(["a", "c", "d"]);
    expect(decideProposalIn(data, "routine", "c", "never", MON_9).changed).toBe(
      true,
    );
    expect(data.routines[1].status).toBe("never");
    expect(
      decideProposalIn(data, "routine", "zzz", "approve", MON_9).changed,
    ).toBe(false);
    expect(
      decideProposalIn(data, "preference", "p1", "approve", MON_9).changed,
    ).toBe(true);
    expect(data.preferences[0].status).toBe("approved");
    // A correction preference is not a proposal.
    expect(
      decideProposalIn(data, "preference", "p2", "never", MON_9).changed,
    ).toBe(false);
    expect(
      decideProposalIn(data, "preference", "p1", "dismiss", MON_9).changed,
    ).toBe(true);
    expect(data.preferences.map((p) => p.id)).toEqual(["p2"]);
    const listed = learnedProposals(data);
    // Proposed first, then approved; retired and refused stay out; only observed preferences.
    expect(listed.routines.map((r) => [r.id, r.status])).toEqual([
      ["a", "approved"],
    ]);
    expect(listed.preferences).toEqual([]);
    expect(
      learnedProposals({
        ...data,
        procedures: [
          procedure(),
          procedure({ id: "p-approved", status: "approved" }),
        ],
      }).procedures.map((p) => p.status),
    ).toEqual(["proposed", "approved"]);
  });
});

// ---------------------------------------------------------------------------

function fakeStore(data: MemoryData) {
  return {
    data: () => data,
    update: <T>(change: (d: MemoryData) => T) => change(data),
  };
}
const snapshot = (run: Partial<Snapshot["run"] & object> | null): Snapshot => ({
  run: run
    ? ({
        id: "run-1",
        task: "Open Slack, then open Mail.",
        createdAt: new Date(2026, 8, 14, 9, 15, 1).toISOString(),
        status: "executing",
        privacy: "PRIVATE_LOCAL",
        provider: "ollama",
        model: "m",
        synthetic: false,
        actions: 0,
        frames: 0,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        summary: "",
        origin: "routine",
        ...run,
      } as Snapshot["run"])
    : null,
  frame: null,
  events: [],
  message: "",
});

describe("the scheduler", () => {
  const settingsOn = (over: Partial<Settings> = {}): Settings => ({
    ...defaultSettings,
    observer: { ...defaultSettings.observer, on: true },
    ...over,
  });
  function harness(
    o: {
      data?: MemoryData;
      settings?: Settings;
      now?: Date;
      presence?: "present" | "away" | "unknown";
      idleMs?: number;
      locked?: boolean;
      typingIn?: string;
      runActive?: boolean;
      listening?: boolean;
      startFails?: boolean;
    } = {},
  ) {
    const data = o.data ?? withRoutines(routine());
    const state = {
      now: o.now ?? MON_9,
      presence: o.presence ?? "present",
      idleMs: o.idleMs,
      locked: o.locked ?? false,
      typingIn: o.typingIn,
      runActive: o.runActive ?? false,
      listening: o.listening ?? false,
      settings: o.settings ?? settingsOn(),
    };
    const started: { task: string; source: unknown }[] = [];
    const traces: { event: string; data: Record<string, unknown> }[] = [];
    const scheduler = createRoutineScheduler({
      settings: () => state.settings,
      memory: () => fakeStore(data),
      runActive: () => state.runActive,
      listening: () => state.listening,
      presence: {
        current: () => state.presence,
        idleMs: () => state.idleMs,
        locked: () => state.locked,
      },
      typingIn: () => state.typingIn,
      start: async (task, source) => {
        if (o.startFails) throw new Error("no helper");
        started.push({ task, source });
      },
      trace: (event, d = {}) => traces.push({ event, data: d }),
      now: () => state.now,
    });
    return { scheduler, data, state, started, traces };
  }

  it("starts a due routine as a run with origin routine and the owner's provenance, once a day", async () => {
    const h = harness();
    expect(await h.scheduler.tick()).toBe(true);
    expect(h.started).toEqual([
      {
        task: "Open Slack, then open Mail, then open Safari at youtube.com.",
        source: { origin: "routine", taskSource: "user_words" },
      },
    ]);
    expect(h.data.routines[0].lastRunAt).toBe(MON_9.toISOString());
    expect(h.scheduler.pending()).toEqual({ routineId: "routine-1" });
    expect(h.traces.map((t) => t.event)).toEqual(["RoutineStarted"]);
    expect(h.traces[0].data).toEqual({ routineId: "routine-1" });
    // While it runs, nothing else starts; after it, not again today.
    expect(await h.scheduler.tick()).toBe(false);
    h.scheduler.onSnapshot(snapshot({ status: "completed" }));
    expect(h.scheduler.pending()).toBeUndefined();
    expect(await h.scheduler.tick()).toBe(false);
    expect(h.started).toHaveLength(1);
  });

  it("waits while a run is going, someone is listening, the Mac is locked, the owner types in its app, or presence forbids", async () => {
    for (const patch of [
      { runActive: true },
      { listening: true },
      { locked: true },
      { typingIn: "com.apple.mail" },
      {
        settings: {
          ...defaultSettings,
          observer: { ...defaultSettings.observer, on: true },
          workInBackground: false,
        } as Settings,
        presence: "present" as const,
        idleMs: 3000,
      },
      {
        settings: {
          ...defaultSettings,
          observer: { ...defaultSettings.observer, on: true },
          memory: false,
        } as Settings,
      },
      { settings: defaultSettings },
    ]) {
      const h = harness(patch);
      expect(await h.scheduler.tick(), JSON.stringify(patch)).toBe(false);
      expect(h.started).toEqual([]);
    }
    // Typing elsewhere is fine; with background off, an away owner or a long idle lets it start.
    expect(
      await harness({ typingIn: "com.apple.Notes" }).scheduler.tick(),
    ).toBe(true);
    const away = harness({
      settings: { ...settingsOn(), workInBackground: false },
      presence: "away",
    });
    expect(await away.scheduler.tick()).toBe(true);
    const idle = harness({
      settings: { ...settingsOn(), workInBackground: false },
      presence: "unknown",
      idleMs: 25_000,
    });
    expect(await idle.scheduler.tick()).toBe(true);
    // Outside the window nothing is due.
    expect(
      await harness({ now: new Date(2026, 8, 14, 14) }).scheduler.tick(),
    ).toBe(false);
  });

  it("records each replay's outcome from the snapshot and moves confidence", async () => {
    const h = harness();
    await h.scheduler.tick();
    // Another run's snapshot is not this replay's.
    h.scheduler.onSnapshot(
      snapshot({ id: "other", origin: "voice", status: "completed" }),
    );
    expect(h.scheduler.pending()).toEqual({ routineId: "routine-1" });
    h.scheduler.onSnapshot(snapshot({ status: "executing" }));
    expect(h.scheduler.pending()).toEqual({
      routineId: "routine-1",
      runId: "run-1",
    });
    h.scheduler.onSnapshot(
      snapshot({
        status: "completed",
        corrections: [
          { text: "use Chrome instead", after_action: 1, timestamp: "t" },
        ],
      }),
    );
    expect(h.data.routines[0].confidence).toBeCloseTo(0.55);
    expect(h.data.routines[0]).toMatchObject({
      status: "approved",
      correctionStreak: 1,
      corrections: ["use Chrome instead"],
      runs: { corrected: 1 },
    });
    expect(h.traces.at(-1)).toEqual({
      event: "RoutineRun",
      data: { routineId: "routine-1", outcome: "corrected" },
    });
    // An undo right after counts as undone; a late one does not.
    h.scheduler.noteUndo();
    expect(h.data.routines[0].runs.undone).toBe(1);
    expect(h.data.routines[0].status).toBe("proposed");
    h.scheduler.noteUndo();
    expect(h.data.routines[0].runs.undone).toBe(1);
    // A declined (stopped) replay.
    const h2 = harness();
    await h2.scheduler.tick();
    h2.scheduler.onSnapshot(snapshot({ status: "cancelled" }));
    expect(h2.data.routines[0].runs.declined).toBe(1);
    h2.state.now = new Date(MON_9.getTime() + 61_000);
    h2.scheduler.noteUndo();
    expect(h2.data.routines[0].runs.undone).toBe(0);
    // A start that fails is a failed replay.
    const h3 = harness({ startFails: true });
    expect(await h3.scheduler.tick()).toBe(false);
    expect(h3.data.routines[0].runs.failed).toBe(1);
    expect(h3.scheduler.pending()).toBeUndefined();
    expect(h3.traces.map((t) => t.event)).toEqual([
      "RoutineStarted",
      "RoutineStartFailed",
      "RoutineRun",
    ]);
  });

  it("starts a routine on a trigger, the owner's own words overriding the presence gate", async () => {
    const h = harness({ locked: true });
    expect(await h.scheduler.trigger({ kind: "unlocked" })).toBe(false);
    expect(
      await h.scheduler.trigger({ kind: "spoken", text: "morning check-in" }),
    ).toBe(true);
    const h2 = harness({ now: new Date(2026, 8, 14, 14) });
    expect(await h2.scheduler.trigger({ kind: "unlocked" })).toBe(false);
    const h3 = harness();
    expect(
      await h3.scheduler.trigger({
        kind: "app_launched",
        appId: "com.tinyspeck.slackmacgap",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the observer service", () => {
  function harness(
    o: {
      settings?: Settings;
      runActive?: boolean;
      presence?: "present" | "away" | "unknown";
      data?: MemoryData;
      now?: Date;
    } = {},
  ) {
    const state = {
      settings: o.settings ?? {
        ...defaultSettings,
        observer: { ...defaultSettings.observer, on: true },
      },
      runActive: o.runActive ?? false,
      presence: o.presence ?? ("present" as const),
      now: o.now ?? MON_9,
      helper: false,
    };
    const observeCalls: unknown[] = [];
    const observeRuns: (string | undefined)[] = [];
    const appended: unknown[] = [];
    const said: string[] = [];
    const traces: { event: string; data: Record<string, unknown> }[] = [];
    let paused = false;
    let changes = 0;
    const data = o.data ?? emptyMemory();
    const log: WorkLog = {
      directory: "/tmp/observer",
      get paused() {
        return paused;
      },
      append: (raw) => {
        appended.push(raw);
        return { written: true, event: raw as never, bytes: 100 };
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
      noteHelperDrop: () => {},
      days: () => ["2026-09-13", "2026-09-14"],
      read: () => [],
      dayDigest: () => ({ ...emptyDayDigest("2026-09-14"), frames: 3 }),
      digest: () => ({
        days: [],
        routines: { proposed: 0, approved: 0, retired: 0, observed: 0 },
        procedures: { proposed: 0, approved: 0, retired: 0, observed: 0 },
        preferences: { proposed: 0, approved: 0, retired: 0, observed: 0 },
        replays: {},
      }),
      bytes: () => 4096,
      forget: () => {},
      applyRetention: () => ({ removed: ["2026-08-01"], imagesExpired: 2 }),
      scheduleMidnight: () => {},
      close: () => {},
    };
    let ticks = 0;
    const consolidator: Consolidator = {
      tick: async () => {
        ticks += 1;
        return undefined;
      },
      dayEnd: async () => undefined,
      run: async () => {
        throw new Error("unused");
      },
      status: () => ({
        tokensToday: 42,
        lastCode: "ok",
        lastAt: "2026-09-14T08:00:00.000Z",
      }),
    };
    const observer = createObserver({
      settings: () => state.settings,
      controller: () => {
        state.helper = true;
        return {
          observe: async (options) => void observeCalls.push(options),
          setObserveRun: (runId) => void observeRuns.push(runId),
        };
      },
      helperRunning: () => state.helper,
      log,
      consolidator,
      memory: () => fakeStore(data),
      runActive: () => state.runActive,
      presence: () => state.presence,
      say: (text) => said.push(text),
      onChange: () => {
        changes += 1;
      },
      trace: (event, d = {}) => traces.push({ event, data: d }),
      now: () => state.now,
    });
    return {
      observer,
      state,
      observeCalls,
      observeRuns,
      appended,
      said,
      traces,
      data,
      ticks: () => ticks,
      changes: () => changes,
    };
  }

  it("pushes the setting and tier to the stream once, and stops it without spawning a helper", async () => {
    const h = harness();
    await h.observer.apply();
    await h.observer.apply();
    expect(h.observeCalls).toEqual([
      { on: true, tier: "structure", everyMs: OBSERVE_EVERY_MS },
    ]);
    expect(OBSERVE_EVERY_MS).toBe(20_000);
    h.state.settings = {
      ...h.state.settings,
      observer: { ...h.state.settings.observer, tier: "text" },
    };
    await h.observer.apply();
    expect(h.observeCalls.at(-1)).toEqual({
      on: true,
      tier: "text",
      everyMs: 20_000,
    });
    h.state.settings = defaultSettings;
    await h.observer.apply();
    expect(h.observeCalls.at(-1)).toEqual({
      on: false,
      tier: "structure",
      everyMs: 20_000,
    });
    expect(h.traces.filter((t) => t.event === "ObserverApplied")).toHaveLength(
      3,
    );
    // Off from the start with no helper running: nothing is asked of anyone.
    const off = harness({ settings: defaultSettings });
    await off.observer.apply();
    expect(off.observeCalls).toEqual([]);
    expect(off.state.helper).toBe(false);
    expect(off.observer.state()).toBe("off");
    expect(off.observer.menuLabel()).toBeUndefined();
  });

  it("pauses at once and resumes, telling the menu bar", async () => {
    const h = harness();
    await h.observer.apply();
    expect(h.observer.state()).toBe("on");
    expect(h.observer.menuLabel()).toBe("Watching how you work (pause)");
    await h.observer.setPaused(true);
    expect(h.observer.paused).toBe(true);
    expect(h.observer.state()).toBe("paused");
    expect(h.observer.menuLabel()).toBe("Watching paused (resume)");
    expect(h.observeCalls.at(-1)).toEqual({
      on: false,
      tier: "structure",
      everyMs: 20_000,
    });
    expect(h.changes()).toBe(1);
    // Paused: a frame that still arrives is not written, but is counted in the trace.
    h.observer.observed({
      event: "observe_frame",
      atMs: 1,
      appId: "com.apple.mail",
      controls: [],
    });
    expect(h.appended).toEqual([]);
    expect(h.traces.filter((t) => t.event === "ObserverFrameDropped")).toEqual([
      { event: "ObserverFrameDropped", data: { reason: "paused" } },
    ]);
    await h.observer.setPaused(false);
    expect(h.observer.state()).toBe("on");
    expect(h.observeCalls.at(-1)).toEqual({
      on: true,
      tier: "structure",
      everyMs: 20_000,
    });
    expect(h.traces.map((t) => t.event)).toContain("ObserverPaused");
    expect(h.traces.map((t) => t.event)).toContain("ObserverResumed");
    // Ticks do nothing while paused.
    await h.observer.setPaused(true);
    await h.observer.tick();
    expect(h.ticks()).toBe(0);
    await h.observer.setPaused(false);
    await h.observer.tick();
    expect(h.ticks()).toBe(1);
  });

  it("writes the stream's events to the log with content-free traces, and remembers where the owner types", () => {
    const h = harness();
    h.observer.observed({
      event: "observe_frame",
      atMs: 1,
      appId: "com.apple.mail",
      appName: "Mail",
      windowTitle: "Inbox",
      controls: [],
    });
    h.observer.observed({
      event: "observe_frame",
      atMs: 2,
      appId: "com.1password.1password",
      excluded: "protected",
      controls: [],
    });
    h.observer.observed({
      event: "observe_action",
      atMs: 3,
      appId: "com.apple.mail",
      kind: "typing",
      typed: { field: "To", chars: 8, ms: 700 },
    });
    h.observer.observed({
      event: "observe_dropped",
      atMs: 4,
      reason: "cap",
      dropped: 3,
    });
    h.observer.observed({ event: "nonsense" });
    expect(h.appended).toHaveLength(3);
    expect(h.traces.map((t) => [t.event, t.data])).toEqual([
      ["ObserverFrame", { appId: "com.apple.mail", bytes: 100 }],
      [
        "ObserverFrame",
        { appId: "com.1password.1password", excluded: "protected", bytes: 100 },
      ],
      ["ObserverAction", { kind: "typing" }],
      ["ObserverDropped", { dropped: 3, reason: "cap" }],
      ["ObserverEventInvalid", {}],
    ]);
    expect(JSON.stringify(h.traces)).not.toContain("Inbox");
    expect(h.observer.typingIn()).toBe("com.apple.mail");
    h.state.now = new Date(MON_9.getTime() + 31_000);
    expect(h.observer.typingIn()).toBeUndefined();
  });

  it("offers a new routine aloud once a day, never during a run or with nobody there", async () => {
    const data = withRoutines(
      routine({ id: "a", status: "proposed" }),
      routine({ id: "b", status: "proposed" }),
    );
    const h = harness({ data, runActive: true });
    await h.observer.tick();
    expect(h.said).toEqual([]);
    h.state.runActive = false;
    h.state.presence = "away";
    await h.observer.tick();
    expect(h.said).toEqual([]);
    h.state.presence = "present";
    await h.observer.tick();
    expect(h.said).toEqual([offerSentence(routine())]);
    expect(data.routines[0].offeredAt).toBe(MON_9.toISOString());
    expect(h.traces.at(-1)).toEqual({
      event: "RoutineOffered",
      data: { routineId: "a" },
    });
    // Not the second one today.
    await h.observer.tick();
    expect(h.said).toHaveLength(1);
    // Tomorrow the next one.
    h.state.now = new Date(2026, 8, 15, 9);
    await h.observer.tick();
    expect(h.said).toHaveLength(2);
    expect(data.routines[1].offeredAt).toBeDefined();
    // Nothing left to offer.
    h.state.now = new Date(2026, 8, 16, 9);
    await h.observer.tick();
    expect(h.said).toHaveLength(2);
  });

  it("tells the stream which run is under way, at its start and its end, only with a helper", async () => {
    const h = harness();
    // No helper yet: nothing is asked of one that does not exist.
    h.observer.onSnapshot(snapshot({ id: "run-1", origin: "voice" }));
    expect(h.observeRuns).toEqual([]);
    await h.observer.apply();
    h.observer.onSnapshot(snapshot({ id: "run-2", origin: "voice" }));
    h.observer.onSnapshot(
      snapshot({ id: "run-2", origin: "voice", status: "thinking" }),
    );
    expect(h.observeRuns).toEqual(["run-2"]);
    h.observer.onSnapshot(
      snapshot({ id: "run-2", origin: "voice", status: "completed" }),
    );
    expect(h.observeRuns).toEqual(["run-2", undefined]);
    h.observer.onSnapshot(snapshot(null));
    expect(h.observeRuns).toEqual(["run-2", undefined]);
    h.observer.onSnapshot(snapshot({ id: "run-3" }));
    expect(h.observeRuns).toEqual(["run-2", undefined, "run-3"]);
  });

  it("reports status and forgets, and start applies retention", async () => {
    const h = harness();
    h.observer.start();
    expect(h.traces[0]).toEqual({
      event: "ObserverRetention",
      data: { removed: 1, imagesExpired: 2 },
    });
    const status = h.observer.status();
    expect(status).toMatchObject({
      on: true,
      tier: "structure",
      paused: false,
      state: "on",
      retentionDays: 14,
      path: "/tmp/observer",
      days: ["2026-09-13", "2026-09-14"],
      bytes: 4096,
      consolidation: {
        tokensToday: 42,
        budget: 200_000,
        idleMinutes: 10,
        lastCode: "ok",
      },
    });
    expect(status.today.frames).toBe(3);
    expect(h.observer.forget("today").on).toBe(true);
    expect(h.traces.at(-1)).toEqual({
      event: "ObserverForgotten",
      data: { scope: "today" },
    });
    h.observer.close();
  });
});
