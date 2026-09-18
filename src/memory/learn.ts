import type { LearnInput, TrajectoryStep } from "../core/memory";
import { redactSecrets, scanText } from "../core/sanitize";
import {
  CONTROL_LABEL_LIMIT,
  normalizeRole,
  REPLAYABLE_ROLES,
  utf16Prefix,
} from "../core/labels";
import { bound, tokenize } from "./retrieve";
import { normalizeTask, opensApp, replayable, templateOf } from "./skills";
import {
  addEpisodeTo,
  markSkillIn,
  prune,
  recordAppUseIn,
  stableId,
  upsertPreferenceIn,
  upsertSkillIn,
} from "./store";
import type { MemoryData, Skill, SkillStep } from "./types";

/** Plan abandon reasons caused by the user or system pausing, not the skill. */
const INTERRUPTIONS = new Set(["paused", "takeover", "interrupted"]);

/** Longest procedure stored as a skill. */
export const MAX_SKILL_STEPS = 30;

const POINTER = new Set([
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
]);
// Steps a skill can replay as they were recorded. Named targets belong here
// for the same reason they exist: a menu path and a control name resolve again
// on a screen that has moved on, where a coordinate would not.
const KEPT = new Set([
  "open_app",
  "open_file",
  "menu_item",
  "click_control",
  "hotkey",
  "key",
  "type_text",
  "scroll",
  "wait",
]);

const hasCredential = (text: string) =>
  scanText(text).some((f) => f.action === "BLOCK_UPLOAD");

const PLACEHOLDER_ONLY = /^(?:\s|\[Sensitive text omitted\])*$/;

export interface LearnResult {
  episode: boolean;
  preferences: number;
  skill?: "created" | "merged" | "replaced" | "kept" | "dropped";
  planEvidence?: "success" | "failure";
}

const skillIdOf = (planId: string) =>
  planId.startsWith("skill:") ? planId.slice("skill:".length) : planId;

/**
 * Turn a successful trajectory into skill steps. Returns undefined when the
 * run cannot become a skill (credential, nothing kept, too long).
 */
export function extractSkill(
  task: string,
  steps: TrajectoryStep[],
  now: Date,
): Skill | undefined {
  if (hasCredential(task)) return undefined;
  const normalized = normalizeTask(task);
  const slots: string[] = [];
  const skillSteps: SkillStep[] = [];
  let hintOnly = false;
  for (const step of steps) {
    const action = step?.action;
    if (!action || typeof action.type !== "string") continue;
    const type = action.type;
    const { frame_id: _frame, ...rest } = action;
    void _frame;
    // Every text-bearing field is checked; a credential drops the whole skill.
    for (const value of Object.values(rest))
      if (typeof value === "string" && hasCredential(value)) return undefined;
    // Opening an app or file works from any frontmost app; the app that was
    // frontmost before it (often wherever the user started) is not a precondition.
    const expect =
      step.appId && !opensApp(action) ? { expectAppId: step.appId } : {};
    if (POINTER.has(type)) {
      const rawLabel = step.target?.label;
      const rawRole = step.target?.role;
      const label =
        typeof rawLabel === "string"
          ? utf16Prefix(
              rawLabel.replace(/\s+/g, " ").trim(),
              CONTROL_LABEL_LIMIT,
            )
          : "";
      const role = typeof rawRole === "string" ? rawRole.trim() : "";
      const pointer: Record<string, unknown> = { type };
      if (typeof rest.button === "string") pointer.button = rest.button;
      // Replay finds the control by role and label among the grounded
      // controls; a drag, a missing label or a role those walks never report
      // (menu bar, menu and Dock items, cells) cannot resolve.
      if (
        type === "drag" ||
        !label ||
        !REPLAYABLE_ROLES.has(normalizeRole(role))
      )
        hintOnly = true;
      skillSteps.push({
        action: pointer,
        ...(role || label ? { target: { role, label } } : {}),
        ...expect,
      });
      continue;
    }
    if (!KEPT.has(type)) continue;
    if (type === "type_text" && typeof rest.text === "string") {
      const typed = rest.text.trim();
      const key = typed.toLowerCase();
      if (
        typed.length >= 2 &&
        new RegExp(
          `(?<![\\p{L}\\p{N}])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
          "u",
        ).test(normalized)
      ) {
        let n = slots.findIndex((s) => s.toLowerCase() === key);
        if (n < 0) {
          slots.push(typed);
          n = slots.length - 1;
        }
        skillSteps.push({
          action: { ...rest, text: rest.text.replace(typed, `{slot${n}}`) },
          ...expect,
        });
        continue;
      }
    }
    skillSteps.push({ action: { ...rest }, ...expect });
  }
  if (!skillSteps.length || skillSteps.length > MAX_SKILL_STEPS)
    return undefined;
  const trigger = templateOf(task, slots);
  // Slots must all appear in the trigger, and some literal words must remain.
  if (slots.some((_, i) => !trigger.includes(`{slot${i}}`))) return undefined;
  const literal = tokenize(trigger.replace(/\{slot\d+\}/g, " "));
  if (!literal.length || trigger.length > 300) return undefined;
  const stamp = now.toISOString();
  return {
    id: stableId("skill", trigger),
    kind: "skill",
    trigger,
    tokens: literal,
    slots: slots.map((_, i) => `slot${i}`),
    steps: skillSteps,
    hintOnly,
    successes: 1,
    failures: 0,
    createdAt: stamp,
    lastUsed: stamp,
  };
}

/** An open step's frontmost app from skills learned before it was dropped. */
const withoutOpenApp = (step: SkillStep): SkillStep => {
  if (!step?.expectAppId || !opensApp(step.action)) return step;
  const { expectAppId: _app, ...rest } = step;
  void _app;
  return rest;
};

/** What makes two steps the same procedure: wait durations do not. */
const comparable = (step: SkillStep) => {
  const plain = withoutOpenApp(step);
  return {
    action:
      plain?.action?.type === "wait" ? { type: "wait" } : (plain?.action ?? {}),
    target: plain?.target ?? null,
    expectAppId: plain?.expectAppId ?? null,
  };
};

const sameSteps = (a: SkillStep[], b: SkillStep[]) =>
  a.length === b.length &&
  JSON.stringify(a.map(comparable)) === JSON.stringify(b.map(comparable));

/** Apply the learning rules of docs/MEMORY.md to the data in place. */
export function learnFromRun(
  data: MemoryData,
  input: LearnInput,
  now: Date,
): LearnResult {
  const result: LearnResult = { episode: false, preferences: 0 };
  if (!input || input.synthetic) return result;
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const corrections = (input.corrections ?? [])
    .filter((c): c is string => typeof c === "string")
    .map((c) => bound(redactSecrets(c.replace(/\s+/g, " ").trim()), 300))
    .filter((c) => !PLACEHOLDER_ONLY.test(c));

  // The user acted during the run (takeover, hand-off or correction): the
  // trajectory misses their steps, so no skill is learned or credited.
  const handsOn =
    input.handsOn === true ||
    (Array.isArray(input.corrections) &&
      input.corrections.some((c) => typeof c === "string" && c.trim() !== ""));

  // App usage: launched apps count, and each app seen in this run once. A
  // built-in intent's own launch (its preferred browser, say) is not a choice
  // by the user or the model, so neither it nor seeing that app afterwards
  // counts, unless the app was already frontmost before the launch.
  const launched = new Map<string, string | undefined>();
  const intentLaunched = new Set<string>();
  const frontmost = new Set<string>();
  for (const step of steps) {
    if (!step) continue;
    if (typeof step.appId === "string") frontmost.add(step.appId);
    if (typeof step.launchedAppId !== "string" || !step.launchedAppId) continue;
    if (step.fromPlan === "intent") {
      if (!frontmost.has(step.launchedAppId))
        intentLaunched.add(step.launchedAppId);
    } else
      launched.set(
        step.launchedAppId,
        typeof step.action?.name === "string" ? step.action.name : undefined,
      );
  }
  const seen = new Set(
    (input.appsSeen ?? []).filter((a): a is string => typeof a === "string"),
  );
  for (const [bundleId, name] of launched) {
    recordAppUseIn(data, bundleId, name, now);
    seen.delete(bundleId);
  }
  for (const bundleId of intentLaunched) seen.delete(bundleId);
  for (const bundleId of seen) recordAppUseIn(data, bundleId, undefined, now);

  // Episode.
  const task = bound(redactSecrets(String(input.task ?? "").trim()), 500);
  if (task) {
    addEpisodeTo(data, {
      id: String(input.runId),
      kind: "episode",
      task,
      tokens: tokenize(task),
      status: input.status,
      ...(typeof input.outcome === "boolean" ? { outcome: input.outcome } : {}),
      apps: [
        ...new Set([
          ...launched.keys(),
          ...intentLaunched,
          ...(input.appsSeen ?? []),
        ]),
      ]
        .filter((a) => typeof a === "string")
        .slice(0, 8),
      summary: bound(redactSecrets(String(input.summary ?? "")), 300),
      corrections,
      actions: steps.length,
      cost: Number(input.usage?.cost) || 0,
      createdAt: now.toISOString(),
    });
    result.episode = true;
  }

  // Preferences from corrections. Their tokens include the task they
  // corrected, so the same or a similar task recalls them even when the
  // correction names a different value ("send it to dr.lee@…").
  const taskTokens = tokenize(task);
  for (const correction of corrections)
    if (upsertPreferenceIn(data, correction, "correction", now, taskTokens))
      result.preferences += 1;

  // Replacement is decided from each skill's state before this run's
  // evidence, so one bad run cannot both demote and overwrite a proven skill.
  const replayableBefore = new Set(
    data.skills.filter((s) => replayable(s)).map((s) => s.id),
  );

  const succeeded =
    input.status === "completed" && input.outcome !== false && steps.length > 0;

  // Plan evidence. An abandoned replay, or one whose run the user rejected or
  // that ended failed or cancelled after every step ran, is a failure. A full
  // replay counts as a success only when the run completed hands-off.
  if (input.plan?.source === "skill") {
    const skillId = skillIdOf(input.plan.id);
    const skill = data.skills.find((s) => s.id === skillId);
    if (skill) {
      const replayedAll = input.plan.completedSteps >= skill.steps.length;
      const endedBadly =
        (input.status === "failed" || input.status === "cancelled") &&
        input.outcome !== true;
      // A pause or takeover that the run recovered from without a correction
      // (an accidental touch, a false wake) says nothing about the skill.
      const interruptedOnly =
        input.plan.abandoned &&
        INTERRUPTIONS.has(String(input.plan.abandonReason ?? "")) &&
        input.status === "completed" &&
        input.outcome !== false &&
        corrections.length === 0;
      if (interruptedOnly) {
        // Neutral: no success or failure recorded.
      } else if (
        input.plan.abandoned ||
        input.outcome === false ||
        (replayedAll && endedBadly)
      ) {
        markSkillIn(data, skillId, false, now);
        result.planEvidence = "failure";
      } else if (input.status === "completed" && replayedAll && !handsOn) {
        markSkillIn(data, skillId, true, now);
        result.planEvidence = "success";
      }
    }
  }

  // Skills: only from successful, hands-off, non-intent runs whose plan (if
  // any) did not already account for the evidence.
  const planHandled =
    input.plan?.source === "intent" ||
    (input.plan?.source === "skill" && !input.plan.abandoned);
  if (succeeded && !planHandled && !handsOn) {
    const skill = extractSkill(input.task, steps, now);
    if (!skill) result.skill = "dropped";
    else {
      const existing = data.skills.find(
        (s) => s.id === skill.id || s.trigger === skill.trigger,
      );
      if (!existing) {
        upsertSkillIn(data, skill);
        result.skill = "created";
      } else if (sameSteps(existing.steps, skill.steps)) {
        existing.steps = existing.steps.map(withoutOpenApp);
        existing.successes += 1;
        existing.lastUsed = now.toISOString();
        result.skill = "merged";
      } else if (!replayableBefore.has(existing.id)) {
        // A skill that cannot replay (unproven, demoted by failures or hint
        // only, which includes failures >= successes) gives way to the newest
        // working procedure.
        upsertSkillIn(data, { ...skill, id: existing.id });
        result.skill = "replaced";
      } else result.skill = "kept";
    }
  }
  prune(data, now);
  return result;
}
