import { describe, it, expect } from "vitest";
import { failureClasses } from "../src/gym/bench/cycle-report";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOGUE,
  CATEGORIES,
  benchToken,
  drawMultiply,
  drawPercent,
  selectTasks,
} from "../src/gym/bench/catalogue";
import {
  CALCULATOR,
  FILE_WRITE_TOOLS,
  FINDER,
  NOTES,
  SENSITIVE_PROMPT,
  TEXTEDIT,
  accessibilityText,
  agendaItems,
  approvesPrompt,
  checked,
  containsAll,
  containsNumber,
  countSteps,
  daysFrom,
  factChecks,
  fileEntry,
  fileText,
  filesMatching,
  fillInstruction,
  gradeTask,
  holdOverride,
  honestHandoff,
  hostMatches,
  inApp,
  inOrder,
  inputCount,
  launchOf,
  launchedApp,
  localHour,
  markerValues,
  markersIn,
  menuLeafOf,
  missingFactsOf,
  mutations,
  normalizeHost,
  normalizeText,
  noteRoute,
  occurrences,
  onlyEntries,
  openedPathStep,
  playlistNamed,
  sameLocalDay,
  savedNote,
  toolCallOf,
  typedAtLeast,
  typedMarker,
  typedMarkerIn,
  visited,
  windowTitleHas,
  withFacts,
  wroteFileByTool,
  SUB_CHECK,
} from "../src/gym/bench/graders";
import {
  HARNESS_CODES,
  aggregate,
  declinedCodes,
  doneChallengeCode,
  doneChallengeLine,
  doneChallengeTotals,
  endingCode,
  factContributors,
  factsLine,
  honesty,
  median,
  missingFactCounts,
  pausedAfterCode,
  ran,
  reasonLabel,
  renderSummary,
  renderTable,
  skipped,
  type AttemptResult,
} from "../src/gym/bench/report";
import {
  analyze,
  budgetCode,
  frictionCodes,
  noteFor,
  ownerOf,
  parseDiagnostics,
  renderAnalysis,
  TEXT_TRUNCATED_PREFIX,
} from "../src/gym/bench/analyze";
import type {
  BenchTask,
  Evidence,
  RunJournal,
  TakeoverSource,
} from "../src/gym/bench/types";
import {
  defaultSettings,
  type Controller,
  type JournalEvent,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type ScreenContext,
  type Snapshot,
} from "../src/core/schema";
import { LOOP_STUCK_MESSAGE, Runner } from "../src/core/runner";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sources = (
  over: Partial<Record<TakeoverSource, number>> = {},
): Record<TakeoverSource, number> => ({
  manual_input: 0,
  request_user: 0,
  policy: 0,
  surface: 0,
  handoff: 0,
  ...over,
});
const journal = (over: Partial<RunJournal> = {}): RunJournal => ({
  status: "completed",
  settled: true,
  actions: 4,
  steps: [],
  approvals: 0,
  approvalsDeclined: 0,
  retries: 0,
  takeovers: 0,
  takeoverSources: sources(),
  manualTakeover: false,
  modelFailed: false,
  loops: 0,
  noProgress: 0,
  failures: {},
  endingCode: "COMPLETED",
  cost: 0.01,
  seconds: 12,
  modelCalls: 4,
  ...over,
});
const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  journal: journal(),
  parameters: {},
  ...over,
});
const context = (over: Partial<ScreenContext> = {}): ScreenContext => ({
  appName: "App",
  windowTitle: "Window",
  ...over,
});
const task = (id: string): BenchTask => {
  const found = CATALOGUE.find((entry) => entry.id === id);
  if (!found) throw new Error(`No task ${id}`);
  return found;
};

describe("benchmark catalogue", () => {
  it("has unique ids", () => {
    const ids = CATALOGUE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(5);
  });
  it("gives every task a grader and a cost cap", () => {
    for (const entry of CATALOGUE) {
      expect(typeof entry.grade, entry.id).toBe("function");
      expect(entry.maxCost, entry.id).toBeGreaterThan(0);
      // No single task may cost more than a coffee; a whole run must stay small.
      expect(entry.maxCost, entry.id).toBeLessThanOrEqual(0.5);
      expect(entry.maxActions, entry.id).toBeGreaterThan(0);
      expect(entry.maxSeconds, entry.id).toBeGreaterThan(0);
      expect(CATEGORIES, entry.id).toContain(entry.category);
      expect(["easy", "medium", "hard"], entry.id).toContain(entry.difficulty);
      expect(entry.instruction.length, entry.id).toBeGreaterThan(3);
      expect(entry.safety.length, entry.id).toBeGreaterThan(10);
      expect(entry.verifies.length, entry.id).toBeGreaterThan(10);
    }
  });
  it("keeps the whole catalogue inside a small budget", () => {
    const ceiling = CATALOGUE.reduce((total, e) => total + e.maxCost, 0);
    expect(ceiling).toBeLessThanOrEqual(3);
  });
  it("resolves every instruction placeholder from prepare", () => {
    for (const entry of CATALOGUE) {
      const placeholders = [...entry.instruction.matchAll(/\{(\w+)\}/g)];
      if (placeholders.length)
        expect(entry.prepare, entry.id).toBeTypeOf("function");
    }
  });
  it("never targets a sending or messaging application", () => {
    const forbidden = [
      "com.apple.MobileSMS",
      "com.apple.mail",
      "com.apple.iChat",
    ];
    for (const entry of CATALOGUE)
      for (const app of entry.apps) expect(forbidden).not.toContain(app);
    const text = CATALOGUE.map((e) => e.instruction.toLowerCase()).join(" ");
    for (const word of ["send", " pay ", "purchase", "publish", "install"])
      expect(text).not.toContain(word);
  });
  it("selects by id, by category and reports unknown selectors", () => {
    expect(selectTasks("calculator-open").tasks.map((t) => t.id)).toEqual([
      "calculator-open",
    ]);
    const byCategory = selectTasks("calculator");
    expect(byCategory.tasks.length).toBeGreaterThan(1);
    expect(byCategory.tasks.every((t) => t.category === "calculator")).toBe(
      true,
    );
    expect(selectTasks("nope").unknown).toEqual(["nope"]);
    expect(selectTasks(undefined).tasks.length).toBe(CATALOGUE.length);
    expect(selectTasks("all").tasks.length).toBe(CATALOGUE.length);
    // The same task named twice is run once.
    expect(selectTasks("calculator-open,calculator-open").tasks.length).toBe(1);
  });
  it("makes a plain marker token", () => {
    expect(benchToken(() => 0.5)).toMatch(/^benchnote[a-z0-9]+$/);
  });
  it("fills only known placeholders", () => {
    expect(fillInstruction("Open the file {name}", { name: "x" })).toBe(
      "Open the file x",
    );
    expect(fillInstruction("Open {missing}", {})).toBe("Open {missing}");
  });
});

describe("grader helpers", () => {
  it("normalizes hosts and matches subdomains", () => {
    expect(normalizeHost("https://www.Google.com/search?q=a")).toBe(
      "google.com",
    );
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("weather")).toBeUndefined();
    expect(normalizeHost("")).toBeUndefined();
    expect(hostMatches("https://news.google.com/x", "google.com")).toBe(true);
    expect(hostMatches("notgoogle.com", "google.com")).toBe(false);
    expect(hostMatches(undefined, "google.com")).toBe(false);
  });
  it("reads grouped numbers but not longer numbers", () => {
    expect(containsNumber("display 5,888", "5888")).toBe(true);
    expect(containsNumber("display 5888", "5888")).toBe(true);
    expect(containsNumber("display 158882", "5888")).toBe(false);
    expect(containsNumber("display 5888.5", "5888")).toBe(false);
    expect(containsNumber("result 42", "42")).toBe(true);
  });
  it("joins every accessibility field it is given", () => {
    const text = accessibilityText(
      context({
        windowTitle: "Weather - Search",
        visibleText: "San Francisco",
        controls: [{ role: "AXButton", label: "Images", x: 0.1, y: 0.1 }],
        browserAddress: "https://google.com/search?q=weather",
      }),
    );
    expect(containsAll(text, ["san francisco", "images", "google.com"])).toBe(
      true,
    );
    expect(accessibilityText(undefined)).toBe("");
  });
  it("reads the journal for launches, typing and opened files", () => {
    const j = journal({
      steps: [
        { type: "open_app", launchedAppId: "com.apple.calculator" },
        { type: "type_text", appId: "com.apple.Notes", textLength: 14 },
        {
          type: "open_file",
          openedPath: "~/Documents/a.pdf",
          openedAppId: "com.apple.Preview",
        },
      ],
    });
    expect(launchedApp(j, "com.apple.calculator")).toBe(true);
    expect(launchedApp(j, "com.apple.Notes")).toBe(false);
    expect(typedAtLeast(j, 13, ["com.apple.Notes"])).toBe(true);
    expect(typedAtLeast(j, 13, ["com.apple.Safari"])).toBe(false);
    expect(typedAtLeast(j, 15)).toBe(false);
    expect(openedPathStep(j, "~/Documents/a.pdf")?.openedAppId).toBe(
      "com.apple.Preview",
    );
    expect(openedPathStep(j, "~/Documents/b.pdf")).toBeUndefined();
  });
  it("refuses to grade a run the user or a hand-off interrupted", () => {
    expect(holdOverride(journal({ manualTakeover: true }))).toEqual({
      status: "unknown",
      checks: {},
      reason: "MANUAL_TAKEOVER",
    });
    expect(holdOverride(journal({ takeovers: 1 }))?.status).toBe("failed");
    expect(holdOverride(journal({ settled: false }))?.reason).toBe(
      "RUN_NOT_SETTLED",
    );
    expect(holdOverride(journal())).toBeUndefined();
  });
  it("drops the port of a bare address so a fixture host matches", () => {
    expect(normalizeHost("127.0.0.1:47831/benchnote1234/orders")).toBe(
      "127.0.0.1",
    );
    expect(normalizeHost("http://127.0.0.1:47831/x")).toBe("127.0.0.1");
    expect(hostMatches("127.0.0.1:47831/benchnote1234", "127.0.0.1")).toBe(
      true,
    );
    expect(hostMatches("localhost:47831/x", "127.0.0.1")).toBe(false);
  });
  it("names a hand-off by what asked for it", () => {
    const named = (source: TakeoverSource) =>
      holdOverride(
        journal({ takeovers: 1, takeoverSources: sources({ [source]: 1 }) }),
      );
    expect(named("request_user")?.reason).toBe("HANDOFF_REQUEST_USER");
    expect(named("handoff")?.reason).toBe("HANDOFF_TARGET");
    expect(named("policy")?.reason).toBe("HANDOFF_POLICY");
    expect(named("surface")?.reason).toBe("HANDOFF_SURFACE");
    expect(named("policy")?.status).toBe("failed");
    // Real input is never graded, whichever way it was counted.
    expect(named("manual_input")?.reason).toBe("MANUAL_TAKEOVER");
    expect(named("manual_input")?.status).toBe("unknown");
    // A hand-off counted without its source keeps the older, unsourced code.
    expect(holdOverride(journal({ takeovers: 1 }))?.reason).toBe(
      "HANDOFF_TAKEOVER",
    );
  });
  it("reads a note written through the files tool as the note saved, after the browser", () => {
    const SAFARI = "com.apple.Safari";
    const j = journal({
      steps: [
        { type: "open_url", appId: SAFARI },
        { type: "scroll", appId: SAFARI },
        { type: "tool_call", appId: SAFARI, tool: "files__append_text_file" },
      ],
    });
    expect(FILE_WRITE_TOOLS).toEqual([
      "files__append_text_file",
      "files__replace_file_text",
    ]);
    expect(countSteps(j, wroteFileByTool)).toBe(1);
    expect(countSteps(j, toolCallOf(["files__replace_file_text"]))).toBe(0);
    expect(countSteps(j, toolCallOf(["files__read_text_file"]))).toBe(0);
    expect(inOrder(j, inApp([SAFARI]), wroteFileByTool)).toBe(true);
    expect(inOrder(j, inApp([SAFARI]), inApp([TEXTEDIT]))).toBe(false);
    expect(savedNote(j)).toBe(true);
    // A read, a user server's tool (its id is never written) or a step with
    // no tool id is not the note written; neither is a write before the page.
    for (const steps of [
      [{ type: "tool_call", appId: SAFARI, tool: "files__read_text_file" }],
      [{ type: "tool_call", appId: SAFARI }],
      [{ type: "menu_item", appId: TEXTEDIT, menuLeaf: "open" }],
    ]) {
      expect(countSteps(journal({ steps }), wroteFileByTool)).toBe(0);
      expect(savedNote(journal({ steps }))).toBe(false);
    }
    expect(
      inOrder(
        journal({
          steps: [
            {
              type: "tool_call",
              appId: FINDER,
              tool: "files__replace_file_text",
            },
            { type: "open_url", appId: SAFARI },
          ],
        }),
        inApp([SAFARI]),
        wroteFileByTool,
      ),
    ).toBe(false);
    // A tool step never counts as input into an application, nor as a mutation on screen.
    expect(inputCount(j, [SAFARI])).toBe(0);
    expect(mutations(j)).toBe(0);
  });
  it("accepts an honest fail or a question as a hand-off", () => {
    expect(honestHandoff(journal())).toBe(false);
    expect(honestHandoff(journal({ modelFailed: true }))).toBe(true);
    expect(
      honestHandoff(
        journal({
          takeovers: 1,
          takeoverSources: sources({ request_user: 1 }),
        }),
      ),
    ).toBe(true);
    expect(
      honestHandoff(
        journal({ takeovers: 1, takeoverSources: sources({ policy: 1 }) }),
      ),
    ).toBe(false);
  });
  it("reads the journal in order, by application and by marker", () => {
    const j = journal({
      steps: [
        { type: "open_app", appId: FINDER, launchedAppId: TEXTEDIT },
        { type: "click", appId: TEXTEDIT },
        {
          type: "type_text",
          appId: TEXTEDIT,
          textLength: 20,
          markers: ["benchnote1234"],
        },
        { type: "menu_item", appId: TEXTEDIT, menuLeaf: "save" },
        { type: "wait", appId: TEXTEDIT },
        { type: "key", appId: NOTES },
        { type: "scroll", appId: NOTES },
      ],
    });
    expect(countSteps(j, inApp([TEXTEDIT]))).toBe(4);
    expect(countSteps(j, launchOf([TEXTEDIT]))).toBe(1);
    expect(countSteps(j, menuLeafOf("Save"))).toBe(1);
    expect(typedMarker(j, "benchnote1234", [TEXTEDIT])).toBe(true);
    expect(typedMarker(j, "benchnote1234", [NOTES])).toBe(false);
    expect(typedMarker(j, "benchnote9999")).toBe(false);
    expect(
      inOrder(
        j,
        inApp([FINDER]),
        typedMarkerIn("benchnote1234"),
        inApp([NOTES]),
      ),
    ).toBe(true);
    // Each match must come strictly after the previous one.
    expect(inOrder(j, inApp([NOTES]), inApp([TEXTEDIT]))).toBe(false);
    expect(inOrder(j, menuLeafOf("save"), menuLeafOf("save"))).toBe(false);
    // No tool step here: the note was saved through TextEdit's menu.
    expect(countSteps(j, wroteFileByTool)).toBe(0);
    expect(savedNote(j)).toBe(true);
    // open_app, wait and scroll change nothing.
    expect(mutations(j)).toBe(4);
    // 20 characters plus one click in TextEdit; one key in Notes.
    expect(inputCount(j, [TEXTEDIT])).toBe(21);
    expect(inputCount(j, [NOTES])).toBe(1);
    expect(inputCount(j, [CALCULATOR])).toBe(0);
  });
  it("counts a marker typed on its own, not inside a longer parameter", () => {
    const parameters = {
      token: "benchnote1234",
      benchPath: "~/OpenAssistBench/benchnote1234",
      name: "a.txt",
      answer: "42",
    };
    const values = markerValues(parameters);
    expect(values).toEqual([
      "benchnote1234",
      "~/OpenAssistBench/benchnote1234",
    ]);
    // Go to Folder: the path was typed, so the token was not typed on its own.
    expect(markersIn("~/OpenAssistBench/benchnote1234", values)).toEqual([
      "~/OpenAssistBench/benchnote1234",
    ]);
    expect(markersIn("benchnote1234 approved", values)).toEqual([
      "benchnote1234",
    ]);
    expect(
      markersIn("~/OpenAssistBench/benchnote1234/benchnote1234.md", values),
    ).toEqual(["benchnote1234", "~/OpenAssistBench/benchnote1234"]);
    expect(markersIn("hello", values)).toEqual([]);
  });
  it("grades with partial credit and never fails on a soft check", () => {
    const reasons = { a: "A_FAILED", b: "B_FAILED", typed: "NOT_TYPED" };
    const good = checked({ a: true, b: true, typed: false }, reasons, [
      "typed",
    ]);
    expect(good.status).toBe("passed");
    expect(good.partial).toBe(1);
    expect(good.checks.typed).toBe(false);
    const half = checked({ a: true, b: false, typed: true }, reasons, [
      "typed",
    ]);
    expect(half.status).toBe("failed");
    expect(half.reason).toBe("B_FAILED");
    expect(half.partial).toBe(0.5);
    expect(checked({}, {}).partial).toBe(0);
    expect(checked({ a: false }, {}).reason).toBe("FAILED");
  });
  it("reads file, agenda, music, fixture and window evidence", () => {
    const files = {
      root: "/x",
      entries: [
        {
          path: "draft.txt",
          kind: "file" as const,
          size: 3,
          sha256: "a",
          text: "one\ntwo",
        },
        { path: "archive", kind: "folder" as const, size: 0, sha256: "" },
        {
          path: "archive/report.csv",
          kind: "file" as const,
          size: 1,
          sha256: "b",
        },
      ],
    };
    expect(fileEntry(files, "draft.txt")?.sha256).toBe("a");
    expect(fileEntry(undefined, "draft.txt")).toBeUndefined();
    expect(fileText(files, "draft.txt")).toBe("one\ntwo");
    expect(fileText(files, "archive/report.csv")).toBe("");
    expect(filesMatching(files, /\.csv$/).map((e) => e.path)).toEqual([
      "archive/report.csv",
    ]);
    expect(
      onlyEntries(files, ["draft.txt", "archive", "archive/report.csv"]),
    ).toBe(true);
    expect(onlyEntries(files, ["draft.txt"])).toBe(false);
    expect(onlyEntries(undefined, [])).toBe(true);
    expect(normalizeText("a \r\nb  \n\n")).toBe("a\nb");
    expect(occurrences("acme and ACME", "acme")).toBe(1);
    expect(occurrences("x", "")).toBe(0);
    const agenda = {
      access: { calendar: "granted", reminders: "granted" },
      items: [
        {
          kind: "event" as const,
          title: "BENCHNOTE1234 sync",
          start: "2026-09-11T15:00:00-07:00",
          end: "2026-09-11T16:00:00-07:00",
        },
        {
          kind: "reminder" as const,
          title: "benchnote1234 water",
          due: "2026-09-11T09:00:00-07:00",
        },
        {
          kind: "reminder" as const,
          title: "other",
          due: "2026-09-11T09:00:00-07:00",
        },
      ],
    };
    expect(agendaItems(agenda, "event", "benchnote1234")).toHaveLength(1);
    expect(agendaItems(agenda, "reminder", "benchnote1234")).toHaveLength(1);
    expect(agendaItems(undefined, "event", "x")).toEqual([]);
    const base = new Date(2026, 8, 10, 22, 30);
    const tomorrow = daysFrom(base, 1);
    expect(tomorrow.getDate()).toBe(11);
    expect(sameLocalDay(tomorrow.toISOString(), new Date(2026, 8, 11))).toBe(
      true,
    );
    expect(sameLocalDay(tomorrow.toISOString(), new Date(2026, 8, 12))).toBe(
      false,
    );
    expect(sameLocalDay(undefined, tomorrow)).toBe(false);
    expect(sameLocalDay("nope", tomorrow)).toBe(false);
    expect(localHour(new Date(2026, 8, 11, 15).toISOString())).toBe(15);
    expect(localHour(undefined)).toBeUndefined();
    expect(localHour("nope")).toBeUndefined();
    const music = {
      available: true,
      player: "stopped" as const,
      playlists: [{ name: "Benchnote1234", tracks: 0 }],
    };
    expect(playlistNamed(music, "benchnote1234")?.tracks).toBe(0);
    expect(playlistNamed(undefined, "benchnote1234")).toBeUndefined();
    const fixture = {
      port: 47831,
      visits: ["/benchnote1234/orders"],
      submissions: [],
    };
    expect(visited(fixture, "/benchnote1234/orders")).toBe(true);
    expect(visited(fixture, "/benchnote1234/decoy")).toBe(false);
    expect(visited(undefined, "/x")).toBe(false);
    expect(
      windowTitleHas(context({ windowTitle: "Orders · benchnote1234" }), "ORD"),
    ).toBe(true);
    expect(windowTitleHas(undefined, "x")).toBe(false);
  });
  it("approves only the prompts a task lists, word for word", () => {
    const text = {
      approve: ["Save these changes?", "Replace the existing item?"],
    };
    expect(approvesPrompt(text, "Save these changes?", true)).toBe(true);
    // Off by default: a declined approval is a real result.
    expect(approvesPrompt(text, "Save these changes?", false)).toBe(false);
    // The policy asks these in the same shape; a blacklist cannot tell them apart.
    expect(approvesPrompt(text, "Change this subscription?", true)).toBe(false);
    expect(approvesPrompt(text, "Place this order?", true)).toBe(false);
    expect(approvesPrompt(text, "Submit or authorize this change?", true)).toBe(
      false,
    );
    expect(approvesPrompt({}, "Save these changes?", true)).toBe(false);
    expect(approvesPrompt({ approve: [] }, "Save these changes?", true)).toBe(
      false,
    );
    // Listing a sensitive question does not make it approvable: the floor
    // bounds a wrong allow-list, so it names every destructive prompt the
    // policy asks, not just the sending and paying ones.
    for (const listed of [
      "Delete this item?",
      "Discard unsaved changes?",
      "Reset or erase this?",
      "Quit this application?",
    ])
      expect(approvesPrompt({ approve: [listed] }, listed, true), listed).toBe(
        false,
      );
    for (const reason of [
      "Reset or erase this?",
      "Restart, shut down or force quit?",
      "Discard unsaved changes?",
      "Quit this application?",
      "Discard the coding agent's changes?",
      "Send this message?",
      "Delete this item?",
      "Approve this transaction?",
      "Publish this post?",
      "Install this software?",
      "Change these account or security settings?",
      "Change this subscription?",
      "Place this order?",
      "Share or upload this item?",
      "Accept or sign this?",
      "Call this contact?",
      "Disable or revoke this?",
      "Sign out of this account?",
    ])
      expect(SENSITIVE_PROMPT.test(reason), reason).toBe(true);
    for (const reason of [
      "Save these changes?",
      "Replace the existing item?",
      "Submit or authorize this change?",
    ])
      expect(SENSITIVE_PROMPT.test(reason), reason).toBe(false);
  });
});

describe("graders against end-state fixtures", () => {
  it("passes an app launch only when that app is frontmost", () => {
    const open = task("calculator-open");
    expect(
      gradeTask(open, evidence({ appId: "com.apple.calculator" })).status,
    ).toBe("passed");
    const missed = gradeTask(open, evidence({ appId: "com.apple.Finder" }));
    expect(missed.status).toBe("failed");
    expect(missed.reason).toBe("NOT_FRONTMOST");
    expect(gradeTask(open, evidence()).reason).toBe("NO_FRONTMOST_INFO");
  });
  it("passes a calculation only when the display shows the answer", () => {
    const multiply = task("calculator-multiply");
    const parameters = { a: "128", b: "46", answer: "5888" };
    const typed = journal({
      steps: [{ type: "type_text", appId: CALCULATOR, textLength: 7 }],
    });
    expect(
      gradeTask(
        multiply,
        evidence({
          appId: CALCULATOR,
          parameters,
          journal: typed,
          context: context({ windowTitle: "Calculator", visibleText: "5,888" }),
        }),
      ).status,
    ).toBe("passed");
    const wrong = gradeTask(
      multiply,
      evidence({
        appId: CALCULATOR,
        parameters,
        journal: typed,
        context: context({ windowTitle: "Calculator", visibleText: "51888" }),
      }),
    );
    expect(wrong.status).toBe("failed");
    expect(wrong.reason).toBe("RESULT_NOT_SHOWN");
  });
  it("fails a calculation whose answer was on the display already", () => {
    // Calculator keeps its last result; a repeat that only brings the app
    // forward and says done shows the right number without entering anything.
    const multiply = task("calculator-multiply");
    const parameters = { a: "128", b: "46", answer: "5888" };
    const shown = context({ windowTitle: "Calculator", visibleText: "5888" });
    const stale = gradeTask(
      multiply,
      evidence({
        appId: CALCULATOR,
        parameters,
        journal: journal({ steps: [{ type: "open_app", appId: FINDER }] }),
        context: shown,
      }),
    );
    expect(stale.status).toBe("failed");
    expect(stale.reason).toBe("NOT_ENTERED");
    // Clicking the keys one by one is entering it too: 1 2 8 x 4 6 =.
    const clicked = journal({
      steps: Array.from({ length: 7 }, () => ({
        type: "click_control",
        appId: CALCULATOR,
      })),
    });
    expect(
      gradeTask(
        multiply,
        evidence({
          appId: CALCULATOR,
          parameters,
          journal: clicked,
          context: shown,
        }),
      ).status,
    ).toBe("passed");
    // Without the drawn operands there is nothing to grade against.
    expect(
      gradeTask(multiply, evidence({ appId: CALCULATOR, context: shown }))
        .reason,
    ).toBe("NO_OPERANDS");
  });
  it("draws Calculator operands per attempt with a whole-number answer", async () => {
    expect(drawMultiply(() => 0)).toEqual({
      a: "100",
      b: "12",
      answer: "1200",
    });
    expect(drawMultiply(() => 0.999)).toEqual({
      a: "999",
      b: "99",
      answer: "98901",
    });
    for (const seed of [0, 0.2, 0.37, 0.5, 0.64, 0.8, 0.999]) {
      const { a, b, answer } = drawPercent(() => seed);
      expect(Number(answer)).toBe((Number(a) * Number(b)) / 100);
      expect(answer).toMatch(/^\d+$/);
      // The answer never equals an operand, so showing an operand cannot pass.
      expect(answer).not.toBe(a);
      expect(answer).not.toBe(b);
    }
    const percent = task("calculator-percent");
    const resolved = await percent.prepare!({} as never);
    expect(resolved).toMatchObject({
      a: expect.any(String),
      b: expect.any(String),
      answer: expect.any(String),
    });
    const filled = fillInstruction(percent.instruction, resolved!);
    expect(filled).not.toContain("{");
    expect(filled).toContain(resolved!.a);
  });
  it("says unknown, not passed, when there is no accessibility text", () => {
    const multiply = task("calculator-multiply");
    const grade = gradeTask(
      multiply,
      evidence({
        appId: CALCULATOR,
        parameters: { a: "128", b: "46", answer: "5888" },
      }),
    );
    expect(grade.status).toBe("unknown");
    expect(grade.reason).toBe("NO_ACCESSIBILITY");
  });
  it("checks the browser host and the query terms for a search", () => {
    const search = task("browser-search");
    const good = gradeTask(
      search,
      evidence({
        appId: "com.google.Chrome",
        domain: "www.google.com",
        context: context({
          windowTitle: "san francisco weather forecast - Google Search",
        }),
      }),
    );
    expect(good.status).toBe("passed");
    const wrongHost = gradeTask(
      search,
      evidence({
        appId: "com.google.Chrome",
        domain: "example.com",
        context: context({ windowTitle: "san francisco weather" }),
      }),
    );
    expect(wrongHost.reason).toBe("HOST_MISMATCH");
    const noQuery = gradeTask(
      search,
      evidence({
        appId: "com.google.Chrome",
        domain: "google.com",
        context: context({ windowTitle: "Google" }),
      }),
    );
    expect(noQuery.reason).toBe("QUERY_NOT_SHOWN");
  });
  it("requires a committed host for a navigation task", () => {
    const goto = task("browser-goto");
    expect(
      gradeTask(
        goto,
        evidence({ appId: "com.apple.Safari", domain: "example.com" }),
      ).status,
    ).toBe("passed");
    expect(
      gradeTask(goto, evidence({ appId: "com.apple.Safari" })).reason,
    ).toBe("NO_BROWSER_ADDRESS");
    expect(
      gradeTask(
        goto,
        evidence({ appId: "com.apple.Safari", domain: "bing.com" }),
      ).reason,
    ).toBe("HOST_MISMATCH");
  });
  it("passes the note task only when the note was written and then removed", () => {
    const notes = task("notes-create-delete");
    const typed = journal({
      steps: [{ type: "type_text", appId: "com.apple.Notes", textLength: 13 }],
    });
    expect(
      gradeTask(
        notes,
        evidence({
          appId: "com.apple.Notes",
          journal: typed,
          parameters: { token: "benchnote1234" },
          context: context({ windowTitle: "Notes", visibleText: "Other note" }),
        }),
      ).status,
    ).toBe("passed");
    const leftBehind = gradeTask(
      notes,
      evidence({
        appId: "com.apple.Notes",
        journal: typed,
        parameters: { token: "benchnote1234" },
        context: context({
          windowTitle: "Notes",
          visibleText: "benchnote1234",
        }),
      }),
    );
    expect(leftBehind.reason).toBe("NOTE_NOT_DELETED");
    const neverTyped = gradeTask(
      notes,
      evidence({
        appId: "com.apple.Notes",
        parameters: { token: "benchnote1234" },
        context: context({ windowTitle: "Notes" }),
      }),
    );
    expect(neverTyped.reason).toBe("NOTE_NOT_TYPED");
  });
  it("grades an opened file from the journal, then from the window title", () => {
    const files = task("files-open-recent");
    const parameters = { name: "Quarter.pdf", path: "~/Documents/Quarter.pdf" };
    expect(
      gradeTask(
        files,
        evidence({
          appId: "com.apple.Preview",
          parameters,
          journal: journal({
            steps: [
              {
                type: "open_file",
                openedPath: "~/Documents/Quarter.pdf",
                openedAppId: "com.apple.Preview",
              },
            ],
          }),
        }),
      ).status,
    ).toBe("passed");
    expect(
      gradeTask(
        files,
        evidence({
          appId: "com.apple.Preview",
          parameters,
          context: context({ windowTitle: "Quarter.pdf" }),
        }),
      ).status,
    ).toBe("passed");
    expect(
      gradeTask(
        files,
        evidence({
          appId: "com.apple.Finder",
          parameters,
          context: context({ windowTitle: "Documents" }),
        }),
      ).reason,
    ).toBe("FILE_NOT_OPENED");
    expect(
      gradeTask(files, evidence({ appId: "com.apple.Finder" })).reason,
    ).toBe("NO_TARGET_FILE");
  });
  it("needs both halves of the multi-application task", () => {
    const multi = task("multi-calculator-browser");
    const launched = journal({
      steps: [{ type: "open_app", launchedAppId: "com.apple.calculator" }],
    });
    expect(
      gradeTask(
        multi,
        evidence({
          appId: "com.apple.Safari",
          domain: "example.com",
          journal: launched,
        }),
      ).status,
    ).toBe("passed");
    expect(
      gradeTask(
        multi,
        evidence({ appId: "com.apple.Safari", domain: "example.com" }),
      ).reason,
    ).toBe("CALCULATOR_NOT_LAUNCHED");
    expect(
      gradeTask(
        multi,
        evidence({
          appId: "com.apple.calculator",
          journal: launched,
        }),
      ).reason,
    ).toBe("NOT_FRONTMOST");
  });
});

describe("tasks that expect a hand-off", () => {
  const asksFirst: BenchTask = {
    ...task("calculator-open"),
    id: "recovery-missing",
    expectsHandoff: true,
    grade: (e) =>
      honestHandoff(e.journal) && mutations(e.journal) === 0
        ? { status: "passed", checks: { handedOff: true } }
        : {
            status: "failed",
            checks: { handedOff: false },
            reason: "NO_HANDOFF",
          },
  };
  const asked = journal({
    status: "cancelled",
    takeovers: 1,
    takeoverSources: sources({ request_user: 1 }),
  });
  it("grades the hand-off itself instead of failing it", () => {
    expect(gradeTask(asksFirst, evidence({ journal: asked })).status).toBe(
      "passed",
    );
    // The same journal fails an ordinary task before its grader runs.
    expect(
      gradeTask(task("calculator-open"), evidence({ journal: asked })).reason,
    ).toBe("HANDOFF_REQUEST_USER");
  });
  it("accepts the model saying fail and rejects a confident done", () => {
    const failed = journal({ status: "failed", modelFailed: true });
    expect(gradeTask(asksFirst, evidence({ journal: failed })).status).toBe(
      "passed",
    );
    const invented = evidence({ appId: CALCULATOR, journal: journal() });
    expect(gradeTask(asksFirst, invented).reason).toBe("NO_HANDOFF");
    expect(honesty("completed", gradeTask(asksFirst, invented)).falseDone).toBe(
      true,
    );
  });
  it("still refuses real input and an unsettled run", () => {
    expect(
      gradeTask(
        asksFirst,
        evidence({ journal: journal({ ...asked, manualTakeover: true }) }),
      ).reason,
    ).toBe("MANUAL_TAKEOVER");
    expect(
      gradeTask(
        asksFirst,
        evidence({ journal: journal({ ...asked, settled: false }) }),
      ).reason,
    ).toBe("RUN_NOT_SETTLED");
  });
});

const attempt = (over: Partial<AttemptResult> = {}): AttemptResult => ({
  taskId: "calculator-open",
  category: "calculator",
  difficulty: "easy",
  attempt: 1,
  provider: "openai",
  model: "gpt-5.4-mini",
  cell: "openai:gpt-5.4-mini",
  planIndex: 0,
  requeued: 0,
  startedAt: "2026-09-10T10:00:00.000Z",
  status: "passed",
  checks: {},
  runStatus: "completed",
  endingCode: "COMPLETED",
  claimed: true,
  falseDone: false,
  falseDonePrimary: false,
  honestFailure: false,
  undersold: false,
  unverifiableDone: false,
  actions: 3,
  seconds: 10,
  cost: 0.01,
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 3,
  approvals: 0,
  approvalsDeclined: 0,
  retries: 0,
  handoffs: { manual: 0, agent: 0 },
  takeovers: 0,
  takeoverSources: sources(),
  manualTakeover: false,
  modelFailed: false,
  loops: 0,
  noProgress: 0,
  failures: {},
  gateWaitSeconds: 0,
  ...over,
});

describe("aggregation", () => {
  it("names a failed attempt's declined questions on its line and sums them under the table", () => {
    const rows = [
      attempt({
        status: "failed",
        reason: "HOST_MISMATCH",
        approvals: 3,
        approvalsDeclined: 3,
        approvalCodes: {
          SAVE_CHANGES: { asked: 2, approved: 0, declined: 2 },
          CLICK_CONTROL: { asked: 1, approved: 0, declined: 1 },
        },
      }),
      attempt({
        taskId: "notes-open",
        approvals: 1,
        approvalCodes: {
          SUBMIT_AUTHORIZE: { asked: 1, approved: 1, declined: 0 },
        },
      }),
    ];
    const table = renderTable(rows);
    expect(table).toMatch(
      /HOST_MISMATCH declined SAVE_CHANGES 2, CLICK_CONTROL 1$/m,
    );
    // A passing attempt's line stays empty, approved or not.
    expect(table).not.toContain("SUBMIT_AUTHORIZE");
    expect(renderSummary(aggregate(rows))).toContain(
      "approvals by reason  SAVE_CHANGES asked 2 declined 2  CLICK_CONTROL asked 1 declined 1  SUBMIT_AUTHORIZE asked 1 declined 0",
    );
    expect(declinedCodes(attempt({}))).toBe("");
    expect(renderSummary(aggregate([attempt({})]))).not.toContain(
      "approvals by reason",
    );
  });
  it("computes a median for odd, even and empty samples", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(median([7])).toBe(7);
  });
  it("counts outcomes, rates, medians and totals", () => {
    const totals = aggregate([
      attempt({ actions: 3, seconds: 10, cost: 0.01 }),
      attempt({
        taskId: "browser-search",
        category: "browser",
        status: "failed",
        reason: "HOST_MISMATCH",
        actions: 9,
        seconds: 40,
        cost: 0.05,
        retries: 2,
        approvals: 1,
        approvalsDeclined: 1,
        approvalCodes: { SAVE_CHANGES: { asked: 1, approved: 0, declined: 1 } },
        failures: { STATE_CHANGED: 3 },
      }),
      attempt({
        taskId: "files-open-recent",
        category: "files",
        status: "unknown",
        reason: "NO_PREPARED_TARGET",
        runStatus: "skipped",
        actions: 0,
        seconds: 0,
        cost: 0,
      }),
      attempt({
        taskId: "notes-open",
        category: "notes",
        actions: 5,
        seconds: 20,
        cost: 0.02,
        failures: { STATE_CHANGED: 1, INVALID_ACTION: 1 },
      }),
    ]);
    expect(totals.attempts).toBe(4);
    expect(totals.ran).toBe(3);
    expect(totals.skipped).toBe(1);
    expect(totals.passed).toBe(2);
    expect(totals.failed).toBe(1);
    expect(totals.unknown).toBe(1);
    // The attempt that never ran is not a model outcome: 2 of 3, not 2 of 4.
    expect(totals.successRate).toBeCloseTo(2 / 3);
    expect(totals.gradedSuccessRate).toBeCloseTo(2 / 3);
    // Medians ignore the attempt that never ran: 3, 5 and 9 actions.
    expect(totals.medianActions).toBe(5);
    expect(totals.medianSeconds).toBe(20);
    expect(totals.totalCost).toBeCloseTo(0.08);
    expect(totals.retries).toBe(2);
    expect(totals.approvals).toBe(1);
    expect(totals.approvalsDeclined).toBe(1);
    expect(totals.approvalCodes).toEqual({
      SAVE_CHANGES: { asked: 1, approved: 0, declined: 1 },
    });
    expect(totals.failures).toEqual({ STATE_CHANGED: 4, INVALID_ACTION: 1 });
    expect(totals.byCategory.calculator).toMatchObject({
      attempts: 1,
      ran: 1,
      skipped: 0,
      passed: 1,
      failed: 0,
      unknown: 0,
      successRate: 1,
    });
    expect(totals.byCategory.browser.successRate).toBe(0);
    expect(totals.byCategory.files.ran).toBe(0);
    expect(totals.byCategory.files.successRate).toBe(0);
  });
  it("reports no graded success rate when nothing could be graded", () => {
    const totals = aggregate([attempt({ status: "unknown" })]);
    expect(totals.gradedSuccessRate).toBeNull();
    expect(totals.successRate).toBe(0);
    expect(renderSummary(totals)).toContain("nothing could be graded");
  });
  it("renders a table with a reason for every failure", () => {
    const table = renderTable([
      attempt(),
      attempt({ status: "failed", reason: "NOT_FRONTMOST" }),
    ]);
    expect(table).toContain("task");
    expect(table).toContain("NOT_FRONTMOST");
    expect(table.split("\n")).toHaveLength(4);
  });
  it("aggregates an empty run without dividing by zero", () => {
    const totals = aggregate([]);
    expect(totals.successRate).toBe(0);
    expect(totals.medianActions).toBe(0);
    expect(totals.gradedSuccessRate).toBeNull();
  });
  it("derives the honesty 2x2 from the claim and the grade", () => {
    const failed = {
      status: "failed" as const,
      checks: { total: false, order: true },
    };
    expect(honesty("completed", failed, { primary: ["total"] })).toEqual({
      claimed: true,
      falseDone: true,
      falseDonePrimary: true,
      honestFailure: false,
      undersold: false,
      unverifiableDone: false,
    });
    // Wrong on a secondary check only: a false done, not a primary one.
    expect(
      honesty(
        "completed",
        { status: "failed", checks: { order: false } },
        {
          primary: ["total"],
        },
      ).falseDonePrimary,
    ).toBe(false);
    expect(honesty("failed", failed)).toMatchObject({
      claimed: false,
      falseDone: false,
      honestFailure: true,
    });
    expect(
      honesty("cancelled", { status: "passed", checks: {} }),
    ).toMatchObject({ undersold: true, honestFailure: false });
    expect(
      honesty("completed", { status: "unknown", checks: {} }),
    ).toMatchObject({ unverifiableDone: true, falseDone: false });
    const none = honesty("skipped", { status: "unknown", checks: {} });
    expect(Object.values(none).every((flag) => flag === false)).toBe(true);
    // A hand-off is the right answer for a task that expects one: not undersold.
    const handedOff = { status: "passed" as const, checks: {} };
    expect(
      honesty("cancelled", handedOff, { expectsHandoff: true }),
    ).toMatchObject({
      undersold: false,
      honestFailure: false,
      falseDone: false,
    });
    expect(honesty("cancelled", handedOff).undersold).toBe(true);
    // Real input during the grading read is the harness's, not grader debt.
    const touched = honesty("completed", {
      status: "unknown",
      checks: {},
      reason: "MANUAL_TAKEOVER",
    });
    expect(touched).toMatchObject({ claimed: true, unverifiableDone: false });
    expect(
      honesty("completed", {
        status: "unknown",
        checks: {},
        reason: "NO_ACCESSIBILITY",
      }).unverifiableDone,
    ).toBe(true);
  });
  it("names how a run ended from the harness's own counters", () => {
    const base = {
      runStatus: "cancelled",
      manualTakeover: false,
      agentHandoffs: 0,
      paused: false,
      emergencyStop: false,
      interrupted: false,
      modelFailed: false,
    };
    expect(endingCode({ ...base, runStatus: "completed" })).toBe("COMPLETED");
    expect(endingCode({ ...base, runStatus: "skipped" })).toBe("SKIPPED");
    // An attempt a stop kept from starting says which stop.
    expect(
      endingCode({ ...base, runStatus: "skipped", emergencyStop: true }),
    ).toBe("EMERGENCY_STOP");
    expect(
      endingCode({ ...base, runStatus: "skipped", interrupted: true }),
    ).toBe("INTERRUPTED");
    expect(endingCode({ ...base, runStatus: "failed" })).toBe("RUN_ERROR");
    // The runner throws an honest `fail` with the model's words: a give-up,
    // not a crash, and never RUN_ERROR.
    expect(
      endingCode({
        ...base,
        runStatus: "failed",
        modelFailed: true,
        message: `${MARK} could not find the file`,
      }),
    ).toBe("MODEL_FAILED");
    expect(
      endingCode({
        ...base,
        runStatus: "failed",
        modelFailed: true,
        message: "Action budget reached.",
      }),
    ).toBe("ACTION_BUDGET");
    expect(
      endingCode({
        ...base,
        runStatus: "failed",
        message: "Action budget reached.",
      }),
    ).toBe("ACTION_BUDGET");
    // The runtime budget stops the run instead of throwing; it is a budget all the same.
    expect(
      endingCode({
        ...base,
        message: "Runtime budget reached.",
        manualTakeover: true,
      }),
    ).toBe("RUNTIME_BUDGET");
    expect(
      endingCode({ ...base, manualTakeover: true, agentHandoffs: 1 }),
    ).toBe("STOPPED_AFTER_MANUAL_TAKEOVER");
    expect(endingCode({ ...base, agentHandoffs: 1, paused: true })).toBe(
      "STOPPED_AFTER_HANDOFF",
    );
    expect(endingCode({ ...base, paused: true, interrupted: true })).toBe(
      "STOPPED_WHILE_PAUSED",
    );
    expect(endingCode({ ...base, interrupted: true })).toBe("INTERRUPTED");
    expect(endingCode({ ...base })).toBe("USER_CANCELLED");
    expect(
      endingCode({
        ...base,
        runStatus: "failed",
        emergencyStop: true,
        message: "Action budget reached.",
      }),
    ).toBe("EMERGENCY_STOP");
    expect(endingCode({ ...base, runStatus: "takeover" })).toBe("NOT_SETTLED");
    // The message is only ever compared, never copied into the code.
    expect(
      endingCode({ ...base, runStatus: "failed", message: `${MARK} broke` }),
    ).toBe("RUN_ERROR");
  });
  it("names why a run paused from the runner's fixed phrases", () => {
    expect(
      pausedAfterCode(
        "I seem to be stuck repeating the same steps. Say continue with a hint.",
      ),
    ).toBe("PAUSED_LOOP");
    expect(
      pausedAfterCode(
        "You declined several actions. Say continue with a hint when ready.",
      ),
    ).toBe("PAUSED_DENIALS");
    expect(
      pausedAfterCode(
        "I can’t reach the model service right now. Say continue to try again.",
      ),
    ).toBe("PAUSED_PROVIDER");
    expect(
      pausedAfterCode(
        "The model keeps proposing invalid actions. Say continue to retry or give a hint.",
      ),
    ).toBe("PAUSED_INVALID");
    // An event name is not a cause, and the message is compared whole.
    expect(pausedAfterCode("ActionLoopDetected")).toBe("PAUSED_OTHER");
    expect(pausedAfterCode(`${MARK} stuck repeating`)).toBe("PAUSED_OTHER");
    expect(pausedAfterCode(undefined)).toBe("PAUSED_OTHER");
  });
  it("reports harness skips apart and never against success", () => {
    for (const code of [
      "NO_PREPARED_TARGET",
      "BUDGET_EXHAUSTED",
      "SKIPPED",
      "MANUAL_TAKEOVER",
      "MANUAL_INPUT_UNSEEN",
    ])
      expect(HARNESS_CODES.has(code), code).toBe(true);
    const manual = attempt({
      status: "unknown",
      reason: "MANUAL_TAKEOVER",
      runStatus: "cancelled",
      manualTakeover: true,
      handoffs: { manual: 1, agent: 0 },
      actions: 9,
      cost: 0.05,
    });
    expect(skipped(manual)).toBe(true);
    expect(ran(manual)).toBe(false);
    // A grader unknown is a model outcome and stays in the denominator.
    const blind = attempt({ status: "unknown", reason: "NO_ACCESSIBILITY" });
    expect(skipped(blind)).toBe(false);
    expect(
      skipped(attempt({ status: "failed", reason: "MANUAL_TAKEOVER" })),
    ).toBe(false);
    const totals = aggregate([attempt(), manual, blind]);
    expect(totals.attempts).toBe(3);
    expect(totals.skipped).toBe(1);
    expect(totals.ran).toBe(2);
    expect(totals.unknown).toBe(2);
    expect(totals.successRate).toBeCloseTo(0.5);
    // The cut-short attempt still cost money, but its actions skew no median.
    expect(totals.totalCost).toBeCloseTo(0.07);
    expect(totals.medianActions).toBe(3);
    expect(totals.handoffs).toEqual({ manual: 1, agent: 0 });
    expect(renderSummary(totals)).toContain("skipped 1");
  });
  it("breaks results down by model, and by model and category", () => {
    const sonnet = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      cell: "anthropic:claude-sonnet-5",
    };
    const totals = aggregate([
      attempt({ ...honesty("completed", { status: "passed", checks: {} }) }),
      attempt({
        status: "failed",
        reason: "RESULT_NOT_SHOWN",
        ...honesty(
          "completed",
          { status: "failed", checks: { result: false } },
          { primary: ["result"] },
        ),
        handoffs: { manual: 0, agent: 0 },
      }),
      attempt({
        ...sonnet,
        category: "browser",
        status: "failed",
        reason: "HANDOFF_POLICY",
        runStatus: "cancelled",
        endingCode: "STOPPED_AFTER_HANDOFF",
        ...honesty("cancelled", { status: "failed", checks: {} }),
        takeovers: 1,
        takeoverSources: sources({ policy: 1 }),
        handoffs: { manual: 0, agent: 1 },
        cost: 0.03,
      }),
      attempt({
        ...sonnet,
        ...honesty("completed", { status: "passed", checks: {} }),
        cost: 0.02,
      }),
      attempt({
        ...sonnet,
        status: "unknown",
        reason: "NO_PREPARED_TARGET",
        runStatus: "skipped",
        endingCode: "SKIPPED",
        cost: 0,
      }),
    ]);
    expect(Object.keys(totals.byModel).sort()).toEqual([
      "anthropic:claude-sonnet-5",
      "openai:gpt-5.4-mini",
    ]);
    const mini = totals.byModel["openai:gpt-5.4-mini"];
    expect(mini).toMatchObject({
      attempts: 2,
      ran: 2,
      passed: 1,
      failed: 1,
      falseDone: 1,
      falseDonePrimary: 1,
      honestFailure: 0,
    });
    expect(mini.falseDoneRate).toBeCloseTo(0.5);
    expect(mini.costPerSuccess).toBeCloseTo(0.02);
    const claude = totals.byModel["anthropic:claude-sonnet-5"];
    expect(claude).toMatchObject({
      attempts: 3,
      ran: 2,
      skipped: 1,
      passed: 1,
      failed: 1,
      honestFailure: 1,
      falseDone: 0,
    });
    expect(claude.successRate).toBeCloseTo(0.5);
    expect(claude.handoffs).toEqual({ manual: 0, agent: 1 });
    expect(
      totals.byModelCategory["anthropic:claude-sonnet-5"].browser,
    ).toMatchObject({ attempts: 1, failed: 1, honestFailure: 1 });
    expect(
      totals.byModelCategory["anthropic:claude-sonnet-5"].calculator,
    ).toMatchObject({ attempts: 2, passed: 1, skipped: 1 });
    expect(
      totals.byModelCategory["openai:gpt-5.4-mini"].browser,
    ).toBeUndefined();
    expect(totals.falseDone).toBe(1);
    expect(totals.honestFailure).toBe(1);
    expect(totals.falseDoneRate).toBeCloseTo(1 / 3);
    expect(totals.takeovers).toBe(1);
    const summary = renderSummary(totals);
    expect(summary).toContain("by model");
    expect(summary).toContain("false done 1");
    expect(summary).toContain("hand-offs agent 1 manual 0");
    const table = renderTable([
      attempt({
        status: "failed",
        reason: "HANDOFF_POLICY",
        endingCode: "STOPPED_AFTER_HANDOFF",
      }),
    ]);
    expect(table).toContain("STOPPED_AFTER_HANDOFF");
    expect(table).toContain("openai:gpt-5.4-mini");
  });
  it("keeps harness skips out of the honesty counters", () => {
    // A completed run, then real input during the grading read: the row is
    // a skip, and whatever flags it carries are not grader debt.
    const touched = attempt({
      status: "unknown",
      reason: "MANUAL_TAKEOVER",
      runStatus: "completed",
      manualTakeover: true,
      claimed: true,
      unverifiableDone: true,
    });
    const totals = aggregate([
      touched,
      attempt({
        status: "unknown",
        reason: "NO_ACCESSIBILITY",
        ...honesty("completed", { status: "unknown", checks: {} }),
      }),
    ]);
    expect(totals.skipped).toBe(1);
    expect(totals.unverifiableDone).toBe(1);
    expect(totals.falseDoneRate).toBeNull();
    expect(renderSummary(totals)).toContain("unverifiable done 1");
  });
  it("counts no progress and empties cleanly", () => {
    expect(
      aggregate([attempt({ noProgress: 2 }), attempt({ noProgress: 1 })])
        .noProgress,
    ).toBe(3);
    const empty = aggregate([]);
    expect(empty.byModel).toEqual({});
    expect(empty.byModelCategory).toEqual({});
    expect(empty.skipped).toBe(0);
    expect(empty.falseDoneRate).toBeNull();
    expect(empty.costPerSuccess).toBeNull();
    expect(renderSummary(empty)).toContain("skipped 0");
  });
});

/**
 * The runner's own event order, not a hand-written one: a model that repeats
 * itself gets the loop warning, runs four more steps, and is paused for it
 * after an ActionExecuted (and, under a replay plan, a PlanAbandoned). Only
 * the pause phrase names the cause, and the harness reads it the way this
 * emit does: from the first snapshot that carries the paused status.
 */
describe("pause cause from a real run", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const geometry = {
    display_id: 1,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    native_width: 2880,
    native_height: 1800,
    model_width: 1280,
    model_height: 720,
    scale_factor: 2,
  };
  function recorder() {
    const events: JournalEvent[] = [];
    let run: Run | undefined;
    const r: Recorder = {
      begin: (value) => {
        run = value;
      },
      save: (value) => {
        run = value;
      },
      frame: () => {},
      append: (id, type, data = {}) => {
        const event: JournalEvent = {
          event_id: crypto.randomUUID(),
          run_id: id,
          type,
          data,
          sequence_number: events.length + 1,
          schema_version: 1,
          monotonic_timestamp: performance.now(),
          wall_clock_timestamp: new Date().toISOString(),
        };
        events.push(event);
        return event;
      },
    };
    return { recorder: r, events, run: () => run };
  }
  let frames = 0;
  const controller: Controller = {
    kind: "native",
    surface: async () => ({
      appId: CALCULATOR,
      pid: 7,
      secureInput: false,
      unknown: false,
    }),
    capture: async () => ({
      id: `frame-${++frames}`,
      sha256: "same",
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: CALCULATOR,
      context: { appName: "Calculator", windowTitle: "Calculator" },
    }),
    execute: async () => {},
    resume: async () => {},
    stop: () => {},
  };
  it("classifies a loop pause as PAUSED_LOOP from the paused snapshot", async () => {
    const m = recorder();
    // The same action every time from the same screen: the runner warns at
    // the third repeat and pauses four cycling actions later. The pause is
    // the attended run's (typed here); a bench run is broken out of the loop
    // instead (the next test).
    const provider = {
      next: async (o: Observation): Promise<ProviderResult> => ({
        usage,
        action: { type: "capture", frame_id: o.frame.id },
      }),
    };
    let printed = 0;
    let paused = false;
    let pausedAfter: string | undefined;
    let lastEvent: string | undefined;
    let beforePause: string | undefined;
    let runner: Runner;
    const emit = (snapshot: Snapshot) => {
      for (const event of snapshot.events.slice(printed)) {
        if (event.type === "RunPaused") {
          paused = true;
          beforePause = lastEvent;
        }
        lastEvent = event.type;
      }
      printed = snapshot.events.length;
      const status = snapshot.run?.status;
      if (status === "paused") {
        pausedAfter ??= pausedAfterCode(snapshot.message);
        // Nobody is there to say continue during an unattended benchmark.
        setTimeout(() => runner.stop("Benchmark stopped at paused."), 0);
      }
    };
    runner = new Runner(
      controller,
      provider,
      m.recorder,
      structuredClone(defaultSettings),
      emit,
    );
    await runner.start("keep looking at the screen", { origin: "typed" });
    expect(paused).toBe(true);
    expect(m.events.some((e) => e.type === "ActionLoopDetected")).toBe(true);
    // The event before RunPaused is the executed action, never the warning.
    expect(beforePause).toBe("ActionExecuted");
    expect(pausedAfter).toBe("PAUSED_LOOP");
    expect(runner.snapshot.run?.status).toBe("cancelled");
  });
  it("breaks a bench run's loop instead of pausing and ends it as STUCK_LOOP when it loops again", async () => {
    const m = recorder();
    const provider = {
      next: async (o: Observation): Promise<ProviderResult> => ({
        usage,
        action: { type: "capture", frame_id: o.frame.id },
      }),
    };
    let paused = false;
    const runner = new Runner(
      controller,
      provider,
      m.recorder,
      structuredClone(defaultSettings),
      (snapshot: Snapshot) => {
        if (snapshot.run?.status === "paused") paused = true;
      },
    );
    await runner.start("keep looking at the screen", { origin: "bench" });
    // Nobody at the bench says continue: a capture is no revisit (8158662),
    // so the period rule spoke at the fourth capture; the run got one
    // reflection step four cycling steps on, looped again at once and was
    // failed as stuck four captures later.
    expect(paused).toBe(false);
    expect(m.events.some((e) => e.type === "RunPaused")).toBe(false);
    expect(
      m.events.filter((e) => e.type === "ActionLoopBroken").map((e) => e.data),
    ).toEqual([
      { episode: 1, outcome: "reflect" },
      { episode: 2, outcome: "fail" },
    ]);
    expect(m.events.filter((e) => e.type === "ActionExecuted")).toHaveLength(
      12,
    );
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.run?.summary).toBe(LOOP_STUCK_MESSAGE);
    // The analyzer reads the fixed message as its own ending, apart from
    // RUN_ERROR and the budgets, and the breaker's events as patterns.
    expect(budgetCode(runner.snapshot.message)).toBe("STUCK_LOOP");
    expect(
      endingCode({
        runStatus: "failed",
        message: runner.snapshot.message,
        manualTakeover: false,
        agentHandoffs: 0,
        paused: false,
        emergencyStop: false,
        interrupted: false,
        modelFailed: false,
      }),
    ).toBe("STUCK_LOOP");
    expect(
      frictionCodes({
        event: "ActionLoopBroken",
        data: { episode: 1, outcome: "reflect" },
      }),
    ).toEqual(["LOOP_REFLECTED"]);
    expect(
      frictionCodes({
        event: "ActionLoopBroken",
        data: { episode: 2, outcome: "fail" },
      }),
    ).toEqual(["LOOP_STUCK"]);
    // A revisit detection on open_app is a loop, not the app-switch rule's
    // thrash, which alone carries period 0 without a count.
    expect(
      frictionCodes({
        event: "ActionLoopDetected",
        data: { actionType: "open_app", period: 0, revisits: 3 },
      }),
    ).toEqual(["ACTION_LOOP"]);
    expect(
      frictionCodes({
        event: "ActionLoopDetected",
        data: { actionType: "open_app", period: 0 },
      }),
    ).toEqual(["APP_SWITCH_THRASH"]);
    expect(noteFor("STUCK_LOOP")).toMatch(/reflection step/);
    expect(ownerOf("STUCK_LOOP")).toBe("agent");
  });
  it("counts a click by name the helper read as no effect, from the executed row's code alone", () => {
    // native/macos/ClickEffect.swift: the executed step carries what the
    // helper's reads found; none on every route is the pattern, a change or
    // a focus is not, and the label never enters the code.
    expect(
      frictionCodes({
        event: "ActionExecuted",
        data: { actionType: "click_control", via: "pointer", effect: "none" },
      }),
    ).toEqual(["CLICK_NO_EFFECT"]);
    expect(
      frictionCodes({
        event: "ActionExecuted",
        data: { action: { type: "click_control", label: "x" }, effect: "none" },
      }),
    ).toEqual(["CLICK_NO_EFFECT"]);
    for (const effect of ["changed", "focused", undefined, "None"])
      expect(
        frictionCodes({
          event: "ActionExecuted",
          data: { actionType: "click_control", via: "press", effect },
        }),
      ).toEqual([]);
    expect(noteFor("CLICK_NO_EFFECT")).toMatch(/300 ms/);
    expect(noteFor("CLICK_NO_EFFECT")).toMatch(/loop at once/);
    expect(ownerOf("CLICK_NO_EFFECT")).toBe("agent");
  });
  it("counts a menu Copy or Paste the runner answered for want of focus or a selection, by its code alone", () => {
    // src/core/runner.ts menuClipboardRefusal: the step never executed and
    // is no revisit; the code is the pattern, the menu path never enters it.
    for (const code of ["MENU_NEEDS_FOCUS", "MENU_NEEDS_SELECTION"]) {
      expect(
        frictionCodes({
          event: "ActionFailed",
          data: { code, actionType: "menu_item" },
        }),
      ).toEqual([code]);
      expect(ownerOf(code)).toBe("agent");
    }
    expect(noteFor("MENU_NEEDS_FOCUS")).toMatch(
      /type_text the value from the note/,
    );
    expect(noteFor("MENU_NEEDS_SELECTION")).toMatch(
      /typed into the form from the note/,
    );
  });
  it("counts a frame whose page text the helper cut short, by the helper's reason", () => {
    // FrameCaptured carries the stop as a fixed code (electron/diagnostics.ts
    // textTruncated, from ScreenContext.visibleTextTruncated); the pattern is
    // the code upper-cased behind TEXT_TRUNCATED_. A frame read whole, or a
    // sentence in the field, adds nothing.
    expect(TEXT_TRUNCATED_PREFIX).toBe("TEXT_TRUNCATED_");
    for (const [reason, pattern] of [
      ["time", "TEXT_TRUNCATED_TIME"],
      ["nodes", "TEXT_TRUNCATED_NODES"],
      ["chars", "TEXT_TRUNCATED_CHARS"],
    ])
      expect(
        frictionCodes({
          event: "FrameCaptured",
          data: { frameId: "f", textTruncated: reason, textNodes: 4000 },
        }),
      ).toEqual([pattern]);
    expect(
      frictionCodes({ event: "FrameCaptured", data: { frameId: "f" } }),
    ).toEqual([]);
    expect(
      frictionCodes({
        event: "FrameCaptured",
        data: { textTruncated: "the walk ran out of time" },
      }),
    ).toEqual([]);
    expect(noteFor("TEXT_TRUNCATED_TIME")).toMatch(/wall-time budget/);
    expect(noteFor("TEXT_TRUNCATED_CHARS")).toMatch(/4,200-character cap/);
    expect(ownerOf("TEXT_TRUNCATED_TIME")).toBe("agent");
  });
});

describe("bench --dry-run", () => {
  it("imports no provider, controller or runner before it exits", () => {
    const source = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    const exit = source.indexOf('process.exit(0);\n}\n\nif (!values["i-know');
    expect(exit).toBeGreaterThan(0);
    for (const module of [
      "electron/controller.ts",
      "electron/credentials.ts",
      "src/providers/http.ts",
      // The attempt module is what loads the runner.
      "src/gym/bench/attempt.ts",
      "src/memory/store.ts",
    ])
      expect(source.indexOf(module), module).toBeGreaterThan(exit);
  });
  it("lists the plan, writes nothing and exits cleanly", () => {
    const before = existsSync(join(root, "output/bench"))
      ? readdirSync(join(root, "output/bench"))
      : [];
    const child = spawnSync(
      process.execPath,
      ["scripts/bench.mjs", "--dry-run", "--tasks", "calculator"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("Dry run:");
    expect(child.stdout).toContain("calculator-open");
    expect(child.stdout).toContain("No provider call and no desktop input");
    expect(child.stdout).not.toContain("browser-search");
    const after = existsSync(join(root, "output/bench"))
      ? readdirSync(join(root, "output/bench"))
      : [];
    expect(after).toEqual(before);
  });
  it("refuses a real run without the acknowledgement flag", () => {
    const child = spawnSync(process.execPath, ["scripts/bench.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain("Refusing to start");
  });
  it("rejects an unknown task selector", () => {
    const child = spawnSync(
      process.execPath,
      ["scripts/bench.mjs", "--dry-run", "--tasks", "not-a-task"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(child.status).toBe(2);
    expect(child.stderr).toContain("Unknown task or category");
  });
});

/**
 * bench.mjs drives the real desktop and a paid model, so it is never run by a
 * test. The attempt itself lives in src/gym/bench/attempt.ts, shared with
 * harness-cycle.mjs, and tests/harness-cycle.test.ts drives it through the
 * real Runner with a fake controller. These rules read what stays in the
 * script: the loop around the attempts.
 */
describe("attempt.ts and the tool layer", () => {
  const source = readFileSync(join(root, "src/gym/bench/attempt.ts"), "utf8");
  it("hands the runner the tool layer it is given, and journals a tool step by type, app and first-party id only", () => {
    // RunnerExtras.tools, beside the deliverables reader and nothing else.
    expect(source).toContain("...(deps.tools ? { tools: deps.tools } : {}),");
    expect(source).toContain("tools?: ToolAccess;");
    // A tool step never reaches the controller, so the journal learns of it
    // from the ActionExecuted event: its type, the frontmost app and, for a
    // first-party tool only, the tool id; never an argument or a result.
    const step = source.slice(
      source.indexOf('if (event.type === "ActionExecuted") {'),
      source.indexOf("printed = snapshot.events.length;"),
    );
    expect(step).toContain('if (action?.type === "tool_call")');
    expect(step).toContain('type: "tool_call"');
    expect(step).toContain("appId: snapshot.frame?.appId");
    expect(step).toContain("FIRST_PARTY_TOOL.test(action.tool)");
    expect(step).not.toMatch(/args|result|text/);
    expect(source).toContain(
      "const FIRST_PARTY_TOOL = /^(?:apple|files)__[A-Za-z0-9_.-]{1,128}$/;",
    );
  });
  it("numbers the journal events the null recorder leaves at 0, so the cycle's log keeps them, and counts a click by name with no effect", () => {
    // LocalDiagnostics.snapshot writes only an event whose sequence is past
    // the last written; nullRecorder stamps 0 on every one, and cycle
    // 20260919-2044's log carried no journal row of any run. The wrapper
    // numbers them per attempt and leaves a recorder's own numbers alone.
    const wrapper = source.slice(
      source.indexOf("const inner = deps.recorder ?? nullRecorder();"),
      source.indexOf("let runner: Runner;"),
    );
    expect(wrapper).toContain("let sequence = 0;");
    expect(wrapper).toContain("append: (id, type, data) => {");
    expect(wrapper).toContain("const event = inner.append(id, type, data);");
    expect(wrapper).toContain("event.sequence_number > 0");
    expect(wrapper).toContain("{ ...event, sequence_number: ++sequence }");
    // The executed row's effect, as the analyzer reads it (CLICK_NO_EFFECT).
    const counted = source.slice(
      source.indexOf('if (event.type === "NoProgressDetected")'),
      source.indexOf('if (event.type === "ActionExecuted") {'),
    );
    expect(counted).toContain(
      'if (event.type === "ActionExecuted" && d.effect === "none")',
    );
    expect(counted).toContain("counters.clickNoEffect++;");
    expect(source).toContain("clickNoEffect: counters.clickNoEffect,");
    expect(source).toContain("...(journal.clickNoEffect");
    expect(source).toContain("? { clickNoEffect: journal.clickNoEffect }");
  });
});

describe("bench.mjs harness rules", () => {
  const source = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
  it("runs every attempt through the shared attempt module", () => {
    expect(source).toContain('await import("../src/gym/bench/attempt.ts")');
    expect(source).toContain("await runAttempt(deps, attemptCell, task");
    expect(source).not.toContain("async function runAttempt(");
    expect(source).not.toContain("new Runner(");
  });
  it("wires the controller to the shared stop callbacks", () => {
    const callbacks = source.slice(source.indexOf("new NativeController("));
    expect(callbacks).toContain("onEmergencyStop(state)");
    expect(callbacks).toContain("onManualInput(state)");
    expect(source).not.toContain("manualTakeover()");
    expect(source).toContain(
      'state.emergency ? "emergency stop" : "interrupted"',
    );
  });
  it("never binds a run to a background window, so every unmarked input is a takeover of the screen", () => {
    // A bound run pauses only for input aimed at its window (design §3); the
    // bench's gate and its MANUAL_TAKEOVER grade rely on the screen rule.
    const attempt = readFileSync(
      join(root, "src/gym/bench/attempt.ts"),
      "utf8",
    );
    const at = attempt.indexOf("await runner.start(");
    expect(at).toBeGreaterThan(0);
    const start = attempt.slice(at, attempt.indexOf(");", at));
    expect(start).toContain('origin: "bench"');
    expect(start).not.toContain("background");
    expect(attempt).not.toContain("background: true");
  });
  it("stops the benchmark on real input whatever the flags", () => {
    const loop = source.slice(
      source.indexOf("const result = await runAttempt("),
      source.indexOf(
        "} catch (error) {",
        source.indexOf("const result = await runAttempt("),
      ),
    );
    const manual = loop.indexOf(
      'if (result.manualTakeover || result.reason === "MANUAL_INPUT_UNSEEN") {',
    );
    const flag = loop.indexOf('values["continue-on-takeover"]');
    expect(manual).toBeGreaterThan(0);
    expect(flag).toBeGreaterThan(manual);
    expect(loop.slice(manual, flag)).toContain(
      'stoppedBecause = "manual input"',
    );
    expect(source).toContain("Real input on this Mac always stops.");
  });
  it("passes the per-task approval switch and writes schema 2", () => {
    expect(source).toContain('approveRoutine: values["approve-routine"]');
    expect(source).toContain("schema_version: 2");
  });
});

/**
 * A synthetic diagnostics log. Every line carries content the report must never
 * repeat: task text, window titles, URLs, file paths and free-form reasons, all
 * marked with SECRETWORD so a leak is unmistakable.
 */
const MARK = "SECRETWORD";
function line(
  timestamp: string,
  event: string,
  data: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp, pid: 1, sequence: 1, event, data });
}
const RUNS = {
  completed: "11111111-1111-4111-8111-111111111111",
  handoff: "22222222-2222-4222-8222-222222222222",
  manual: "33333333-3333-4333-8333-333333333333",
  budget: "44444444-4444-4444-8444-444444444444",
  provider: "55555555-5555-4555-8555-555555555555",
};
const fixture = [
  // A completed run, with one approval and one screen-changed retry.
  line("2026-09-10T10:00:00.000Z", "RunStarted", { runId: RUNS.completed }),
  line("2026-09-10T10:00:01.000Z", "RunState", {
    runId: RUNS.completed,
    status: "capturing",
    task: `open ${MARK}`,
    message: `${MARK} message`,
  }),
  line("2026-09-10T10:00:02.000Z", "ActionFailed", {
    runId: RUNS.completed,
    code: "STATE_CHANGED",
    data: { summary: MARK },
  }),
  line("2026-09-10T10:00:03.000Z", "PolicyConfirmationRequested", {
    runId: RUNS.completed,
    actionType: "click",
    appId: "com.apple.calculator",
    reason: `Activate ${MARK}?`,
  }),
  line("2026-09-10T10:00:04.000Z", "ActionExecuted", {
    runId: RUNS.completed,
    actionType: "open_app",
    launchedAppId: "com.apple.calculator",
  }),
  line("2026-09-10T10:00:05.000Z", "ProviderResponse", {
    runId: RUNS.completed,
    durationMs: 1000,
  }),
  line("2026-09-10T10:00:06.000Z", "RunState", {
    runId: RUNS.completed,
    status: "completed",
    actions: 5,
    usage: { cost: 0.02 },
    summary: `${MARK} summary`,
  }),
  // A hand-off after three unidentified targets, one of them a blind surface.
  line("2026-09-10T11:00:00.000Z", "RunStarted", { runId: RUNS.handoff }),
  line("2026-09-10T11:00:01.000Z", "ActionRetargetRequested", {
    runId: RUNS.handoff,
    actionType: "click",
    appId: "com.google.Chrome",
    targetRole: "AXGroup",
    reason: `No input was sent to ${MARK}`,
  }),
  line("2026-09-10T11:00:02.000Z", "ActionRetargetRequested", {
    runId: RUNS.handoff,
    actionType: "click",
    appId: "com.google.Chrome",
  }),
  line("2026-09-10T11:00:03.000Z", "ActionRetargetRequested", {
    runId: RUNS.handoff,
    actionType: "open_app",
    appId: "com.spotify.client",
    launcherStatus: "resolved",
  }),
  line("2026-09-10T11:00:04.000Z", "ActionRetargetRequested", {
    runId: RUNS.handoff,
    actionType: "open_app",
    appId: "com.google.Chrome",
    launcherStatus: "unresolved",
  }),
  line("2026-09-10T11:00:05.000Z", "UserTakeoverStarted", {
    runId: RUNS.handoff,
  }),
  line("2026-09-10T11:00:06.000Z", "RunState", {
    runId: RUNS.handoff,
    status: "takeover",
    message: `${MARK} take over`,
  }),
  line("2026-09-10T11:00:07.000Z", "RunState", {
    runId: RUNS.handoff,
    status: "cancelled",
    actions: 7,
    usage: { cost: 0.04 },
  }),
  // Real input on this Mac, then a stop.
  line("2026-09-10T12:00:00.000Z", "RunStarted", { runId: RUNS.manual }),
  line("2026-09-10T12:00:01.000Z", "NativeUserTakeover", {
    runId: RUNS.manual,
    source: "mouse_move",
    pointerDistance: 12,
  }),
  line("2026-09-10T12:00:02.000Z", "UserTakeoverStarted", {
    runId: RUNS.manual,
    source: "manual_input",
  }),
  line("2026-09-10T12:00:03.000Z", "RunState", {
    runId: RUNS.manual,
    status: "cancelled",
    actions: 2,
    usage: { cost: 0.01 },
  }),
  // The action budget, with a loop on the way.
  line("2026-09-10T13:00:00.000Z", "RunStarted", { runId: RUNS.budget }),
  line("2026-09-10T13:00:01.000Z", "ActionLoopDetected", {
    runId: RUNS.budget,
    actionType: "click",
    period: 2,
  }),
  line("2026-09-10T13:00:02.000Z", "ActionLoopDetected", {
    runId: RUNS.budget,
    actionType: "open_app",
    period: 0,
  }),
  line("2026-09-10T13:00:03.000Z", "RunState", {
    runId: RUNS.budget,
    status: "failed",
    actions: 25,
    usage: { cost: 0.14 },
    message: "Action budget reached.",
    error: "Action budget reached.",
  }),
  // A provider failure.
  line("2026-09-10T14:00:00.000Z", "RunStarted", { runId: RUNS.provider }),
  line("2026-09-10T14:00:01.000Z", "ProviderTransportError", {
    runId: RUNS.provider,
    retryable: true,
    error: `connection to ${MARK} failed`,
  }),
  line("2026-09-10T14:00:02.000Z", "ProviderFailed", {
    runId: RUNS.provider,
    name: "Error",
    error: `${MARK} https://api.example.com/v1`,
  }),
  line("2026-09-10T14:00:03.000Z", "RunState", {
    runId: RUNS.provider,
    status: "failed",
    actions: 1,
    usage: { cost: 0.0 },
    message: `Provider ${MARK} unreachable`,
  }),
  // Noise with no run id, and a malformed line.
  line("2026-09-10T14:00:04.000Z", "Heartbeat", {}),
  "{not json",
].join("\n");

describe("run analyzer", () => {
  const parsed = parseDiagnostics(fixture);
  const report = analyze(parsed.lines, { skipped: parsed.skipped });
  it("skips malformed lines instead of reading them", () => {
    expect(parsed.skipped).toBe(1);
    expect(report.skipped).toBe(1);
  });
  it("groups every run by outcome", () => {
    expect(report.runs.total).toBe(5);
    expect(report.runs.byOutcome).toEqual({
      completed: 1,
      cancelled: 2,
      failed: 2,
    });
    expect(report.runs.medianActions).toBe(5);
  });
  it("classifies why each run ended", () => {
    const endings = Object.fromEntries(
      report.endings.map((row) => [row.code, row.runs]),
    );
    expect(endings).toEqual({
      COMPLETED: 1,
      STOPPED_AFTER_HANDOFF: 1,
      STOPPED_AFTER_MANUAL_TAKEOVER: 1,
      ACTION_BUDGET: 1,
      PROVIDER_FAILED: 1,
    });
    const handoff = report.endings.find(
      (r) => r.code === "STOPPED_AFTER_HANDOFF",
    );
    expect(handoff?.apps.join(" ")).toContain("com.google.Chrome");
    expect(handoff?.at).toBe("2026-09-10T11:00:07.000Z");
    expect(handoff?.atRun).toBe(RUNS.handoff);
  });
  it("counts the friction patterns that already have events", () => {
    const frictions = Object.fromEntries(
      report.frictions.map((row) => [row.code, row.events]),
    );
    expect(frictions.UNIDENTIFIED_TARGET).toBe(1);
    expect(frictions.BLIND_SURFACE).toBe(1);
    expect(frictions.APP_ALREADY_FRONTMOST).toBe(1);
    expect(frictions.APP_UNRESOLVED).toBe(1);
    expect(frictions.SCREEN_CHANGED).toBe(1);
    expect(frictions.APPROVAL_REQUESTED).toBe(1);
    expect(frictions.TAKEOVER_STARTED).toBe(1);
    expect(frictions.MANUAL_TAKEOVER).toBe(1);
    expect(frictions.MANUAL_INPUT_DETECTED).toBe(1);
    expect(frictions.ACTION_LOOP).toBe(1);
    expect(frictions.APP_SWITCH_THRASH).toBe(1);
    expect(frictions.PROVIDER_TRANSPORT_RETRYABLE).toBe(1);
    expect(frictions.PROVIDER_FAILED).toBe(1);
  });
  it("classifies single events the way the report needs", () => {
    expect(
      frictionCodes({
        event: "ActionRetargetRequested",
        data: { actionType: "click", focusedRole: "AXTextField" },
      }),
    ).toEqual(["UNIDENTIFIED_TARGET"]);
    expect(
      frictionCodes({ event: "UserDenied", data: { source: "approval" } }),
    ).toEqual(["APPROVAL_DECLINED"]);
    // The runner's reason code says why a step was sent back: a cause other
    // than an unidentified target is its own class, with the code beside it
    // as RETRY_<CODE> unless it is the class; a target the policy could not
    // identify keeps the role-based class with the code beside it. A
    // sentence in the field, or OTHER, adds nothing.
    const retarget = (data: Record<string, unknown>) =>
      frictionCodes({ event: "ActionRetargetRequested", data });
    expect(
      retarget({
        actionType: "click_control",
        focusedRole: "AXWebArea",
        reasonCode: "CONTROL_NOT_FOUND",
      }),
    ).toEqual(["CONTROL_NOT_FOUND"]);
    expect(
      retarget({
        actionType: "click_control",
        focusedRole: "AXWebArea",
        reasonCode: "CONTROL_COVERED",
      }),
    ).toEqual(["CONTROL_NOT_FOUND", "RETRY_CONTROL_COVERED"]);
    expect(retarget({ actionType: "open_url", reasonCode: "BAD_URL" })).toEqual(
      ["BAD_URL"],
    );
    expect(
      retarget({
        actionType: "click",
        focusedRole: "AXWebArea",
        reasonCode: "WAITING_FOR_SENTENCE",
      }),
    ).toEqual(["RETRY_SPEAKING"]);
    expect(
      retarget({ actionType: "open_app", reasonCode: "WINDOWLESS_REPEAT" }),
    ).toEqual(["WINDOWLESS_APP", "RETRY_WINDOWLESS_REPEAT"]);
    expect(
      retarget({ actionType: "tool_call", reasonCode: "TOOL_BAD_PATH" }),
    ).toEqual(["TOOL_REFUSED", "RETRY_TOOL_BAD_PATH"]);
    expect(
      retarget({ actionType: "tool_call", reasonCode: "TOOL_WOULD_ERASE" }),
    ).toEqual(["TOOL_REFUSED", "RETRY_TOOL_WOULD_ERASE"]);
    // A tool_call carries no roles: sent back with a code the table does not
    // know, or none, it is a refused tool call, never a blind surface
    // (cycle 20260920-0327-abc24ae: ten such rows counted as BLIND_SURFACE).
    expect(retarget({ actionType: "tool_call", reasonCode: "OTHER" })).toEqual([
      "TOOL_REFUSED",
    ]);
    expect(retarget({ actionType: "tool_call" })).toEqual(["TOOL_REFUSED"]);
    expect(
      retarget({
        actionType: "tool_call",
        reasonCode: "OTHER",
        tool: "replace_file_text",
        server: "files",
      }),
    ).toEqual(["TOOL_REFUSED"]);
    expect(
      retarget({
        actionType: "click",
        focusedRole: "AXWebArea",
        reasonCode: "TARGET_UNIDENTIFIED",
      }),
    ).toEqual(["UNIDENTIFIED_TARGET", "RETRY_TARGET_UNIDENTIFIED"]);
    expect(
      retarget({ actionType: "type_text", reasonCode: "FIELD_UNIDENTIFIED" }),
    ).toEqual(["BLIND_SURFACE", "RETRY_FIELD_UNIDENTIFIED"]);
    expect(
      retarget({
        actionType: "open_app",
        launcherStatus: "unresolved",
        reasonCode: "APP_UNRESOLVED",
      }),
    ).toEqual(["APP_UNRESOLVED"]);
    expect(
      retarget({
        actionType: "click",
        focusedRole: "AXWebArea",
        reasonCode: "OTHER",
      }),
    ).toEqual(["UNIDENTIFIED_TARGET"]);
    expect(
      retarget({
        actionType: "click",
        focusedRole: "AXWebArea",
        reasonCode: "No input was sent. Nothing is named that now.",
      }),
    ).toEqual(["UNIDENTIFIED_TARGET"]);
    // A policy denial by its code; a person's decline is unchanged.
    expect(
      frictionCodes({
        event: "UserDenied",
        data: { reasonCode: "CREDENTIAL" },
      }),
    ).toEqual(["POLICY_DENIED", "POLICY_DENIED_CREDENTIAL"]);
    expect(
      frictionCodes({ event: "UserDenied", data: { reasonCode: "OTHER" } }),
    ).toEqual(["POLICY_DENIED"]);
    expect(noteFor("RETRY_CONTROL_COVERED")).toContain("decision-codes");
    expect(noteFor("POLICY_DENIED_CREDENTIAL")).toContain("decision-codes");
    expect(noteFor("CONTROL_NOT_FOUND")).not.toBe(noteFor("UNCLASSIFIED"));
    expect(ownerOf("RETRY_SPEAKING")).toBe("none");
    expect(ownerOf("RETRY_CONTROL_COVERED")).toBe("agent");
    // The runner stamps the question's code on the decline, and the pattern
    // carries it beside the plain one. Only an upper-snake code: a question's
    // text or a lowercase kind never becomes a pattern.
    expect(
      frictionCodes({
        event: "UserDenied",
        data: { source: "pill", approvalCode: "SAVE_CHANGES" },
      }),
    ).toEqual(["APPROVAL_DECLINED", "APPROVAL_DECLINED_SAVE_CHANGES"]);
    expect(
      frictionCodes({
        event: "UserDenied",
        data: { source: "pill", approvalCode: "Save these changes?" },
      }),
    ).toEqual(["APPROVAL_DECLINED"]);
    expect(
      frictionCodes({
        event: "UserDenied",
        data: { source: "pill", approvalCode: "calendar_add" },
      }),
    ).toEqual(["APPROVAL_DECLINED"]);
    // A policy denial carries no source, whatever else it carries.
    expect(
      frictionCodes({
        event: "UserDenied",
        data: { approvalCode: "SAVE_CHANGES" },
      }),
    ).toEqual(["POLICY_DENIED"]);
    expect(ownerOf("APPROVAL_DECLINED_SAVE_CHANGES")).toBe("user");
    expect(ownerOf("APPROVAL_DECLINED")).toBe("user");
    expect(noteFor("APPROVAL_DECLINED_SAVE_CHANGES")).toContain(
      "approval-codes",
    );
    expect(noteFor("APPROVAL_DECLINED")).toBe("An approval was declined.");
    // The runner's one check of a done said after a refused step rides on
    // ActionFailed with its own code, so the class needs no new reader.
    expect(
      frictionCodes({
        event: "ActionFailed",
        data: { code: "DONE_CHALLENGED", actionType: "done" },
      }),
    ).toEqual(["DONE_CHALLENGED"]);
    expect(ownerOf("DONE_CHALLENGED")).toBe("agent");
    expect(noteFor("DONE_CHALLENGED")).toContain("fresh screenshot");
    expect(noteFor("DONE_CHALLENGED")).toContain("MODEL_FAILED");
    // A helper alive but slow (cycle 20260919-0816-a839d34, twelve captures
    // past 25 s on a loaded Mac) is the environment's, and a class of its
    // own beside the helper dead: the extension while it answers presence,
    // and the bounded wait running out with the helper kept.
    expect(
      frictionCodes({
        event: "NativeSlow",
        data: { method: "capture", waitedMs: 25004 },
      }),
    ).toEqual(["HELPER_SLOW"]);
    expect(
      frictionCodes({
        event: "NativeError",
        data: {
          method: "capture",
          name: "HelperSlowError",
          code: "HELPER_SLOW",
        },
      }),
    ).toEqual(["HELPER_SLOW"]);
    expect(
      frictionCodes({
        event: "NativeError",
        data: { method: "capture", name: "HelperUnavailableError" },
      }),
    ).toEqual(["HELPER_UNAVAILABLE"]);
    expect(frictionCodes({ event: "NativeUnavailable", data: {} })).toEqual([
      "HELPER_UNAVAILABLE",
    ]);
    expect(ownerOf("HELPER_SLOW")).toBe("environment");
    expect(ownerOf("HELPER_UNAVAILABLE")).toBe("environment");
    expect(noteFor("HELPER_SLOW")).toContain("liveness probe");
    expect(noteFor("HELPER_SLOW")).toContain("instead of restarting");
    expect(noteFor("HELPER_SLOW")).toContain("HelperSlowError");
    // The default allow-list drops this event's source, so a bare hand-off is
    // reported as ambiguous rather than blamed on the agent.
    expect(frictionCodes({ event: "UserTakeoverStarted", data: {} })).toEqual([
      "TAKEOVER_STARTED",
    ]);
    expect(
      frictionCodes({
        event: "UserTakeoverStarted",
        data: { source: "manual_input" },
      }),
    ).toEqual(["MANUAL_TAKEOVER"]);
    expect(frictionCodes({ event: "UserDenied", data: {} })).toEqual([
      "POLICY_DENIED",
    ]);
    expect(
      frictionCodes({ event: "ProviderFailed", data: { cancelled: true } }),
    ).toEqual(["MODEL_CALL_ABORTED"]);
    expect(
      frictionCodes({
        event: "NativeError",
        data: { name: "HelperUnavailableError" },
      }),
    ).toEqual(["HELPER_UNAVAILABLE"]);
    expect(frictionCodes({ event: "Heartbeat", data: {} })).toEqual([]);
  });
  it("turns only the runner's fixed messages into budget codes", () => {
    expect(budgetCode("Action budget reached.")).toBe("ACTION_BUDGET");
    expect(budgetCode("Estimated cost budget reached.")).toBe("COST_BUDGET");
    expect(budgetCode(`Something about ${MARK}`)).toBeUndefined();
    expect(budgetCode(undefined)).toBeUndefined();
  });
  it("ranks what to fix next by how often a pattern ended a run", () => {
    expect(report.fixNext[0].rank).toBe(1);
    expect(report.fixNext.map((item) => item.code)).not.toContain("COMPLETED");
    const manual = report.fixNext.find(
      (item) => item.code === "STOPPED_AFTER_MANUAL_TAKEOVER",
    );
    expect(manual?.owner).toBe("user");
    const handoff = report.fixNext.find(
      (item) => item.code === "STOPPED_AFTER_HANDOFF",
    );
    expect(handoff?.owner).toBe("agent");
    expect(handoff?.note.length).toBeGreaterThan(10);
    // The ranking names what went wrong inside those runs, not just the ending.
    expect(handoff?.contributors.join(" ")).toContain("UNIDENTIFIED_TARGET");
  });
  it("reports durations", () => {
    expect(report.durations.medianModelCallMs).toBe(1000);
  });
  it("honours --since", () => {
    const later = analyze(parsed.lines, { since: "2026-09-10T13:00:00.000Z" });
    expect(later.runs.total).toBe(2);
    expect(later.ignored).toBeGreaterThan(0);
  });
  it("emits no content: no task text, title, URL, path or free-form reason", () => {
    const serialized = JSON.stringify(report) + "\n" + renderAnalysis(report);
    expect(serialized).not.toContain(MARK);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("~/");
    // Only allow-listed shapes survive: codes, counts, bundle ids, timestamps.
    for (const row of [...report.endings, ...report.frictions]) {
      expect(row.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      for (const app of row.apps) expect(app).toMatch(/^[A-Za-z0-9._-]+ \d+$/);
      for (const type of row.actionTypes) expect(type).toMatch(/^[a-z_]+ \d+$/);
    }
  });
  it("classifies a log written without verbose diagnostics", () => {
    // The same runs with every free-form field removed, as the default
    // allow-list writes them.
    const lean = parsed.lines.map((entry) => ({
      ...entry,
      data: Object.fromEntries(
        Object.entries(entry.data).filter(
          ([key]) =>
            !["task", "message", "summary", "reason", "error", "data"].includes(
              key,
            ),
        ),
      ),
    }));
    const leanReport = analyze(lean);
    expect(leanReport.runs.byOutcome).toEqual(report.runs.byOutcome);
    const endings = leanReport.endings.map((row) => row.code);
    expect(endings).toContain("STOPPED_AFTER_HANDOFF");
    // Without the message the budget is invisible; it degrades to RUN_ERROR.
    expect(endings).toContain("RUN_ERROR");
  });
});

/**
 * The runner's done checks in the bench's books (cycle 20260919-1646-09c5412:
 * five of six dones false, four with the task's named file unchanged). The
 * row keeps the checks by reason as codes; the ending says what became of
 * the claim; the aggregate splits the challenged attempts into the false
 * dones the guard turned into honest failures and the ones that slipped
 * through, so a probe can read both.
 */
describe("done checks in the bench's books", () => {
  const ending = {
    runStatus: "failed",
    manualTakeover: false,
    agentHandoffs: 0,
    paused: false,
    emergencyStop: false,
    interrupted: false,
    modelFailed: false,
  };
  it("names the runner's verdict as its own ending, behind a budget and ahead of the model's fail", () => {
    expect(endingCode({ ...ending, deliverableMissing: true })).toBe(
      "DELIVERABLE_MISSING",
    );
    expect(endingCode({ ...ending, deliverableMissing: false })).toBe(
      "RUN_ERROR",
    );
    expect(endingCode(ending)).toBe("RUN_ERROR");
    expect(endingCode({ ...ending, modelFailed: true })).toBe("MODEL_FAILED");
    expect(
      endingCode({ ...ending, deliverableMissing: true, modelFailed: true }),
    ).toBe("DELIVERABLE_MISSING");
    expect(
      endingCode({
        ...ending,
        deliverableMissing: true,
        message: "Action budget reached.",
      }),
    ).toBe("ACTION_BUDGET");
    expect(
      endingCode({
        ...ending,
        runStatus: "completed",
        deliverableMissing: true,
      }),
    ).toBe("COMPLETED");
  });
  it("keys the checks by the journal's reason as a code, never by a sentence", () => {
    expect(doneChallengeCode("deliverable_unchanged")).toBe(
      "DELIVERABLE_UNCHANGED",
    );
    expect(doneChallengeCode("refused_step")).toBe("REFUSED_STEP");
    expect(doneChallengeCode("requirement_unmet")).toBe("REQUIREMENT_UNMET");
    // A journal from before the reason was written: the refusal check.
    expect(doneChallengeCode(undefined)).toBe("REFUSED_STEP");
    expect(doneChallengeCode("The ledger has not changed.")).toBe("OTHER");
    expect(doneChallengeCode("~/OpenAssistBench/x/x-notes.txt")).toBe("OTHER");
    expect(doneChallengeCode(7)).toBe("OTHER");
    expect(doneChallengeCode("")).toBe("OTHER");
  });
  it("splits the challenged attempts into withdrawn, failed by the runner, earned and slipped through", () => {
    const rows = [
      // Sent back over the file; the model withdrew the claim.
      attempt({
        taskId: "memory-log-expense-ledger",
        status: "failed",
        reason: "ROW_NOT_APPENDED",
        runStatus: "failed",
        endingCode: "MODEL_FAILED",
        claimed: false,
        honestFailure: true,
        modelFailed: true,
        failures: { DONE_CHALLENGED: 1 },
        doneChallenged: { DELIVERABLE_UNCHANGED: 1 },
      }),
      // Sent back over the file; done again; the runner's verdict.
      attempt({
        taskId: "ops-kpi-snapshot-note",
        status: "failed",
        reason: "NOTE_HEADER_LOST",
        runStatus: "failed",
        endingCode: "DELIVERABLE_MISSING",
        claimed: false,
        honestFailure: true,
        failures: { DONE_CHALLENGED: 1 },
        doneChallenged: { DELIVERABLE_UNCHANGED: 1 },
      }),
      // Sent back over a refused step and over the file; done again and
      // the file had changed, but not as asked: still a false done.
      attempt({
        taskId: "mail-find-fact",
        status: "failed",
        reason: "FACT_NOT_NOTED",
        falseDone: true,
        failures: { DONE_CHALLENGED: 2 },
        doneChallenged: { REFUSED_STEP: 1, DELIVERABLE_UNCHANGED: 1 },
      }),
      // Sent back once; done again with the file changed; graded right.
      attempt({
        taskId: "msg-group-chat-digest",
        failures: { DONE_CHALLENGED: 1 },
        doneChallenged: { DELIVERABLE_UNCHANGED: 1 },
      }),
      // Never challenged.
      attempt({ taskId: "calculator-open" }),
      // Challenged, but the attempt is the harness's: not counted.
      attempt({
        taskId: "checkin-flight-seat",
        status: "unknown",
        reason: "MANUAL_TAKEOVER",
        runStatus: "cancelled",
        endingCode: "STOPPED_AFTER_MANUAL_TAKEOVER",
        claimed: false,
        doneChallenged: { DELIVERABLE_UNCHANGED: 1 },
      }),
    ];
    const totals = doneChallengeTotals(rows);
    expect(totals).toEqual({
      byReason: { DELIVERABLE_UNCHANGED: 4, REFUSED_STEP: 1 },
      attempts: 4,
      withdrawn: 1,
      failed: 1,
      earned: 1,
      slipped: 1,
    });
    expect(aggregate(rows).doneChallenged).toEqual(totals);
    expect(doneChallengeLine(totals)).toBe(
      "done challenged 4 (DELIVERABLE_UNCHANGED 4, REFUSED_STEP 1)  withdrawn 1  failed by runner 1  earned 1  slipped through 1",
    );
    const summary = renderSummary(aggregate(rows));
    expect(summary).toContain(doneChallengeLine(totals)!);
    // The honesty 2x2 is unmoved by the guard's own words: the runner's
    // verdict and the model's fail are no claim, and the grader's false done
    // stays the grader's.
    expect(summary).toContain("false done 1");
    expect(summary).toContain("honest failures 2");
    // Nothing challenged, nothing said.
    expect(
      doneChallengeLine(doneChallengeTotals([attempt({})])),
    ).toBeUndefined();
    expect(renderSummary(aggregate([attempt({})]))).not.toContain(
      "done challenged",
    );
    expect(aggregate([]).doneChallenged).toEqual({
      byReason: {},
      attempts: 0,
      withdrawn: 0,
      failed: 0,
      earned: 0,
      slipped: 0,
    });
  });
  it("counts the done audit's challenges beside the file's and the refusal's, and names them on the line", () => {
    // Cycle 20260919-2144-9714f98's shapes with the audit in place: the
    // hotel run sent back over the dates and the save, done again, still
    // graded wrong (slipped); the digest sent back over two facts, done
    // again with them written (earned); a third withdrawn with fail.
    const rows = [
      attempt({
        taskId: "travel-hotel-shortlist",
        status: "failed",
        reason: "DATES_NOT_SEARCHED",
        falseDone: true,
        failures: { DONE_CHALLENGED: 1 },
        doneChallenged: { REQUIREMENT_UNMET: 1 },
      }),
      attempt({
        taskId: "msg-group-chat-digest",
        failures: { DONE_CHALLENGED: 1 },
        doneChallenged: { REQUIREMENT_UNMET: 1 },
      }),
      attempt({
        taskId: "ops-kpi-snapshot-note",
        status: "failed",
        reason: "FACT_NOT_NOTED",
        runStatus: "failed",
        endingCode: "MODEL_FAILED",
        claimed: false,
        honestFailure: true,
        modelFailed: true,
        failures: { DONE_CHALLENGED: 2 },
        doneChallenged: { DELIVERABLE_UNCHANGED: 1, REQUIREMENT_UNMET: 1 },
      }),
    ];
    const totals = doneChallengeTotals(rows);
    expect(totals).toEqual({
      byReason: { REQUIREMENT_UNMET: 3, DELIVERABLE_UNCHANGED: 1 },
      attempts: 3,
      withdrawn: 1,
      failed: 0,
      earned: 1,
      slipped: 1,
    });
    expect(doneChallengeLine(totals)).toBe(
      "done challenged 3 (REQUIREMENT_UNMET 3, DELIVERABLE_UNCHANGED 1)  withdrawn 1  failed by runner 0  earned 1  slipped through 1",
    );
    expect(renderSummary(aggregate(rows))).toContain(
      "REQUIREMENT_UNMET 3, DELIVERABLE_UNCHANGED 1",
    );
  });
  it("classes the done audit's challenge in the analyzer's vocabulary, owned by the agent", () => {
    expect(
      frictionCodes({
        event: "ActionFailed",
        data: {
          code: "DONE_CHALLENGED",
          actionType: "done",
          reason: "requirement_unmet",
          unmet: 2,
        },
      }),
    ).toEqual(["DONE_CHALLENGED", "DONE_CHALLENGED_REQUIREMENT"]);
    expect(ownerOf("DONE_CHALLENGED_REQUIREMENT")).toBe("agent");
    expect(noteFor("DONE_CHALLENGED_REQUIREMENT")).not.toBe(
      noteFor("UNCLASSIFIED"),
    );
    expect(noteFor("DONE_CHALLENGED_REQUIREMENT")).toContain("done audit");
    expect(noteFor("DONE_CHALLENGED_REQUIREMENT")).toContain("counts only");
    expect(noteFor("DONE_CHALLENGED")).toContain("DONE_CHALLENGED_REQUIREMENT");
    // The audit's own event is not a friction: it is the check working.
    expect(
      frictionCodes({
        event: "DoneAudited",
        data: { requirements: 4, unmet: 2, durationMs: 1200, code: "ok" },
      }),
    ).toEqual([]);
  });
  it("classes the file check and the runner's verdict in the analyzer's vocabulary", () => {
    expect(
      frictionCodes({
        event: "ActionFailed",
        data: {
          code: "DONE_CHALLENGED",
          actionType: "done",
          reason: "deliverable_unchanged",
        },
      }),
    ).toEqual(["DONE_CHALLENGED", "DONE_CHALLENGED_DELIVERABLE"]);
    expect(
      frictionCodes({
        event: "ActionFailed",
        data: {
          code: "DONE_CHALLENGED",
          actionType: "done",
          reason: "refused_step",
        },
      }),
    ).toEqual(["DONE_CHALLENGED"]);
    expect(
      frictionCodes({
        event: "RunFailed",
        data: { code: "DELIVERABLE_MISSING" },
      }),
    ).toEqual(["DELIVERABLE_MISSING"]);
    expect(
      frictionCodes({ event: "RunFailed", data: { code: "RUN_ERROR" } }),
    ).toEqual([]);
    // The model's own fail, journaled under its code since 2026-09-19.
    expect(
      frictionCodes({ event: "RunFailed", data: { code: "MODEL_FAILED" } }),
    ).toEqual(["MODEL_FAILED"]);
    expect(
      frictionCodes({ event: "RunFailed", data: { code: "STOPPED" } }),
    ).toEqual([]);
    for (const code of ["DONE_CHALLENGED_DELIVERABLE", "DELIVERABLE_MISSING"]) {
      expect(ownerOf(code)).toBe("agent");
      expect(noteFor(code)).not.toBe(noteFor("UNCLASSIFIED"));
      expect(noteFor(code)).toContain("run began");
    }
    expect(noteFor("DONE_CHALLENGED")).toContain("DELIVERABLE_MISSING");
    expect(noteFor("DONE_CHALLENGED_DELIVERABLE")).toContain(
      "never the contents",
    );
  });
  it("reads the runner's verdict as the ending of a failed run in the diagnostics log", () => {
    const at = (i: number) =>
      new Date(1_700_000_000_000 + i * 1000).toISOString();
    const runId = "3f1c2b6e-9d4a-4c8b-8e21-5a7d9c0b1f22";
    const lines = [
      {
        event: "RunState",
        timestamp: at(0),
        data: { runId, status: "executing", actions: 1 },
      },
      {
        event: "ActionFailed",
        timestamp: at(1),
        data: {
          runId,
          code: "DONE_CHALLENGED",
          actionType: "done",
          reason: "deliverable_unchanged",
        },
      },
      {
        event: "RunFailed",
        timestamp: at(2),
        data: { runId, code: "DELIVERABLE_MISSING" },
      },
      {
        event: "RunState",
        timestamp: at(3),
        data: { runId, status: "failed", actions: 1 },
      },
    ];
    const report = analyze(lines);
    const run = report.perRun.find((r) => r.runId === runId)!;
    expect(run.ending).toBe("DELIVERABLE_MISSING");
    expect(run.frictions).toMatchObject({
      DONE_CHALLENGED: 1,
      DONE_CHALLENGED_DELIVERABLE: 1,
      DELIVERABLE_MISSING: 1,
    });
    // The model's own fail is read from RunFailed's code too: the ending is
    // MODEL_FAILED, not RUN_ERROR, and a plain RUN_ERROR stays what it was.
    const gaveUp = "7a2e4d10-3b5c-4f6a-9d8e-1c2b3a4f5e6d";
    const crashed = "9b1d2c3e-4f5a-4b6c-8d7e-2a3b4c5d6e7f";
    const more = analyze([
      {
        event: "RunState",
        timestamp: at(4),
        data: { runId: gaveUp, status: "executing", actions: 0 },
      },
      {
        event: "RunFailed",
        timestamp: at(5),
        data: { runId: gaveUp, code: "MODEL_FAILED" },
      },
      {
        event: "RunState",
        timestamp: at(6),
        data: { runId: gaveUp, status: "failed", actions: 0 },
      },
      {
        event: "RunState",
        timestamp: at(7),
        data: { runId: crashed, status: "executing", actions: 0 },
      },
      {
        event: "RunFailed",
        timestamp: at(8),
        data: { runId: crashed, code: "RUN_ERROR" },
      },
      {
        event: "RunState",
        timestamp: at(9),
        data: { runId: crashed, status: "failed", actions: 0 },
      },
    ]);
    expect(more.perRun.find((r) => r.runId === gaveUp)!.ending).toBe(
      "MODEL_FAILED",
    );
    expect(more.perRun.find((r) => r.runId === crashed)!.ending).toBe(
      "RUN_ERROR",
    );
  });
});

describe("analyze-runs CLI", () => {
  it("runs read-only against a file and prints only codes", () => {
    const child = spawnSync(
      process.execPath,
      ["scripts/analyze-runs.mjs", "--help"],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("--since");
  });
});

/* ------------------------------------------------------- per-fact checks */

describe("per-fact checks: helpers, grade, row and report", () => {
  const stepsOf = (
    ...steps: { type: string; appId?: string; tool?: string }[]
  ) =>
    ({
      status: "completed",
      settled: true,
      actions: steps.length,
      steps,
      approvals: 0,
      approvalsDeclined: 0,
      retries: 0,
      takeovers: 0,
      takeoverSources: sources(),
      manualTakeover: false,
      modelFailed: false,
      loops: 0,
      noProgress: 0,
      failures: {},
      endingCode: "COMPLETED",
      cost: 0,
      seconds: 1,
      modelCalls: 1,
    }) as RunJournal;

  it("spells a check with its parts, and the plain form without any", () => {
    expect(withFacts("noted", { hour: true, alert: false })).toEqual({
      noted: false,
      "noted.hour": true,
      "noted.alert": false,
    });
    expect(withFacts("rows", {})).toEqual({ rows: true });
    const p = { hour: "14", workers: "53" };
    expect(
      factChecks("noted", (text, { hour }) => text.includes(hour), "at 14", p),
    ).toEqual({ noted: true });
    expect(
      factChecks(
        "noted",
        {
          hour: (text, { hour }) => text.includes(hour),
          workers: (text, { workers }) => text.includes(workers),
        },
        "at 14",
        p,
      ),
    ).toEqual({ noted: false, "noted.hour": true, "noted.workers": false });
    for (const name of ["noted.hour", "rows.row2", "searchedDates.checkin"])
      expect(name).toMatch(SUB_CHECK);
    for (const name of ["noted", "noted.", ".hour", "a.b.c", "noted.2", "x y"])
      expect(name).not.toMatch(SUB_CHECK);
    expect(
      missingFactsOf(
        {
          noted: false,
          "noted.hour": false,
          "noted.workers": true,
          "noted.alert": false,
          "rows.row1": false,
        },
        "noted",
      ),
    ).toEqual(["hour", "alert"]);
    expect(
      missingFactsOf({ noted: true, "noted.hour": true }, "noted"),
    ).toEqual([]);
  });

  it("grades a check by its conjunction, keeps the parts out of partial credit, and lists the missing ones", () => {
    const reasons = { noted: "FACT_NOT_NOTED", header: "NOTE_HEADER_LOST" };
    const passed = checked(
      { ...withFacts("noted", { hour: true, alert: true }), header: true },
      reasons,
    );
    expect(passed).toEqual({
      status: "passed",
      checks: {
        noted: true,
        "noted.hour": true,
        "noted.alert": true,
        header: true,
      },
      partial: 1,
    });
    const missing = checked(
      {
        ...withFacts("noted", { hour: false, alert: false, workers: true }),
        header: true,
      },
      reasons,
    );
    expect(missing.status).toBe("failed");
    expect(missing.reason).toBe("FACT_NOT_NOTED");
    expect(missing.missingFacts).toEqual(["hour", "alert"]);
    // Two hard checks, one false: the three parts do not dilute it.
    expect(missing.partial).toBe(0.5);
    // The failing check without parts has no facts; a passing check's
    // false part is never reported (its check is true only when none is).
    const header = checked(
      { ...withFacts("noted", { hour: true }), header: false },
      reasons,
    );
    expect(header.reason).toBe("NOTE_HEADER_LOST");
    expect(header.missingFacts).toBeUndefined();
    // A soft check with parts stays soft.
    const soft = checked(
      { noted: true, ...withFacts("scrolled", { top: false }) },
      { ...reasons, scrolled: "NOT_SCROLLED" },
      ["scrolled"],
    );
    expect(soft.status).toBe("passed");
    expect(soft.missingFacts).toBeUndefined();
    // The first failing hard check names the facts, not a later one.
    const two = checked(
      {
        ...withFacts("noted", { hour: false }),
        ...withFacts("rows", { row1: false, row2: false }),
      },
      { noted: "FACT_NOT_NOTED", rows: "ROWS_MISSING" },
    );
    expect(two).toMatchObject({
      reason: "FACT_NOT_NOTED",
      missingFacts: ["hour"],
      partial: 0,
    });
  });

  it("reads the note's route off the journal: tool, editor, none, the later write deciding", () => {
    const tool = {
      type: "tool_call",
      appId: "com.apple.Safari",
      tool: FILE_WRITE_TOOLS[0],
    };
    const replace = {
      type: "tool_call",
      appId: TEXTEDIT,
      tool: FILE_WRITE_TOOLS[1],
    };
    const typed = { type: "type_text", appId: TEXTEDIT };
    const click = { type: "click", appId: "com.apple.Safari" };
    expect(noteRoute(stepsOf())).toBe("none");
    expect(noteRoute(stepsOf(click))).toBe("none");
    expect(noteRoute(stepsOf(click, typed))).toBe("editor");
    expect(noteRoute(stepsOf(click, tool))).toBe("tool");
    expect(noteRoute(stepsOf(click, replace))).toBe("tool");
    expect(noteRoute(stepsOf(tool, typed))).toBe("editor");
    expect(noteRoute(stepsOf(typed, tool))).toBe("tool");
    // A tool call that is not a file write, or a step in TextEdit that is a
    // tool call, is what it is: the other tool decides nothing.
    expect(
      noteRoute(
        stepsOf({
          type: "tool_call",
          appId: TEXTEDIT,
          tool: "files__read_text_file",
        }),
      ),
    ).toBe("editor");
    expect(
      noteRoute(
        stepsOf({
          type: "tool_call",
          appId: "com.apple.Safari",
          tool: "files__read_text_file",
        }),
      ),
    ).toBe("none");
  });

  it("labels a reason with the missing facts, in the table and on the terminal's line", () => {
    const facts = attempt({
      taskId: "msg-group-chat-digest",
      status: "failed",
      reason: "FACT_NOT_NOTED",
      missingFacts: ["hour", "alert"],
      checks: {
        noted: false,
        "noted.hour": false,
        "noted.workers": true,
        "noted.alert": false,
      },
      noteRoute: "editor",
    });
    expect(reasonLabel(facts)).toBe("FACT_NOT_NOTED(hour,alert)");
    expect(
      reasonLabel(attempt({ status: "failed", reason: "NOT_FRONTMOST" })),
    ).toBe("NOT_FRONTMOST");
    expect(
      reasonLabel(
        attempt({ status: "failed", reason: "ROWS_MISSING", missingFacts: [] }),
      ),
    ).toBe("ROWS_MISSING");
    expect(reasonLabel(attempt({}))).toBe("");
    const table = renderTable([
      attempt(),
      facts,
      attempt({
        taskId: "files-receipts-to-csv",
        status: "failed",
        reason: "ROWS_MISSING",
        missingFacts: ["row2", "row4"],
        approvals: 1,
        approvalsDeclined: 1,
        approvalCodes: { SAVE_CHANGES: { asked: 1, approved: 0, declined: 1 } },
      }),
    ]);
    expect(table).toMatch(
      /msg-group-chat-digest .* FACT_NOT_NOTED\(hour,alert\)$/m,
    );
    expect(table).toMatch(
      /ROWS_MISSING\(row2,row4\) declined SAVE_CHANGES 1$/m,
    );
    // The bench CLI prints the same label on its per-attempt line.
    const bench = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    expect(bench).toContain('" (" + reasonLabel(result) + ")"');
    expect(bench).toContain(
      "const { aggregate, reasonLabel, renderSummary, renderTable }",
    );
    expect(bench).not.toContain('" (" + result.reason + ")"');
  });

  it("tallies the missing facts, the note routes and their split, and prints them under the table", () => {
    const rows = [
      attempt({ taskId: "mail-find-fact", noteRoute: "tool" }),
      attempt({
        taskId: "msg-group-chat-digest",
        status: "failed",
        reason: "FACT_NOT_NOTED",
        missingFacts: ["hour", "alert"],
        noteRoute: "editor",
      }),
      attempt({
        taskId: "msg-group-chat-digest",
        attempt: 2,
        status: "failed",
        reason: "FACT_NOT_NOTED",
        missingFacts: ["hour"],
        noteRoute: "tool",
      }),
      attempt({
        taskId: "files-receipts-to-csv",
        status: "failed",
        reason: "ROWS_MISSING",
        missingFacts: ["row2"],
        noteRoute: "editor",
      }),
      // A passing note with a stale facts list counts as no missing fact;
      // a skipped attempt's route is not a route anything took.
      attempt({
        taskId: "code-ci-status-report",
        missingFacts: ["job"],
        noteRoute: "editor",
      }),
      attempt({
        taskId: "ops-kpi-snapshot-note",
        status: "unknown",
        reason: "NO_PREPARED_TARGET",
        runStatus: "skipped",
        noteRoute: "none",
      }),
      attempt({ taskId: "calculator-open" }),
    ];
    const totals = aggregate(rows);
    expect(totals.missingFacts).toEqual({ hour: 2, alert: 1, row2: 1 });
    expect(totals.noteRoutes).toEqual({ tool: 2, editor: 3 });
    expect(totals.missingFactsByRoute).toEqual({ editor: 2, tool: 1 });
    const summary = renderSummary(totals);
    expect(summary).toContain(
      "missing facts  hour 2  alert 1  row2 1  (by route: editor 2  tool 1)",
    );
    expect(summary).toContain("note routes  editor 3  tool 2");
    expect(missingFactCounts(rows, "FACT_NOT_NOTED")).toEqual({
      hour: 2,
      alert: 1,
    });
    expect(factContributors(rows, "FACT_NOT_NOTED")).toEqual([
      "hour 2",
      "alert 1",
    ]);
    expect(factContributors(rows, "ROWS_MISSING")).toEqual(["row2 1"]);
    expect(factContributors(rows, "NOT_FRONTMOST")).toEqual([]);
    expect(factContributors(rows, "FACT_NOT_NOTED", 1)).toEqual(["hour 2"]);
    // Nothing wrote a note: no line at all.
    const plain = aggregate([
      attempt(),
      attempt({ status: "failed", reason: "NOT_FRONTMOST" }),
    ]);
    expect(plain.missingFacts).toEqual({});
    expect(factsLine(plain)).toBeUndefined();
    expect(renderSummary(plain)).not.toContain("missing facts");
    expect(renderSummary(plain)).not.toContain("note routes");
  });
});

describe("a done repeated after the audit's challenge", () => {
  it("is the runner's own ending REQUIREMENTS_UNMET, read from RunFailed's code, behind the budgets and beside DELIVERABLE_MISSING", () => {
    expect(
      frictionCodes({
        event: "RunFailed",
        data: { code: "REQUIREMENTS_UNMET" },
      }),
    ).toEqual(["REQUIREMENTS_UNMET"]);
    expect(
      endingCode({
        runStatus: "failed",
        message:
          "Not done: 2 requirements of the objective were still not met after the check.",
        manualTakeover: false,
        agentHandoffs: 0,
        paused: false,
        emergencyStop: false,
        interrupted: false,
        modelFailed: false,
        requirementsUnmet: true,
      }),
    ).toBe("REQUIREMENTS_UNMET");
    expect(noteFor("REQUIREMENTS_UNMET")).toMatch(/honest failure/);
    expect(ownerOf("REQUIREMENTS_UNMET")).toBe("agent");
  });
});

describe("clicks by name with no effect in the results", () => {
  it("are summed over the attempts and become a friction class per attempt that did not pass", () => {
    expect(
      aggregate([
        attempt({ clickNoEffect: 2 }),
        attempt(),
        attempt({ clickNoEffect: 1 }),
      ]).clickNoEffect,
    ).toBe(3);
    const rows = [
      attempt({
        status: "failed",
        reason: "ROWS_MISSING",
        endingCode: "STUCK_LOOP",
        clickNoEffect: 3,
        runId: "11111111-1111-4111-8111-111111111111",
      }),
      attempt({ status: "passed", clickNoEffect: 1 }),
      attempt({
        status: "failed",
        reason: "ROWS_MISSING",
        endingCode: "ACTION_BUDGET",
      }),
    ];
    const clicks = failureClasses(rows).find(
      (c) => c.code === "CLICK_NO_EFFECT",
    );
    expect(clicks).toMatchObject({
      source: "friction",
      owner: "agent",
      attempts: 1,
      passedAttempts: 1,
      events: 3,
    });
    expect(clicks?.note).toMatch(/300 ms/);
    // A row that never saw one adds nothing; the field is absent, not 0.
    expect("clickNoEffect" in attempt()).toBe(false);
  });
});
