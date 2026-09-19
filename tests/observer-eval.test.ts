import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  TARGETS,
  consolidationOutputSchema,
  frameSchema,
  actionSchema,
  isFrame,
  localDay,
  localHour,
  normalizeChord,
  routineMatches,
  scoreOutput,
  scorePreferences,
  scoreProcedures,
  scoreRoutines,
  stepMatches,
  stepOverlap,
  timelineOf,
  tokenTarget,
  worklogSchema,
  type ConsolidationOutput,
  type ObserveAction,
  type ObserveFrame,
  type PlantedStep,
  type ProcedureOutput,
  type RoutineOutput,
  type SkillStepOutput,
  type Worklog,
} from "../src/gym/observer-eval";

// The synthetic work log (tests/fixtures/observer-worklog.json) and the eval
// that scores a consolidator against what it plants. The scorer is tested
// here with hand-written outputs (perfect, partial, inventing); no model and
// no network. The fixture's builder must reproduce the committed file.
const root = resolve(__dirname, "..");
const fixturePath = join(root, "tests/fixtures/observer-worklog.json");
const worklog: Worklog = worklogSchema.parse(
  JSON.parse(readFileSync(fixturePath, "utf8")),
);
const offset = worklog.utcOffsetMinutes;
const rowsOf = (day: string) => worklog.days.find((d) => d.day === day)!.rows;
const framesOf = (day: string) => rowsOf(day).filter(isFrame);
const actionsOf = (day: string) =>
  rowsOf(day).filter((r): r is ObserveAction => !isFrame(r));
const SLACK = "com.tinyspeck.slackmacgap";
const MAIL = "com.apple.mail";
const LINEAR = "com.linear";
const SAFARI = "com.apple.Safari";
const CHROME = "com.google.Chrome";
const PREVIEW = "com.apple.Preview";
const NUMBERS = "com.apple.iWork.Numbers";

/** Whether an observed row is the planted step (kind and its detail). */
const rowIsStep = (row: ObserveAction, step: PlantedStep): boolean =>
  row.kind === step.kind &&
  (step.appId === undefined || row.appId === step.appId) &&
  (step.label === undefined || row.target?.label === step.label) &&
  (step.field === undefined || row.typed?.field === step.field) &&
  (step.chord === undefined || row.chord === step.chord) &&
  (step.menu === undefined ||
    JSON.stringify(row.menu) === JSON.stringify(step.menu));
/** Whether the planted steps appear in order among the rows. */
const stepsInOrder = (rows: ObserveAction[], steps: PlantedStep[]): boolean => {
  let i = 0;
  for (const row of rows) if (i < steps.length && rowIsStep(row, steps[i])) i++;
  return i === steps.length;
};

/** A SkillStep a consolidator might write for a planted step, across the alias table. */
const skillStepFor = (step: PlantedStep): SkillStepOutput => {
  switch (step.kind) {
    case "click":
      return {
        action: { type: "click_control", label: step.label ?? "x" },
        target: { role: "button", label: step.label ?? "x" },
        expectAppId: step.appId,
      };
    case "double_click":
      return {
        action: { type: "double_click" },
        target: { role: "image", label: "{slot0}.pdf" },
        expectAppId: step.appId,
      };
    case "menu_item":
      return {
        action: { type: "menu_item", path: step.menu },
        expectAppId: step.appId,
      };
    case "typing":
      return {
        action: { type: "type_text", text: "{slot0}" },
        target: { role: "textField", label: step.field! },
        expectAppId: step.appId,
      };
    case "key_chord":
      return {
        action: { type: "hotkey", keys: step.chord!.toLowerCase().split("+") },
        expectAppId: step.appId,
      };
    case "app_switch":
      return { action: { type: "open_app", name: step.appName } };
    default:
      return { action: { type: step.kind } };
  }
};
const planted = worklog.planted;
const [filing, weekly] = planted.procedures;
const perfectRoutine: RoutineOutput = {
  id: "r1",
  name: "Morning triage",
  when: { weekdays: [1, 2, 3, 4, 5], hourRange: [8, 10] },
  steps: [{ appId: SLACK }, { appId: MAIL }, { appId: LINEAR }],
  seen: 5,
  confidence: 0.9,
};
const perfectProcedure = (p: typeof filing): ProcedureOutput => ({
  id: p.id,
  trigger: p.slots.length
    ? "file the {slot0} receipt"
    : "send the weekly report",
  steps: p.steps.map(skillStepFor),
  observedRuns: p.runs.length,
  slots: p.slots.length ? ["{slot0}"] : [],
  confidence: 0.8,
  status: "proposed",
});
const perfect: ConsolidationOutput = {
  routines: [perfectRoutine],
  procedures: [perfectProcedure(filing), perfectProcedure(weekly)],
  preferences: [
    { text: "opens docs.example.com in Google Chrome", source: "observed" },
    { text: "reads Slack before Mail in the morning", source: "observed" },
  ],
};

describe("the observer work-log fixture", () => {
  it("is five weekdays of §2 rows, in time order, each inside its local day, and what the builder writes", () => {
    expect(worklog.days.map((d) => d.day)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ]);
    expect(worklog.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(worklog.tier).toBe("structure");
    for (const d of worklog.days) {
      expect(d.rows.length).toBeGreaterThan(80);
      for (const [i, row] of d.rows.entries()) {
        expect(localDay(row.atMs, offset)).toBe(d.day);
        if (i) expect(row.atMs).toBeGreaterThanOrEqual(d.rows[i - 1].atMs);
        expect(
          (isFrame(row) ? frameSchema : actionSchema).safeParse(row).success,
        ).toBe(true);
      }
      // Every §2 action kind is exercised somewhere in the week.
    }
    const kinds = new Set(
      worklog.days.flatMap((d) => actionsOf(d.day).map((a) => a.kind)),
    );
    expect([...kinds].sort()).toEqual([...ACTION_KINDS].sort());
    const built = spawnSync(
      process.execPath,
      [join(root, "tests/fixtures/observer-worklog.build.mjs")],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(built.status).toBe(0);
    expect(JSON.parse(built.stdout)).toEqual(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
  });

  it("writes excluded frames with nothing but the app, and no image or text digest anywhere", () => {
    const frames = worklog.days.flatMap((d) => framesOf(d.day));
    const excluded = frames.filter((f) => f.excluded);
    const codes = new Set(excluded.map((f) => f.excluded));
    expect([...codes].sort()).toEqual([
      "idle",
      "locked",
      "own_run",
      "protected",
      "secure_input",
    ]);
    for (const f of excluded) {
      const keys = Object.keys(f).sort();
      if (f.excluded === "locked" || f.excluded === "idle")
        expect(keys).toEqual(["atMs", "event", "excluded"]);
      else if (f.excluded === "own_run")
        expect(keys).toEqual(["atMs", "event", "excluded", "runId"]);
      else expect(keys).toEqual(["appId", "atMs", "event", "excluded"]);
    }
    expect(excluded.filter((f) => f.excluded === "locked")).toHaveLength(5);
    expect(frames.some((f) => f.image !== undefined)).toBe(false);
    expect(frames.some((f) => f.textDigest !== undefined)).toBe(false);
    for (const f of frames.filter((f) => !f.excluded)) {
      expect(f.appId).toBeDefined();
      expect(f.controls).toBeDefined();
      expect(f.controls!.length).toBeLessThanOrEqual(60);
      if (f.windowTitle) expect(f.windowTitle.length).toBeLessThanOrEqual(120);
    }
  });

  it("plants the morning routine on every weekday between eight and ten", () => {
    const [routine] = planted.routines;
    expect(routine.apps).toEqual([SLACK, MAIL, LINEAR]);
    expect(routine.days).toEqual(worklog.days.map((d) => d.day));
    for (const d of worklog.days) {
      const morning = actionsOf(d.day).filter((a) => {
        const h = localHour(a.atMs, offset);
        return a.kind === "app_switch" && h >= 8 && h < 10;
      });
      const apps = morning.map((a) => a.appId);
      // Slack, then Mail, then Linear, in that order and nothing before Slack.
      expect(apps.slice(0, 3)).toEqual([SLACK, MAIL, LINEAR]);
      expect(localHour(morning[0].atMs, offset)).toBeGreaterThanOrEqual(8);
      expect(localHour(morning[2].atMs, offset)).toBeLessThan(10);
    }
  });

  it("repeats the filing procedure four times with a different vendor, and the weekly report three times", () => {
    expect(filing.id).toBe("file-receipt");
    expect(filing.runs).toHaveLength(4);
    expect(filing.slots).toEqual(["vendor"]);
    expect(new Set(filing.runs.map((r) => r.slot)).size).toBe(4);
    expect(filing.runs.map((r) => r.day)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-18",
    ]);
    expect(weekly.id).toBe("weekly-report");
    expect(weekly.runs).toHaveLength(3);
    expect(weekly.slots).toEqual([]);
    expect(weekly.runs.map((r) => r.day)).toEqual([
      "2026-09-14",
      "2026-09-16",
      "2026-09-18",
    ]);
    for (const p of [filing, weekly])
      for (const run of p.runs) {
        const rows = actionsOf(run.day).filter(
          (a) => a.atMs >= run.fromMs && a.atMs <= run.toMs,
        );
        expect(stepsInOrder(rows, p.steps), `${p.id} on ${run.day}`).toBe(true);
      }
    // The two procedures' distinctive menu items appear exactly as often as their runs, and nowhere else.
    const menus = worklog.days.flatMap((d) =>
      actionsOf(d.day).filter((a) => a.kind === "menu_item"),
    );
    expect(
      menus.filter(
        (a) => a.appId === PREVIEW && a.menu?.join("/") === "File/Export…",
      ),
    ).toHaveLength(4);
    expect(
      menus.filter(
        (a) =>
          a.appId === NUMBERS && a.menu?.join("/") === "File/Export To/PDF…",
      ),
    ).toHaveLength(3);
    // The slot shows in the attachment's label: a different receipt each run.
    const attachments = worklog.days.flatMap((d) =>
      actionsOf(d.day).filter(
        (a) => a.kind === "double_click" && a.appId === MAIL,
      ),
    );
    expect(attachments.map((a) => a.target?.label)).toEqual(
      filing.runs.map((r) => `Receipt - ${r.slot}.pdf`),
    );
  });

  it("flips the docs browser from Safari to Chrome on day four, and only for that host", () => {
    const [pref] = planted.preferences;
    expect(pref.flipDay).toBe("2026-09-17");
    for (const d of worklog.days) {
      const docs = framesOf(d.day).filter((f) => f.host === "docs.example.com");
      expect(docs.length, d.day).toBeGreaterThan(0);
      const expected = d.day < pref.flipDay ? SAFARI : CHROME;
      for (const f of docs) expect(f.appId).toBe(expected);
      const others = framesOf(d.day).filter(
        (f) => f.host && f.host !== "docs.example.com",
      );
      expect(others.length).toBeGreaterThan(0);
      for (const f of others) expect(f.appId).toBe(SAFARI);
    }
  });

  it("carries its decoys: Music then Messages on two days only, Terminal every day", () => {
    const music = planted.decoys.find((d) => d.id === "music-messages")!;
    for (const d of worklog.days) {
      const has = framesOf(d.day).some((f) => f.appId === "com.apple.Music");
      expect(has, d.day).toBe(music.days.includes(d.day));
      expect(
        framesOf(d.day).some((f) => f.appId === "com.apple.Terminal"),
      ).toBe(true);
    }
  });

  it("builds one day's timeline: frames and actions apart, in order, without images", () => {
    const t = timelineOf(worklog, "2026-09-15");
    expect(t.day).toBe("2026-09-15");
    expect(t.weekday).toBe(2);
    expect(t.timezone).toBe("America/Los_Angeles");
    expect(t.utcOffsetMinutes).toBe(-420);
    expect(t.frames.length + t.actions.length).toBe(
      rowsOf("2026-09-15").length,
    );
    expect(t.frames.every((f) => f.event === "observe_frame")).toBe(true);
    expect(t.actions.every((a) => a.event === "observe_action")).toBe(true);
    expect(t.frames.some((f) => "image" in f)).toBe(false);
    const withImage: Worklog = {
      ...worklog,
      days: [
        {
          day: "2026-09-15",
          weekday: 2,
          rows: [
            {
              event: "observe_frame",
              atMs: 1,
              appId: SAFARI,
              controls: [],
              image: "AAAA",
            } as ObserveFrame,
          ],
        },
      ],
    };
    expect(timelineOf(withImage, "2026-09-15").frames[0]).toEqual({
      event: "observe_frame",
      atMs: 1,
      appId: SAFARI,
      controls: [],
    });
    expect(() => timelineOf(worklog, "2026-09-19")).toThrow(/no day/);
  });
});

describe("the §4 output schema, read leniently", () => {
  it("takes weekdays by name or number and an hour range as a pair or an object", () => {
    const out = consolidationOutputSchema.parse({
      routines: [
        {
          name: "x",
          when: {
            weekdays: ["Mon", "tuesday", 3, "x", 9],
            hourRange: { from: 8, to: 10 },
          },
          steps: [{ appId: SLACK }],
        },
        {
          name: "y",
          when: { hourRange: { start: 16, end: 17 } },
          steps: [{ appId: MAIL, host: "example.com", action: "open" }],
        },
      ],
    });
    expect(out.routines[0].when.weekdays).toEqual([1, 2, 3]);
    expect(out.routines[0].when.hourRange).toEqual([8, 10]);
    expect(out.routines[1].when.hourRange).toEqual([16, 17]);
    expect(out.routines[1].when.weekdays).toBeUndefined();
    expect(out.procedures).toEqual([]);
    expect(out.preferences).toEqual([]);
  });

  it("refuses a routine without steps, a step without an app, a procedure without a trigger", () => {
    expect(
      consolidationOutputSchema.safeParse({
        routines: [{ name: "x", when: { hourRange: [8, 9] }, steps: [] }],
      }).success,
    ).toBe(false);
    expect(
      consolidationOutputSchema.safeParse({
        routines: [
          {
            name: "x",
            when: { hourRange: [8, 9] },
            steps: [{ host: "a.com" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      consolidationOutputSchema.safeParse({
        procedures: [{ steps: [{ action: { type: "click_control" } }] }],
      }).success,
    ).toBe(false);
    expect(consolidationOutputSchema.safeParse("routines").success).toBe(false);
  });
});

describe("scoring a consolidator's output", () => {
  it("scores the perfect output as full recall and precision, every step, the later value, nothing invented", () => {
    const score = scoreOutput(planted, perfect, worklog.days.length);
    expect(score.routines).toMatchObject({
      planted: 1,
      found: 1,
      recovered: 1,
      matched: 1,
      invented: 0,
      recall: 1,
      precision: 1,
      byRoutine: [{ id: "morning-triage", recovered: true }],
    });
    expect(score.procedures).toEqual([
      {
        id: "file-receipt",
        recovered: true,
        plantedSteps: 6,
        foundSteps: 6,
        matchedSteps: 6,
        stepRecall: 1,
        stepPrecision: 1,
        observedRuns: 4,
        slotReported: true,
      },
      {
        id: "weekly-report",
        recovered: true,
        plantedSteps: 11,
        foundSteps: 11,
        matchedSteps: 11,
        stepRecall: 1,
        stepPrecision: 1,
        observedRuns: 3,
        slotReported: undefined,
      },
    ]);
    expect(score.unmatchedProcedures).toBe(0);
    expect(score.preferences).toEqual([
      { id: "docs-browser", reported: true, later: true, stale: false },
    ]);
    expect(score.targets).toEqual({
      routineRecall: { target: 0.8, value: 1, met: true },
      inventedRoutines: { target: 1, value: 0, met: true },
    });
  });

  it("matches a routine by ordered app subsequence and a touching hour window, not otherwise", () => {
    const [r] = planted.routines;
    expect(routineMatches(r, perfectRoutine)).toBe(true);
    // One extra app, a window an hour off, weekday names: still the routine.
    expect(
      routineMatches(r, {
        ...perfectRoutine,
        when: { weekdays: [1], hourRange: [7, 8] },
        steps: [
          { appId: SLACK },
          { appId: MAIL },
          { appId: "com.apple.iCal" },
          { appId: LINEAR },
        ],
      }),
    ).toBe(true);
    // The wrong order, an afternoon window, two extra apps, weekends only: not.
    expect(
      routineMatches(r, {
        ...perfectRoutine,
        steps: [{ appId: MAIL }, { appId: SLACK }, { appId: LINEAR }],
      }),
    ).toBe(false);
    expect(
      routineMatches(r, { ...perfectRoutine, when: { hourRange: [14, 15] } }),
    ).toBe(false);
    expect(
      routineMatches(r, {
        ...perfectRoutine,
        steps: [
          { appId: SAFARI },
          { appId: SLACK },
          { appId: MAIL },
          { appId: "com.apple.iCal" },
          { appId: LINEAR },
        ],
      }),
    ).toBe(false);
    expect(
      routineMatches(r, {
        ...perfectRoutine,
        when: { weekdays: [0, 6], hourRange: [8, 10] },
      }),
    ).toBe(false);
    // Two apps of three is not the routine.
    expect(
      routineMatches(r, {
        ...perfectRoutine,
        steps: [{ appId: SLACK }, { appId: MAIL }],
      }),
    ).toBe(false);
  });

  it("counts invented routines and misses the target past one per five days", () => {
    const decoy: RoutineOutput = {
      name: "Afternoon music",
      when: { weekdays: [2, 4], hourRange: [13, 15] },
      steps: [{ appId: "com.apple.Music" }, { appId: "com.apple.MobileSMS" }],
    };
    const terminal: RoutineOutput = {
      name: "Terminal after lunch",
      when: { hourRange: [13, 16] },
      steps: [{ appId: "com.apple.Terminal" }, { appId: SAFARI }],
    };
    const one = scoreRoutines(planted.routines, [perfectRoutine, decoy]);
    expect(one).toMatchObject({
      found: 2,
      matched: 1,
      invented: 1,
      recall: 1,
      precision: 0.5,
    });
    expect(
      scoreOutput(planted, { ...perfect, routines: [perfectRoutine, decoy] }, 5)
        .targets.inventedRoutines,
    ).toEqual({ target: 1, value: 1, met: true });
    const two = scoreOutput(
      planted,
      { ...perfect, routines: [perfectRoutine, decoy, terminal] },
      5,
    );
    expect(two.routines).toMatchObject({ invented: 2, precision: 1 / 3 });
    expect(two.targets.inventedRoutines).toEqual({
      target: 1,
      value: 2,
      met: false,
    });
    // Ten days allow two.
    expect(
      scoreOutput(
        planted,
        { ...perfect, routines: [perfectRoutine, decoy, terminal] },
        10,
      ).targets.inventedRoutines.met,
    ).toBe(true);
    // A duplicate of the right routine is matched twice, invented never.
    expect(
      scoreRoutines(planted.routines, [
        perfectRoutine,
        { ...perfectRoutine, name: "Morning again" },
      ]),
    ).toMatchObject({
      matched: 2,
      invented: 0,
      recovered: 1,
      recall: 1,
      precision: 1,
    });
    // Nothing found: recall 0, the target missed.
    const none = scoreOutput(
      planted,
      { routines: [], procedures: [], preferences: [] },
      5,
    );
    expect(none.routines).toMatchObject({
      recall: 0,
      precision: 1,
      invented: 0,
    });
    expect(none.targets.routineRecall).toEqual({
      target: 0.8,
      value: 0,
      met: false,
    });
    expect(
      none.procedures.every((p) => !p.recovered && p.stepRecall === 0),
    ).toBe(true);
    expect(none.preferences).toEqual([
      { id: "docs-browser", reported: false, later: false, stale: false },
    ]);
  });

  it("scores procedure steps by kind and label as an ordered overlap", () => {
    // Two steps dropped and one foreign step added: recall 4/6, precision 4/5.
    const partial: ProcedureOutput = {
      trigger: "file a receipt",
      steps: [
        skillStepFor(filing.steps[0]),
        skillStepFor(filing.steps[1]),
        {
          action: { type: "click_control", label: "Zoom In" },
          target: { role: "button", label: "Zoom In" },
        },
        skillStepFor(filing.steps[3]),
        skillStepFor(filing.steps[5]),
      ],
      observedRuns: 4,
    };
    const { byProcedure, unmatched } = scoreProcedures(planted.procedures, [
      partial,
    ]);
    expect(byProcedure[0]).toEqual({
      id: "file-receipt",
      recovered: true,
      plantedSteps: 6,
      foundSteps: 5,
      matchedSteps: 4,
      stepRecall: 4 / 6,
      stepPrecision: 4 / 5,
      observedRuns: 4,
      slotReported: false,
    });
    expect(byProcedure[1]).toMatchObject({
      id: "weekly-report",
      recovered: false,
      matchedSteps: 0,
    });
    expect(unmatched).toBe(0);
    // A slot in the trigger counts as reported; a slot in a step's text too.
    expect(
      scoreProcedures(
        [filing],
        [{ ...partial, trigger: "file the {slot0} receipt" }],
      ).byProcedure[0].slotReported,
    ).toBe(true);
    expect(
      scoreProcedures(
        [filing],
        [
          {
            ...partial,
            steps: [
              ...partial.steps,
              { action: { type: "type_text", text: "{slot0}" } },
            ],
          },
        ],
      ).byProcedure[0].slotReported,
    ).toBe(true);
    // The order matters: the same steps reversed overlap in one step only.
    const reversed: ProcedureOutput = {
      trigger: "x",
      steps: [...filing.steps].reverse().map(skillStepFor),
    };
    expect(scoreProcedures([filing], [reversed]).byProcedure[0]).toMatchObject({
      matchedSteps: 1,
      recovered: false,
    });
    // Fewer than half the steps is not recovered; an unrelated procedure is unmatched.
    const unrelated: ProcedureOutput = {
      trigger: "y",
      steps: [{ action: { type: "open_app", name: "Music" } }],
    };
    const both = scoreProcedures(planted.procedures, [
      perfectProcedure(weekly),
      unrelated,
    ]);
    expect(both.byProcedure.map((p) => p.recovered)).toEqual([false, true]);
    expect(both.unmatched).toBe(1);
  });

  it("matches a step by the alias table: labels blind to case and ellipsis, chords as sorted tokens, menus by their last item", () => {
    const click: PlantedStep = {
      kind: "click",
      appId: NUMBERS,
      label: "Next…",
    };
    expect(
      stepMatches(click, {
        action: { type: "click_control", label: "next..." },
      }),
    ).toBe(true);
    expect(
      stepMatches(click, {
        action: { type: "click" },
        target: { role: "button", label: "NEXT" },
      }),
    ).toBe(true);
    expect(
      stepMatches(click, {
        action: { type: "click_control", label: "Export" },
      }),
    ).toBe(false);
    expect(
      stepMatches(click, { action: { type: "hotkey", keys: ["cmd", "n"] } }),
    ).toBe(false);
    expect(
      stepMatches(click, {
        action: { type: "click_control", label: "Next…" },
        expectAppId: MAIL,
      }),
    ).toBe(false);
    const chord: PlantedStep = {
      kind: "key_chord",
      appId: MAIL,
      chord: "CMD+N",
    };
    expect(
      stepMatches(chord, {
        action: { type: "hotkey", keys: ["command", "n"] },
      }),
    ).toBe(true);
    expect(
      stepMatches(chord, { action: { type: "hotkey", keys: ["n", "cmd"] } }),
    ).toBe(true);
    expect(
      stepMatches(chord, {
        action: { type: "hotkey", keys: ["cmd", "shift", "n"] },
      }),
    ).toBe(false);
    expect(stepMatches(chord, { action: { type: "key", key: "cmd+n" } })).toBe(
      true,
    );
    expect(stepMatches(chord, { action: { type: "hotkey" } })).toBe(true);
    expect(normalizeChord("shift+cmd+s")).toBe("CMD+S+SHIFT");
    expect(normalizeChord(["Option", "Command", "Esc"])).toBe("CMD+ESC+OPT");
    const menu: PlantedStep = {
      kind: "menu_item",
      appId: NUMBERS,
      menu: ["File", "Export To", "PDF…"],
    };
    expect(
      stepMatches(menu, {
        action: { type: "menu_item", path: ["File", "Export To", "PDF..."] },
      }),
    ).toBe(true);
    expect(
      stepMatches(menu, {
        action: { type: "menu_item", path: ["File", "Print…"] },
      }),
    ).toBe(false);
    expect(
      stepMatches(menu, {
        action: { type: "menu_item" },
        target: { role: "menuItem", label: "PDF…" },
      }),
    ).toBe(true);
    expect(stepMatches(menu, { action: { type: "menu_item" } })).toBe(false);
    const typing: PlantedStep = {
      kind: "typing",
      appId: PREVIEW,
      field: "Export As",
    };
    expect(
      stepMatches(typing, {
        action: { type: "type_text", text: "{slot0}", field: "export as" },
      }),
    ).toBe(true);
    expect(
      stepMatches(typing, { action: { type: "type_text", text: "{slot0}" } }),
    ).toBe(false);
    const app: PlantedStep = {
      kind: "app_switch",
      appId: NUMBERS,
      appName: "Numbers",
    };
    expect(
      stepMatches(app, { action: { type: "open_app", name: "numbers" } }),
    ).toBe(true);
    expect(
      stepMatches(app, { action: { type: "open_app", name: "Mail" } }),
    ).toBe(false);
    expect(
      stepMatches(app, {
        action: { type: "app_switch" },
        expectAppId: NUMBERS,
      }),
    ).toBe(true);
    expect(stepMatches(app, { action: { type: "open_app" } })).toBe(false);
    const dbl: PlantedStep = { kind: "double_click", appId: MAIL };
    expect(
      stepMatches(dbl, {
        action: { type: "click_control", label: "Receipt - {slot0}.pdf" },
      }),
    ).toBe(true);
    expect(stepMatches(dbl, { action: { type: "scroll" } })).toBe(false);
    expect(stepOverlap(filing.steps, filing.steps.map(skillStepFor))).toBe(6);
    expect(stepOverlap(filing.steps, [])).toBe(0);
  });

  it("reads the flipped preference: reported with the later value, or stale with the earlier one", () => {
    const [pref] = planted.preferences;
    expect(
      scorePreferences([pref], [{ text: "Uses Chrome for docs.example.com" }]),
    ).toEqual([
      { id: "docs-browser", reported: true, later: true, stale: false },
    ]);
    expect(
      scorePreferences([pref], [{ text: "opens docs in Safari" }]),
    ).toEqual([
      { id: "docs-browser", reported: true, later: false, stale: true },
    ]);
    // Both values named, the later among them: not stale.
    expect(
      scorePreferences(
        [pref],
        [{ text: "moved from Safari to Chrome for docs.example.com" }],
      )[0],
    ).toMatchObject({ later: true, stale: false });
    // A stale and a fresh preference side by side: both flags.
    expect(
      scorePreferences(
        [pref],
        [{ text: "docs in Safari" }, { text: "docs in Chrome" }],
      )[0],
    ).toEqual({ id: "docs-browser", reported: true, later: true, stale: true });
    // A preference about something else says nothing.
    expect(
      scorePreferences(
        [pref],
        [{ text: "uses Safari for news.example.org" }],
      )[0],
    ).toEqual({
      id: "docs-browser",
      reported: false,
      later: false,
      stale: false,
    });
  });

  it("measures the input-token target per consolidated day", () => {
    expect(tokenTarget([41_200, 38_000, 45_500])).toEqual({
      target: TARGETS.inputTokensPerDay,
      value: 45_500,
      met: true,
      days: 3,
      missedDays: 0,
      max: 45_500,
    });
    expect(tokenTarget([250_000, 10_000])).toMatchObject({
      met: false,
      missedDays: 1,
      max: 250_000,
    });
    expect(tokenTarget([])).toMatchObject({ met: true, days: 0, max: 0 });
    expect(TARGETS).toEqual({
      routineRecall: 0.8,
      inventedRoutinesPerFiveDays: 1,
      inputTokensPerDay: 200_000,
    });
  });
});

describe("scripts/observer-eval.mjs", () => {
  const script = join(root, "scripts/observer-eval.mjs");
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...env,
      },
    });

  it("refuses to run without the opt-in flag, before reading anything", () => {
    const result = run(["--provider", "ollama"], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("OPEN_ASSIST_OBSERVER_EVAL=1");
    expect(result.stdout).toBe("");
    const wrong = run(["--provider", "ollama"], {
      OPEN_ASSIST_OBSERVER_EVAL: "yes",
    });
    expect(wrong.status).toBe(2);
    // A remote provider needs its key before any call.
    const noKey = run(
      ["--provider", "openai", "--key-env", "NO_SUCH_KEY_VAR"],
      { OPEN_ASSIST_OBSERVER_EVAL: "1" },
    );
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toContain("No key in $NO_SUCH_KEY_VAR");
  }, 90_000);

  it("runs the fixture through consolidateDay, reports every day failed with the consolidator's own code when no local model answers, and spends nothing", () => {
    const result = run(["--provider", "ollama", "--days", "2"], {
      OPEN_ASSIST_OBSERVER_EVAL: "1",
    });
    expect(result.status).toBe(1);
    // Ollama is not running in the test: the landed consolidator answers
    // code "model" for the day instead of throwing, and the eval reports it.
    expect(result.stderr).toContain("2026-09-14: model");
    expect(result.stderr).toContain("2026-09-15: model");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      provider: "ollama",
      fixture: "tests/fixtures/observer-worklog.json",
      days: 2,
      consolidatedDays: 0,
      tokens: { calls: 0, input: 0, output: 0 },
      estimatedCost: 0,
      missedTargets: ["routineRecall"],
      failedDays: [
        { day: "2026-09-14", code: "model" },
        { day: "2026-09-15", code: "model" },
      ],
    });
    expect(report.routines).toMatchObject({
      planted: 1,
      found: 0,
      recall: 0,
      invented: 0,
    });
    expect(report.targets.inputTokensPerDay).toMatchObject({
      met: true,
      days: 0,
    });
    expect(report.found).toBeUndefined();
    expect(result.stdout).not.toContain("Acme");
  }, 90_000);
});
