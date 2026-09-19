import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BUTLER_WORDS,
  PHRASE_LIMIT,
  VOCABULARY_LIMIT,
  openAppName,
  recognizerVocabulary,
  vocabularyPhrase,
} from "../src/voice/vocabulary";
import { SKIP_PHASES } from "../src/gym/voice/grade";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = (
  name: string,
  bundleId = `com.example.${name.toLowerCase().replace(/\W+/g, "-")}`,
) => ({ name, bundleId });
const use = (
  bundleId: string,
  count: number,
  lastUsed = "2026-09-18T00:00:00.000Z",
) => ({ bundleId, name: bundleId, count, lastUsed });

describe("recognizer vocabulary", () => {
  it("names the words the 2026-09-19 trial misheard, ahead of everything", () => {
    expect(BUTLER_WORDS).toContain("TextEdit");
    expect(BUTLER_WORDS).toContain("Calculator");
    expect(recognizerVocabulary({ installed: [] })).toEqual([...BUTLER_WORDS]);
    // Apple's request takes 100; the helper puts "Hey Butler" first while listening for it.
    expect(VOCABULARY_LIMIT + 1).toBeLessThanOrEqual(100);
  });

  it("puts the apps opened most first, then the open ones, then the rest alphabetically", () => {
    const installed = [
      app("Zed"),
      app("Numbers"),
      app("Slack"),
      app("TextEdit"),
      app("Visual Studio Code"),
      app("Xcode"),
      app("Preview"),
      app("Pages"),
    ];
    const usage = {
      [app("Pages").bundleId]: use(app("Pages").bundleId, 3),
      [app("Numbers").bundleId]: use(app("Numbers").bundleId, 9),
      // Opened often once, uninstalled since: not a word to bias toward.
      "com.example.gone": use("com.example.gone", 50),
    };
    const openApps = [
      "Preview (frontmost): report.pdf",
      "Zed: main.ts | b.ts",
      "Butler regression check",
    ];
    expect(recognizerVocabulary({ installed, usage, openApps })).toEqual([
      ...BUTLER_WORDS,
      "Numbers",
      "Pages",
      "Preview",
      "Zed",
      "Visual Studio Code",
      "VS Code",
    ]);
  });

  it("orders equal counts by recency, and the same inputs always give the same list", () => {
    const installed = [app("Pages"), app("Numbers"), app("Keynote")];
    const usage = {
      [app("Pages").bundleId]: use(
        app("Pages").bundleId,
        2,
        "2026-09-01T00:00:00.000Z",
      ),
      [app("Keynote").bundleId]: use(
        app("Keynote").bundleId,
        2,
        "2026-09-18T00:00:00.000Z",
      ),
    };
    const list = recognizerVocabulary({ installed, usage });
    expect(list.slice(BUTLER_WORDS.length)).toEqual([
      "Keynote",
      "Pages",
      "Numbers",
    ]);
    expect(
      recognizerVocabulary({ installed: [...installed].reverse(), usage }),
    ).toEqual(list);
  });

  it("keeps the installed name beside the way it is said", () => {
    const list = recognizerVocabulary({
      installed: [app("Google Chrome"), app("zoom.us"), app("Microsoft Excel")],
    });
    expect(list.slice(BUTLER_WORDS.length)).toEqual([
      "Google Chrome",
      "Microsoft Excel",
      "Excel",
      "zoom.us",
      "Zoom",
    ]);
    // "Chrome" is already one of Butler's words: once.
    expect(list.filter((p) => p.toLowerCase() === "chrome")).toHaveLength(1);
  });

  it("trims, drops .app, collapses spaces, dedupes regardless of case, and drops empty or overlong names", () => {
    expect(vocabularyPhrase("  TextEdit.app ")).toBe("TextEdit");
    expect(vocabularyPhrase("Visual  Studio\tCode")).toBe("Visual Studio Code");
    expect(vocabularyPhrase("")).toBeUndefined();
    expect(vocabularyPhrase("   ")).toBeUndefined();
    expect(vocabularyPhrase(".app")).toBeUndefined();
    expect(vocabularyPhrase("x".repeat(PHRASE_LIMIT))).toBe(
      "x".repeat(PHRASE_LIMIT),
    );
    expect(vocabularyPhrase("x".repeat(PHRASE_LIMIT + 1))).toBeUndefined();
    const list = recognizerVocabulary({
      installed: [
        app("safari"),
        app("SAFARI", "com.other.safari"),
        app(" Notes.app "),
        app("x".repeat(60)),
        app(""),
      ],
    });
    expect(list).toEqual([...BUTLER_WORDS]);
  });

  it("stops at 90 phrases, in priority order, however many apps are installed", () => {
    const installed = Array.from({ length: 120 }, (_, i) =>
      app(`App ${String(i + 1).padStart(3, "0")}`),
    );
    const usage = {
      [installed[119].bundleId]: use(installed[119].bundleId, 4),
    };
    const openApps = ["App 110 (frontmost)"];
    const list = recognizerVocabulary({ installed, usage, openApps });
    expect(list).toHaveLength(VOCABULARY_LIMIT);
    expect(list.slice(0, BUTLER_WORDS.length)).toEqual([...BUTLER_WORDS]);
    expect(list.slice(BUTLER_WORDS.length, BUTLER_WORDS.length + 2)).toEqual([
      "App 120",
      "App 110",
    ]);
    expect(list.at(-1)).toBe("App 073");
    expect(
      recognizerVocabulary({
        installed: [...installed].reverse(),
        usage,
        openApps,
      }),
    ).toEqual(list);
  });

  it("reads the application from an open-app line", () => {
    expect(openAppName("Safari (frontmost): Home | Mail: inbox")).toBe(
      "Safari",
    );
    expect(openAppName("Zed")).toBe("Zed");
    expect(openAppName("Notes (frontmost)")).toBe("Notes");
    expect(openAppName("Notes: a: b")).toBe("Notes");
  });

  it("is sent with the helper's configure, again when the app list changes, and reported as a count", () => {
    const main = read("electron/main.ts");
    const configure = main.slice(
      main.indexOf("async function configureVoice("),
      main.indexOf("function currentGate("),
    );
    expect(configure).toContain("vocabulary,");
    expect(configure).toContain("vocabularySent = JSON.stringify(vocabulary)");
    // An index answer schedules a debounced re-send of the list alone, only when it changed.
    const remember = main.slice(
      main.indexOf("function rememberAppNames("),
      main.indexOf("function refreshAppNames("),
    );
    expect(remember).toContain("scheduleVocabulary()");
    const sender = main.slice(
      main.indexOf("function voiceVocabulary("),
      main.indexOf("function voiceOutputConfig("),
    );
    expect(sender).toMatch(
      /recognizerVocabulary\(\{[\s\S]*installed: installedApps,[\s\S]*usage: memory && settings\.memory \? memory\.data\(\)\.apps : undefined,[\s\S]*openApps: frameContext\(\)\?\.openApps,/,
    );
    expect(sender).toMatch(
      /if \(key === vocabularySent\) return;[\s\S]*call\("configure", \{ vocabulary \}\)/,
    );
    // Diagnostics carry the count and never the words.
    expect(main).toMatch(/debug\("VoiceEvent", \{[\s\S]*?count: event\.count,/);
    expect(read("electron/voice.ts")).toMatch(/count\?: number;/);
    expect(read("electron/diagnostics.ts")).toMatch(
      /countFields = new Set\(\[[^\]]*"count"/,
    );
    // Bookkeeping for the voice loop's gate: nothing happened in the room.
    expect(SKIP_PHASES.has("vocabulary")).toBe(true);
    // The helper stores the sanitized list, reports its size, and hands it to every request.
    const helper = read("native/macos/Voice.swift");
    expect(helper).toMatch(
      /command\["vocabulary"\] as\? \[String\][\s\S]{0,200}recognizerVocabulary\(value\)/,
    );
    expect(helper).toContain(
      'output(["event": "vocabulary", "count": next.count])',
    );
    expect(helper).toContain(
      "recognizerContext(ambient: mode == .standby || mode == .followUp, vocabulary: vocabulary)",
    );
    const policy = read("native/macos/WakePolicy.swift");
    expect(policy).toContain(
      "developer.apple.com/documentation/speech/sfspeechrecognitionrequest/contextualstrings",
    );
    expect(policy).toContain(
      `let recognizerVocabularyLimit = ${VOCABULARY_LIMIT}`,
    );
    expect(policy).toContain(`let recognizerPhraseLimit = ${PHRASE_LIMIT}`);
    expect(read("docs/VOICE_PRODUCT.md")).toMatch(/contextual strings/);
  });
});
