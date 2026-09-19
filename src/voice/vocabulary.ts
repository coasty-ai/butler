import { normalizeAppName } from "../core/policy";
import type { SystemIndex } from "../core/memory";

/**
 * How often an app was opened, as memory records it (src/memory/types.ts
 * AppUsage, structurally); src/voice imports nothing above src/core.
 */
export interface AppUsage {
  bundleId: string;
  name: string;
  count: number;
  lastUsed: string;
}

/**
 * The phrases the voice helper hands Apple's on-device recognizer as
 * SFSpeechRecognitionRequest.contextualStrings, so the names a command turns
 * on are written as said: the 2026-09-19 voice trial heard "open a new
 * TextEdit window" as "open a new text window" and "quit Calculator" as
 * "quick calculator". Apple documents the strings as raising the likelihood
 * of those phrases being recognized, asks for brief ones ("one or two words
 * whenever possible") and says to limit them to no more than 100
 * (developer.apple.com/documentation/speech/sfspeechrecognitionrequest/contextualstrings);
 * the helper puts the wake phrase first while listening for it, so this list
 * stops at 90. Pure: electron/main.ts builds it from the native index,
 * memory's app usage and the workspace's open-app lines, and re-sends it
 * through "configure" whenever it changes.
 */
export const VOCABULARY_LIMIT = 90;
/** Longer names are dropped: Apple says lengthy phrases are less likely to be recognized. */
export const PHRASE_LIMIT = 40;
/**
 * Butler's own command words and the app names recognizers garble, always
 * first so no length of app list can push them out.
 */
export const BUTLER_WORDS = [
  "TextEdit",
  "Calculator",
  "Finder",
  "Safari",
  "Notes",
  "Reminders",
  "Calendar",
  "Messages",
  "Slack",
  "Chrome",
  "Terminal",
  "Xcode",
  "undo",
  "scroll",
  "Butler",
] as const;
/**
 * Installed names as people say them, kept beside the installed name: the
 * vendor-free or shortened form a command would use.
 */
const SPOKEN_FORMS = new Map<string, readonly string[]>([
  ["visual studio code", ["VS Code"]],
  ["google chrome", ["Chrome"]],
  ["zoom.us", ["Zoom"]],
  ["microsoft excel", ["Excel"]],
  ["microsoft powerpoint", ["PowerPoint"]],
  ["microsoft outlook", ["Outlook"]],
]);

export interface VocabularyInput {
  /** The native index's applications, as "index" last listed them. */
  installed: readonly Pick<SystemIndex["apps"][number], "name" | "bundleId">[];
  /** Memory's app usage by bundle id: the apps opened most come first. */
  usage?: Readonly<Record<string, AppUsage>>;
  /** The workspace's open-app lines ("Safari (frontmost): Home | Mail"), in use order. */
  openApps?: readonly string[];
}

/** A name as the recognizer should see it, or undefined when it is not a phrase. */
export function vocabularyPhrase(name: string): string | undefined {
  let phrase = name.trim();
  if (/\.app$/i.test(phrase)) phrase = phrase.slice(0, -4);
  phrase = phrase.split(/\s+/).filter(Boolean).join(" ");
  return phrase && phrase.length <= PHRASE_LIMIT ? phrase : undefined;
}

/** The application an open-app line names: "Safari (frontmost): Home | Mail" is Safari. */
export function openAppName(line: string): string {
  return line.replace(/: .*$/s, "").replace(/ \(frontmost\)$/, "");
}

/**
 * The phrases in priority order: Butler's words, the apps opened most (by
 * count, then recency), the apps open now (in the workspace's use order),
 * then every installed app alphabetically, each installed name followed by
 * its spoken form. Deduplicated regardless of case and cut at
 * VOCABULARY_LIMIT, so the same inputs always give the same list.
 */
export function recognizerVocabulary({
  installed,
  usage = {},
  openApps = [],
}: VocabularyInput): string[] {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const app of installed) {
    byId.set(app.bundleId, app.name);
    byName.set(normalizeAppName(app.name), app.name);
  }
  const frequent = Object.values(usage)
    .filter((use) => byId.has(use.bundleId))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.lastUsed.localeCompare(a.lastUsed) ||
        a.bundleId.localeCompare(b.bundleId),
    )
    .map((use) => byId.get(use.bundleId)!);
  const running = openApps.flatMap(
    (line) => byName.get(normalizeAppName(openAppName(line))) ?? [],
  );
  const rest = [...byName.values()].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" }),
  );
  const phrases: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const phrase = vocabularyPhrase(name);
    if (
      !phrase ||
      seen.has(phrase.toLowerCase()) ||
      phrases.length >= VOCABULARY_LIMIT
    )
      return;
    seen.add(phrase.toLowerCase());
    phrases.push(phrase);
  };
  for (const word of BUTLER_WORDS) add(word);
  for (const name of [...frequent, ...running, ...rest]) {
    add(name);
    for (const spoken of SPOKEN_FORMS.get(normalizeAppName(name)) ?? [])
      add(spoken);
  }
  return phrases;
}
