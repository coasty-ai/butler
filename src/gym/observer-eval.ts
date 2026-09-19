import { z } from "zod";

/**
 * The pure half of scripts/observer-eval.mjs (lane O3 of
 * .data/design/observer.md): the design's §2 frame and action shapes as zod,
 * the synthetic work-log fixture's shape with its planted truth, the §4
 * consolidation output schema (read leniently, so a consolidator that spells
 * a weekday or an hour range another way still scores), and the scoring of
 * a consolidator's output against what was planted. Nothing in the app
 * imports this; the eval script and its tests do.
 */

/** The §7 targets the eval and the report measure against. */
export const TARGETS = {
  /** Recall on the planted routines. */
  routineRecall: 0.8,
  /** Invented routines allowed per five observed days. */
  inventedRoutinesPerFiveDays: 1,
  /** Input tokens the consolidator may spend in a day. */
  inputTokensPerDay: 200_000,
} as const;

export const BUNDLE_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
const HOST = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHORD = /^([A-Z]+\+)+[A-Z0-9]+$/;

export const EXCLUSIONS = [
  "secure_input",
  "protected",
  "locked",
  "own_run",
  "idle",
] as const;
export const ACTION_KINDS = [
  "click",
  "double_click",
  "right_click",
  "key_chord",
  "typing",
  "scroll",
  "app_switch",
  "menu_item",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const control = z
  .object({
    role: z.string().min(1).max(40),
    label: z.string().max(120),
  })
  .strict();

/** One frame as §2 writes it; an excluded frame carries nothing but appId. */
export const frameSchema = z
  .object({
    event: z.literal("observe_frame"),
    atMs: z.number().int().nonnegative(),
    appId: z.string().regex(BUNDLE_ID).optional(),
    appName: z.string().min(1).max(60).optional(),
    windowTitle: z.string().max(120).optional(),
    host: z.string().regex(HOST).optional(),
    focusedRole: z.string().min(1).max(40).optional(),
    focusedLabel: z.string().max(120).optional(),
    controls: z.array(control).max(60).optional(),
    textDigest: z.string().max(1500).optional(),
    image: z.string().optional(),
    excluded: z.enum(EXCLUSIONS).optional(),
    /** own_run frames carry the run's id only. */
    runId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((frame, ctx) => {
    if (frame.excluded) {
      const allowed = new Set(["event", "atMs", "appId", "excluded", "runId"]);
      const extra = Object.keys(frame).filter((key) => !allowed.has(key));
      if (extra.length)
        ctx.addIssue({
          code: "custom",
          message: `an excluded frame carries nothing but appId: ${extra.join(", ")}`,
        });
      if (frame.runId && frame.excluded !== "own_run")
        ctx.addIssue({
          code: "custom",
          message: "only an own_run frame carries a runId",
        });
      if (frame.excluded === "locked" && frame.appId)
        ctx.addIssue({
          code: "custom",
          message: "a locked frame carries nothing",
        });
    } else {
      if (!frame.appId)
        ctx.addIssue({
          code: "custom",
          message: "a recorded frame names its appId",
        });
      if (!frame.controls)
        ctx.addIssue({
          code: "custom",
          message: "a recorded frame carries its controls (possibly none)",
        });
    }
  });
export type ObserveFrame = z.infer<typeof frameSchema>;

/** One owner action as §2 writes it: content-free by construction. */
export const actionSchema = z
  .object({
    event: z.literal("observe_action"),
    atMs: z.number().int().nonnegative(),
    appId: z.string().regex(BUNDLE_ID),
    kind: z.enum(ACTION_KINDS),
    target: control.optional(),
    chord: z.string().regex(CHORD).optional(),
    typed: z
      .object({
        field: z.string().max(120),
        chars: z.number().int().positive(),
        ms: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    scroll: z
      .object({
        direction: z.enum(["up", "down"]),
        ticks: z.number().int().positive(),
      })
      .strict()
      .optional(),
    menu: z.array(z.string().min(1).max(60)).min(1).max(8).optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const needs: Partial<
      Record<ActionKind, "chord" | "typed" | "scroll" | "menu">
    > = {
      key_chord: "chord",
      typing: "typed",
      scroll: "scroll",
      menu_item: "menu",
    };
    for (const [kind, field] of Object.entries(needs) as [
      ActionKind,
      "chord" | "typed" | "scroll" | "menu",
    ][]) {
      if (action.kind === kind && action[field] === undefined)
        ctx.addIssue({ code: "custom", message: `${kind} carries ${field}` });
      if (action.kind !== kind && action[field] !== undefined)
        ctx.addIssue({
          code: "custom",
          message: `only ${kind} carries ${field}`,
        });
    }
  });
export type ObserveAction = z.infer<typeof actionSchema>;

export const rowSchema = z.union([frameSchema, actionSchema]);
export type ObserveRow = z.infer<typeof rowSchema>;
export const isFrame = (row: ObserveRow): row is ObserveFrame =>
  row.event === "observe_frame";

const day = z.string().regex(DAY);
const hour = z.number().int().min(0).max(24);
const bundle = z.string().regex(BUNDLE_ID);

const plantedRoutineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** The apps in order. */
    apps: z.array(bundle).min(2),
    /** JavaScript weekdays: 0 Sunday to 6 Saturday. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    /** Local hours [from, to], the window the routine starts in. */
    hourRange: z.tuple([hour, hour]),
    /** The fixture days it was planted on. */
    days: z.array(day).min(1),
  })
  .strict();
export type PlantedRoutine = z.infer<typeof plantedRoutineSchema>;

const plantedStepSchema = z
  .object({
    kind: z.enum(ACTION_KINDS),
    appId: bundle.optional(),
    appName: z.string().optional(),
    /** A pointer step's target label; absent when the label carries the slot. */
    label: z.string().optional(),
    /** A typing step's field label. */
    field: z.string().optional(),
    chord: z.string().optional(),
    menu: z.array(z.string()).optional(),
  })
  .strict();
export type PlantedStep = z.infer<typeof plantedStepSchema>;

const plantedProcedureSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    steps: z.array(plantedStepSchema).min(3),
    runs: z
      .array(
        z
          .object({
            day,
            fromMs: z.number().int().nonnegative(),
            toMs: z.number().int().nonnegative(),
            slot: z.string().optional(),
          })
          .strict(),
      )
      .min(3),
    slots: z.array(z.string()),
  })
  .strict();
export type PlantedProcedure = z.infer<typeof plantedProcedureSchema>;

const plantedPreferenceSchema = z
  .object({
    id: z.string().min(1),
    /** Words that name the preference's subject (any one, blind to case). */
    subject: z.array(z.string().min(1)).min(1),
    /** Words of the value before the flip. */
    earlier: z.array(z.string().min(1)).min(1),
    /** Words of the value from the flip day on. */
    later: z.array(z.string().min(1)).min(1),
    flipDay: day,
  })
  .strict();
export type PlantedPreference = z.infer<typeof plantedPreferenceSchema>;

const decoySchema = z
  .object({
    id: z.string().min(1),
    apps: z.array(bundle).min(1),
    days: z.array(day).min(1),
    note: z.string().min(1),
  })
  .strict();

/** tests/fixtures/observer-worklog.json. */
export const worklogSchema = z
  .object({
    version: z.literal(1),
    timezone: z.string().min(1),
    utcOffsetMinutes: z
      .number()
      .int()
      .min(-14 * 60)
      .max(14 * 60),
    tier: z.enum(["structure", "text", "pixels"]),
    days: z
      .array(
        z
          .object({
            day,
            weekday: z.number().int().min(0).max(6),
            rows: z.array(rowSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    planted: z
      .object({
        routines: z.array(plantedRoutineSchema),
        procedures: z.array(plantedProcedureSchema),
        preferences: z.array(plantedPreferenceSchema),
        decoys: z.array(decoySchema),
      })
      .strict(),
  })
  .strict();
export type Worklog = z.infer<typeof worklogSchema>;
export type PlantedTruth = Worklog["planted"];

/** The local hour of an instant, given the fixture's fixed offset. */
export const localHour = (atMs: number, utcOffsetMinutes: number): number =>
  new Date(atMs + utcOffsetMinutes * 60_000).getUTCHours();
/** The local day of an instant, given the fixture's fixed offset. */
export const localDay = (atMs: number, utcOffsetMinutes: number): string =>
  new Date(atMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);

/**
 * One day's compact timeline for the consolidator: the day's frames and
 * actions in §2 shapes, images stripped (§4: never images), in time order.
 */
export function timelineOf(worklog: Worklog, day: string) {
  const entry = worklog.days.find((d) => d.day === day);
  if (!entry) throw new Error(`no day ${day} in the fixture`);
  const rows = [...entry.rows].sort((a, b) => a.atMs - b.atMs);
  const frames = rows
    .filter(isFrame)
    .map(({ image: _image, ...frame }) => frame);
  const actions = rows.filter((row) => !isFrame(row));
  return {
    day: entry.day,
    weekday: entry.weekday,
    timezone: worklog.timezone,
    utcOffsetMinutes: worklog.utcOffsetMinutes,
    tier: worklog.tier,
    frames,
    actions,
  };
}
export type Timeline = ReturnType<typeof timelineOf>;

// ---- The §4 output, read leniently ------------------------------------------

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const weekdayOutput = z
  .union([z.number(), z.string()])
  .transform((value): number | undefined => {
    if (typeof value === "number")
      return Number.isInteger(value) && value >= 0 && value <= 6
        ? value
        : undefined;
    const named = WEEKDAY_NAMES[value.trim().toLowerCase()];
    if (named !== undefined) return named;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : undefined;
  });
const hourOutput = z.number().min(0).max(24);
const hourRangeOutput = z
  .union([
    z.tuple([hourOutput, hourOutput]),
    z.object({ from: hourOutput, to: hourOutput }),
    z.object({ start: hourOutput, end: hourOutput }),
  ])
  .transform((value): [number, number] =>
    Array.isArray(value)
      ? value
      : "from" in value
        ? [value.from, value.to]
        : [value.start, value.end],
  );

export const routineOutputSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  when: z.looseObject({
    weekdays: z
      .array(weekdayOutput)
      .transform((list) => list.filter((d): d is number => d !== undefined))
      .optional(),
    hourRange: hourRangeOutput,
  }),
  steps: z
    .array(
      z.looseObject({
        appId: z.string(),
        host: z.string().optional(),
        action: z.string().optional(),
      }),
    )
    .min(1),
  seen: z.number().optional(),
  lastSeen: z.string().optional(),
  confidence: z.number().optional(),
  status: z.string().optional(),
});
export type RoutineOutput = z.infer<typeof routineOutputSchema>;

/** A SkillStep as src/memory/types.ts has it, read loosely. */
export const skillStepOutputSchema = z.looseObject({
  action: z.record(z.string(), z.unknown()),
  target: z
    .looseObject({ role: z.string().optional(), label: z.string() })
    .optional(),
  expectAppId: z.string().optional(),
});
export type SkillStepOutput = z.infer<typeof skillStepOutputSchema>;

export const procedureOutputSchema = z.looseObject({
  id: z.string().optional(),
  trigger: z.string(),
  steps: z.array(skillStepOutputSchema).min(1),
  observedRuns: z.number().optional(),
  slots: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  status: z.enum(["proposed", "approved", "retired"]).optional(),
});
export type ProcedureOutput = z.infer<typeof procedureOutputSchema>;

export const preferenceOutputSchema = z.looseObject({
  text: z.string(),
  source: z.string().optional(),
  weight: z.number().optional(),
});

export const consolidationOutputSchema = z.looseObject({
  routines: z.array(routineOutputSchema).default([]),
  procedures: z.array(procedureOutputSchema).default([]),
  preferences: z.array(preferenceOutputSchema).default([]),
});
export type ConsolidationOutput = z.infer<typeof consolidationOutputSchema>;

// ---- Matching ---------------------------------------------------------------

/** Lower case, ellipses and punctuation dropped, whitespace collapsed. */
export const normalizeLabel = (text: string): string =>
  text
    .toLowerCase()
    .replace(/…|\.\.\./g, "")
    .replace(/[^a-z0-9{}]+/g, " ")
    .trim();

const isSubsequence = (needle: string[], hay: string[]): boolean => {
  let i = 0;
  for (const item of hay) if (i < needle.length && item === needle[i]) i++;
  return i === needle.length;
};

/** Whether two [from, to] hour windows touch, with `slackHours` of tolerance. */
export const hoursOverlap = (
  a: [number, number],
  b: [number, number],
  slackHours = 1,
): boolean => a[0] - slackHours <= b[1] && b[0] <= a[1] + slackHours;

/**
 * A found routine recovers a planted one when the planted apps are an
 * ordered subsequence of its steps, it has at most one app more than was
 * planted, its hour window touches the planted one (an hour of slack) and,
 * when it names weekdays, one of them was planted.
 */
export function routineMatches(
  planted: PlantedRoutine,
  found: RoutineOutput,
): boolean {
  const apps = found.steps.map((step) => step.appId);
  if (!isSubsequence(planted.apps, apps)) return false;
  if (apps.length > planted.apps.length + 1) return false;
  if (!hoursOverlap(planted.hourRange, found.when.hourRange)) return false;
  const weekdays = found.when.weekdays;
  if (
    weekdays &&
    weekdays.length &&
    !weekdays.some((d) => planted.weekdays.includes(d))
  )
    return false;
  return true;
}

export interface RoutineScore {
  planted: number;
  found: number;
  /** Planted routines some found routine recovers. */
  recovered: number;
  /** Found routines that recover a planted one (duplicates count). */
  matched: number;
  /** Found routines that recover none. */
  invented: number;
  recall: number;
  precision: number;
  /** Per planted routine: whether it was recovered. */
  byRoutine: { id: string; recovered: boolean }[];
}

export function scoreRoutines(
  planted: PlantedRoutine[],
  found: RoutineOutput[],
): RoutineScore {
  const byRoutine = planted.map((p) => ({
    id: p.id,
    recovered: found.some((f) => routineMatches(p, f)),
  }));
  const matched = found.filter((f) =>
    planted.some((p) => routineMatches(p, f)),
  );
  const recovered = byRoutine.filter((r) => r.recovered).length;
  return {
    planted: planted.length,
    found: found.length,
    recovered,
    matched: matched.length,
    invented: found.length - matched.length,
    recall: planted.length ? recovered / planted.length : 1,
    precision: found.length ? matched.length / found.length : 1,
    byRoutine,
  };
}

/** The core action types a SkillStep may carry for each observed kind. */
export const STEP_TYPES: Record<ActionKind, readonly string[]> = {
  click: ["click_control", "click"],
  double_click: ["double_click", "click_control", "click"],
  right_click: ["right_click", "click_control"],
  key_chord: ["hotkey", "key"],
  typing: ["type_text"],
  scroll: ["scroll"],
  app_switch: ["open_app"],
  menu_item: ["menu_item"],
};

const MODIFIERS: Record<string, string> = {
  COMMAND: "CMD",
  META: "CMD",
  SUPER: "CMD",
  OPTION: "OPT",
  ALT: "OPT",
  CONTROL: "CTRL",
};
/** "cmd+shift+s", ["Command","S"] and "CMD+S" compare as sorted tokens. */
export const normalizeChord = (chord: string | string[]): string =>
  (Array.isArray(chord) ? chord : chord.split("+"))
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)
    .map((token) => MODIFIERS[token] ?? token)
    .sort()
    .join("+");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const asStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;

/** The label a SkillStep names: its target's, else the action's own. */
const stepLabel = (step: SkillStepOutput): string | undefined =>
  step.target?.label ??
  asString(step.action.label) ??
  asString(step.action.field) ??
  asString(step.action.name);

const stepPath = (step: SkillStepOutput): string[] | undefined =>
  asStrings(step.action.path) ??
  asStrings(step.action.menu) ??
  asStrings(step.action.items);

/**
 * Whether a SkillStep replays a planted step: the action type is one the
 * observed kind maps to (or the kind itself), and every detail the planted
 * step carries (label, field, chord, menu, app) agrees with the detail the
 * SkillStep names, when it names one.
 */
export function stepMatches(
  planted: PlantedStep,
  step: SkillStepOutput,
): boolean {
  const type = asString(step.action.type) ?? asString(step.action.kind) ?? "";
  if (type !== planted.kind && !STEP_TYPES[planted.kind].includes(type))
    return false;
  const label = stepLabel(step);
  if (planted.label !== undefined) {
    if (label === undefined) return false;
    if (normalizeLabel(label) !== normalizeLabel(planted.label)) return false;
  }
  if (planted.field !== undefined) {
    if (label === undefined) return false;
    if (normalizeLabel(label) !== normalizeLabel(planted.field)) return false;
  }
  if (planted.chord !== undefined) {
    const keys =
      asStrings(step.action.keys) ??
      asString(step.action.chord) ??
      asString(step.action.keys) ??
      asString(step.action.key);
    if (
      keys !== undefined &&
      normalizeChord(keys) !== normalizeChord(planted.chord)
    )
      return false;
  }
  if (planted.menu !== undefined) {
    const path = stepPath(step);
    const last = path ? path.at(-1) : label;
    if (last === undefined) return false;
    if (normalizeLabel(last) !== normalizeLabel(planted.menu.at(-1) ?? ""))
      return false;
  }
  if (planted.appId !== undefined) {
    const named =
      step.expectAppId ??
      asString(step.action.appId) ??
      asString(step.action.bundleId) ??
      asString(step.action.app);
    if (planted.kind === "app_switch") {
      const name = asString(step.action.name) ?? asString(step.action.app);
      const ok =
        named === planted.appId ||
        (name !== undefined &&
          planted.appName !== undefined &&
          normalizeLabel(name) === normalizeLabel(planted.appName));
      if (!ok) return false;
    } else if (named !== undefined && named !== planted.appId) return false;
  }
  return true;
}

/** Longest common subsequence of planted steps and found steps under stepMatches. */
export function stepOverlap(
  planted: PlantedStep[],
  found: SkillStepOutput[],
): number {
  const rows = planted.length;
  const cols = found.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = 1; i <= rows; i++)
    for (let j = 1; j <= cols; j++)
      table[i][j] = stepMatches(planted[i - 1], found[j - 1])
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
  return table[rows][cols];
}

export interface ProcedureScore {
  id: string;
  /** Some found procedure replays at least half the planted steps, in order. */
  recovered: boolean;
  plantedSteps: number;
  foundSteps: number;
  matchedSteps: number;
  stepRecall: number;
  stepPrecision: number;
  observedRuns?: number;
  /** For a planted slot: whether the found procedure carries a slot. */
  slotReported?: boolean;
}

export function scoreProcedures(
  planted: PlantedProcedure[],
  found: ProcedureOutput[],
): { byProcedure: ProcedureScore[]; unmatched: number } {
  const taken = new Set<number>();
  const byProcedure = planted.map((p): ProcedureScore => {
    let best: { index: number; overlap: number } | undefined;
    found.forEach((f, index) => {
      const overlap = stepOverlap(p.steps, f.steps);
      if (
        !best ||
        overlap > best.overlap ||
        (overlap === best.overlap &&
          f.steps.length < found[best.index].steps.length)
      )
        best = { index, overlap };
    });
    if (!best || best.overlap === 0)
      return {
        id: p.id,
        recovered: false,
        plantedSteps: p.steps.length,
        foundSteps: 0,
        matchedSteps: 0,
        stepRecall: 0,
        stepPrecision: 0,
      };
    taken.add(best.index);
    const f = found[best.index];
    const hasSlot =
      (f.slots?.length ?? 0) > 0 ||
      /\{slot\d+\}/.test(f.trigger) ||
      f.steps.some((s) => /\{slot\d+\}/.test(JSON.stringify(s.action)));
    return {
      id: p.id,
      recovered: best.overlap * 2 >= p.steps.length,
      plantedSteps: p.steps.length,
      foundSteps: f.steps.length,
      matchedSteps: best.overlap,
      stepRecall: best.overlap / p.steps.length,
      stepPrecision: f.steps.length ? best.overlap / f.steps.length : 0,
      observedRuns: f.observedRuns,
      slotReported: p.slots.length ? hasSlot : undefined,
    };
  });
  return { byProcedure, unmatched: found.length - taken.size };
}

export interface PreferenceScore {
  id: string;
  /** Some preference names the subject. */
  reported: boolean;
  /** A preference on the subject carries the value after the flip. */
  later: boolean;
  /** A preference on the subject carries only the value before the flip. */
  stale: boolean;
}

export function scorePreferences(
  planted: PlantedPreference[],
  found: { text: string }[],
): PreferenceScore[] {
  const mentions = (text: string, words: string[]) =>
    words.some((w) => normalizeLabel(text).includes(normalizeLabel(w)));
  return planted.map((p) => {
    const onSubject = found.filter((f) => mentions(f.text, p.subject));
    return {
      id: p.id,
      reported: onSubject.length > 0,
      later: onSubject.some((f) => mentions(f.text, p.later)),
      stale: onSubject.some(
        (f) => mentions(f.text, p.earlier) && !mentions(f.text, p.later),
      ),
    };
  });
}

export interface Target {
  target: number;
  value: number;
  met: boolean;
}

export interface OutputScore {
  routines: RoutineScore;
  procedures: ProcedureScore[];
  /** Found procedures that replay no planted one. */
  unmatchedProcedures: number;
  preferences: PreferenceScore[];
  targets: {
    /** ≥ TARGETS.routineRecall. */
    routineRecall: Target;
    /** ≤ TARGETS.inventedRoutinesPerFiveDays per five days, floored at one. */
    inventedRoutines: Target;
  };
}

/** Score a consolidator's final output against the planted truth over `days` days. */
export function scoreOutput(
  planted: PlantedTruth,
  output: ConsolidationOutput,
  days: number,
): OutputScore {
  const routines = scoreRoutines(planted.routines, output.routines);
  const procedures = scoreProcedures(planted.procedures, output.procedures);
  const inventedAllowed = Math.max(
    1,
    Math.floor((days / 5) * TARGETS.inventedRoutinesPerFiveDays),
  );
  return {
    routines,
    procedures: procedures.byProcedure,
    unmatchedProcedures: procedures.unmatched,
    preferences: scorePreferences(planted.preferences, output.preferences),
    targets: {
      routineRecall: {
        target: TARGETS.routineRecall,
        value: routines.recall,
        met: routines.recall >= TARGETS.routineRecall,
      },
      inventedRoutines: {
        target: inventedAllowed,
        value: routines.invented,
        met: routines.invented <= inventedAllowed,
      },
    },
  };
}

/** The input-token target over the days consolidated. */
export function tokenTarget(inputTokensPerDay: number[]): Target & {
  days: number;
  missedDays: number;
  max: number;
} {
  const max = inputTokensPerDay.reduce((a, b) => Math.max(a, b), 0);
  const missedDays = inputTokensPerDay.filter(
    (n) => n > TARGETS.inputTokensPerDay,
  ).length;
  return {
    target: TARGETS.inputTokensPerDay,
    value: max,
    met: missedDays === 0,
    days: inputTokensPerDay.length,
    missedDays,
    max,
  };
}
