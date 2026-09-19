/**
 * Jev for the fast decider (streaming execution, design §3.2 step 3): the
 * client src/voice/fast.ts asks one Choice question of when its rules say a
 * clause is unsure, built on the wire pieces in ./jev.ts (decisionsRequest,
 * readChoice, the served check, JEV_TIMEOUT_MS). One request, zero data
 * retention forced, no fallback, no retry, a hard timeout; an answer is
 * returned only when TypeSafe served it on the pinned build and it names one
 * of the options asked with probabilities in range. Every failure is
 * `undefined` to the decider (which reads it as "unsure") and a code to
 * `onResult`, never a throw; the key is never part of anything returned.
 *
 * The `JevClient` interface itself lives in src/voice/fast.ts: src/voice may
 * import only src/core (tests/boundaries.test.ts), so the decider types the
 * client by shape and this module implements and re-exports it. The shapes
 * are JevChoiceQuestion and ChoiceAnswer field for field, which
 * tests/voice-fast.test.ts pins at compile time.
 */
import type { JevAnswer, JevClient, JevQuestion } from "../voice/fast";
import {
  DECISIONS_ENDPOINT,
  JEV_TIMEOUT_MS,
  decisionsRequest,
  estimateCost,
  readChoice,
  readServed,
  readUsage,
  servedError,
} from "./jev";

export type { JevAnswer, JevClient, JevQuestion } from "../voice/fast";

/** The question id a clause is asked under; the answer comes back under it. */
export const JEV_CLAUSE_QUESTION_ID = "clause";

export type JevClauseFailure =
  | "no_key"
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
/** What one call came to, for the budget and the trace: labels, a code and numbers, never words. */
export type JevClauseResult =
  | { ok: true; choice: string; p: number; ms: number; cost: number }
  | { ok: false; code: JevClauseFailure; ms: number; cost: number };

export interface JevClauseTransport {
  fetch: typeof fetch;
  key: string;
  timeoutMs?: number;
  now?: () => number;
  /** Every call's outcome, answered or not. */
  onResult?: (result: JevClauseResult) => void;
}

/** Why a transport failed: our own deadline, the caller's abort, or the network. */
function failure(timedOut: boolean, signal?: AbortSignal): JevClauseFailure {
  if (timedOut) return "timeout";
  if (signal?.aborted) return "cancelled";
  return "network";
}

/** A client that asks the Decisions endpoint once per question and never throws. */
export function createJevClauseClient(t: JevClauseTransport): JevClient {
  const now = t.now ?? Date.now;
  return {
    async ask(question: JevQuestion, state: object, signal?: AbortSignal) {
      const started = now();
      const ms = () => now() - started;
      const fail = (code: JevClauseFailure, cost: number) => {
        t.onResult?.({ ok: false, code, ms: ms(), cost });
        return undefined;
      };
      const key = t.key.trim();
      if (!key) return fail("no_key", 0);
      const request = decisionsRequest(state, {
        [JEV_CLAUSE_QUESTION_ID]: question,
      });
      const estimate = estimateCost(request);
      const options = Object.keys(question.criteria);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, t.timeoutMs ?? JEV_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          response = await t.fetch(DECISIONS_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
        } catch {
          return fail(failure(timedOut, signal), estimate);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return fail(
            controller.signal.aborted
              ? failure(timedOut, signal)
              : response.ok
                ? "bad_body"
                : `http_${response.status}`,
            estimate,
          );
        }
        const usage = readUsage(body);
        const cost = usage.priced ? usage.cost : estimate;
        if (!response.ok) return fail(`http_${response.status}`, cost);
        const served = servedError(
          readServed(body, response.headers.get("x-provider-name")),
        );
        if (served) return fail(served, cost);
        const read = readChoice(body, JEV_CLAUSE_QUESTION_ID, options);
        if (!read.ok) return fail(read.code, cost);
        const answer: JevAnswer = read.answer;
        t.onResult?.({
          ok: true,
          choice: answer.choice,
          p: answer.probabilities[answer.choice] ?? 0,
          ms: ms(),
          cost,
        });
        return answer;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
