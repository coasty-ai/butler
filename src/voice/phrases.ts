/**
 * Everything the assistant may say on its own. Short, warm, and never a
 * phrase that the voice routers would act on (stop, pause, continue, yes, no)
 * and never the wake word, so a reply that leaks back into the microphone
 * cannot steer a run. tests/voice-phrases.test.ts enforces this, and
 * tests/fixtures/voice-phrases.json mirrors the full list for the native
 * policy tests.
 */
export type PhraseKind =
  | "ackStart"
  | "ackCorrection"
  | "ackResume"
  | "ackPause"
  | "ackStop"
  | "ackApprove"
  | "ackDecline"
  | "nothingRunning"
  | "nothingToApprove"
  | "stillWorking"
  | "confirmAgain"
  | "needClick"
  | "didntCatch"
  | "goOn"
  | "whatToDo"
  | "pausedFirst"
  | "doneGeneric"
  | "failGeneric"
  | "repeatReason"
  | "needHelp"
  | "approvalGeneric"
  | "budgetStop"
  | "queued"
  | "thinking"
  | "welcome"
  | "previewSample";

export const PHRASES: Record<PhraseKind, readonly string[]> = {
  // "Sure." and "Sure thing." approve a pending action, so they are not acks.
  ackStart: [
    "On it.",
    "Right away.",
    "Leave it with me.",
    "Straight away.",
    "Working on it.",
  ],
  ackCorrection: ["Got it.", "Understood.", "Changing course.", "Noted."],
  ackResume: ["Continuing.", "Picking back up.", "Okay, continuing."],
  ackPause: ["Paused.", "Holding here.", "Okay, holding."],
  ackStop: ["Stopped.", "Okay, stopped."],
  // "Going ahead with it", never "Go ahead", which is an approval phrase.
  ackApprove: ["Okay.", "Doing it now.", "Going ahead with it."],
  ackDecline: ["Okay, I won’t.", "Okay, skipping that.", "Holding off."],
  nothingRunning: ["Nothing’s running right now."],
  nothingToApprove: ["There’s nothing to approve right now."],
  stillWorking: ["Still on it."],
  confirmAgain: [
    "Sorry, was that a yes or a no?",
    "Sorry, I need a yes or a no.",
  ],
  needClick: [
    "To be safe, please click Yes.",
    "Please click Yes to confirm that one.",
  ],
  didntCatch: [
    "Sorry, say that again?",
    "Sorry, I missed that.",
    "Could you say that again?",
  ],
  // "Go on." resumes a run, so it is not a listening cue.
  goOn: ["I’m listening.", "Take your time."],
  // Words that only point elsewhere ("do that", "go for it") name no task.
  whatToDo: ["What would you like me to do?"],
  // A new task would end the one the user paused: they decide, and the
  // answers the question invites ("stop", "carry on") are the router's own.
  pausedFirst: ["Your task is still paused. Should I stop it, or carry on?"],
  doneGeneric: ["Done.", "All done.", "Finished.", "That’s done."],
  failGeneric: ["Sorry, I couldn’t finish that.", "That didn’t work, sorry."],
  repeatReason: [
    "Still stuck on that. You may need to take over.",
    "Same problem again, sorry.",
  ],
  needHelp: [
    "I need your help with this one.",
    "Can you take a look at the screen?",
  ],
  approvalGeneric: ["I need your okay for the next step."],
  budgetStop: ["I stopped because it was taking too long."],
  // "After that, …": the task waits for the current run. Never "next" alone,
  // which could be heard as a control word.
  queued: [
    "I’ll do that next.",
    "Queued for after this one.",
    "Got it, that’s next.",
  ],
  // The filler before a model reply to a question, while the answer is
  // still being written. Never "One moment", which is a pause phrase.
  thinking: ["Let me check.", "Let me see.", "Checking now."],
  // A reply to thanks when the model is off or late.
  welcome: ["Anytime.", "Happy to help.", "My pleasure."],
  previewSample: ["Hi. I’ll speak up when I need you."],
};

/** Acknowledgements of the user's own turn: at most four words. */
export const ACK_KINDS: readonly PhraseKind[] = [
  "ackStart",
  "ackCorrection",
  "ackResume",
  "ackPause",
  "ackStop",
  "ackApprove",
  "ackDecline",
];

/** Index of the variant last used for each kind. */
export type PhraseMemory = Partial<Record<PhraseKind, number>>;

/**
 * Picks a variant, never the one used last time for the same kind, so the
 * assistant does not sound like a recording.
 */
export function pickPhrase(
  kind: PhraseKind,
  memory: PhraseMemory = {},
  random: () => number = Math.random,
): string {
  const variants = PHRASES[kind];
  const last = memory[kind];
  const pool = variants.map((_, i) => i).filter((i) => i !== last);
  const choices = pool.length ? pool : [0];
  const r = random();
  const at = Number.isFinite(r)
    ? Math.min(choices.length - 1, Math.max(0, Math.floor(r * choices.length)))
    : 0;
  memory[kind] = choices[at];
  return variants[choices[at]];
}

export const APPROVAL_SUFFIX = {
  handsFree: "Say yes or no.",
  restricted: "Click Yes to confirm.",
} as const;

/**
 * Spoken after the first approval question of a session only. Push-to-talk
 * gets none: the pill already says how to answer.
 */
export function approvalSuffix(options: {
  first: boolean;
  handsFree: boolean;
  followUp: boolean;
  restricted: boolean;
}): string {
  if (!options.first || !options.handsFree) return "";
  if (options.restricted) return APPROVAL_SUFFIX.restricted;
  return options.followUp ? APPROVAL_SUFFIX.handsFree : "";
}

/** Fragment verbs answered with "{Verb} what?". */
export const CLARIFY_WHAT_VERBS = [
  "open",
  "launch",
  "start",
  "close",
  "quit",
  "play",
  "type",
  "write",
  "send",
  "delete",
  "find",
] as const;
/** Fragment verbs answered with "{Verb} who?". */
export const CLARIFY_WHO_VERBS = ["email", "message", "text", "call"] as const;
export const CLARIFY_SEARCH = "Search for what?";
export const CLARIFY_GO = "Go where?";

const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);

/** The clarification question for a bare fragment verb, if it has a template. */
export function clarificationTemplate(verb: string): string | undefined {
  if ((CLARIFY_WHAT_VERBS as readonly string[]).includes(verb))
    return `${capitalize(verb)} what?`;
  if ((CLARIFY_WHO_VERBS as readonly string[]).includes(verb))
    return `${capitalize(verb)} who?`;
  if (verb === "search" || verb === "look") return CLARIFY_SEARCH;
  if (verb === "go") return CLARIFY_GO;
  return undefined;
}

/** Every string the assistant can say without run content. */
export function allAssistantPhrases(): string[] {
  const all = [
    ...Object.values(PHRASES).flat(),
    ...Object.values(APPROVAL_SUFFIX),
    ...CLARIFY_WHAT_VERBS.map((v) => clarificationTemplate(v)!),
    CLARIFY_SEARCH,
    CLARIFY_GO,
    ...CLARIFY_WHO_VERBS.map((v) => clarificationTemplate(v)!),
  ];
  return [...new Set(all)];
}
