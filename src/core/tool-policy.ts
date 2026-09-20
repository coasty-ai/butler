/**
 * The policy's answer for a tool_call: the refusals every tool step passes
 * first (practice runs, an unlisted or denylisted tool, a credential in the
 * arguments, invalid arguments, the per-run budget, the privacy mode), then
 * the tier of the tool against the autonomy setting (.data/design/mcp-lanes.md
 * §2.3). Every ALLOW, DENY and RETRY reason is a fixed string; only a CONFIRM
 * question carries content, rendered by toolQuestion. The user's own words
 * ground the arguments: an entity they never said is named in the question,
 * and one leaving for an open-world server asks even under "all".
 */
import type { Action, Settings } from "./schema";
import type { Decision, PolicyContext } from "./policy";
import { scanText } from "./sanitize";
import { ENTITY, entityTokens } from "./entities";
import {
  TOOL_DENYLIST,
  TOOL_LIMITS,
  TOOL_REFUSALS,
  toolsAllowed,
  type ToolClock,
  type ToolQuestion,
} from "./tools";
import {
  contentWords,
  parseWhen,
  stringLeaves,
  toolQuestion,
  weekdayOf,
  zoneParts,
} from "./tool-text";

type ToolCall = Extract<Action, { type: "tool_call" }>;

/** The fixed reasons a tool step runs on. */
export const TOOL_ALLOWED = {
  read: "Read through a tool without changing anything.",
  grounded: "Add what the user asked for, in their words; it can be undone.",
  undoable: "Add through a tool; it can be undone.",
  grounded_write:
    "Change the file the user named, in their words; it can be undone.",
  unasked: "Done without asking, as you set. Reported when done.",
} as const;

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const dayNumber = (w: { y: number; m: number; d: number }) =>
  Math.round(Date.UTC(w.y, w.m - 1, w.d) / 86400000);
const digits = (n: number) => `(?<!\\d)${n}(?!\\d)`;
/**
 * Whether the user's words support a date argument the model wrote: the day
 * (today, tonight, tomorrow, a weekday within two weeks, or the day and
 * month) and, for a time, its hour (as said, with the minutes when they are
 * not on the hour). A miss only costs a question.
 */
function dateSupported(
  value: string,
  words: string,
  clock: ToolClock,
): boolean {
  const w = parseWhen(value, clock);
  if (!w) return false;
  const said = words.toLowerCase();
  const days = dayNumber(w) - dayNumber(zoneParts(clock.now, clock.zone));
  const month = MONTH_NAMES[w.m - 1];
  const dayOk =
    (days === 0 &&
      /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/.test(said)) ||
    (days === 1 && /\btomorrow\b/.test(said)) ||
    (days >= 0 &&
      days <= 13 &&
      new RegExp(`\\b${DAY_NAMES[weekdayOf(w)]}\\b`).test(said)) ||
    new RegExp(
      `${digits(w.d)}(?:st|nd|rd|th)?(?: of)? ${month}\\b|\\b${month} ${digits(w.d)}`,
    ).test(said);
  if (!dayOk) return false;
  if (w.h === undefined) return true;
  const h12 = w.h % 12 || 12;
  const minutes = w.mi ? `:${String(w.mi).padStart(2, "0")}` : "(?::00)?";
  return (
    new RegExp(`(?:${digits(w.h)}|${digits(h12)})${minutes}(?!:\\d)`).test(
      said,
    ) ||
    (w.h === 12 && !w.mi && /\bnoon\b/.test(said)) ||
    (w.h === 0 && !w.mi && /\bmidnight\b/.test(said))
  );
}
/**
 * How the user's words cover a tool's arguments. `ungrounded` is every
 * entity (address, link, number, handle, amount) in the arguments the user
 * never said, and every entity when the words are not the user's own (a
 * rewrite, an accepted offer, a watch wake-up). `grounded` needs no
 * ungrounded entity, every content word of the free-text arguments in the
 * words, and each date argument supported by them against the clock.
 */
export function toolGrounding(
  groundText: string[],
  userWords: string | undefined,
  when: { dates: string[]; clock: ToolClock },
): { ungrounded: string[]; grounded: boolean } {
  // Entities as the arguments spell them, so a question reads "415 555
  // 0100" as written; they compare by their normalised form.
  const entities = [
    ...new Set(
      groundText.flatMap((t) => [...t.matchAll(ENTITY)].map((m) => m[0])),
    ),
  ];
  if (userWords === undefined) return { ungrounded: entities, grounded: false };
  const saidEntities = new Set(entityTokens(userWords));
  const ungrounded = entities.filter(
    (e) => !entityTokens(e).every((token) => saidEntities.has(token)),
  );
  const said = new Set(contentWords(userWords));
  const grounded =
    !ungrounded.length &&
    groundText.every((t) => contentWords(t).every((word) => said.has(word))) &&
    when.dates.every((d) => dateSupported(d, userWords, when.clock));
  return { ungrounded, grounded };
}

const allow = (reason: string): Decision => ({ kind: "ALLOW", reason });
const retry = (reason: string): Decision => ({ kind: "RETRY", reason });
const deny = (reason: string): Decision => ({ kind: "DENY", reason });

/** The decision for one tool_call; see the module note for the order. */
export function toolDecision(
  action: ToolCall,
  settings: Settings,
  synthetic: boolean,
  context: PolicyContext,
): Decision {
  if (synthetic) return retry(TOOL_REFUSALS.practice);
  const tool = context.tool;
  const clock = context.clock;
  if (!tool || !clock) return retry(TOOL_REFUSALS.unknown_tool);
  const { spec, prepared } = tool;
  if (TOOL_DENYLIST.test(spec.name)) return deny(TOOL_REFUSALS.denylisted);
  if (
    stringLeaves(action.args).some((text) =>
      scanText(text).some((f) => f.action === "BLOCK_UPLOAD"),
    )
  )
    return deny(TOOL_REFUSALS.credential);
  if (!prepared.ok) return retry(TOOL_REFUSALS[prepared.problem]);
  if (tool.calls >= TOOL_LIMITS.callsPerRun) return deny(TOOL_REFUSALS.budget);
  if (!toolsAllowed(settings, spec)) return deny(TOOL_REFUSALS.privacy);
  const dates = spec.dateKeys
    .map((key) => action.args[key])
    .filter((v): v is string => typeof v === "string");
  const grounding = toolGrounding(prepared.groundText, context.userWords, {
    dates,
    clock,
  });
  const all = settings.autonomy === "all" && settings.autonomyAllAcknowledged;
  const ask = (question: ToolQuestion = prepared.question): Decision => ({
    kind: "CONFIRM",
    reason: toolQuestion(question, grounding.ungrounded, clock),
  });
  // Entities the user never said, leaving for a server that reaches beyond
  // itself: the one question "all" keeps, like the protected-website one.
  if (
    spec.openWorld &&
    grounding.ungrounded.length &&
    (all || spec.tier === "read")
  )
    return {
      ...ask({ kind: "send_to", server: spec.title, tool: spec.name }),
      floor: true,
    };
  if (spec.tier === "read") {
    if (spec.trusted) return allow(TOOL_ALLOWED.read);
    return all ? allow(TOOL_ALLOWED.unasked) : ask();
  }
  if (all) return allow(TOOL_ALLOWED.unasked);
  if (spec.tier === "additive" && spec.undoable) {
    if (settings.autonomy === "flow") return allow(TOOL_ALLOWED.undoable);
    if (settings.autonomy === "task" && grounding.grounded)
      return allow(TOOL_ALLOWED.grounded);
  }
  // A write that replaces what a first-party, closed-world tool holds (the
  // files tool's replace_file_text) runs unasked only when its own undo can
  // take it back and the user's words named what it touches: the rule the
  // Save button runs under (policy.ts askedForLabel), for the tool step. An
  // MCP write, untrusted or open-world, keeps its question. Whether the
  // words asked for the file's contents to go at all is the tool's own rule
  // at prepare (would_erase, refused above with the other problems).

  if (
    spec.tier === "write" &&
    spec.undoable &&
    spec.trusted &&
    !spec.openWorld &&
    grounding.grounded &&
    (settings.autonomy === "task" || settings.autonomy === "flow")
  )
    return allow(TOOL_ALLOWED.grounded_write);
  return ask();
}
