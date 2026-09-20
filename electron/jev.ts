/**
 * One call to TypeSafe's Jev through OpenRouter for the dialog act: the
 * opt-in early decider behind Settings → "Decide with Jev". It sends the
 * same state the dialog model gets (never screen text), asks for zero data
 * retention with no fallback, gives up after a hard timeout, never retries
 * on the hot path, and discards any answer that did not come from TypeSafe
 * on the pinned dated build. It never throws: every failure is a code, and
 * the key it sends is never part of what it returns, so nothing built from
 * a verdict can carry it.
 */
import type { Settings } from "../src/core/schema";
import { DIALOG_SYSTEM } from "../src/assistant/prompt";
import { DIALOG_ACTS } from "../src/assistant/protocol";
import {
  APP_DIALOG_VARIANT,
  DECISIONS_ENDPOINT,
  JEV_ACT_QUESTION_ID,
  JEV_TIMEOUT_MS,
  decisionsRequest,
  dialogActQuestion,
  estimateCost,
  readChoice,
  readServed,
  readUsage,
  servedError,
  type JevChoiceQuestion,
} from "../src/providers/jev";

/**
 * The act question, built once from the dialog prompt's own lines when this
 * module loads, so a prompt that no longer has them fails here and in every
 * test that imports it (tests/jev.test.ts, tests/eval-jev.test.ts), never
 * per turn. Undefined when it cannot be built: the decider then asks
 * nothing and the turn takes today's path, with "no_question" in its trace.
 * An opt-in decider must never be what keeps the app from starting.
 */
export const JEV_ACT_QUESTION: JevChoiceQuestion | undefined = (() => {
  try {
    return dialogActQuestion(APP_DIALOG_VARIANT, DIALOG_SYSTEM, DIALOG_ACTS);
  } catch {
    return undefined;
  }
})();

export type JevFailure =
  | "no_key"
  /** The question could not be built from the dialog prompt (JEV_ACT_QUESTION). */
  | "no_question"
  /** The decider's own path threw before it could ask; the code is all that is kept. */
  | "error"
  | "timeout"
  | "cancelled"
  | "network"
  | `http_${number}`
  | "bad_body"
  | "wrong_provider"
  | "wrong_model"
  | "no_answer"
  | "bad_type"
  | "bad_choice"
  | "bad_probabilities";

/** What one call came back with; `cost` is what the hourly budget is charged. */
export type JevVerdict =
  | {
      ok: true;
      act: string;
      /** The probability of the chosen act. */
      p: number;
      confidence: number;
      ms: number;
      cost: number;
    }
  | { ok: false; code: JevFailure; ms: number; cost: number };

export interface JevCall {
  fetch: typeof fetch;
  key: string;
  /** The dialog state as an object: jevState(dialogStateJson(...)). */
  state: unknown;
  question: JevChoiceQuestion;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Asks the act question once. The response is trusted only when both the
 * body and the x-provider-name header name TypeSafe and the model is the
 * pinned build; the answer only when it is a choice among the acts asked,
 * with probabilities in range. A response that says what it cost is charged
 * that; one that does not (a timeout, a network error, a body that is not
 * JSON) is charged the pessimistic estimate, so a run of failures still
 * counts against the hourly budget.
 */
export async function askJevAct(o: JevCall): Promise<JevVerdict> {
  const now = o.now ?? Date.now;
  const started = now();
  const ms = () => now() - started;
  const key = o.key.trim();
  if (!key) return { ok: false, code: "no_key", ms: 0, cost: 0 };
  const request = decisionsRequest(o.state, {
    [JEV_ACT_QUESTION_ID]: o.question,
  });
  const estimate = estimateCost(request);
  const options = Object.keys(o.question.criteria);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, o.timeoutMs ?? JEV_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await o.fetch(DECISIONS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        code: failure(timedOut, o.signal),
        ms: ms(),
        cost: estimate,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        code: controller.signal.aborted
          ? failure(timedOut, o.signal)
          : response.ok
            ? "bad_body"
            : `http_${response.status}`,
        ms: ms(),
        cost: estimate,
      };
    }
    const usage = readUsage(body);
    const cost = usage.priced ? usage.cost : estimate;
    if (!response.ok)
      return { ok: false, code: `http_${response.status}`, ms: ms(), cost };
    const served = servedError(
      readServed(body, response.headers.get("x-provider-name")),
    );
    if (served) return { ok: false, code: served, ms: ms(), cost };
    const read = readChoice(body, JEV_ACT_QUESTION_ID, options);
    if (!read.ok) return { ok: false, code: read.code, ms: ms(), cost };
    return {
      ok: true,
      act: read.answer.choice,
      p: read.answer.probabilities[read.answer.choice] ?? 0,
      confidence: read.answer.confidence,
      ms: ms(),
      cost,
    };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** Why a transport failed: our own deadline, the caller's abort, or the network. */
function failure(timedOut: boolean, signal?: AbortSignal): JevFailure {
  if (timedOut) return "timeout";
  if (signal?.aborted) return "cancelled";
  return "network";
}

/**
 * The settings as they may be saved: the decider is forced off in
 * PRIVATE_LOCAL (the conversation would leave the Mac), and turning it on
 * needs an OpenRouter key in the vault, so a toggle can never be "on"
 * without a key behind it. Throws with the one fixed line the settings
 * window shows.
 */
export function jevSettingsToSave(next: Settings, typedKey?: string): Settings {
  let out = next;
  // The legacy explicit on is the default plus consent.
  if (out.decisions === "jev")
    out = { ...out, decisions: "auto", jevConsented: true };
  // A key typed into Settings sits beside the disclosure: that is consent.
  if (typedKey?.trim()) out = { ...out, jevConsented: true };
  return out;
}

/**
 * Whether the decider may run at all for these settings and keys: never
 * off, never local, never without a key, and never without consent.
 */
export function jevEnabled(s: Settings, key: string): boolean {
  return (
    s.decisions !== "off" &&
    s.privacy !== "PRIVATE_LOCAL" &&
    !!key.trim() &&
    (s.jevConsented || s.decisions === "jev")
  );
}

/**
 * Settings from a config saved before "auto" and consent existed. The old
 * explicit on becomes "auto" with consent. The old default "off" becomes
 * "auto" (still idle until the user consents) only when no OpenRouter key
 * is stored; with a key it may have been a deliberate off, so it stays off
 * and is marked as the user's.
 */
export function migrateDecisions(
  settings: Settings,
  stored: { decisions?: unknown; decisionsChosen?: unknown } | undefined,
  keyStored = false,
): Settings {
  if (settings.decisions === "jev")
    return {
      ...settings,
      decisions: "auto",
      decisionsChosen: true,
      jevConsented: true,
    };
  if (stored?.decisionsChosen === true || settings.decisions !== "off")
    return settings;
  return keyStored
    ? { ...settings, decisionsChosen: true }
    : { ...settings, decisions: "auto" };
}

/** --decide-with-jev: a developer's explicit consent at launch. */
export function launchDecideWithJev(
  settings: Settings,
  args: string[],
): Settings | undefined {
  if (!args.includes("--decide-with-jev")) return undefined;
  return {
    ...settings,
    decisions: "auto",
    decisionsChosen: true,
    jevConsented: true,
  };
}
