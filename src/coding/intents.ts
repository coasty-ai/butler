/**
 * The words that hand work to a coding agent and steer it afterwards, as a
 * deterministic grammar over the whole utterance: "ask Claude Code to fix the
 * failing test in open-assist", "what's the coding agent doing?", "read me
 * the summary", "tell it yes", "tell it to use the other approach", "stop the
 * coding agent", "quit Codex". Anything else is not a coding request and goes
 * to the router as before.
 *
 * Nothing here is an approval of Butler's own: "tell it yes" names the agent
 * (or "it", which means the agent only while one is at work), and a bare
 * "yes" never reaches a coding agent (docs/CODING_AGENTS.md).
 */
import { AGENT_WORDS, agentFromWords, type CodingAgentId } from "./agents";

/** A trailing "in <project>" clause and the task without it, for when the name resolves. */
export interface Place {
  name: string;
  task: string;
}
export type CodingRequest =
  | {
      kind: "delegate";
      agent?: CodingAgentId;
      /** The whole request as said, minus the delegation words. */
      task: string;
      place?: Place;
    }
  | { kind: "status"; agent?: CodingAgentId; pronoun: boolean }
  | { kind: "summary"; agent?: CodingAgentId; pronoun: boolean }
  | { kind: "answer"; yes: boolean; agent?: CodingAgentId; pronoun: boolean }
  | { kind: "tell"; text: string; agent?: CodingAgentId; pronoun: boolean }
  | { kind: "interrupt"; agent?: CodingAgentId; pronoun: boolean }
  | { kind: "quit"; agent?: CodingAgentId; pronoun: boolean };

const LEAD_WORDS = "hey|ok|okay|so|um|uh|please|butler|now|also|and|then";
const LEAD = String.raw`(?:(?:${LEAD_WORDS}) )*(?:(?:can|could|would|will) you )?(?:please )?`;
const LEAD_PUNCTUATION = new RegExp(`^(?:(?:${LEAD_WORDS})[,:]? )+`, "i");
const IT = String.raw`(?:it|them|him|her|that)`;
const TARGET = `(${AGENT_WORDS}|${IT})`;
const AGENT = `(${AGENT_WORDS})`;
const YES = String.raw`(?:yes|yeah|yep|yup|sure|okay|ok|go ahead|to go ahead|to proceed|proceed|approve|approved|allow|allowed|it can|that'?s fine|fine|do it|to do it)`;
const NO = String.raw`(?:no|nope|nah|don'?t|do not|not to|deny|denied|decline|refuse|it can'?t|it cannot)`;
const re = (source: string) => new RegExp(`^${LEAD}${source}$`, "d");
const IS_IT = new RegExp(`^${IT}$`);
const IS_YES = new RegExp(`^${YES}$`);
const IS_NO = new RegExp(`^${NO}$`);

/** [pattern, the answer when the words fix it; otherwise the yes/no group says]. */
const ANSWER: [RegExp, boolean | undefined][] = [
  [re(`(?:tell|answer) ${TARGET},? (?:that )?(${YES}|${NO})`), undefined],
  [re(`(?:say|reply|answer) (${YES}|${NO}) to ${TARGET}`), undefined],
  [
    re(`let ${TARGET} (?:go ahead|proceed|do it|run it|continue|run that)`),
    true,
  ],
  [re(`don'?t let ${TARGET}(?: .+)?`), false],
  [
    re(`(?:approve|allow) ${AGENT}(?:'s)? (?:request|question|command|edit)`),
    true,
  ],
  [
    re(
      `(?:deny|decline|refuse) ${AGENT}(?:'s)? (?:request|question|command|edit)`,
    ),
    false,
  ],
];
const INTERRUPT = [
  re(`(?:stop|interrupt|halt|pause|cancel) ${AGENT}`),
  re(`tell ${TARGET} (?:to )?(?:stop|halt|hold on|pause|cancel(?: that)?)`),
  re(`${AGENT},? (?:stop|hold on|pause)`),
];
const QUIT = [
  re(
    `(?:quit|close|end|kill|exit|shut down|terminate|dismiss) (?:the )?${AGENT}(?:'s)?(?: (?:session|window|pane|process))?`,
  ),
  re(`tell ${TARGET} to (?:quit|exit|close|shut down|go away)`),
  re(`(?:end|close|quit|kill) the (?:coding |tmux )?session`),
];
const STATUS = [
  re(
    `what(?:'s| is) ${TARGET} (?:doing|up to|working on)(?: (?:now|right now|at the moment))?`,
  ),
  re(
    `how(?:'s| is) ${TARGET} (?:doing|going|getting on|coming along|getting along)`,
  ),
  re(
    `is ${TARGET} (?:done|finished|still (?:working|going|running|busy)|stuck|working|busy|running)(?: yet)?`,
  ),
  re(`${AGENT} status`),
  re(`status (?:of|on|for) ${TARGET}`),
  re(`(?:any )?(?:update|news|progress) (?:on|from|with) ${TARGET}`),
  re(`(?:has|did) ${TARGET} finish(?:ed)?(?: yet)?`),
  re(`where(?:'s| is) ${TARGET}(?: at)?`),
  re(`check on ${TARGET}`),
];
const SUMMARY = [
  re(
    `read (?:me |out )?(?:the |its |their )?(?:summary|result|results|report|findings|what ${IT} (?:said|did|found|wrote))`,
  ),
  re(`what did ${TARGET} (?:say|do|find|report|write|change)`),
  re(`what(?:'s| is) (?:the |its )?(?:summary|result|verdict)`),
  re(`(?:give|tell) me (?:the |its )?(?:summary|result|report|findings)`),
  re(`(?:the )?summary`),
];
const TELL = [
  re(`tell ${TARGET},? (?:that |to )?(.+)`),
  re(`answer ${TARGET},? (.+)`),
];
/** [pattern, the agent's group, the task's group]. */
const DELEGATE: [RegExp, number, number][] = [
  [re(`(?:ask|tell|have|get|let) ${AGENT} to (.+)`), 1, 2],
  [re(`(?:have|let) ${AGENT} (.+)`), 1, 2],
  [re(`(?:delegate|hand|hand off|give|send|pass) (.+?) to ${AGENT}`), 2, 1],
  [re(`${AGENT}[,:] (.+)`), 1, 2],
];
// "… in open-assist", "… in the settings repo", "… in ~/code/app": a place
// the task may name last. Whether it is one is settled by resolution
// (src/coding/project.ts); until then the task keeps its words.
const PLACE =
  /^(.*\S),? in (?:the |my )?((?:~\/|\/)?[\w.~/-]+(?: [\w.-]+){0,2}?)(?: (?:repo|repository|project|folder|directory|codebase|code base))?$/d;
const TRAILING = /(?:,? ?(?:please|for me|thanks|thank you|now))+$/;

/** Group `group` of a `d`-flag match, sliced from `from` (same length as the matched text). */
const span = (m: RegExpExecArray, group: number, from: string) => {
  const at = m.indices?.[group];
  return at ? from.slice(at[0], at[1]) : "";
};
/** A lowercase copy the same length as the text, or the copy itself when casing changed lengths. */
const folded = (text: string) => {
  const lower = text.toLowerCase();
  return { lower, source: lower.length === text.length ? text : lower };
};
const yesOrNo = (words: string): boolean | undefined =>
  IS_YES.test(words) ? true : IS_NO.test(words) ? false : undefined;
const who = (words: string) => ({
  agent: agentFromWords(words),
  pronoun: IS_IT.test(words),
});

/** The coding request in the words, or undefined when they are not one. */
export function codingRequest(text: string): CodingRequest | undefined {
  // Casing and punctuation are kept for the task; matching is on a same-
  // length lowercase copy with the trailing punctuation cut from both.
  const base = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
    // "Hey Butler, could you …": the comma after a lead word is not a word.
    .replace(LEAD_PUNCTUATION, (lead) => lead.replace(/[,:]/g, ""));
  const { lower: k, source } = folded(base);
  if (!k) return undefined;
  for (const [pattern, fixed] of ANSWER) {
    const m = pattern.exec(k);
    if (!m) continue;
    // The target and the answer are the two groups, in either order.
    const groups = [1, 2].map((g) => span(m, g, k)).filter(Boolean);
    const words = groups.find((g) => yesOrNo(g) !== undefined);
    const yes = fixed ?? (words ? yesOrNo(words) : undefined);
    if (yes === undefined) continue;
    return {
      kind: "answer",
      yes,
      ...who(groups.find((g) => g !== words) ?? ""),
    };
  }
  for (const pattern of INTERRUPT) {
    const m = pattern.exec(k);
    if (m) return { kind: "interrupt", ...who(span(m, 1, k)) };
  }
  for (const pattern of QUIT) {
    const m = pattern.exec(k);
    if (m) return { kind: "quit", ...who(span(m, 1, k)) };
  }
  for (const pattern of STATUS) {
    const m = pattern.exec(k);
    if (m) return { kind: "status", ...who(span(m, 1, k)) };
  }
  for (const pattern of SUMMARY) {
    const m = pattern.exec(k);
    if (m) return { kind: "summary", ...who(span(m, 1, k)) };
  }
  // "tell Claude Code to …" hands work over; "tell it …" (below) relays.
  for (const [pattern, agentGroup, taskGroup] of DELEGATE) {
    const m = pattern.exec(k);
    if (!m) continue;
    const task = span(m, taskGroup, source).replace(TRAILING, "").trim();
    if (!task) continue;
    const place = placeOf(task);
    return {
      kind: "delegate",
      agent: agentFromWords(span(m, agentGroup, k)),
      task,
      ...(place ? { place } : {}),
    };
  }
  for (const pattern of TELL) {
    const m = pattern.exec(k);
    if (!m) continue;
    const said = span(m, 2, source).replace(TRAILING, "").trim();
    if (!said) continue;
    return { kind: "tell", text: said, ...who(span(m, 1, k)) };
  }
  return undefined;
}

/** The trailing place clause of a task, when it has the shape of one. */
function placeOf(task: string): Place | undefined {
  const { lower, source } = folded(task);
  const m = PLACE.exec(lower);
  if (!m) return undefined;
  const rest = span(m, 1, source).replace(/,$/, "").trim();
  const name = span(m, 2, source).trim();
  return rest && name ? { name, task: rest } : undefined;
}
