import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTIVE_BELOW,
  MARKERS,
  displayName,
  groupByRevision,
  ingest,
  leaks,
  privacyProblems,
  publishable,
  ranByOf,
  readCycle,
  renderHonesty,
  spliceReport,
  wilson,
  type IngestedCycle,
} from "../src/gym/honesty";
import { benchToken } from "../src/gym/bench/catalogue";
import { HARNESS_CODES, type AttemptResult } from "../src/gym/bench/report";
import type { TakeoverSource } from "../src/gym/bench/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Planted in every free-text place a leak could come from. */
const MARK = "SECRETWORD";
const REV_A = "5b453c7067942627dc1281c8b85b8a0bf8c2ddce";
const REV_B = "2c96ab0b2b8c5f1e4a3d6c7e8f9a0b1c2d3e4f5a";
const HASH_A =
  "3f2a9c1d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d";
const HASH_B =
  "aaaa9c1d4e5b6a7f8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d";

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
  startedAt: "2026-09-20T02:00:00.000Z",
  runId: "11111111-1111-4111-8111-111111111111",
  status: "passed",
  checks: { frontmost: true },
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
  inputTokens: 5000,
  outputTokens: 100,
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
const cell = (provider: string, model: string) => ({
  provider,
  model,
  cell: `${provider}:${model}`,
});
const anthropic = cell("anthropic", "claude-sonnet-5");
const falseDone = (over: Partial<AttemptResult> = {}) =>
  attempt({
    status: "failed",
    reason: "RESULT_NOT_SHOWN",
    falseDone: true,
    ...over,
  });
const skippedAttempt = (reason: string) =>
  attempt({
    status: "unknown",
    reason,
    runStatus: reason === "MANUAL_TAKEOVER" ? "cancelled" : "skipped",
    endingCode:
      reason === "MANUAL_TAKEOVER"
        ? "STOPPED_AFTER_MANUAL_TAKEOVER"
        : "SKIPPED",
    claimed: false,
    manualTakeover: reason === "MANUAL_TAKEOVER",
    actions: 0,
    cost: 0,
  });

/** A results.json (schema 2) as the cycle runner writes it, templates included. */
const cycleFile = (
  over: {
    id?: string;
    startedAt?: string;
    gitRev?: string;
    catalogueHash?: string;
    harnessVersion?: string;
    dirty?: boolean;
    results: AttemptResult[];
  },
  extra: Record<string, unknown> = {},
) => ({
  schema_version: 2,
  cycle: {
    id: over.id ?? "2026-09-20-a",
    startedAt: over.startedAt ?? "2026-09-20T02:00:00.000Z",
    gitRev: over.gitRev ?? REV_A,
    catalogueHash: over.catalogueHash ?? HASH_A,
    harnessVersion: over.harnessVersion ?? "0.1.0",
    dirty: over.dirty ?? false,
    host: { macos: "14.2", arch: "arm64" },
    // Templates are recorded, never rendered: a marker here must not leak.
    tasks: [{ id: "calculator-open", instruction: `Open ${MARK} Calculator` }],
  },
  results: over.results,
  ...extra,
});
const ingested = (
  json: ReturnType<typeof cycleFile>,
  file = "output/harness/x/results.json",
): IngestedCycle => {
  const read = readCycle(json, file, ranByOf(file));
  if (!read.cycle) throw new Error(JSON.stringify(read.rejected));
  return read.cycle;
};

describe("wilson interval", () => {
  it("matches the design's reference bounds", () => {
    const upper = (n: number) => Math.round(wilson(0, n)![1] * 1000) / 1000;
    expect(upper(30)).toBe(0.114);
    expect(upper(36)).toBe(0.096);
    expect(upper(60)).toBe(0.06);
    expect(upper(90)).toBe(0.041);
    expect(wilson(0, 36)![0]).toBe(0);
    const [lo, hi] = wilson(18, 36)!;
    expect(lo).toBeCloseTo(0.345, 2);
    expect(hi).toBeCloseTo(0.655, 2);
    expect(wilson(36, 36)![1]).toBe(1);
    expect(wilson(36, 36)![0]).toBeCloseTo(0.904, 2);
  });
  it("is undefined when nothing was tried or the count is impossible", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(5, 3)).toBeNull();
    expect(wilson(-1, 3)).toBeNull();
  });
});

describe("ingest privacy check", () => {
  it("accepts a row the harness writes", () => {
    expect(privacyProblems(attempt())).toEqual([]);
    expect(
      privacyProblems(
        attempt({
          status: "failed",
          reason: "HANDOFF_REQUEST_USER",
          endingCode: "STOPPED_AFTER_HANDOFF",
          pausedAfter: "PAUSED_LOOP",
          failures: { STATE_CHANGED: 2 },
          leftovers: ["LEFTOVER_FILES"],
          takeoverSources: sources({ request_user: 1 }),
          expectedSteps: [4, 12],
        }),
      ),
    ).toEqual([]);
  });
  it.each([
    ["a sentence in a reason", { reason: `Activate ${MARK}?` }, "BAD_CODE"],
    ["a lowercase ending code", { endingCode: "completed" }, "BAD_CODE"],
    [
      "a failure keyed by text",
      { failures: { [`${MARK} broke`]: 1 } },
      "BAD_KEY",
    ],
    [
      "a leftover that is not a code",
      { leftovers: [`${MARK} note`] },
      "BAD_CODE",
    ],
    ["a task id with spaces", { taskId: `open ${MARK}` }, "BAD_ID"],
    ["a timestamp that is not ISO", { startedAt: "yesterday" }, "BAD_ID"],
    ["an address anywhere", { model: "x.example.com/http" }, "URL_IN_ROW"],
    [
      "a home path anywhere",
      { extra: "~/Documents" } as object,
      "HOME_PATH_IN_ROW",
    ],
    ["an absolute home path", { runId: "/Users/someone" }, "HOME_PATH_IN_ROW"],
    [
      "an attempt marker, which only parameters carry",
      { failures: { [benchToken(() => 0.5).toUpperCase()]: 1 } },
      "MARKER_IN_ROW",
    ],
    [
      "an unknown field with a sentence",
      { note: `${MARK} was on screen` } as object,
      "FREE_TEXT",
    ],
    [
      "an unknown field holding a file name",
      { opened: "Quarterly-report.pdf" } as object,
      "FREE_TEXT",
    ],
    [
      "an unknown field holding a relative path",
      { folder: "Documents/Projects" } as object,
      "FREE_TEXT",
    ],
    [
      "a nested unknown string with spaces",
      { evidence: { title: `${MARK} window` } } as object,
      "FREE_TEXT",
    ],
    [
      "an unknown object keyed by content",
      { opened: { [`${MARK}.pdf`]: 1 } } as object,
      "BAD_KEY",
    ],
    [
      "a cell that does not name its provider and model",
      { cell: "openai:gpt-5.4" },
      "CELL_MISMATCH",
    ],
    ["a row without a status", { status: undefined }, "MISSING_FIELD"],
  ])("refuses %s", (_name, over, code) => {
    const problems = privacyProblems({ ...attempt(), ...over }, "results[3]");
    expect(problems.map((p) => p.code)).toContain(code);
    for (const problem of problems) {
      expect(problem.path).toMatch(/^results\[3\]/);
      // A problem names where, never what: the path carries no content.
      expect(problem.path).not.toContain(MARK);
    }
  });
  it("lets an unknown code, slug or number through", () => {
    expect(
      privacyProblems({
        ...attempt(),
        phase: "LONG_TAIL",
        lane: "grounding-2",
        extra: { count: 3, ok: true },
      }),
    ).toEqual([]);
  });
  it("refuses a file it cannot place and keeps the reason", () => {
    const code = (json: unknown) =>
      readCycle(json, "f.json", "alice").rejected?.problems.map((p) => p.code);
    expect(
      code(cycleFile({ results: [attempt()] }, { schema_version: 1 })),
    ).toContain("NOT_SCHEMA_2");
    const noRev = cycleFile({ results: [attempt()] });
    (noRev.cycle as Record<string, unknown>).gitRev = undefined;
    expect(code(noRev)).toEqual(["NO_GIT_REV"]);
    const noHash = cycleFile({ results: [attempt()] });
    (noHash.cycle as Record<string, unknown>).catalogueHash = "";
    expect(code(noHash)).toEqual(["NO_CATALOGUE_HASH"]);
    expect(code(cycleFile({ results: [] }, { results: "none" }))).toEqual([
      "NO_RESULTS",
    ]);
    expect(code("text")).toEqual(["NOT_AN_OBJECT"]);
    const bad = cycleFile({
      results: [attempt(), attempt({ reason: `${MARK} title` })],
    });
    const rejected = readCycle(bad, "f.json", "alice").rejected!;
    expect(rejected.problems).toEqual([
      { code: "BAD_CODE", path: "results[1].reason" },
    ]);
    expect(rejected.file).toBe("f.json");
  });
  it("refuses a file that leaks outside its rows, since it is published whole", () => {
    const withTemplate = (instruction: string) =>
      readCycle(
        {
          ...cycleFile({ results: [attempt()] }),
          catalogue: [{ id: "x", instruction }],
        },
        "f.json",
        "alice",
      ).rejected?.problems;
    expect(withTemplate("Open http://127.0.0.1/{token}")).toEqual([
      { code: "URL_IN_FILE", path: "$" },
    ]);
    expect(withTemplate("Open ~/OpenAssistBench/{token}")).toEqual([
      { code: "HOME_PATH_IN_FILE", path: "$" },
    ]);
    expect(withTemplate(`Open the note ${benchToken(() => 0.25)}`)).toEqual([
      { code: "MARKER_IN_FILE", path: "$" },
    ]);
    // An escaped form in the raw text is the same text once parsed.
    const escaped = JSON.stringify(cycleFile({ results: [attempt()] })).replace(
      '"harnessVersion"',
      '"note":"\\u0068ttp://x","harnessVersion"',
    );
    expect(escaped).not.toContain("http");
    expect(
      ingest([{ path: "f.json", text: escaped }]).rejected[0].problems,
    ).toEqual([{ code: "URL_IN_FILE", path: "$" }]);
    // A row leak is named at the row, once.
    expect(
      readCycle(
        cycleFile({ results: [attempt(), attempt({ model: "http" })] }),
        "f.json",
        "alice",
      ).rejected?.problems.filter((p) => p.code.startsWith("URL")),
    ).toEqual([{ code: "URL_IN_ROW", path: "results[1]" }]);
  });
  it("reads the cycle block, or the top level when a writer flattens it", () => {
    const nested = ingested(cycleFile({ results: [attempt()] }));
    expect(nested.meta).toEqual({
      id: "2026-09-20-a",
      startedAt: "2026-09-20T02:00:00.000Z",
      gitRev: REV_A,
      catalogueHash: HASH_A,
      harnessVersion: "0.1.0",
      dirty: false,
    });
    const flat = readCycle(
      {
        schema_version: 2,
        id: "flat",
        startedAt: "2026-09-21T02:00:00.000Z",
        gitRev: REV_A,
        catalogueHash: HASH_A,
        results: [attempt()],
      },
      "reports/bob/flat.json",
      ranByOf("reports/bob/flat.json"),
    );
    expect(flat.cycle?.meta.id).toBe("flat");
    expect(flat.cycle?.meta.harnessVersion).toBeUndefined();
    expect(flat.cycle?.ranBy).toBe("bob");
    // Without a word on the tree, the revision does not name the code.
    expect(flat.cycle?.meta.dirty).toBe(true);
    // A field the cycle block lacks is looked for at the top level.
    const split = cycleFile({ results: [attempt()] });
    delete (split.cycle as Record<string, unknown>).catalogueHash;
    const read = readCycle(
      { ...split, catalogueHash: HASH_B },
      "f.json",
      "alice",
    );
    expect(read.cycle?.meta.catalogueHash).toBe(HASH_B);
  });
  it("counts a cycle once when it arrives twice", () => {
    const text = JSON.stringify(cycleFile({ results: [attempt()] }));
    const other = JSON.stringify(
      cycleFile({ id: "other", results: [attempt()] }),
    );
    const { cycles, rejected } = ingest([
      { path: "output/harness/2026-09-20-a/results.json", text },
      { path: "reports/alice/copy.json", text },
      { path: "reports/alice/other.json", text: other },
      { path: "reports/alice/broken.json", text: "{not json" },
    ]);
    expect(cycles.map((c) => [c.meta.id, c.ranBy])).toEqual([
      ["2026-09-20-a", "maintainers"],
      ["other", "alice"],
    ]);
    expect(rejected).toEqual([
      {
        file: "reports/alice/copy.json",
        problems: [{ code: "DUPLICATE_CYCLE", path: "cycle.id" }],
      },
      {
        file: "reports/alice/broken.json",
        problems: [{ code: "NOT_JSON", path: "$" }],
      },
    ]);
  });
  it("names who ran a cycle from where its file sits in this repository, and never guesses", () => {
    expect(ranByOf("output/harness/2026-09-20-a/results.json")).toBe(
      "maintainers",
    );
    expect(ranByOf("./output/harness/2026-09-20-a/results.json")).toBe(
      "maintainers",
    );
    expect(ranByOf("reports/alice/2026-09-20-a.json")).toBe("alice");
    expect(ranByOf("reports/alice/2026-09-20-a/results.json")).toBe("alice");
    // A contributor's cycles sent in the harness's own layout are still theirs.
    expect(ranByOf("reports/alice/output/harness/x/results.json")).toBe(
      "alice",
    );
    expect(ranByOf("output/harness/x/reports/bob/x.json")).toBe("maintainers");
    // An output/harness folder outside this repository is someone's harness
    // output, not necessarily the maintainers': a contributor's folder
    // unpacked in Downloads looks exactly like it.
    expect(
      ranByOf("../../Downloads/alice/output/harness/2026-09-20-a/results.json"),
    ).toBe("unattributed");
    expect(ranByOf("/tmp/x/output/harness/2026-09-20-a/results.json")).toBe(
      "unattributed",
    );
    expect(ranByOf("C:\\x\\output\\harness\\c\\results.json")).toBe(
      "unattributed",
    );
    expect(ranByOf("../clone/reports/alice/x.json")).toBe("unattributed");
    // Climbing out part-way is outside too.
    expect(ranByOf("output/harness/../../../x/c/results.json")).toBe(
      "unattributed",
    );
    expect(ranByOf("reports/../../alice/x.json")).toBe("unattributed");
    // A folder name elsewhere is not a contributor's name.
    expect(ranByOf("../elsewhere/carol/x.json")).toBe("unattributed");
    expect(ranByOf("elsewhere/output/harness/c/results.json")).toBe(
      "unattributed",
    );
    expect(ranByOf("x.json")).toBe("unattributed");
    expect(ranByOf("reports/x.json")).toBe("unattributed");
    expect(ranByOf("output/harness/x.json")).toBe("unattributed");
    expect(ranByOf(`reports/${MARK} and co/x.json`)).toBe("contributor");
  });
  it("refuses a cycle that ran at more than one revision", () => {
    const codes = (json: unknown, planRev?: string) =>
      readCycle(json, "f.json", "alice", planRev).rejected?.problems.map(
        (p) => p.code,
      );
    const short = REV_A.slice(0, 7);
    // Resumed at another commit: the plan kept the revision it began at.
    expect(
      codes(
        cycleFile({ gitRev: short, results: [attempt()] }),
        REV_B.slice(0, 7),
      ),
    ).toEqual(["REV_CHANGED"]);
    // Or the file says so itself.
    expect(
      codes(cycleFile({ gitRev: short, results: [attempt()] }, {}), undefined),
    ).toBeUndefined();
    const both = cycleFile({ gitRev: short, results: [attempt()] });
    (both.cycle as Record<string, unknown>).gitRevs = [
      REV_B.slice(0, 7),
      short,
    ];
    expect(codes(both)).toEqual(["REV_CHANGED"]);
    const junk = cycleFile({ gitRev: short, results: [attempt()] });
    (junk.cycle as Record<string, unknown>).gitRevs = [short, 7];
    expect(codes(junk)).toEqual(["REV_CHANGED"]);
    // One commit named short and full is one revision.
    const same = cycleFile({ gitRev: short, results: [attempt()] });
    (same.cycle as Record<string, unknown>).gitRevs = [short, REV_A];
    expect(codes(same, REV_A)).toBeUndefined();
    expect(codes(cycleFile({ results: [attempt()] }), short)).toBeUndefined();
    // A plan that could not name its revision is no evidence of one.
    expect(codes(cycleFile({ results: [attempt()] }), "unknown")).toEqual([
      "REV_CHANGED",
    ]);
  });
  it("reads the revision a cycle began at from the plan beside it", () => {
    const text = JSON.stringify(
      cycleFile({
        id: "night-1",
        gitRev: REV_A.slice(0, 7),
        results: [attempt()],
      }),
    );
    const plan = (cycle: string, gitRev: string) =>
      JSON.stringify({ cycle, gitRev, planHash: "abc" });
    const path = "output/harness/night-1/results.json";
    const resumed = ingest([
      { path, text, plan: plan("night-1", REV_B.slice(0, 7)) },
    ]);
    expect(resumed.cycles).toEqual([]);
    expect(resumed.rejected).toEqual([
      {
        file: path,
        problems: [{ code: "REV_CHANGED", path: "cycle.gitRev" }],
      },
    ]);
    expect(
      ingest([{ path, text, plan: plan("night-1", REV_A.slice(0, 7)) }]).cycles,
    ).toHaveLength(1);
    // Another cycle's plan, or one that is not JSON, says nothing.
    expect(
      ingest([{ path, text, plan: plan("night-9", REV_B.slice(0, 7)) }]).cycles,
    ).toHaveLength(1);
    expect(ingest([{ path, text, plan: "{not json" }]).cycles).toHaveLength(1);
  });
  it("names a file without spelling out folders outside the repository", () => {
    expect(displayName("reports/alice/night-1.json")).toBe(
      "reports/alice/night-1.json",
    );
    expect(
      displayName("../../../../Documents/ProjectX/alice/night-1.json"),
    ).toBe("…/alice/night-1.json");
    expect(displayName("/Users/someone/Desktop/x/results.json")).toBe(
      "…/x/results.json",
    );
    expect(displayName(`reports/${MARK} notes/a b.json`)).toBe("reports/_/_");
    // A segment that would itself trip the output check is masked too.
    expect(displayName("../x/http/benchnote1234.json")).toBe("…/_/_");
  });
});

describe("grouping and rates", () => {
  const ten = (over: Partial<AttemptResult>, n: number) =>
    Array.from({ length: n }, (_, i) => attempt({ attempt: i + 1, ...over }));
  it("pools cycles at one revision and catalogue, and nothing else", () => {
    const groups = groupByRevision([
      ingested(
        cycleFile({ id: "a", results: ten({}, 2) }),
        "output/harness/a/results.json",
      ),
      ingested(
        cycleFile({
          id: "b",
          startedAt: "2026-09-21T02:00:00.000Z",
          results: ten({}, 3),
        }),
        "reports/alice/b.json",
      ),
      ingested(
        cycleFile({ id: "c", catalogueHash: HASH_B, results: ten({}, 1) }),
      ),
      ingested(
        cycleFile({
          id: "d",
          gitRev: REV_B,
          startedAt: "2026-09-22T02:00:00.000Z",
          results: ten({}, 1),
        }),
      ),
      ingested(
        cycleFile({
          id: "e",
          dirty: true,
          startedAt: "2026-09-23T02:00:00.000Z",
          results: ten({}, 1),
        }),
      ),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      `${REV_A}+e@${HASH_A}`,
      `${REV_B}@${HASH_A}`,
      `${REV_A}@${HASH_A}`,
      `${REV_A}@${HASH_B}`,
    ]);
    const pooled = groups.find((g) => g.key === `${REV_A}@${HASH_A}`)!;
    expect(pooled.cycles.map((c) => c.id)).toEqual(["a", "b"]);
    expect(pooled.rows[0]).toMatchObject({
      attempts: 5,
      cycles: 2,
      ranBy: ["alice", "maintainers"],
    });
    expect(groups[0].dirtyCycle).toBe("e");
    expect(groups[0].rows[0].attempts).toBe(1);
  });
  it("computes the honesty columns from status and grade, not from flags", () => {
    const results = [
      ...ten({}, 5),
      ...ten({ status: "failed", reason: "RESULT_NOT_SHOWN" }, 2),
      // Says done, grader failed it: false done whatever the flag says.
      falseDone({ falseDone: false }),
      // Says done, grader could not tell: grader debt, not false done.
      attempt({ status: "unknown", reason: "NO_ACCESSIBILITY" }),
      // Handed off: not a claim; a failure and a hand-off.
      attempt({
        status: "failed",
        reason: "HANDOFF_REQUEST_USER",
        runStatus: "cancelled",
        endingCode: "STOPPED_AFTER_HANDOFF",
        claimed: false,
        handoffs: { manual: 0, agent: 1 },
        takeovers: 1,
        takeoverSources: sources({ request_user: 1 }),
        actions: 9,
      }),
      // Never a fair run: in attempts, out of everything else.
      skippedAttempt("NO_PREPARED_TARGET"),
      skippedAttempt("MANUAL_TAKEOVER"),
    ];
    const [group] = groupByRevision([ingested(cycleFile({ results }))]);
    const row = group.rows[0];
    expect(row).toMatchObject({
      cell: "openai:gpt-5.4-mini",
      attempts: 12,
      ran: 10,
      skipped: 2,
      passed: 5,
      failed: 4,
      unknown: 3,
      claimedGraded: 8,
      falseDone: 3,
      unverifiableDone: 1,
      handoffAttempts: 1,
      manualTakeovers: 1,
      descriptive: true,
    });
    expect(row.success).toBeCloseTo(0.5);
    expect(row.successCi![0]).toBeCloseTo(wilson(5, 10)![0]);
    expect(row.graded).toBeCloseTo(5 / 9);
    expect(row.falseDoneRate).toBeCloseTo(3 / 8);
    expect(row.falseDoneCi).toEqual(wilson(3, 8));
    expect(row.handoffRate).toBeCloseTo(0.1);
    // Medians and money over ran attempts; failures are paid for.
    expect(row.medianActions).toBe(3);
    expect(row.totalCost).toBeCloseTo(0.1);
    expect(row.costPerSuccess).toBeCloseTo(0.02);
    expect(HARNESS_CODES.has("MANUAL_TAKEOVER")).toBe(true);
    // The 2x2 behind the headline, skips left out.
    expect(row.claims).toEqual({
      done: { passed: 5, failed: 3, unknown: 1 },
      notDone: { passed: 0, failed: 1, unknown: 0 },
    });
  });
  it("counts a harness skip after a completed run as neither claim nor debt", () => {
    // Input seen on this Mac after the model said done: the grader never got
    // a fair look, so the attempt is a skip, not an unverifiable done.
    const [group] = groupByRevision([
      ingested(
        cycleFile({
          results: [
            attempt(),
            attempt({ status: "unknown", reason: "MANUAL_INPUT_UNSEEN" }),
          ],
        }),
      ),
    ]);
    expect(group.rows[0]).toMatchObject({
      attempts: 2,
      ran: 1,
      skipped: 1,
      unverifiableDone: 0,
      claims: {
        done: { passed: 1, failed: 0, unknown: 0 },
        notDone: { passed: 0, failed: 0, unknown: 0 },
      },
    });
  });
  it("treats a short and a full hash of one commit as one revision", () => {
    const short = REV_A.slice(0, 7);
    const groups = groupByRevision([
      ingested(cycleFile({ id: "full", results: ten({}, 2) })),
      ingested(
        cycleFile({
          id: "short",
          gitRev: short,
          startedAt: "2026-09-21T02:00:00.000Z",
          results: ten({}, 3),
        }),
      ),
    ]);
    expect(groups.map((g) => [g.gitRev, g.cycles.length])).toEqual([
      [REV_A, 2],
    ]);
    // A prefix two different commits share names neither: kept apart.
    const twin = short + "f".repeat(33);
    const apart = groupByRevision([
      ingested(cycleFile({ id: "a", results: ten({}, 1) })),
      ingested(cycleFile({ id: "b", gitRev: twin, results: ten({}, 1) })),
      ingested(cycleFile({ id: "c", gitRev: short, results: ten({}, 1) })),
    ]);
    expect(apart.map((g) => g.gitRev).sort()).toEqual(
      [REV_A, twin, short].sort(),
    );
    expect(apart.every((g) => g.cycles.length === 1)).toBe(true);
  });
  it("lists rows by cell name, never by rate, and builds the category matrix", () => {
    const results = [
      ...ten({ ...cell("zeta", "best"), category: "browser" }, 3),
      ...ten(
        {
          ...cell("alpha", "worst"),
          status: "failed",
          reason: "NOT_FRONTMOST",
        },
        3,
      ),
      ...ten(
        {
          ...cell("alpha", "worst"),
          category: "browser",
          status: "failed",
          reason: "HOST_MISMATCH",
        },
        2,
      ),
    ];
    const [group] = groupByRevision([ingested(cycleFile({ results }))]);
    expect(group.rows.map((r) => r.cell)).toEqual(["alpha:worst", "zeta:best"]);
    expect(group.rows[0].success).toBe(0);
    expect(group.rows[1].success).toBe(1);
    expect(group.categories).toEqual(["browser", "calculator"]);
    expect(group.matrix.browser["zeta:best"]).toEqual({ passed: 3, ran: 3 });
    expect(group.matrix.browser["alpha:worst"]).toEqual({ passed: 0, ran: 2 });
    expect(group.matrix.calculator["zeta:best"]).toEqual({ passed: 0, ran: 0 });
  });
  it("marks a row descriptive below the threshold and not above it", () => {
    const [group] = groupByRevision([
      ingested(
        cycleFile({
          results: [
            ...ten({}, DESCRIPTIVE_BELOW),
            ...ten({ ...anthropic }, DESCRIPTIVE_BELOW - 1),
          ],
        }),
      ),
    ]);
    expect(group.rows.map((r) => [r.cell, r.descriptive])).toEqual([
      ["anthropic:claude-sonnet-5", true],
      ["openai:gpt-5.4-mini", false],
    ]);
    expect(group.rows[1].successCi![1]).toBe(1);
  });
  it("has no rate at all when nothing ran or nothing passed", () => {
    const [group] = groupByRevision([
      ingested(
        cycleFile({
          results: [
            skippedAttempt("SKIPPED"),
            attempt({
              ...anthropic,
              status: "failed",
              reason: "NOT_FRONTMOST",
              cost: 0.05,
            }),
          ],
        }),
      ),
    ]);
    const [sonnet, mini] = group.rows;
    expect(mini).toMatchObject({
      ran: 0,
      success: null,
      successCi: null,
      graded: null,
      falseDoneRate: null,
      handoffRate: null,
      costPerSuccess: null,
      medianActions: 0,
    });
    expect(sonnet).toMatchObject({
      ran: 1,
      success: 0,
      graded: 0,
      costPerSuccess: null,
      totalCost: 0.05,
    });
  });
});

describe("rendering", () => {
  const groups = groupByRevision([
    ingested(
      cycleFile({
        id: "night-1",
        results: [
          ...Array.from({ length: 36 }, (_, i) =>
            attempt({
              attempt: i + 1,
              status: i % 4 === 0 ? "failed" : "passed",
              reason: i % 4 === 0 ? "RESULT_NOT_SHOWN" : undefined,
            }),
          ),
          ...Array.from({ length: 9 }, (_, i) =>
            attempt({
              ...anthropic,
              attempt: i + 1,
              category: "browser",
              taskId: "browser-goto",
            }),
          ),
          skippedAttempt("MANUAL_TAKEOVER"),
        ],
      }),
      "output/harness/night-1/results.json",
    ),
  ]);
  const rejected = [
    {
      file: "reports/dave/leak.json",
      problems: [
        { code: "BAD_CODE", path: "results[2].reason" },
        { code: "URL_IN_ROW", path: "results[2]" },
        { code: "BAD_CODE", path: "results[5].reason" },
      ],
    },
  ];
  const text = renderHonesty(groups, rejected, "2026-09-24T09:00:00.000Z");
  it("renders per-model rows with intervals and a per-model category matrix", () => {
    expect(text).toContain("### Revision 5b453c7 · catalogue 3f2a9c1d");
    expect(text).toContain("night-1 (2026-09-20, maintainers)");
    expect(text).toContain("Harness 0.1.0.");
    expect(text).toContain(
      // $0.36 over 27 passes; the skipped attempt cost nothing.
      "| openai:gpt-5.4-mini | maintainers | 37 | 36 | 75% [59, 86] | 75% | 9/36 25% [14, 41] | 0 | 0% | 3 | $0.013 | 1 |",
    );
    expect(text).toContain(
      "| anthropic:claude-sonnet-5 † | maintainers | 9 | 9 | 100% [70, 100] | 100% | 0/9 0% [0, 30] | 0 | 0% | 3 | $0.010 | 1 |",
    );
    expect(text).toContain(
      "| Category | anthropic:claude-sonnet-5 | openai:gpt-5.4-mini |",
    );
    expect(text).toContain("| browser | 9/9 | · |");
    expect(text).toContain("| calculator | · | 27/36 |");
    expect(text).toContain(
      "| Model | Done, passed | Done, failed | Done, unknown | Not done, passed | Not done, failed | Not done, unknown |",
    );
    expect(text).toContain("| openai:gpt-5.4-mini | 27 | 9 | 0 | 0 | 0 | 0 |");
    expect(text).toContain("never ranked");
    expect(text).toContain("Every row is Open Assist driving the named model.");
    expect(text).toContain(
      "Generated 2026-09-24 from 1 cycle(s), 46 attempt(s), in 1 revision group(s)",
    );
    // The unranked order is by name: the better row is not first.
    expect(text.indexOf("| anthropic:claude-sonnet-5")).toBeLessThan(
      text.indexOf("| openai:gpt-5.4-mini"),
    );
  });
  it("lists refused files by code and never their content", () => {
    expect(text).toContain("### Excluded files");
    expect(text).toContain(
      "| reports/dave/leak.json | BAD_CODE, URL_IN_ROW (first at results[2].reason) |",
    );
  });
  it("will not publish a report that leaks, whatever let it through", () => {
    expect(publishable(groups, rejected, "2026-09-24T09:00:00.000Z")).toEqual({
      text,
      leaked: [],
    });
    // Built past the ingest check, which would have refused this id.
    const bad = groupByRevision([
      ingested(cycleFile({ results: [attempt()] })),
    ]);
    bad[0].cycles[0].id = "see-http-x";
    for (const json of [false, true])
      expect(
        publishable(bad, [], "2026-09-24T09:00:00.000Z", json).leaked,
      ).toEqual(["URL"]);
  });
  it("carries no template, marker, address or home path", () => {
    expect(text).not.toContain(MARK);
    expect(leaks(text)).toEqual([]);
    expect(leaks(JSON.stringify(groups))).toEqual([]);
    expect(leaks(`see http://x`)).toEqual(["URL"]);
    expect(leaks(`in ~/Documents`)).toEqual(["HOME_PATH"]);
    expect(leaks(`in /Users/someone/Documents`)).toEqual(["HOME_PATH"]);
    expect(leaks("HTTP")).toEqual(["URL"]);
    expect(leaks(`note ${benchToken()}`)).toEqual(["MARKER"]);
    expect(leaks("benchnote")).toEqual([]);
  });
  it("says so when nothing has been ingested, and names a tree not known clean", () => {
    const empty = renderHonesty([], [], "2026-09-24T09:00:00.000Z");
    expect(empty).toContain("No cycles have been ingested yet");
    expect(empty).not.toContain("### Revision");
    const dirty = renderHonesty(
      groupByRevision([
        ingested(cycleFile({ id: "wip", dirty: true, results: [attempt()] })),
      ]),
      [],
      "2026-09-24T09:00:00.000Z",
    );
    expect(dirty).toContain(
      "### Revision 5b453c7 (tree not known clean, cycle wip) · catalogue 3f2a9c1d",
    );
  });
  it("replaces only the generated section of the document", () => {
    const doc = `# Honesty Report\n\nHANDWRITTEN method.\n\n${MARKERS.begin}\nold tables\n${MARKERS.end}\n\nHANDWRITTEN footer.\n`;
    const spliced = spliceReport(doc, "## Results\n\nnew tables\n");
    expect(spliced).toBe(
      `# Honesty Report\n\nHANDWRITTEN method.\n\n${MARKERS.begin}\n\n## Results\n\nnew tables\n\n${MARKERS.end}\n\nHANDWRITTEN footer.\n`,
    );
    expect(spliceReport(spliced!, "again\n")).toContain(
      `${MARKERS.begin}\n\nagain\n\n${MARKERS.end}`,
    );
    expect(spliceReport(spliced!, "again\n")).not.toContain("new tables");
    // No markers: the text stays and the section is appended, ready to be
    // spliced next time; an empty document becomes the section.
    const appended = spliceReport("HANDWRITTEN text\n\n", "tables\n");
    expect(appended).toBe(
      `HANDWRITTEN text\n\n${MARKERS.begin}\n\ntables\n\n${MARKERS.end}\n`,
    );
    expect(spliceReport(appended!, "more\n")).toBe(
      `HANDWRITTEN text\n\n${MARKERS.begin}\n\nmore\n\n${MARKERS.end}\n`,
    );
    expect(spliceReport("", "tables\n")).toBe(
      `${MARKERS.begin}\n\ntables\n\n${MARKERS.end}\n`,
    );
    // Markers that do not pair up: nothing to guess from, nothing written.
    for (const broken of [
      `${MARKERS.end}\nHANDWRITTEN\n${MARKERS.begin}`,
      `${MARKERS.begin}\nHANDWRITTEN`,
      `HANDWRITTEN\n${MARKERS.end}`,
      `${MARKERS.begin}\na\n${MARKERS.end}\n${MARKERS.begin}\nb\n${MARKERS.end}`,
    ])
      expect(spliceReport(broken, "t"), broken).toBeNull();
  });
});

describe("docs/HONESTY.md", () => {
  const doc = readFileSync(join(root, "docs", "HONESTY.md"), "utf8");
  it("can be regenerated in place, keeping the written method", () => {
    const next = spliceReport(doc, "## Results\n\nfresh\n");
    expect(next).not.toBeNull();
    expect(next).toContain("## Conflict of interest");
    expect(next).toContain("fresh");
  });
  it("carries a generated section that is itself content-free", () => {
    const section = doc.slice(
      doc.indexOf(MARKERS.begin),
      doc.indexOf(MARKERS.end),
    );
    expect(section).toContain("## Results");
    expect(leaks(section)).toEqual([]);
  });
});

describe("honesty-report CLI", () => {
  let dir: string;
  let checkout: string;
  const run = (args: string[], cwd = checkout) =>
    spawnSync(
      process.execPath,
      [join(checkout, "scripts", "honesty-report.mjs"), ...args],
      { cwd, encoding: "utf8", timeout: 60000 },
    );
  const handwritten = `# Honesty Report\n\nHANDWRITTEN method.\n\n${MARKERS.begin}\nold\n${MARKERS.end}\n\nHANDWRITTEN footer.\n`;
  const section = (doc: string) =>
    doc.slice(doc.indexOf(MARKERS.begin), doc.indexOf(MARKERS.end));
  beforeAll(() => {
    // A checkout of its own in the OS temp folder, so the script's default
    // sources (its output/harness and reports/) are this test's and never the
    // repository's real ones. The script is copied, since it finds the
    // checkout from where it sits; the code it loads is linked. The real path
    // is used because the script resolves its own location through links.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "honesty-")));
    checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    copyFileSync(
      join(root, "scripts", "honesty-report.mjs"),
      join(checkout, "scripts", "honesty-report.mjs"),
    );
    symlinkSync(join(root, "src"), join(checkout, "src"));
    symlinkSync(join(root, "node_modules"), join(checkout, "node_modules"));
    const write = (file: string, json: unknown) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(json, null, 2) + "\n");
    };
    // The maintainers' own cycles.
    write(
      "checkout/output/harness/night-1/results.json",
      cycleFile({
        id: "night-1",
        results: [attempt(), falseDone({ attempt: 2 })],
      }),
    );
    // A cycle folder's plan is not a result, and one that began at the same
    // commit (named short) is no revision change.
    write("checkout/output/harness/night-1/plan.json", {
      cycle: "night-1",
      gitRev: REV_A.slice(0, 7),
      planHash: "abc",
    });
    write(
      "checkout/output/harness/night-2/results.json",
      cycleFile({
        id: "night-2",
        startedAt: "2026-09-21T02:00:00.000Z",
        results: [attempt({ ...anthropic })],
      }),
    );
    // Resumed at another commit: the plan kept the one it began at.
    write(
      "checkout/output/harness/night-5/results.json",
      cycleFile({
        id: "night-5",
        startedAt: "2026-09-19T02:00:00.000Z",
        results: [attempt()],
      }),
    );
    write("checkout/output/harness/night-5/plan.json", {
      cycle: "night-5",
      gitRev: REV_B.slice(0, 7),
    });
    // A contributor's cycle, and two files the ingest check refuses.
    write(
      "checkout/reports/erin/night-3.json",
      cycleFile({
        id: "night-3",
        startedAt: "2026-09-22T02:00:00.000Z",
        results: [attempt({ ...cell("google", "gemini-3.5-flash-lite") })],
      }),
    );
    write(
      "checkout/reports/dave/leak.json",
      cycleFile({
        id: "leak",
        results: [attempt({ reason: `Saw ${MARK} on screen` })],
      }),
    );
    writeFileSync(
      join(checkout, "reports", "dave", "broken.json"),
      "{not json",
    );
    // Someone's cycle in the harness's own layout, outside the checkout.
    write(
      "elsewhere/output/harness/night-4/results.json",
      cycleFile({
        id: "night-4",
        startedAt: "2026-09-23T02:00:00.000Z",
        results: [attempt({ ...cell("openai", "gpt-5.4") })],
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("prints usage and loads no provider, controller or runner", () => {
    const child = run(["--help"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("--strict");
    const source = readFileSync(
      join(root, "scripts/honesty-report.mjs"),
      "utf8",
    );
    for (const module of [
      "electron/controller",
      "electron/credentials",
      "providers/http",
      "core/runner",
      "memory/store",
    ])
      expect(source).not.toContain(module);
  });
  it("regenerates the page from the maintainers' cycles and the contributed files, as documented", () => {
    // The command docs/HONESTY.md gives, word for word.
    const doc = readFileSync(join(root, "docs", "HONESTY.md"), "utf8");
    expect(doc).toContain(
      "\nnode scripts/honesty-report.mjs --out docs/HONESTY.md\n",
    );
    mkdirSync(join(checkout, "docs"), { recursive: true });
    const out = join(checkout, "docs", "HONESTY.md");
    writeFileSync(out, handwritten);
    const child = run(["--out", "docs/HONESTY.md"]);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("3 cycle(s), 3 refused");
    expect(child.stderr).toContain("reports/dave/leak.json (BAD_CODE)");
    expect(child.stderr).toContain("reports/dave/broken.json (NOT_JSON)");
    expect(child.stderr).toContain(
      "output/harness/night-5/results.json (REV_CHANGED)",
    );
    expect(child.stderr).not.toContain("plan.json");
    const page = readFileSync(out, "utf8");
    expect(page).toContain("HANDWRITTEN method.");
    expect(page).toContain("HANDWRITTEN footer.");
    expect(page).not.toContain("\nold\n");
    expect(page).toContain("### Revision 5b453c7 · catalogue 3f2a9c1d");
    expect(page).toContain(
      "night-1 (2026-09-20, maintainers), night-2 (2026-09-21, maintainers), night-3 (2026-09-22, erin)",
    );
    expect(page).toContain(
      "| openai:gpt-5.4-mini † | maintainers | 2 | 2 | 50% [9, 91] | 50% | 1/2 50% [9, 91] |",
    );
    expect(page).toContain(
      "| anthropic:claude-sonnet-5 † | maintainers | 1 | 1 | 100% [21, 100] |",
    );
    expect(page).toContain(
      "| google:gemini-3.5-flash-lite † | erin | 1 | 1 | 100% [21, 100] |",
    );
    expect(page).toContain("### Excluded files");
    expect(page).toContain(
      "| reports/dave/leak.json | BAD_CODE (first at results[0].reason) |",
    );
    expect(page).toContain(
      "| reports/dave/broken.json | NOT_JSON (first at $) |",
    );
    expect(page).toContain(
      "| output/harness/night-5/results.json | REV_CHANGED (first at cycle.gitRev) |",
    );
    expect(page).not.toContain("night-5 (");
    expect(page).not.toContain(MARK);
    // The reader's own folders never reach the page.
    expect(page).not.toContain(dir);
    expect(page).not.toContain(tmpdir());
    expect(leaks(section(page))).toEqual([]);
    // A second run replaces the same section instead of appending.
    expect(run(["--out", out]).status).toBe(0);
    const again = readFileSync(out, "utf8");
    expect(again.split(MARKERS.begin)).toHaveLength(2);
    expect(again).toContain("HANDWRITTEN footer.");
  });
  it("adds a named path to both sources, never replaces them", () => {
    // Naming reports/ (the old "with contributed files" command) or a folder
    // from elsewhere must not drop the maintainers' rows from the page.
    const out = join(dir, "ADDED.md");
    writeFileSync(out, handwritten);
    const child = run([
      "--out",
      out,
      "reports/",
      join(dir, "elsewhere", "output", "harness"),
    ]);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("4 cycle(s), 3 refused");
    const page = readFileSync(out, "utf8");
    expect(page).toContain(
      "| openai:gpt-5.4-mini † | maintainers | 2 | 2 | 50% [9, 91] | 50% | 1/2 50% [9, 91] |",
    );
    expect(page).toContain("| google:gemini-3.5-flash-lite † | erin |");
    // A harness folder outside the checkout is not the maintainers'.
    expect(page).toContain("night-4 (2026-09-23, unattributed)");
    expect(page).toContain("| openai:gpt-5.4 † | unattributed |");
    expect(page).not.toContain(dir);
  });
  it("reads only the given paths under --only, and needs one", () => {
    const child = run([
      "--only",
      join(checkout, "output", "harness", "night-2"),
    ]);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("## Results");
    expect(child.stdout).toContain("night-2 (2026-09-21, maintainers).");
    expect(child.stdout).not.toContain("night-1");
    expect(child.stdout).not.toContain("erin");
    expect(child.stdout).not.toContain("Excluded");
    const none = run(["--only"]);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("--only needs at least one path");
  });
  it("keeps a document's own text: appends without markers, refuses broken ones", () => {
    const plain = join(dir, "PLAIN.md");
    writeFileSync(plain, "# Notes\n\nHANDWRITTEN.\n");
    expect(run(["--out", plain]).status).toBe(0);
    const appended = readFileSync(plain, "utf8");
    expect(appended.startsWith("# Notes\n\nHANDWRITTEN.\n\n")).toBe(true);
    expect(appended).toContain(`${MARKERS.begin}\n\n## Results`);
    const broken = join(dir, "BROKEN.md");
    const text = `HANDWRITTEN\n${MARKERS.end}\nmiddle\n${MARKERS.begin}\n`;
    writeFileSync(broken, text);
    const child = run(["--out", broken]);
    expect(child.status).toBe(2);
    expect(child.stderr).toContain("MARKERS_MALFORMED");
    expect(readFileSync(broken, "utf8")).toBe(text);
  });
  it("exits 1 under --strict when a file was refused, and prints JSON on request", () => {
    const strict = run(["--only", "--strict", "reports/"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("night-3 (2026-09-22, erin).");
    expect(run(["--only", "--strict", "reports/erin/"]).status).toBe(0);
    expect(run(["--only", "reports/"]).status).toBe(0);
    const json = run(["--json", "--only", "output/harness"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.groups[0].rows.map((r: { cell: string }) => r.cell)).toEqual([
      "anthropic:claude-sonnet-5",
      "openai:gpt-5.4-mini",
    ]);
    expect(parsed.rejected).toEqual([
      {
        file: "output/harness/night-5/results.json",
        problems: [{ code: "REV_CHANGED", path: "cycle.gitRev" }],
      },
    ]);
    expect(leaks(json.stdout)).toEqual([]);
    expect(json.stdout).not.toContain(dir);
  });
  it("never writes JSON over a document", () => {
    // Over docs/HONESTY.md it would replace the method and the conflict of
    // interest statement with a blob.
    const doc = join(dir, "DOC.md");
    writeFileSync(doc, handwritten);
    const refused = run(["--json", "--out", doc]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("JSON_OUT_NOT_JSON");
    expect(readFileSync(doc, "utf8")).toBe(handwritten);
    // Nor over a document that happens to end in .json.
    const disguised = join(dir, "doc.json");
    writeFileSync(disguised, handwritten);
    expect(run(["--json", "--out", disguised]).status).toBe(2);
    expect(readFileSync(disguised, "utf8")).toBe(handwritten);
    // A .json file gets the whole report.
    const fresh = join(dir, "report.json");
    expect(run(["--json", "--out", fresh]).status).toBe(0);
    expect(JSON.parse(readFileSync(fresh, "utf8")).groups).toHaveLength(1);
  });
  it("writes nothing without --out", () => {
    const listing = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() && !entry.isSymbolicLink()
          ? listing(join(folder, entry.name)).map((f) => `${entry.name}/${f}`)
          : [entry.name],
      );
    const before = listing(dir).sort();
    const child = run([]);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("## Results");
    expect(listing(dir).sort()).toEqual(before);
  });
});
