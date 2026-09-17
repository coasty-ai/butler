import type { BenchCategory, BenchTask, Evidence, Grade } from "./types";
import {
  BROWSER_APPS,
  SEARCH_HOSTS,
  accessibilityText,
  containsAll,
  containsNumber,
  frontmost,
  gradeFrontmostAnd,
  hostMatches,
  hostMatchesAny,
  launchedApp,
  openedPathStep,
  typedAtLeast,
  unverifiable,
  verdict,
} from "./graders";

/**
 * The automation benchmark catalogue.
 *
 * Every task is safe to run unattended: it opens, reads, computes or navigates,
 * and the one task that creates something deletes it again. Nothing here sends,
 * posts, pays, installs, or touches Messages, Mail or any user document.
 *
 * Graders read the end state through the native controller (frontmost bundle
 * id, window title, accessibility text, committed browser host) or the run
 * journal. No grader compares screenshots, and none returns screen text.
 */

const CALCULATOR = "com.apple.Calculator";
const NOTES = "com.apple.Notes";
const MUSIC = "com.apple.Music";

/** A task that only has to bring an application to the front. */
function opensApp(
  id: string,
  instruction: string,
  appId: string,
  category: BenchCategory,
  safety: string,
): BenchTask {
  return {
    id,
    instruction,
    apps: [appId],
    category,
    difficulty: "easy",
    maxCost: 0.05,
    maxActions: 8,
    maxSeconds: 90,
    safety,
    verifies: `The native controller reports ${appId} frontmost when the run ends.`,
    grade: (evidence) => gradeFrontmostAnd(evidence, [appId]),
  };
}

/** Calculator: the display must show the answer, not just the app. */
function calculates(
  id: string,
  instruction: string,
  answer: string,
  difficulty: "medium" | "hard",
  maxCost: number,
): BenchTask {
  return {
    id,
    instruction,
    apps: [CALCULATOR],
    category: "calculator",
    difficulty,
    maxCost,
    maxActions: 20,
    maxSeconds: 180,
    safety: "Arithmetic in Calculator. Nothing is saved or sent.",
    verifies: `Calculator is frontmost and its accessibility text shows ${answer}.`,
    grade: (evidence) =>
      gradeFrontmostAnd(
        evidence,
        [CALCULATOR],
        (text) => ({ result: containsNumber(text, answer) }),
        { result: "RESULT_NOT_SHOWN" },
      ),
  };
}

/** A web search: the browser is frontmost, on a search host, showing the query. */
function searches(
  id: string,
  instruction: string,
  terms: string[],
  hosts: string[],
  difficulty: "easy" | "medium",
  maxCost: number,
): BenchTask {
  return {
    id,
    instruction,
    apps: BROWSER_APPS,
    category: id.startsWith("media") ? "media" : "browser",
    difficulty,
    maxCost,
    maxActions: 16,
    maxSeconds: 180,
    safety:
      "Read-only navigation. The task never signs in, submits a form or plays media.",
    verifies: `A browser is frontmost on ${hosts.length > 2 ? "a search results page" : hosts.join(" or ")} and the page text or address shows the query terms.`,
    grade: (evidence) => {
      const app = frontmost(evidence);
      if (!app) return unverifiable("NO_FRONTMOST_INFO");
      const address = evidence.domain ?? evidence.context?.browserAddress;
      const checks: Record<string, boolean> = {
        frontmost: BROWSER_APPS.includes(app),
        host: hostMatchesAny(address, hosts),
      };
      const text = accessibilityText(evidence.context);
      // Without any host or accessibility text there is nothing to read back.
      if (!address && !text)
        return checks.frontmost
          ? unverifiable("NO_ACCESSIBILITY")
          : verdict(checks, { frontmost: "NOT_FRONTMOST" });
      checks.query = containsAll(
        `${text} ${(address ?? "").toLowerCase()}`,
        terms,
      );
      return verdict(checks, {
        frontmost: "NOT_FRONTMOST",
        host: "HOST_MISMATCH",
        query: "QUERY_NOT_SHOWN",
      });
    },
  };
}

/**
 * Notes: create a note with a unique marker, then delete it. The grader needs
 * evidence that the note existed (typed text of at least the marker's length
 * while Notes was frontmost) and that the marker is gone from the end state.
 */
const notesCreateDelete: BenchTask = {
  id: "notes-create-delete",
  instruction:
    "In Notes, create a new note containing exactly the text {token}, then delete that note.",
  apps: [NOTES],
  category: "notes",
  difficulty: "hard",
  maxCost: 0.3,
  maxActions: 30,
  maxSeconds: 300,
  safety:
    "Self-cleaning: the note it creates is the note it deletes, identified by a marker generated for this attempt. No existing note is touched.",
  verifies:
    "The journal shows the marker typed while Notes was frontmost, Notes is frontmost at the end, and the marker no longer appears in the accessibility text.",
  prepare: async ({ token }) => ({ token: token() }),
  grade: (evidence: Evidence): Grade => {
    const marker = evidence.parameters.token ?? "";
    if (!marker) return unverifiable("NO_MARKER");
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const checks: Record<string, boolean> = {
      created: typedAtLeast(evidence.journal, marker.length, [NOTES]),
      frontmost: app === NOTES,
    };
    const text = accessibilityText(evidence.context);
    if (!text)
      return checks.created && checks.frontmost
        ? unverifiable("NO_ACCESSIBILITY")
        : verdict(checks, {
            created: "NOTE_NOT_TYPED",
            frontmost: "NOT_FRONTMOST",
          });
    checks.deleted = !text.includes(marker.toLowerCase());
    return verdict(checks, {
      created: "NOTE_NOT_TYPED",
      frontmost: "NOT_FRONTMOST",
      deleted: "NOTE_NOT_DELETED",
    });
  },
};

/**
 * Files: open a document the local system index already knows about. prepare()
 * picks the most recently used indexed document; with nothing to pick the
 * attempt is skipped as unknown rather than counted as a failure.
 */
const filesOpenRecent: BenchTask = {
  id: "files-open-recent",
  instruction: "Open the file {name}",
  apps: [],
  category: "files",
  difficulty: "medium",
  maxCost: 0.12,
  maxActions: 12,
  maxSeconds: 150,
  safety:
    "Opens an existing document read-only through open_file, which already refuses executables, scripts and installers. Nothing is edited or saved.",
  verifies:
    "The journal shows open_file opening exactly the resolved path and the handling application frontmost, or the frontmost window title names the file.",
  prepare: async ({ index }) => {
    const result = await index("");
    const file = (result.recentFiles ?? []).find(
      (item) => item.kind === "document" && item.name && item.path,
    );
    return file ? { name: file.name, path: file.path } : null;
  },
  grade: (evidence) => {
    const path = evidence.parameters.path ?? "";
    const name = evidence.parameters.name ?? "";
    if (!path || !name) return unverifiable("NO_TARGET_FILE");
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const step = openedPathStep(evidence.journal, path);
    if (step) {
      const checks = {
        opened: true,
        frontmost: !step.openedAppId || step.openedAppId === app,
      };
      return verdict(checks, { frontmost: "HANDLER_NOT_FRONTMOST" });
    }
    // Spotlight or the Finder can open the same file without open_file; the
    // window title is then the only end-state evidence.
    const text = accessibilityText(evidence.context);
    if (!text) return unverifiable("NO_ACCESSIBILITY");
    const base = name.replace(/\.[^.]+$/, "").toLowerCase();
    return verdict(
      { opened: base.length >= 3 && text.includes(base) },
      { opened: "FILE_NOT_OPENED" },
    );
  },
};

/** Multi-app: launch Calculator, then leave the browser frontmost on a host. */
const multiCalculatorBrowser: BenchTask = {
  id: "multi-calculator-browser",
  instruction:
    "Open Calculator, then switch to the browser and go to example.com",
  apps: [CALCULATOR, ...BROWSER_APPS],
  category: "multi-app",
  difficulty: "hard",
  maxCost: 0.3,
  maxActions: 24,
  maxSeconds: 300,
  safety:
    "Launches Calculator and navigates to example.com, a reserved documentation domain with no account or content.",
  verifies:
    "The journal shows Calculator launched, and a browser is frontmost on example.com when the run ends.",
  grade: (evidence) => {
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const address = evidence.domain ?? evidence.context?.browserAddress;
    return verdict(
      {
        launchedCalculator: launchedApp(evidence.journal, CALCULATOR),
        frontmost: BROWSER_APPS.includes(app),
        host: hostMatches(address, "example.com"),
      },
      {
        launchedCalculator: "CALCULATOR_NOT_LAUNCHED",
        frontmost: "NOT_FRONTMOST",
        host: "HOST_MISMATCH",
      },
    );
  },
};

export const CATALOGUE: BenchTask[] = [
  opensApp(
    "browser-open",
    "Open Safari",
    "com.apple.Safari",
    "browser",
    "Launch only. No page is opened and nothing is typed.",
  ),
  {
    ...opensApp(
      "browser-goto",
      "Go to example.com",
      "com.apple.Safari",
      "browser",
      "example.com is a reserved documentation domain with no account or content.",
    ),
    apps: BROWSER_APPS,
    difficulty: "easy",
    maxCost: 0.08,
    maxActions: 10,
    maxSeconds: 120,
    verifies:
      "A browser is frontmost and the committed page host is example.com.",
    grade: (evidence: Evidence): Grade => {
      const app = frontmost(evidence);
      if (!app) return unverifiable("NO_FRONTMOST_INFO");
      const address = evidence.domain ?? evidence.context?.browserAddress;
      const checks = {
        frontmost: BROWSER_APPS.includes(app),
        host: hostMatches(address, "example.com"),
      };
      // No address at all: the browser may be there, but nothing proves the page.
      if (!address && checks.frontmost)
        return unverifiable("NO_BROWSER_ADDRESS");
      return verdict(checks, {
        frontmost: "NOT_FRONTMOST",
        host: "HOST_MISMATCH",
      });
    },
  },
  searches(
    "browser-search",
    "Search the web for the San Francisco weather forecast",
    ["san francisco", "weather"],
    SEARCH_HOSTS,
    "medium",
    0.12,
  ),
  opensApp(
    "calculator-open",
    "Open Calculator",
    CALCULATOR,
    "calculator",
    "Launch only. No calculation is entered.",
  ),
  calculates(
    "calculator-multiply",
    "Open Calculator and multiply 128 by 46",
    "5888",
    "medium",
    0.15,
  ),
  calculates(
    "calculator-percent",
    "In Calculator, work out 17.5 percent of 240",
    "42",
    "hard",
    0.2,
  ),
  opensApp(
    "notes-open",
    "Open Notes",
    NOTES,
    "notes",
    "Launch only. No note is created or edited.",
  ),
  notesCreateDelete,
  filesOpenRecent,
  opensApp(
    "media-open-music",
    "Open Music",
    MUSIC,
    "media",
    "Launch only. Nothing is played, bought or added to a library.",
  ),
  searches(
    "media-youtube-search",
    "In the browser, search YouTube for lofi beats. Do not play anything.",
    ["lofi"],
    ["youtube.com"],
    "medium",
    0.15,
  ),
  multiCalculatorBrowser,
];

export const CATEGORIES: BenchCategory[] = [
  "browser",
  "notes",
  "calculator",
  "files",
  "media",
  "multi-app",
];

/**
 * Resolves a `--tasks` selector: a comma-separated list of task ids, category
 * names or "all". Unknown entries are reported rather than silently dropped.
 */
export function selectTasks(
  selector: string | undefined,
  catalogue: BenchTask[] = CATALOGUE,
): { tasks: BenchTask[]; unknown: string[] } {
  if (!selector || selector.trim() === "" || selector.trim() === "all")
    return { tasks: [...catalogue], unknown: [] };
  const wanted = selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const tasks: BenchTask[] = [];
  const unknown: string[] = [];
  for (const entry of wanted) {
    const byId = catalogue.filter((task) => task.id === entry);
    const byCategory = catalogue.filter((task) => task.category === entry);
    const matched = byId.length ? byId : byCategory;
    if (!matched.length) {
      unknown.push(entry);
      continue;
    }
    for (const task of matched) if (!tasks.includes(task)) tasks.push(task);
  }
  return { tasks, unknown };
}

/** A short unique marker for self-cleaning tasks (letters and digits only). */
export function benchToken(random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 1e6)
    .toString(36)
    .padStart(4, "0");
  return `benchnote${suffix}`;
}
