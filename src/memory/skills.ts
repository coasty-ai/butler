import { redactSecrets } from "../core/sanitize";
import { normalizeRole } from "../core/labels";
import { builtinToolTitle } from "../core/tool-text";
import { bound, CONTEXT_LIMITS } from "./retrieve";
import type { PlanStep, ReplayPlan } from "../core/memory";
import type { Skill } from "./types";

/** Collapse whitespace, trim trailing sentence punctuation; keeps case. */
export const cleanTask = (task: string) =>
  task
    .normalize("NFKC")
    .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,\s]+$/u, "");

/** Remove politeness wrappers that do not change the request. */
export function stripPoliteness(task: string): string {
  let text = cleanTask(task);
  for (;;) {
    const next = text
      .replace(
        /^(?:hey |ok |okay )?(?:please |pls |can you |could you |would you |will you |i want to |i'd like to |i would like to |let's |lets )+/i,
        "",
      )
      .replace(/ (?:please|for me|now|right now)$/i, "")
      .trim();
    if (next === text) return text;
    text = next;
  }
}

export const normalizeTask = (task: string) =>
  stripPoliteness(task).toLowerCase();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Normalized task with each slot value (in order) replaced by {slotN}. */
export function templateOf(task: string, slots: string[]): string {
  let template = normalizeTask(task);
  slots.forEach((value, i) => {
    const v = normalizeTask(value);
    if (!v) return;
    template = template.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, "u"),
      `{slot${i}}`,
    );
  });
  return template;
}

/**
 * open_app and open_file work from any frontmost app and replace it, so the
 * app that happened to be frontmost before them is never a precondition.
 */
export const opensApp = (action: Record<string, unknown> | undefined) =>
  action?.type === "open_app" || action?.type === "open_file";

/** Whether the skill may run without model calls. */
export const replayable = (skill: Skill) =>
  skill.successes >= 2 &&
  skill.failures * 3 <= skill.successes &&
  !skill.hintOnly;

function templateRegex(trigger: string, greedy: boolean): RegExp | undefined {
  const parts = trigger.split(/(\{slot\d+\})/);
  const order: number[] = [];
  let source = "";
  for (const part of parts) {
    const slot = /^\{slot(\d+)\}$/.exec(part);
    if (slot) {
      const n = Number(slot[1]);
      if (order.includes(n)) source += `\\${order.indexOf(n) + 1}`;
      else {
        order.push(n);
        source += greedy ? "(.+)" : "(.+?)";
      }
    } else source += escape(part);
  }
  try {
    const regex = new RegExp(`^${source}$`, "iu");
    (regex as RegExp & { order?: number[] }).order = order;
    return regex;
  } catch {
    return undefined;
  }
}

/** Slot values of `text` for the trigger (shortest or longest captures first). */
function captureSlots(
  trigger: string,
  text: string,
  greedy: boolean,
): string[] | undefined {
  const regex = templateRegex(trigger, greedy) as
    (RegExp & { order?: number[] }) | undefined;
  const match = regex?.exec(text);
  if (!regex || !match) return undefined;
  const slotValues: string[] = [];
  (regex.order ?? []).forEach((n, i) => {
    slotValues[n] = match[i + 1].trim();
  });
  if (
    slotValues.length !== (regex.order ?? []).length ||
    slotValues.some((v) => !v)
  )
    return undefined;
  return slotValues;
}

/**
 * Exact template match with slot capture. Replayable, proven skills win. A
 * task that splits into the slots in more than one way ("text {slot1} to
 * {slot0}" for "text I'm going to be late to Bob") does not match at all.
 */
export function matchSkill(
  skills: Skill[],
  task: string,
): { skill: Skill; slotValues: string[] } | undefined {
  const text = stripPoliteness(task);
  if (!text) return undefined;
  const found: { skill: Skill; slotValues: string[] }[] = [];
  for (const skill of skills) {
    if (!skill?.trigger || !Array.isArray(skill.steps)) continue;
    const slotValues = captureSlots(skill.trigger, text, false);
    if (!slotValues) continue;
    // The shortest and longest captures differ exactly when several splits exist.
    const longest = captureSlots(skill.trigger, text, true);
    if (!longest || longest.some((v, i) => v !== slotValues[i])) continue;
    found.push({ skill, slotValues });
  }
  return found.sort(
    (a, b) =>
      Number(replayable(b.skill)) - Number(replayable(a.skill)) ||
      b.skill.successes -
        b.skill.failures -
        (a.skill.successes - a.skill.failures) ||
      b.skill.lastUsed.localeCompare(a.skill.lastUsed),
  )[0];
}

const fill = (value: unknown, slots: string[]): unknown => {
  if (typeof value === "string")
    return value.replace(/\{slot(\d+)\}/g, (all, n) => slots[Number(n)] ?? all);
  if (Array.isArray(value)) return value.map((v) => fill(v, slots));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fill(v, slots)]),
    );
  return value;
};

const keyName = (key: string) =>
  ({ CMD: "Command", CTRL: "Control", ALT: "Option", SHIFT: "Shift" })[key] ??
  (key.length === 1 ? key : key[0] + key.slice(1).toLowerCase());

/** One short, human-readable outline line for a plan step. */
export function describeStep(step: PlanStep): string {
  const a = step.action;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  let line: string;
  switch (a.type) {
    case "open_app":
      line = `Open ${s(a.name)}`;
      break;
    case "open_file":
      line = `Open ${s(a.path)}`;
      break;
    case "hotkey":
      line = `Press ${(Array.isArray(a.keys) ? a.keys : []).map((k) => keyName(String(k))).join("-")}`;
      break;
    case "key":
      line = `Press ${keyName(s(a.key))}`;
      break;
    case "type_text":
      line = `Type "${bound(s(a.text), 80)}"`;
      break;
    case "menu_item":
      line = `Choose ${bound((Array.isArray(a.path) ? a.path : []).map(String).join(" > "), 80)}`;
      break;
    case "click_control":
      line = `Click "${bound(s(a.label), 80)}"`;
      break;
    case "scroll":
      line = "Scroll";
      break;
    case "wait":
      line = `Wait ${Number(a.milliseconds) || 0} ms`;
      break;
    case "tool_call": {
      // The app for a builtin tool, the tool's own name for a server's;
      // never its arguments.
      const id = s(a.tool);
      const name = builtinToolTitle(id) ?? id.split("__")[1] ?? id;
      line = `${step.tool?.tier === "read" ? "Read with" : "Use"} ${bound(name, 60)}`;
      break;
    }
    default: {
      const verb = s(a.type).replace(/_/g, " ") || "act";
      const target = step.target;
      line = target?.label
        ? `${verb[0].toUpperCase()}${verb.slice(1)} the ${normalizeRole(String(target.role ?? ""))} "${bound(target.label, 60)}"`
        : `${verb[0].toUpperCase()}${verb.slice(1)} (position learned on screen)`;
    }
  }
  return bound(redactSecrets(line), 140);
}

/** Outline bounded to CONTEXT_LIMITS.planSteps lines. */
export function outlineOf(steps: PlanStep[]): string[] {
  const max = CONTEXT_LIMITS.planSteps;
  if (steps.length <= max) return steps.map(describeStep);
  return [
    ...steps.slice(0, max - 1).map(describeStep),
    `…and ${steps.length - (max - 1)} more steps`,
  ];
}

/**
 * Resolve a skill into a plan. `appIdOf` maps an application name to its
 * bundle identifier (from the index or app usage) for completeWhen.
 */
export function toPlan(
  skill: Skill,
  slotValues: string[],
  appIdOf?: (name: string) => string | undefined,
): ReplayPlan {
  const steps: PlanStep[] = skill.steps.map((step) => ({
    action: fill(step.action, slotValues) as Record<string, unknown>,
    ...(step.target ? { target: { ...step.target } } : {}),
    ...(step.tool ? { tool: { ...step.tool } } : {}),
    // Skills learned before this rule pinned open steps to the start app.
    ...(step.expectAppId && !opensApp(step.action)
      ? { expectAppId: step.expectAppId }
      : {}),
  }));
  const last = steps.at(-1);
  const plan: ReplayPlan = {
    id: `skill:${skill.id}`,
    source: "skill",
    mode: replayable(skill) ? "replay" : "hint",
    steps,
    outline: outlineOf(steps),
  };
  if (
    last?.action.type === "open_app" &&
    typeof last.action.name === "string"
  ) {
    const appId = appIdOf?.(last.action.name);
    if (appId) plan.completeWhen = { appId };
  }
  return plan;
}
