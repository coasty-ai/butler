/**
 * Watching how the owner works (.data/design/observer.md): the two events
 * the native stream emits (§2, lane O1 owns their names and fields; these
 * schemas are what lane O2 accepts of them), the work log's content-free
 * digest (§3), and the shapes consolidation proposes (§4) as zod schemas
 * over the storage types in src/memory/types.ts. Nothing here reads or
 * writes a file; src/observer/log.ts and consolidate.ts do.
 */
import { z } from "zod";
import type { ObserverTier } from "../core/schema";
import type {
  MemoryData,
  Preference,
  Procedure,
  ProposalStatus,
  Routine,
  RoutineStep,
  RoutineWindow,
  SkillStep,
} from "../memory/types";

// ---------------------------------------------------------------------------
// The observe stream (design §2).

/** A named control on the surface: its role and label, never a value. */
export const controlSchema = z
  .object({ role: z.string().max(60), label: z.string().max(120) })
  .strict();
export const excludedSchema = z.enum([
  "secure_input",
  "protected",
  "locked",
  "own_run",
  "idle",
]);
export type ObserveExcluded = z.infer<typeof excludedSchema>;
/**
 * One frame: what is in front and what it offers. Unknown keys are dropped
 * rather than refused, so an addition at the source costs nothing here. A
 * frame with `excluded` carries nothing but the application (and a run id
 * for the owner's own run); the log enforces that again before writing.
 */
export const observeFrameSchema = z.object({
  event: z.literal("observe_frame"),
  atMs: z.number().finite().nonnegative(),
  appId: z.string().max(200).optional(),
  appName: z.string().max(100).optional(),
  windowTitle: z.string().max(120).optional(),
  /** The web host only, never a path or query. */
  host: z.string().max(253).optional(),
  focusedRole: z.string().max(60).optional(),
  /** The focused field's label, never its value. */
  focusedLabel: z.string().max(120).optional(),
  controls: z.array(controlSchema).max(60).default([]),
  /** Tier "text" and above: the surface's words, redacted, ≤ 1,500 chars. */
  textDigest: z.string().max(1500).optional(),
  /** Tier "pixels": a JPEG ≤ 512 px wide as base64; never for protected surfaces. */
  image: z.string().max(600_000).optional(),
  excluded: excludedSchema.optional(),
  /** An own_run frame names the run and nothing else. */
  runId: z.string().max(64).optional(),
});
export type ObserveFrame = z.infer<typeof observeFrameSchema>;

export const actionKindSchema = z.enum([
  "click",
  "double_click",
  "right_click",
  "key_chord",
  "typing",
  "scroll",
  "app_switch",
  "menu_item",
]);
export type ObserveActionKind = z.infer<typeof actionKindSchema>;
/** One owner action, content-free by construction: a kind, a target's name, a count. */
export const observeActionSchema = z.object({
  event: z.literal("observe_action"),
  atMs: z.number().finite().nonnegative(),
  appId: z.string().max(200),
  kind: actionKindSchema,
  target: controlSchema.optional(),
  /** "CMD+S": modifiers and a non-text key; never a character key alone. */
  chord: z.string().max(40).optional(),
  /** A typing burst: the field's label and a count, never the characters. */
  typed: z
    .object({
      field: z.string().max(120),
      chars: z.number().int().nonnegative(),
      ms: z.number().finite().nonnegative(),
    })
    .optional(),
  scroll: z
    .object({
      direction: z.enum(["up", "down"]),
      ticks: z.number().int().nonnegative(),
    })
    .optional(),
  /** The menu path for menu_item. */
  menu: z.array(z.string().max(80)).max(12).optional(),
});
export type ObserveAction = z.infer<typeof observeActionSchema>;
/** The helper dropped frames at the source (its own caps): how many and why. */
export const observeDroppedSchema = z.object({
  event: z.literal("observe_dropped"),
  atMs: z.number().finite().nonnegative().optional(),
  reason: z.string().max(40).optional(),
  dropped: z.number().int().nonnegative().optional(),
  /** An older spelling of `dropped`. */
  count: z.number().int().nonnegative().optional(),
});
export type ObserveDropped = z.infer<typeof observeDroppedSchema>;
export const observedEventSchema = z.discriminatedUnion("event", [
  observeFrameSchema,
  observeActionSchema,
  observeDroppedSchema,
]);
export type ObservedEvent = z.infer<typeof observedEventSchema>;

// ---------------------------------------------------------------------------
// The work log's digest (design §3, §7): counts only, for the report
// (scripts/observer-report.mjs, lane O3, reads these keys).

/** One day's counters. */
export interface DayDigest {
  day: string;
  /** Frames written (excluded frames counted under `excluded`, not here). */
  frames: number;
  /** Actions written. */
  actions: number;
  /** Bytes on disk for the day (the encrypted lines). */
  bytesWritten: number;
  /** Bytes of what the log refused, as the events measured before sealing. */
  bytesDropped: number;
  /** Events the log refused, whatever the reason. */
  framesDropped: number;
  /** Excluded frames written, by code. */
  excluded: Record<string, number>;
  /** Frames written, by bundle id ("" for a frame without one). */
  apps: Record<string, number>;
  /** Actions written, by kind. */
  actionKinds: Record<string, number>;
  /** framesDropped by reason: over the day's cap, a credential finding, malformed, while paused, or dropped by the helper. */
  dropped: {
    size: number;
    credential: number;
    invalid: number;
    paused: number;
    helper: number;
  };
  /** Frames currently carrying a picture (tier "pixels", expire after 24 h). */
  images: number;
}
export const emptyDayDigest = (day: string): DayDigest => ({
  day,
  frames: 0,
  actions: 0,
  bytesWritten: 0,
  bytesDropped: 0,
  framesDropped: 0,
  excluded: {},
  apps: {},
  actionKinds: {},
  dropped: { size: 0, credential: 0, invalid: 0, paused: 0, helper: 0 },
  images: 0,
});
/** How many of a kind of proposal stand in each state; `observed` is every one ever kept. */
export interface StatusCounts {
  proposed: number;
  approved: number;
  retired: number;
  observed: number;
}
/** The whole picture the report reads: every day on disk, and memory's counts. */
export interface WorkLogDigest {
  days: DayDigest[];
  routines: StatusCounts;
  procedures: StatusCounts;
  preferences: StatusCounts;
  /** Replays of approved routines, by outcome. */
  replays: Record<string, number>;
}
const statusCounts = (
  items: { status?: string }[],
  observed = items.length,
): StatusCounts => ({
  proposed: items.filter((i) => i.status === "proposed").length,
  approved: items.filter((i) => i.status === "approved").length,
  retired: items.filter((i) => i.status === "retired").length,
  observed,
});
/** Memory's side of the digest: counts by status and replays by outcome. */
export function memoryDigest(
  data: Pick<MemoryData, "routines" | "procedures" | "preferences"> | undefined,
): Omit<WorkLogDigest, "days"> {
  if (!data)
    return {
      routines: statusCounts([]),
      procedures: statusCounts([]),
      preferences: statusCounts([]),
      replays: {},
    };
  const observed = data.preferences.filter((p) => p.source === "observed");
  const replays: Record<string, number> = {};
  for (const r of data.routines)
    for (const [outcome, n] of Object.entries(r.runs ?? {}))
      if (n) replays[outcome] = (replays[outcome] ?? 0) + n;
  return {
    routines: statusCounts(data.routines),
    procedures: statusCounts(data.procedures),
    preferences: statusCounts(
      observed.map((p) => ({ status: p.status ?? "approved" })),
      observed.length,
    ),
    replays,
  };
}

// ---------------------------------------------------------------------------
// What consolidation proposes (design §4), over the storage shapes.

export const proposalStatusSchema = z.enum([
  "proposed",
  "approved",
  "retired",
  "never",
]) satisfies z.ZodType<ProposalStatus>;
const hour = z.number().int().min(0).max(24);
export const routineWindowSchema = z
  .object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hourRange: z.tuple([hour, hour]),
  })
  .refine((w) => w.hourRange[0] < w.hourRange[1], {
    message: "The hour window must end after it starts.",
  }) satisfies z.ZodType<RoutineWindow>;
export const routineStepSchema = z.object({
  appId: z.string().min(1).max(200),
  appName: z.string().min(1).max(100).optional(),
  host: z.string().min(1).max(253).optional(),
  action: z.string().min(1).max(80).optional(),
}) satisfies z.ZodType<RoutineStep>;
/** The action types a proposed procedure step may carry; the runner still judges each. */
export const PROCEDURE_ACTION_TYPES = [
  "open_app",
  "open_url",
  "open_file",
  "click_control",
  "hotkey",
  "key",
  "menu_item",
  "type_text",
  "scroll",
  "wait",
] as const;
export const skillStepSchema = z.object({
  action: z
    .record(z.string().max(40), z.unknown())
    .refine(
      (a) =>
        typeof a.type === "string" &&
        (PROCEDURE_ACTION_TYPES as readonly string[]).includes(a.type) &&
        JSON.stringify(a).length <= 2000,
      { message: "A step's action must be one of the replayable types." },
    ),
  target: controlSchema.optional(),
  expectAppId: z.string().max(200).optional(),
}) satisfies z.ZodType<SkillStep>;
export const routineSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal("routine"),
  name: z.string().min(1).max(80),
  tokens: z.array(z.string().max(40)).max(40),
  when: routineWindowSchema,
  steps: z.array(routineStepSchema).min(1).max(12),
  seen: z.number().int().min(0),
  firstSeen: z.string().max(40),
  lastSeen: z.string().max(40),
  confidence: z.number().min(0).max(1),
  status: proposalStatusSchema,
  procedureId: z.string().max(80).optional(),
  runs: z.object({
    completed: z.number().int().min(0),
    corrected: z.number().int().min(0),
    undone: z.number().int().min(0),
    declined: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  correctionStreak: z.number().int().min(0),
  corrections: z.array(z.string().max(300)).max(10).optional(),
  lastRunAt: z.string().max(40).optional(),
  offeredAt: z.string().max(40).optional(),
}) satisfies z.ZodType<Routine>;
export const procedureSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal("procedure"),
  trigger: z.string().min(1).max(200),
  tokens: z.array(z.string().max(40)).max(40),
  slots: z.array(z.string().max(40)).max(6),
  steps: z.array(skillStepSchema).min(1).max(30),
  observedRuns: z.number().int().min(0),
  lastSeen: z.string().max(40),
  confidence: z.number().min(0).max(1),
  status: proposalStatusSchema,
  skillId: z.string().max(80).optional(),
}) satisfies z.ZodType<Procedure>;

/**
 * What the model answers at consolidation: a JSON object with these three
 * lists and nothing else the merge reads. Every entry carries its evidence
 * count; a preference may contradict one already held.
 */
export const consolidationOutputSchema = z.object({
  routines: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        hourRange: z.tuple([hour, hour]),
        steps: z.array(routineStepSchema).min(1).max(12),
        seen: z.number().int().min(1).max(1000),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20)
    .default([]),
  procedures: z
    .array(
      z.object({
        trigger: z.string().min(1).max(200),
        slots: z.array(z.string().max(40)).max(6).default([]),
        steps: z.array(skillStepSchema).min(1).max(30),
        observedRuns: z.number().int().min(1).max(1000),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20)
    .default([]),
  preferences: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        evidence: z.number().int().min(1).max(1000),
        stance: z.enum(["supports", "contradicts"]).default("supports"),
      }),
    )
    .max(30)
    .default([]),
});
export type ConsolidationOutput = z.infer<typeof consolidationOutputSchema>;

// ---------------------------------------------------------------------------
// Status for the Watching pane and the menu bar.

/** How one consolidation ended (src/observer/consolidate.ts). */
export type ConsolidationCode =
  "ok" | "empty" | "budget" | "privacy" | "parse" | "model";
export type WatchingState = "off" | "on" | "paused";
/** What the Watching pane shows: settings in force, counts, never content. */
export interface WatchingStatus {
  on: boolean;
  tier: ObserverTier;
  paused: boolean;
  state: WatchingState;
  retentionDays: number;
  /** The observer folder under userData. */
  path: string;
  today: DayDigest;
  /** Days on disk, oldest first. */
  days: string[];
  bytes: number;
  consolidation: {
    lastAt?: string;
    lastCode?: ConsolidationCode;
    tokensToday: number;
    budget: number;
    idleMinutes: number;
  };
}

/** An observed preference: the existing Preference with source "observed". */
export type ObservedPreference = Preference & { source: "observed" };
export const isObservedPreference = (p: Preference): p is ObservedPreference =>
  p.source === "observed";
