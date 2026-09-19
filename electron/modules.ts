/**
 * The built-in adapters behind the module ports, as main.ts hands them to
 * createModuleRegistry (.data/design/modules.md §5: "the builtin adapter
 * being today's code"), and the small pieces the consumers share:
 *
 * - clauseSegmenter: a stateless cut of the partial into clauses
 *   (src/voice/stream.ts clausesOf) diffed against the clauses the caller
 *   kept, committing by boundary. The exact stream, with its stability
 *   rule, is stateful and stays in electron/streaming.ts for the builtin
 *   choice; this function is what an adapter's failure falls back to.
 * - fastDecider: decideFast, and for an unsure clause decideFastWithJev
 *   over the choiceModel port, so the decider's last resort is whatever
 *   adapter that port names.
 * - choiceModel: Jev through OpenRouter (src/providers/jev-clause.ts), the
 *   port's question carried as JSON text in `prompt` (choiceQuestionOf /
 *   jevQuestionOf), so nothing of the question is lost on the wire and an
 *   http or mcp adapter reads the same text.
 * - urlOpener: the browser route (NativeController.openUrl → electron/open-url.ts).
 * - tts: answers "not played", which tells electron/speech-output.ts to speak
 *   with its own engines; an adapter that returns audio or plays it replaces them.
 *
 * Nothing here is a policy: every output is judged by its consumer as the
 * built-in's would be.
 */
import type { Action, ExecutionResult } from "../src/core/schema";
import { actionSchema } from "../src/core/schema";
import type {
  Builtins,
  ModulePorts,
  PortAdapter,
} from "../src/modules/registry";
import type { PortInput, PortOutput } from "../src/modules/contracts";
import { clausesOf, type Clause, type ClauseEvent } from "../src/voice/stream";
import {
  decideFast,
  decideFastWithJev,
  type FastAction,
  type JevAnswer,
  type JevClient,
  type JevQuestion,
} from "../src/voice/fast";
import { createJevClauseClient } from "../src/providers/jev-clause";
import { JEV_TIMEOUT_MS } from "../src/providers/jev";

export interface BuiltinDeps {
  /** The native controller's browser route; undefined off macOS or without the helper. */
  controller():
    | {
        openUrl(
          a: Extract<Action, { type: "open_url" }>,
        ): Promise<void | ExecutionResult>;
      }
    | undefined;
  /** The OpenRouter key and whether the decider may run (electron/jev.ts jevEnabled). */
  jev(): { key: string; enabled: boolean };
  fetch: typeof fetch;
  /** The registry itself, once created: the decider reaches the choice model through it. */
  registry(): ModulePorts | undefined;
  timeoutMs?: number;
  now?: () => number;
}

const sameWords = (a: string, b: string) =>
  a
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim() ===
  b
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * segment_clauses without state: the partial cut into clauses, every clause
 * but the last committed by boundary (the following clause's words are
 * there), a previously committed clause kept with its commit time when its
 * words stand, and superseded when they changed.
 */
export function segmentStateless(
  input: PortInput<"clauseSegmenter">,
): PortOutput<"clauseSegmenter"> {
  const cut = clausesOf(input.text, input.atMs);
  const events: ClauseEvent[] = [];
  const clauses: Clause[] = cut.map((c, i) => {
    const previous = input.previous.find(
      (p) => p.index === i && p.state === "committed",
    );
    const last = i === cut.length - 1;
    if (previous && sameWords(previous.text, c.text))
      return {
        ...c,
        state: "committed",
        committedAtMs: previous.committedAtMs,
      };
    if (last) return { ...c, state: "growing", committedAtMs: undefined };
    return c;
  });
  for (const p of input.previous) {
    if (p.state !== "committed") continue;
    const now = clauses[p.index];
    if (now && sameWords(now.text, p.text)) continue;
    if (now && now.state === "committed")
      events.push({ kind: "superseded", clause: p, replacement: now });
  }
  for (const c of clauses) {
    if (c.state !== "committed") continue;
    const kept = input.previous.some(
      (p) =>
        p.index === c.index &&
        p.state === "committed" &&
        sameWords(p.text, c.text),
    );
    const replaced = events.some(
      (e) => e.kind === "superseded" && e.replacement.index === c.index,
    );
    if (!kept && !replaced)
      events.push({ kind: "committed", clause: c, by: "boundary" });
  }
  return {
    clauses: clauses
      .map((c) =>
        c.committedAtMs === undefined ? { ...c, committedAtMs: undefined } : c,
      )
      .map(({ committedAtMs, ...rest }) =>
        committedAtMs === undefined ? rest : { ...rest, committedAtMs },
      ),
    events,
  };
}

// The choice model's question on the wire ------------------------------------

/**
 * A Jev Choice question as the choose port carries it: the option names
 * as `choices`, and the instructions with each option's meaning as JSON
 * text in `prompt`, so the built-in rebuilds the question exactly and an
 * adapter reads every word of it.
 */
export function choiceQuestionOf(
  question: JevQuestion,
  id: string,
): PortInput<"choiceModel">["question"] {
  return {
    id,
    choices: Object.keys(question.criteria),
    prompt: JSON.stringify({
      instructions: question.instructions,
      criteria: question.criteria,
    }),
  };
}
/** The Jev question back from the port's shape; a plain prompt becomes the instructions with the choices as their own meaning. */
export function jevQuestionOf(
  question: PortInput<"choiceModel">["question"],
): JevQuestion {
  try {
    const parsed = (
      typeof question.prompt === "string"
        ? JSON.parse(question.prompt)
        : question.prompt
    ) as {
      instructions?: unknown;
      criteria?: unknown;
    };
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.criteria &&
      typeof parsed.criteria === "object" &&
      !Array.isArray(parsed.criteria) &&
      question.choices.every((c) => c in (parsed.criteria as object))
    )
      return {
        type: "choice",
        instructions: (parsed.instructions ??
          question.prompt) as JevQuestion["instructions"],
        criteria: Object.fromEntries(
          question.choices.map((c) => [
            c,
            (
              parsed.criteria as Record<string, JevQuestion["criteria"][string]>
            )[c],
          ]),
        ),
      };
  } catch {
    /* Not our JSON: the prompt is the instructions. */
  }
  return {
    type: "choice",
    instructions: question.prompt,
    criteria: Object.fromEntries(question.choices.map((c) => [c, c])),
  };
}
/**
 * A JevClient (src/voice/fast.ts) over the choose port: the decider asks
 * its one question as today and reads the port's {choice, p} as an answer
 * with that probability on the chosen option. Never throws.
 */
export function jevClientOverPort(
  port: PortAdapter<"choiceModel">,
  id = "clause",
): JevClient {
  return {
    async ask(question, state, signal): Promise<JevAnswer | undefined> {
      try {
        const out = await port.call(
          {
            question: choiceQuestionOf(question, id),
            state: { ...(state as Record<string, unknown>) },
          },
          signal,
        );
        if (!out || !(out.choice in question.criteria)) return undefined;
        const p = Math.min(1, Math.max(0, out.p));
        return {
          choice: out.choice,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((c) => [
              c,
              c === out.choice ? p : 0,
            ]),
          ),
          confidence: p,
        };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * An adapter's decide_clause reply as a FastAction: an open_url without a
 * recipe code takes its host as the code, and without a label leaves the
 * label empty, so the pill and the run name it by the site and the search
 * read from the address (src/core/streamed.ts urlLabel). The core
 * re-checks the URL itself (electron/streaming.ts: the action schema, the
 * policy while speaking).
 */
export function fastActionOf(
  out: PortOutput<"fastDecider"> | undefined,
): FastAction {
  if (!out) return { kind: "none", reason: "unsure" };
  if (out.kind !== "open_url") return out;
  let host = "";
  try {
    host = new URL(out.url).hostname;
  } catch {
    /* The schema refuses it below. */
  }
  const siteKey =
    out.siteKey ??
    (host
      .replace(/^www\./, "")
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .replace(/^[^A-Za-z]+/, "") ||
      "site");
  return {
    kind: "open_url",
    url: out.url,
    siteKey: siteKey.slice(0, 40),
    label: out.label ?? "",
  };
}

/** Today's code behind each port, for createModuleRegistry's `builtin`. */
export function moduleBuiltins(deps: BuiltinDeps): Builtins {
  const timeoutMs = deps.timeoutMs ?? JEV_TIMEOUT_MS;
  return {
    clauseSegmenter: async (input) => segmentStateless(input),
    fastDecider: async ({ clause, context }, signal) => {
      const local = decideFast(clause, context);
      if (local.kind !== "none" || local.reason !== "unsure") return local;
      if (!deps.jev().enabled) return local;
      const port = deps.registry()?.port("choiceModel");
      if (!port) return local;
      return decideFastWithJev(
        clause,
        context,
        jevClientOverPort(port),
        signal,
      );
    },
    choiceModel: async ({ question, state }, signal) => {
      const { key, enabled } = deps.jev();
      if (!enabled || !key.trim()) throw new Error("jev_off");
      let code = "no_answer";
      const client = createJevClauseClient({
        fetch: deps.fetch,
        key,
        timeoutMs,
        now: deps.now,
        onResult: (r) => {
          if (!r.ok) code = r.code.replace(/[^a-z0-9_]/gi, "_");
        },
      });
      const answer = await client.ask(jevQuestionOf(question), state, signal);
      if (!answer) throw new Error(code);
      return {
        choice: answer.choice,
        p: Math.min(1, Math.max(0, answer.probabilities[answer.choice] ?? 0)),
      };
    },
    urlOpener: async ({ url }) => {
      const c = deps.controller();
      if (!c) throw new Error("no_controller");
      const built = actionSchema.parse({
        type: "open_url",
        url,
        frame_id: "streamed",
      });
      if (built.type !== "open_url") throw new Error("not_open_url");
      const result = await c.openUrl(built);
      return {
        navigated: !!result?.navigated,
        method: result?.navigated?.via ?? "open",
      };
    },
    // The consumer's own engines speak (electron/speech-output.ts).
    tts: async () => ({ played: false, ms: 0 }),
  };
}
