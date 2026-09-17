import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOGUE,
  CATEGORIES,
  benchToken,
  selectTasks,
} from "../src/gym/bench/catalogue";
import {
  accessibilityText,
  containsAll,
  containsNumber,
  fillInstruction,
  gradeTask,
  holdOverride,
  hostMatches,
  launchedApp,
  normalizeHost,
  openedPathStep,
  typedAtLeast,
} from "../src/gym/bench/graders";
import {
  aggregate,
  median,
  renderSummary,
  renderTable,
  type AttemptResult,
} from "../src/gym/bench/report";
import {
  analyze,
  budgetCode,
  frictionCodes,
  parseDiagnostics,
  renderAnalysis,
} from "../src/gym/bench/analyze";
import type { BenchTask, Evidence, RunJournal } from "../src/gym/bench/types";
import type { ScreenContext } from "../src/core/schema";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const journal = (over: Partial<RunJournal> = {}): RunJournal => ({
  status: "completed",
  settled: true,
  actions: 4,
  steps: [],
  approvals: 0,
  approvalsDeclined: 0,
  retries: 0,
  takeovers: 0,
  manualTakeover: false,
  loops: 0,
  failures: {},
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
        { type: "open_app", launchedAppId: "com.apple.Calculator" },
        { type: "type_text", appId: "com.apple.Notes", textLength: 14 },
        {
          type: "open_file",
          openedPath: "~/Documents/a.pdf",
          openedAppId: "com.apple.Preview",
        },
      ],
    });
    expect(launchedApp(j, "com.apple.Calculator")).toBe(true);
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
});

describe("graders against end-state fixtures", () => {
  it("passes an app launch only when that app is frontmost", () => {
    const open = task("calculator-open");
    expect(
      gradeTask(open, evidence({ appId: "com.apple.Calculator" })).status,
    ).toBe("passed");
    const missed = gradeTask(open, evidence({ appId: "com.apple.Finder" }));
    expect(missed.status).toBe("failed");
    expect(missed.reason).toBe("NOT_FRONTMOST");
    expect(gradeTask(open, evidence()).reason).toBe("NO_FRONTMOST_INFO");
  });
  it("passes a calculation only when the display shows the answer", () => {
    const multiply = task("calculator-multiply");
    expect(
      gradeTask(
        multiply,
        evidence({
          appId: "com.apple.Calculator",
          context: context({ windowTitle: "Calculator", visibleText: "5,888" }),
        }),
      ).status,
    ).toBe("passed");
    const wrong = gradeTask(
      multiply,
      evidence({
        appId: "com.apple.Calculator",
        context: context({ windowTitle: "Calculator", visibleText: "51888" }),
      }),
    );
    expect(wrong.status).toBe("failed");
    expect(wrong.reason).toBe("RESULT_NOT_SHOWN");
  });
  it("says unknown, not passed, when there is no accessibility text", () => {
    const multiply = task("calculator-multiply");
    const grade = gradeTask(
      multiply,
      evidence({ appId: "com.apple.Calculator" }),
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
      steps: [{ type: "open_app", launchedAppId: "com.apple.Calculator" }],
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
          appId: "com.apple.Calculator",
          journal: launched,
        }),
      ).reason,
    ).toBe("NOT_FRONTMOST");
  });
});

const attempt = (over: Partial<AttemptResult> = {}): AttemptResult => ({
  taskId: "calculator-open",
  category: "calculator",
  difficulty: "easy",
  attempt: 1,
  status: "passed",
  checks: {},
  runStatus: "completed",
  actions: 3,
  seconds: 10,
  cost: 0.01,
  modelCalls: 3,
  approvals: 0,
  approvalsDeclined: 0,
  retries: 0,
  takeovers: 0,
  loops: 0,
  failures: {},
  ...over,
});

describe("aggregation", () => {
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
    expect(totals.passed).toBe(2);
    expect(totals.failed).toBe(1);
    expect(totals.unknown).toBe(1);
    expect(totals.successRate).toBeCloseTo(0.5);
    expect(totals.gradedSuccessRate).toBeCloseTo(2 / 3);
    // Medians ignore the attempt that never ran: 3, 5 and 9 actions.
    expect(totals.medianActions).toBe(5);
    expect(totals.medianSeconds).toBe(20);
    expect(totals.totalCost).toBeCloseTo(0.08);
    expect(totals.retries).toBe(2);
    expect(totals.approvals).toBe(1);
    expect(totals.approvalsDeclined).toBe(1);
    expect(totals.failures).toEqual({ STATE_CHANGED: 4, INVALID_ACTION: 1 });
    expect(totals.byCategory.calculator).toEqual({
      attempts: 1,
      passed: 1,
      failed: 0,
      unknown: 0,
      successRate: 1,
    });
    expect(totals.byCategory.browser.successRate).toBe(0);
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
      "src/core/runner.ts",
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
    appId: "com.apple.Calculator",
    reason: `Activate ${MARK}?`,
  }),
  line("2026-09-10T10:00:04.000Z", "ActionExecuted", {
    runId: RUNS.completed,
    actionType: "open_app",
    launchedAppId: "com.apple.Calculator",
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
