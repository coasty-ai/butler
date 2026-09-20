import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The streaming report reads the diagnostics stream a voice turn leaves and
// says which clauses committed while the user spoke, what acted on them and
// how fast, whether the final kept them, and whether the run then repeated a
// streamed step. It must print timings, counts and codes only: every text
// field of the fixture (the words, a URL, a label, an app's name, the prelude)
// carries a sentinel that must never appear in any output.
const root = resolve(__dirname, "..");
const script = join(root, "scripts", "streaming-report.mjs");
const SENTINEL = "zqxsentinel";

/** One diagnostics row at `at` ms after the fixture's epoch. */
const T0 = Date.parse("2026-09-19T10:00:00.000Z");
let sequence = 0;
const row = (at: number, event: string, data: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: new Date(T0 + at).toISOString(),
    pid: 1,
    sequence: ++sequence,
    event,
    data,
  });
const voice = (at: number, phase: string, data: Record<string, unknown> = {}) =>
  row(at, "VoiceEvent", { phase, ...data });
const change = (at: number, text: string) => [
  voice(at, "recognition_update", { textLength: text.length }),
  voice(at + 2, "transcript_partial", { text, textLength: text.length }),
];
const request = (at: number, method: string) =>
  row(at, "NativeRequest", {
    requestId: `req-${at}`,
    method,
    request: { url: SENTINEL, action: { type: method, name: SENTINEL } },
  });

/**
 * Turn A (0 s), "go to youtube and play a midwest safety video": clause 0
 * commits by boundary at 1400 and its open_url request goes out at 1500 (a
 * stray `execute` at 1450, the early start's, is further from the action's
 * row and not taken); clause 1 commits by stability at 2900 and its action
 * row at 3150 has no request of its own, so commit -> issue is read from the
 * row. The final at 4850 keeps both; the run starts 250 ms later with a
 * prelude of 2 steps and never reopens the site: its click and its open_app
 * (no open_app was streamed) are not repeats.
 * Turn B (20 s), "open slack and scroll down … go to gmail and send it": four
 * clauses; open_app (its request is `execute`, its early journal entry is not
 * a repeat), scroll (dropped by the final), open_url gmail after a slow
 * decide (480 ms commit -> request), and a consequential clause with no fast
 * action. A speculative model request runs before the final. The run's
 * prelude says 3 steps, 1 dropped; the run then journals an open_url 1700 ms
 * in, the repeat, and a request row of the same kind is not counted twice.
 * Turn C (40 s): a plain turn with no streamed clause.
 * Turn D (60 s): a wake that was cancelled.
 */
const stream = [
  voice(0, "wake_detected"),
  ...change(300, `${SENTINEL} go`),
  ...change(600, `${SENTINEL} go to youtube`),
  ...change(1000, `${SENTINEL} go to youtube and`),
  row(1400, "StreamClauseCommitted", {
    index: 0,
    by: "boundary",
    words: 3,
    leadMs: 3450,
    text: SENTINEL,
  }),
  request(1450, "execute"),
  request(1500, "open_url"),
  row(1520, "StreamedAction", {
    kind: "open_url",
    siteKey: "youtube",
    nav: "home",
    clauseIndex: 0,
    decideMs: 40,
    issueMs: 60,
    url: SENTINEL,
    label: SENTINEL,
  }),
  row(1530, "ActionExecuted", {
    actionType: "open_url",
    early: true,
    action: { type: "open_url", url: SENTINEL },
  }),
  ...change(2000, `${SENTINEL} go to youtube and play a`),
  ...change(2500, `${SENTINEL} go to youtube and play a midwest safety`),
  // Clause 1 committed at three words, grew, and committed again at four
  // (a re-commit); its one query issued off the second commit.
  row(2700, "StreamClauseCommitted", {
    index: 1,
    by: "stable",
    words: 3,
    leadMs: 2150,
  }),
  row(2900, "StreamClauseCommitted", {
    index: 1,
    by: "stable",
    words: 4,
    leadMs: 1950,
    superseded: true,
  }),
  row(3150, "StreamedAction", {
    kind: "open_url",
    siteKey: "youtube",
    nav: "query",
    clauseIndex: 1,
    decideMs: 170,
    issueMs: 50,
    url: SENTINEL,
  }),
  ...change(3300, `${SENTINEL} go to youtube and play a midwest safety video`),
  voice(4800, "turn_endpoint", {
    endReason: "stable_quiet",
    stableMs: 1500,
    quietMs: 1200,
  }),
  voice(4850, "transcript_final", {
    text: `${SENTINEL} go to youtube and play a midwest safety video`,
    textLength: 58,
    confidence: 0.9,
  }),
  row(4852, "Command", { text: SENTINEL, fromVoice: true }),
  row(5100, "StreamedRunStarted", {
    streamedSteps: 2,
    dropped: 0,
    prelude: SENTINEL,
  }),
  row(5120, "RunStarted", { runId: "r1", task: SENTINEL }),
  // The first capture waited for the prelude's last page.
  row(5180, "TransitionSettled", { runId: "r1", kind: "navigated" }),
  row(5200, "ModelRequestStarted", { runId: "r1", model: "m" }),
  request(5300, "capture"),
  request(7000, "execute"),
  row(7010, "ActionExecuted", {
    runId: "r1",
    actionType: "click",
    x: 10,
    y: 20,
    action: { type: "click", note: SENTINEL },
  }),
  request(7490, "execute"),
  row(7500, "ActionExecuted", {
    runId: "r1",
    actionType: "open_app",
    launchedAppId: "com.apple.Safari",
    action: { type: "open_app", name: SENTINEL },
  }),

  voice(20000, "wake_detected"),
  ...change(20400, `${SENTINEL} open slack`),
  row(21000, "StreamClauseCommitted", {
    index: 0,
    by: "boundary",
    words: 2,
    leadMs: 5000,
  }),
  request(21070, "execute"),
  row(21080, "StreamedAction", {
    kind: "open_app",
    clauseIndex: 0,
    decideMs: 10,
    issueMs: 50,
    name: SENTINEL,
  }),
  row(21090, "ActionExecuted", {
    actionType: "open_app",
    early: true,
    launchedAppId: "com.tinyspeck.slackmacgap",
    action: { type: "open_app", name: SENTINEL },
  }),
  ...change(21500, `${SENTINEL} open slack and scroll down`),
  row(22500, "StreamClauseCommitted", {
    index: 1,
    by: "stable",
    words: 2,
    leadMs: 3500,
  }),
  request(22590, "scrollContinuous"),
  row(22600, "StreamedAction", {
    kind: "scroll",
    clauseIndex: 1,
    decideMs: 20,
    issueMs: 60,
  }),
  row(22990, "SpeculationStarted", {}),
  row(23000, "ModelRequestStarted", { runId: "spec", model: "m" }),
  ...change(23500, `${SENTINEL} open slack and go to gmail`),
  row(24200, "StreamClauseCommitted", {
    index: 2,
    by: "stable",
    words: 3,
    leadMs: 1800,
  }),
  request(24680, "open_url"),
  row(24700, "StreamedAction", {
    kind: "open_url",
    siteKey: "gmail",
    clauseIndex: 2,
    decideMs: 400,
    issueMs: 80,
    url: SENTINEL,
  }),
  ...change(24900, `${SENTINEL} open slack and go to gmail and send it`),
  row(25000, "StreamClauseCommitted", {
    index: 3,
    by: "boundary",
    words: 3,
    leadMs: 1000,
  }),
  voice(25900, "turn_endpoint", { endReason: "stable_quiet" }),
  voice(26000, "transcript_final", {
    text: `${SENTINEL} open slack and go to gmail and send it`,
    textLength: 51,
    confidence: 0.9,
  }),
  row(26010, "StreamedActionDropped", {
    kind: "scroll",
    clauseIndex: 1,
    text: SENTINEL,
  }),
  row(26300, "StreamedRunStarted", { streamedSteps: 3, dropped: 1 }),
  row(26320, "RunStarted", { runId: "r2", task: SENTINEL }),
  row(26400, "ModelRequestStarted", { runId: "r2", model: "m" }),
  request(27990, "open_url"),
  row(28000, "ActionExecuted", {
    runId: "r2",
    actionType: "open_url",
    action: { type: "open_url", url: SENTINEL },
  }),
  request(28900, "execute"),
  row(29000, "ActionExecuted", {
    runId: "r2",
    actionType: "click",
    action: { type: "click" },
  }),

  voice(40000, "wake_detected"),
  ...change(40500, `${SENTINEL} open notes`),
  voice(42000, "turn_endpoint", { endReason: "stable_quiet" }),
  voice(42050, "transcript_final", { text: SENTINEL, textLength: 22 }),
  row(42300, "RunStarted", { runId: "r3", task: SENTINEL }),
  request(42400, "execute"),
  row(42500, "ActionExecuted", {
    runId: "r3",
    actionType: "open_app",
    launchedAppId: "com.apple.Notes",
    action: { type: "open_app", name: SENTINEL },
  }),

  voice(60000, "wake_detected"),
  voice(60800, "voice_cancelled"),

  // Turn E (80 s), a correction: the site clause opened one site, was
  // rewritten to another and committed again (a re-commit), which dropped
  // the first step and issued the second (a reissue). The run's first
  // capture did not settle (no TransitionSettled).
  voice(80000, "wake_detected"),
  ...change(80300, `${SENTINEL} go to youtube`),
  row(80900, "StreamClauseCommitted", {
    index: 0,
    by: "boundary",
    words: 3,
    leadMs: 2100,
  }),
  request(80950, "open_url"),
  row(80960, "StreamedAction", {
    kind: "open_url",
    siteKey: "youtube",
    nav: "home",
    clauseIndex: 0,
    decideMs: 10,
    issueMs: 60,
    url: SENTINEL,
  }),
  ...change(81400, `${SENTINEL} go to gmail and`),
  row(81800, "StreamClauseCommitted", {
    index: 0,
    by: "boundary",
    words: 3,
    leadMs: 1200,
    superseded: true,
  }),
  row(81850, "StreamedActionDropped", { kind: "open_url", clauseIndex: 0 }),
  request(81860, "open_url"),
  row(81870, "StreamedAction", {
    kind: "open_url",
    siteKey: "gmail",
    nav: "home",
    clauseIndex: 0,
    decideMs: 10,
    issueMs: 70,
    reissue: true,
    url: SENTINEL,
  }),
  voice(82900, "turn_endpoint", { endReason: "stable_quiet" }),
  voice(83000, "transcript_final", { text: SENTINEL, textLength: 30 }),
  row(83200, "StreamedRunStarted", { streamedSteps: 2, dropped: 1 }),
  row(83220, "RunStarted", { runId: "r5", task: SENTINEL }),
  row(83300, "ModelRequestStarted", { runId: "r5", model: "m" }),
  "not json at all",
].join("\n");

const CONTENT_KEYS = /"(url|text|label|name|task|prelude|note)"/;

describe("streaming-report", () => {
  let file: string;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
    });
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "streaming-report-"));
    file = join(dir, "current.jsonl");
    writeFileSync(file, stream + "\n");
  });

  it("prints --help and refuses a missing file", () => {
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage");
    expect(help.stdout).toContain("--turns N");
    expect(help.stdout).toContain("--json");
    const missing = run(join(root, "no-such-stream.jsonl"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("No such file");
  });

  it("lists each turn's clauses, fast actions, drops and repeats as JSON, without the words", () => {
    const result = run("--json", file);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stdout).not.toMatch(CONTENT_KEYS);
    const report = JSON.parse(result.stdout);
    const { summary } = report;
    expect(summary.turns).toBe(5);
    expect(summary.shown).toBe(5);
    expect(summary.streamedTurns).toBe(3);
    // Nine commits of seven clauses: turn A's clause 1 and turn E's clause 0
    // each committed twice (a re-commit).
    expect(summary.clauses).toMatchObject({
      committed: 9,
      distinct: 7,
      superseded: 2,
      commitsPerClause: { n: 7, p50: 1, max: 2 },
      // Six clauses issued; turn E's clause 0 twice (its reissue).
      issuesPerClause: { n: 6, p50: 1, max: 2 },
      by: { boundary: 5, stable: 4 },
    });
    expect(summary.clauses.wordsPerClause).toMatchObject({ n: 9, p50: 3 });
    expect(summary.clauses.commitToFinalMs).toMatchObject({
      n: 9,
      p50: 2100,
      p95: 5000,
    });
    expect(summary.fastActions).toMatchObject({
      total: 7,
      byKind: { open_url: 5, open_app: 1, scroll: 1 },
      turnsWithOne: 3,
      turnRate: 1,
      issuedFrom: { request: 6, event: 1 },
      targets: { commitToIssueP50Ms: 250, commitToIssueP95Ms: 600 },
      withinTargets: true,
    });
    expect(summary.fastActions.perTurn).toMatchObject({ n: 3, p50: 2 });
    expect(summary.fastActions.decideMs).toMatchObject({
      n: 7,
      p50: 20,
      p95: 400,
    });
    expect(summary.fastActions.issueMs).toMatchObject({
      n: 7,
      p50: 60,
      p95: 80,
    });
    expect(summary.fastActions.commitToIssueMs).toMatchObject({
      n: 7,
      p50: 90,
      p95: 480,
    });
    // The target is read over the site opens (and actions without a nav);
    // the one query, held for its words, is measured apart.
    expect(summary.fastActions.commitToIssueSiteOpensMs).toMatchObject({
      n: 6,
      p50: 90,
      p95: 480,
    });
    expect(summary.fastActions.commitToIssueQueriesMs).toMatchObject({
      n: 1,
      p50: 250,
    });
    expect(summary.navigations).toEqual({
      total: 5,
      siteOpens: 3,
      queries: 1,
      reissues: 1,
      perTurn: { n: 3, p50: 2, max: 2 },
    });
    expect(summary.dropped).toEqual({ actions: 2, rate: 2 / 7 });
    expect(summary.runs).toMatchObject({
      withPrelude: 3,
      streamedSteps: 7,
      droppedInPrelude: 2,
      repeated: 1,
      repeatedActions: 1,
      repeatRate: 1 / 3,
      settled: 1,
    });
    expect(summary.runs.afterFinalMs).toMatchObject({ n: 3, p50: 250 });
    expect(summary.runs.settleWaitMs).toMatchObject({ n: 1, p50: 60 });
    expect(summary.modelRequestsBeforeFinal).toBe(1);
    expect(summary.speculationsBeforeFinal).toBe(1);

    const [a, b, c, d, e] = report.turns;
    expect(a.at).toBe("2026-09-19T10:00:00.000Z");
    expect(a.outcome).toBe("transcript_final");
    expect(a.changes).toBe(6);
    expect(a.clauses).toEqual([
      {
        index: 0,
        by: "boundary",
        words: 3,
        leadMs: 3450,
        toFinalMs: 3450,
        dropped: false,
      },
      {
        index: 1,
        by: "stable",
        words: 3,
        leadMs: 2150,
        toFinalMs: 2150,
        dropped: false,
      },
      {
        index: 1,
        by: "stable",
        words: 4,
        leadMs: 1950,
        toFinalMs: 1950,
        dropped: false,
        superseded: true,
      },
    ]);
    // Clause 0's request at 1500 is nearer its action's row than the stray
    // execute at 1450; clause 1 has no request and is measured from its row,
    // against its last commit (the re-commit at 2900).
    expect(a.actions).toEqual([
      {
        clauseIndex: 0,
        kind: "open_url",
        siteKey: "youtube",
        nav: "home",
        decideMs: 40,
        issueMs: 60,
        commitToIssueMs: 100,
        issuedFrom: "request",
        kept: true,
      },
      {
        clauseIndex: 1,
        kind: "open_url",
        siteKey: "youtube",
        nav: "query",
        decideMs: 170,
        issueMs: 50,
        commitToIssueMs: 250,
        issuedFrom: "event",
        kept: true,
      },
    ]);
    expect(a.dropped).toEqual([]);
    expect(a.shape).toEqual({
      clauses: 2,
      commits: 3,
      supersededCommits: 1,
      commitsPerClause: [1, 2],
      issuesPerClause: [1, 1],
      navigations: 2,
      siteOpens: 1,
      queries: 1,
      reissues: 0,
    });
    expect(a.run).toEqual({
      afterFinalMs: 250,
      streamedSteps: 2,
      dropped: 0,
      repeats: [],
      settled: true,
      settleWaitMs: 60,
    });
    expect(a.modelRequestsBeforeFinal).toBe(0);
    expect(a.speculations).toBe(0);

    expect(b.clauses.map((x: any) => [x.index, x.by, x.dropped])).toEqual([
      [0, "boundary", false],
      [1, "stable", true],
      [2, "stable", false],
      [3, "boundary", false],
    ]);
    expect(
      b.actions.map((x: any) => [x.kind, x.commitToIssueMs, x.kept]),
    ).toEqual([
      ["open_app", 70, true],
      ["scroll", 90, false],
      ["open_url", 480, true],
    ]);
    expect(b.actions[0].siteKey).toBeUndefined();
    expect(b.actions[2].siteKey).toBe("gmail");
    // An older log's action without a nav: counted with the site opens.
    expect(b.actions[2].nav).toBeUndefined();
    expect(b.dropped).toEqual([{ kind: "scroll", clauseIndex: 1 }]);
    expect(b.shape).toMatchObject({
      clauses: 4,
      commits: 4,
      supersededCommits: 0,
      navigations: 1,
      reissues: 0,
    });
    // The journal's open_url after the prelude is the repeat, counted once
    // though a request row of the same kind sits beside it; the early
    // open_app journaled while speaking is not one. No settle row: the run
    // did not wait.
    expect(b.run).toEqual({
      afterFinalMs: 300,
      streamedSteps: 3,
      dropped: 1,
      repeats: [{ kind: "open_url", afterMs: 1700 }],
      settled: false,
    });
    expect(b.modelRequestsBeforeFinal).toBe(1);
    expect(b.speculations).toBe(1);

    expect(c.clauses).toEqual([]);
    expect(c.actions).toEqual([]);
    expect(c.run).toBeUndefined();
    expect(d.outcome).toBe("voice_cancelled");
    expect(d.clauses).toEqual([]);

    // The correction: the drop names the earlier action of the index, the
    // reissue is kept, and each commit row carries the action issued off it.
    expect(e.clauses).toEqual([
      {
        index: 0,
        by: "boundary",
        words: 3,
        leadMs: 2100,
        toFinalMs: 2100,
        dropped: true,
      },
      {
        index: 0,
        by: "boundary",
        words: 3,
        leadMs: 1200,
        toFinalMs: 1200,
        dropped: false,
        superseded: true,
      },
    ]);
    expect(
      e.actions.map((x: any) => [x.siteKey, x.nav, x.kept, x.reissue ?? false]),
    ).toEqual([
      ["youtube", "home", false, false],
      ["gmail", "home", true, true],
    ]);
    expect(e.shape).toEqual({
      clauses: 1,
      commits: 2,
      supersededCommits: 1,
      commitsPerClause: [2],
      issuesPerClause: [2],
      navigations: 2,
      siteOpens: 2,
      queries: 0,
      reissues: 1,
    });
    expect(e.run).toEqual({
      afterFinalMs: 200,
      streamedSteps: 2,
      dropped: 1,
      repeats: [],
      settled: false,
    });
  });

  it("prints the same as text, and the last N turns only, still without the words", () => {
    const text = run(file);
    expect(text.status).toBe(0);
    expect(text.stdout).not.toContain(SENTINEL);
    const json = JSON.parse(run("--json", file).stdout);
    const f = json.summary.fastActions;
    expect(text.stdout).toContain(
      "Turns: 5 in 1 file(s); showing the last 5, 3 with a committed clause, 3 with a fast action, 3 whose run started with a prelude.",
    );
    expect(text.stdout).toContain(
      "Clauses: 9 committed (boundary 5, stable 4); words per clause p50 3; commit -> final n=9 p50 2100 ms p95 5000 ms.",
    );
    expect(text.stdout).toContain(
      "Once per thing asked: 7 clauses in 9 commits (2 re-commits); commits per clause p50 1 max 2; issues per clause p50 1 max 2; navigations per sentence p50 2 max 2 (3 site opens, 1 queries, 1 reissues); first capture settled in 1 of 3 runs (n=1 p50 60 ms p95 60 ms).",
    );
    expect(text.stdout).toContain(
      "Fast actions: 7 (open_url 5, open_app 1, scroll 1); 2 dropped by the final (29%); 1 of 3 runs repeated a streamed step (33%); 1 model requests before the final (1 speculative).",
    );
    expect(text.stdout).toContain(
      "#1 10:00:00 wake_detected  transcript_final; clauses 2 (3 commits, 1 re-commits), fast actions 2, navigations 2, dropped 0, prelude 2 steps, repeats 0",
    );
    expect(text.stdout).toContain(
      "   clause 0 by boundary, 3 words, lead 3450 ms, -> final 3450 ms: open_url youtube home decide 40 ms, issue 60 ms, commit -> request 100 ms; kept",
    );
    expect(text.stdout).toContain(
      "   clause 1 by stable, 3 words, lead 2150 ms, -> final 2150 ms: no fast action; kept",
    );
    expect(text.stdout).toContain(
      "   clause 1 by stable (re-commit), 4 words, lead 1950 ms, -> final 1950 ms: open_url youtube query decide 170 ms, issue 50 ms, commit -> issued 250 ms; kept",
    );
    expect(text.stdout).toContain(
      "   run 250 ms after the final with 2 streamed steps (0 dropped); no repeat; first capture settled 60 ms in",
    );
    expect(text.stdout).toContain(
      "#2 10:00:20 wake_detected  transcript_final; clauses 4, fast actions 3, navigations 1, dropped 1, prelude 3 steps, repeats 1",
    );
    expect(text.stdout).toContain(
      "   clause 1 by stable, 2 words, lead 3500 ms, -> final 3500 ms: scroll decide 20 ms, issue 60 ms, commit -> request 90 ms; dropped by the final",
    );
    expect(text.stdout).toContain(
      "   clause 3 by boundary, 3 words, lead 1000 ms, -> final 1000 ms: no fast action; kept",
    );
    expect(text.stdout).toContain(
      "   run 300 ms after the final with 3 streamed steps (1 dropped); repeated open_url 1700 ms in; first capture not settled",
    );
    expect(text.stdout).toContain(
      "   model requests before the final: 1 (1 speculative)",
    );
    expect(text.stdout).toContain(
      "#3 10:00:40 wake_detected  transcript_final; no streamed clause",
    );
    expect(text.stdout).toContain(
      "#4 10:01:00 wake_detected  voice_cancelled; no streamed clause",
    );
    expect(text.stdout).toContain(
      "#5 10:01:20 wake_detected  transcript_final; clauses 1 (2 commits, 1 re-commits), fast actions 2, navigations 2 (1 reissued), dropped 1, prelude 2 steps, repeats 0",
    );
    expect(text.stdout).toContain(
      "   clause 0 by boundary, 3 words, lead 2100 ms, -> final 2100 ms: open_url youtube home decide 10 ms, issue 60 ms, commit -> request 50 ms; dropped by the final",
    );
    expect(text.stdout).toContain(
      "   clause 0 by boundary (re-commit), 3 words, lead 1200 ms, -> final 1200 ms: open_url gmail home decide 10 ms, issue 70 ms, commit -> request 60 ms, reissued; kept",
    );
    // The summary's numbers are the JSON's.
    expect(text.stdout).toContain(
      `decideMs               n=${f.decideMs.n} p50 ${f.decideMs.p50} ms p95 ${f.decideMs.p95} ms`,
    );
    expect(text.stdout).toContain(
      `issueMs                n=${f.issueMs.n} p50 ${f.issueMs.p50} ms p95 ${f.issueMs.p95} ms`,
    );
    expect(text.stdout).toContain(
      `commit -> issue        n=${f.commitToIssueMs.n} p50 ${f.commitToIssueMs.p50} ms p95 ${f.commitToIssueMs.p95} ms  (target p50 <= 250 ms, p95 <= 600 ms for site opens: met; site opens n=6 p50 90 ms p95 480 ms; queries, held for the words n=1 p50 250 ms p95 250 ms; from a request 6, from the event 1)`,
    );
    expect(text.stdout).toContain(
      "fast actions per turn  p50 2 p95 3; turns with one 3 of 3 (100%)",
    );
    expect(text.stdout).toContain(
      "dropped                2 of 7 fast actions (29%)",
    );
    expect(text.stdout).toContain(
      "repeats                1 of 3 runs with a prelude (33%), 1 steps; run start after the final n=3 p50 250 ms p95 300 ms",
    );
    expect(text.stdout).toContain(
      "before the final       1 model requests (1 speculative) in 3 turns",
    );

    const last = run("--turns", "2", file);
    expect(last.status).toBe(0);
    expect(last.stdout).not.toContain(SENTINEL);
    expect(last.stdout).toContain(
      "showing the last 2, 1 with a committed clause, 1 with a fast action, 1 whose run started with a prelude.",
    );
    expect(last.stdout).toContain("#1 10:01:00 wake_detected  voice_cancelled");
    expect(last.stdout).toContain(
      "#2 10:01:20 wake_detected  transcript_final",
    );
    expect(last.stdout).not.toContain("10:00:00");
    const one = run("--turns", "1", "--json", join(root, "no-such.jsonl"));
    expect(one.status).toBe(2);
    // A window with no fast action: the target line says so.
    const cancelledOnly = JSON.parse(
      run("--json", "--turns", "1", file).stdout,
    );
    expect(cancelledOnly.summary.shown).toBe(1);
    expect(cancelledOnly.turns).toHaveLength(1);
    expect(cancelledOnly.summary.navigations).toEqual({
      total: 2,
      siteOpens: 2,
      queries: 0,
      reissues: 1,
      perTurn: { n: 1, p50: 2, max: 2 },
    });
    expect(cancelledOnly.summary.runs.settled).toBe(0);
    expect(cancelledOnly.summary.runs.settleWaitMs).toEqual({ n: 0 });
  });
});
