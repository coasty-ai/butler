/**
 * Steps taken while the user was still speaking (.data/design/streaming-execution.md
 * §3.3): electron/streaming.ts decides one fast action per committed clause
 * of the growing partial and executes it before any run exists, navigation
 * only (an application, a web address built from a site recipe, a scroll).
 * When the final starts a run, the steps ride in as StartOptions.streamed:
 * the run journals each as its own entry kind (StreamedStep: kind, siteKey,
 * clauseIndex, outcome; never a URL or a word) and tells the model in its
 * first observation what is already done, so it continues from the screen
 * as it is instead of opening the site again. They are not model actions:
 * amendTask still accepts a longer task after them.
 *
 * The words here are what the pill shows and what the model reads; the
 * search terms are the user's own words from the clause, never screen text.
 */
import { z } from "zod";
import { webAddress } from "./schema";

/** A fast action as electron/streaming.ts executed it (src/voice/fast.ts FastAction, minus "none"). */
export const streamedActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open_app"), name: z.string().min(1).max(100) }),
  z.object({
    kind: z.literal("open_url"),
    url: z.string().min(8).max(2000),
    siteKey: z.string().max(40),
    label: z.string().max(120),
  }),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["down", "up"]) }),
]);
export type StreamedAction = z.infer<typeof streamedActionSchema>;
export const streamedStepSchema = z.object({
  /** The clause of the utterance the action answered (0-based). */
  clauseIndex: z.number().int().min(0).max(99),
  action: streamedActionSchema,
  /** When it was issued (the executor's clock). */
  atMs: z.number(),
  /**
   * "done": executed; "failed": refused or errored, nothing changed;
   * "dropped": executed, but the final no longer says the clause (the
   * recognizer rewrote it), so the model is told it was done by mistake.
   */
  outcome: z.enum(["done", "failed", "dropped"]),
});
export type StreamedStep = z.infer<typeof streamedStepSchema>;

/** Sites the recipes address, as people say them; a key outside this list reads as its label or host. */
const SITE_NAMES: Record<string, string> = {
  youtube: "YouTube",
  google: "Google",
  google_maps: "Google Maps",
  maps: "Google Maps",
  amazon: "Amazon",
  wikipedia: "Wikipedia",
  github: "GitHub",
  reddit: "Reddit",
  x: "X",
  twitter: "X",
  gmail: "Gmail",
  linkedin: "LinkedIn",
  netflix: "Netflix",
};
/** Query parameters the recipes carry a search in, and Gmail's fragment. */
const SEARCH_PARAMS = ["search_query", "q", "query", "k", "search"];
const bound = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

/** The site an open_url goes to, as the pill and the model name it. */
export function siteName(
  action: Extract<StreamedAction, { kind: "open_url" }>,
) {
  const known = SITE_NAMES[action.siteKey.toLowerCase()];
  if (known) return known;
  if (action.label.trim()) return bound(action.label.trim(), 60);
  const host = webAddress(action.url)?.hostname ?? "";
  return host.replace(/^www\./, "") || "the page";
}
/** The search a recipe URL carries, decoded; undefined for a plain page. */
export function searchTerms(url: string): string | undefined {
  const parsed = webAddress(url);
  if (!parsed) return undefined;
  for (const key of SEARCH_PARAMS) {
    const value = parsed.searchParams.get(key)?.replace(/\s+/g, " ").trim();
    if (value) return bound(value, 80);
  }
  const fragment = /^#search\/(.+)$/.exec(parsed.hash);
  if (fragment) {
    try {
      const value = decodeURIComponent(fragment[1]).replace(/\+/g, " ").trim();
      if (value) return bound(value, 80);
    } catch {
      /* an undecodable fragment names no search */
    }
  }
  return undefined;
}
/**
 * What an open_url is called: the recipe's own label ("YouTube", "YouTube
 * search for midwest safety"), else the site and the search read from the
 * address, else the host.
 */
export function urlLabel(
  action: Extract<StreamedAction, { kind: "open_url" }>,
): string {
  const label = action.label.replace(/\s+/g, " ").trim();
  if (label) return bound(label, 100);
  const site = siteName(action);
  const terms = searchTerms(action.url);
  return terms ? `${site} search for ${terms}` : site;
}
/** "YouTube search for x" as its site and its words, for the pill's verb. */
const SEARCH_LABEL = /^(.+?) search for (.+)$/i;
/** One step as the model reads it: "opened Safari", "YouTube search for x is loading". */
export function describeStreamed(action: StreamedAction): string {
  switch (action.kind) {
    case "open_app":
      return `opened ${bound(action.name, 60)}`;
    case "open_url":
      return `${urlLabel(action)} is loading`;
    case "scroll":
      return `scrolled ${action.direction}`;
  }
}
/** The pill's line while the user still speaks: "Opening YouTube…", "Searching YouTube for x…". */
export function streamedPillLabel(action: StreamedAction): string {
  switch (action.kind) {
    case "open_app":
      return `Opening ${bound(action.name, 40)}…`;
    case "open_url": {
      const label = urlLabel(action);
      const search = SEARCH_LABEL.exec(label);
      return search
        ? `Searching ${search[1]} for ${bound(search[2], 40)}…`
        : `Opening ${bound(label, 40)}…`;
    }
    case "scroll":
      return `Scrolling ${action.direction}…`;
  }
}
/**
 * The first observation's prelude (design §3.3): what is done, then what
 * the final no longer asked for. Undefined when nothing was done or dropped
 * (failed steps changed nothing and are not named).
 */
export function streamedPrelude(steps: StreamedStep[]): string | undefined {
  const done = steps
    .filter((s) => s.outcome === "done")
    .map((s) => describeStreamed(s.action));
  const dropped = steps
    .filter((s) => s.outcome === "dropped")
    .map((s) => describeStreamed(s.action));
  if (!done.length && !dropped.length) return undefined;
  const parts: string[] = [];
  if (done.length)
    parts.push(
      `Already done while you spoke: ${done.join("; ")}. Continue from this screen; do not repeat these.`,
    );
  if (dropped.length)
    parts.push(
      `Done by mistake (the sentence changed): ${dropped.join("; ")}; put it right if it matters.`,
    );
  return parts.join(" ");
}
/** The pill's line after a final that started no run: what was opened stays. */
export function streamedSummary(steps: StreamedStep[]): string | undefined {
  const done = steps.filter((s) => s.outcome === "done");
  if (!done.length) return undefined;
  const last = done[done.length - 1].action;
  switch (last.kind) {
    case "open_app":
      return `Opened ${bound(last.name, 40)}.`;
    case "open_url": {
      const label = urlLabel(last);
      const search = SEARCH_LABEL.exec(label);
      return search
        ? `Searched ${search[1]} for ${bound(search[2], 40)}.`
        : `Opened ${bound(label, 40)}.`;
    }
    case "scroll":
      return `Scrolling ${last.direction}… say stop.`;
  }
}
