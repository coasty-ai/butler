import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FLOOR_PATHS,
  LOOP_LIMITS,
  classFixed,
  emptyLoopState,
  fixedThreshold,
  floorVerdict,
  laneBrief,
  laneOutcome,
  loopReport,
  recordLane,
  selectLanes,
  strictClass,
  type LoopState,
} from "../src/gym/loop";
import type { CycleResults, FailureClass } from "../src/gym/bench/cycle-report";

/** A failure class as a cycle reports it, with only what the loop reads. */
function cls(over: Partial<FailureClass> = {}): FailureClass {
  const attempts = over.attempts ?? 12;
  const attemptRate = over.attemptRate ?? 0.2;
  return {
    rank: 1,
    code: "UNIDENTIFIED_TARGET",
    source: "friction",
    owner: "agent",
    attempts,
    attemptRate,
    passedAttempts: 0,
    wilson95: [attemptRate / 2, Math.min(1, attemptRate * 2)],
    events: attempts,
    byModel: { "openai:gpt-5.4-mini": { attempts, rate: attemptRate } },
    byCategory: { browser: { attempts, rate: attemptRate } },
    contributors: [],
    examples: [
      {
        runId: "run-1",
        cell: "openai:gpt-5.4-mini",
        taskId: "browser-goto",
        attempt: 1,
        at: "2026-09-19T01:00:00.000Z",
      },
    ],
    note: "The model aimed at a control that was not there.",
    ...over,
  };
}
/** A cycle result with the fields the loop reads and nothing else. */
function cycle(classes: FailureClass[], id = "20260919-0100-abc1234") {
  return {
    schema_version: 2,
    harnessVersion: "1",
    cycle: { id, gitRev: "abc1234" },
    results: [],
    aggregate: {},
    failureClasses: classes,
    regressions: [],
    modelComparison: [],
  } as unknown as CycleResults;
}
const codes = (list: { code: string }[]) => list.map((l) => l.code);

describe("fix loop: choosing lanes", () => {
  it("takes the costliest classes it owns, and never one it cannot fix", () => {
    const lanes = selectLanes(
      cycle([
        cls({ code: "UNIDENTIFIED_TARGET", attemptRate: 0.2, rank: 2 }),
        cls({ code: "FALSE_DONE", attemptRate: 0.3, rank: 1 }),
        cls({ code: "USER_CANCELLED", owner: "user", attemptRate: 0.5 }),
        cls({
          code: "PROVIDER_TIMEOUT",
          owner: "environment",
          attemptRate: 0.4,
        }),
      ]),
      emptyLoopState(),
    );
    // Ordered by how much of the cycle each class cost, not by rank.
    expect(codes(lanes)).toEqual(["FALSE_DONE", "UNIDENTIFIED_TARGET"]);
    // The user's own stops and the provider's outages are nobody's lane.
    expect(codes(lanes)).not.toContain("USER_CANCELLED");
    expect(codes(lanes)).not.toContain("PROVIDER_TIMEOUT");
  });

  it("puts a grader or harness fault first: it hides every other number", () => {
    const lanes = selectLanes(
      cycle([
        cls({ code: "FALSE_DONE", attemptRate: 0.3 }),
        cls({
          code: "NO_END_STATE",
          owner: "grader",
          attemptRate: LOOP_LIMITS.unknownFirstRate,
        }),
      ]),
      emptyLoopState(),
    );
    expect(codes(lanes)[0]).toBe("NO_END_STATE");
    expect(lanes[0].reason).toMatch(/hides other numbers/);
    // Below the rate that hides numbers, it queues by cost like the rest.
    const quieter = selectLanes(
      cycle([
        cls({ code: "FALSE_DONE", attemptRate: 0.3 }),
        cls({ code: "NO_END_STATE", owner: "grader", attemptRate: 0.06 }),
      ]),
      emptyLoopState(),
    );
    expect(codes(quieter)[0]).toBe("FALSE_DONE");
  });

  it("ignores a class too small to learn from, and caps the night's lanes", () => {
    const small = selectLanes(
      cycle([
        cls({ code: "RARE", attempts: 2, attemptRate: 0.2 }),
        cls({ code: "QUIET", attempts: 20, attemptRate: 0.02 }),
      ]),
      emptyLoopState(),
    );
    expect(small).toEqual([]);
    const many = selectLanes(
      cycle(
        ["A", "B", "C", "D", "E"].map((code, i) =>
          cls({ code, attemptRate: 0.5 - i / 100 }),
        ),
      ),
      emptyLoopState(),
    );
    expect(many).toHaveLength(LOOP_LIMITS.maxLanes);
  });

  it("skips a class that is parked, already fixed, or has a lane in flight", () => {
    const state: LoopState = {
      cycles: [],
      classes: {
        PARKED: { code: "PARKED", failedLanes: 3, parked: true },
        DONE: { code: "DONE", failedLanes: 0, fixed: true },
        BUSY: { code: "BUSY", failedLanes: 1, openLane: "fix/busy-1" },
      },
    };
    const lanes = selectLanes(
      cycle(
        ["PARKED", "DONE", "BUSY", "OPEN"].map((code) =>
          cls({ code, attemptRate: 0.3 }),
        ),
      ),
      state,
    );
    expect(codes(lanes)).toEqual(["OPEN"]);
  });

  it("names the branch, worktree, models and example runs for the lane", () => {
    const [lane] = selectLanes(
      cycle([
        cls({
          code: "HANDOFF_TAKEOVER",
          byModel: {
            "openai:gpt-5.4-mini": { attempts: 6, rate: 0.2 },
            "google:gemini-3.5-flash-lite": { attempts: 0, rate: 0 },
          },
          byCategory: {
            browser: { attempts: 4, rate: 0.2 },
            files: { attempts: 0, rate: 0 },
          },
        }),
      ]),
      emptyLoopState(),
      "20260919-0100-abc1234",
    );
    expect(lane.branch).toBe("fix/handoff-takeover-20260919-0100-abc1234");
    expect(lane.worktree).toBe(".claude/worktrees/fix-handoff-takeover");
    // Only the cells and categories the class actually happened in.
    expect(lane.models).toEqual(["openai:gpt-5.4-mini"]);
    expect(lane.categories).toEqual(["browser"]);
    expect(lane.examples).toEqual(["run-1"]);
  });
});

describe("fix loop: the brief", () => {
  const [lane] = selectLanes(cycle([cls()]), emptyLoopState());
  const brief = laneBrief(lane, cycle([cls()]), {
    probeCommand: "npm run cycle -- --probe UNIDENTIFIED_TARGET",
    suites: ["npm test", "npm run test:native-safety"],
  });

  it("says what the lane must prove, and what it may never do", () => {
    expect(brief).toMatch(/failing test first/i);
    expect(brief).toMatch(/npm test ; npm run test:native-safety/);
    expect(brief).toMatch(/adversarial tests/i);
    expect(brief).toMatch(/npm run cycle -- --probe UNIDENTIFIED_TARGET/);
    // The two rules that never move.
    expect(brief).toMatch(/safety floor is never relaxed/i);
    expect(brief).toMatch(/loop never merges/i);
    // The evidence it starts from.
    expect(brief).toMatch(/run-1/);
    expect(brief).toMatch(/openai:gpt-5\.4-mini/);
    expect(brief).toMatch(/aimed at a control that was not there/);
  });

  it("carries codes and counts only: no task text, no screen", () => {
    expect(brief).not.toMatch(/screenshot|"text"|typed/i);
    expect(brief.split("\n").every((line) => line.length < 400)).toBe(true);
  });
});

describe("fix loop: the safety floor", () => {
  const diff = (file: string, body: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}\n`;

  it("refuses a diff that removes a refusal from a floor file", () => {
    const verdict = floorVerdict(
      diff(
        "src/core/policy.ts",
        `-    return { kind: "DENY", reason: "That application is protected." };\n+    return { kind: "ALLOW", reason: "Open it." };`,
      ),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.touched).toEqual(["src/core/policy.ts"]);
    expect(verdict.removed[0].line).toMatch(/DENY/);
    expect(laneOutcome({ floor: verdict, suitesPassed: true })).toEqual({
      verdict: "blocked",
      reason: expect.stringContaining("weakens a safety floor"),
    });
  });

  it("allows a floor file to gain a rule, or to change a line that states none", () => {
    const added = floorVerdict(
      diff(
        "native/macos/LaunchSafety.swift",
        `+    if launchProtected(bundleId: id, protectedApps: protectedApps) { return true }`,
      ),
    );
    expect(added.ok).toBe(true);
    expect(added.touched).toEqual(["native/macos/LaunchSafety.swift"]);
    const comment = floorVerdict(
      diff(
        "src/core/policy.ts",
        `-  // Never opens a protected app.\n+  // Never opens a protected app (see LaunchSafety.swift).`,
      ),
    );
    expect(comment.ok).toBe(true);
  });

  it("reads only the floor files, and knows the ones that matter", () => {
    const elsewhere = floorVerdict(
      diff(
        "src/core/runner.ts",
        `-      if (decision.kind === "DENY") return;\n+      if (decision.kind === "DENY") continue;`,
      ),
    );
    expect(elsewhere.ok).toBe(true);
    expect(elsewhere.touched).toEqual([]);
    for (const path of [
      "src/core/policy.ts",
      "native/macos/InputSafety.swift",
      "native/macos/LaunchSafety.swift",
      "electron/credentials.ts",
    ])
      expect(FLOOR_PATHS).toContain(path);
  });
});

describe("fix loop: outcomes and stopping rules", () => {
  const ok = { ok: true, touched: [], removed: [] };

  it("a lane ends in review, never in a merge", () => {
    expect(laneOutcome({ floor: ok, suitesPassed: true })).toMatchObject({
      verdict: "review",
    });
    const probe = {
      code: "FALSE_DONE",
      pass: true,
      reasons: [],
      before: { k: 6, n: 24, rate: 0.25 },
      after: { k: 0, n: 24, rate: 0 },
      p: 0.01,
    };
    expect(laneOutcome({ floor: ok, suitesPassed: true, probe })).toEqual({
      verdict: "review",
      reason: "probe FALSE_DONE: 25.0% -> 0.0%",
    });
    // Nothing the loop returns can mean "merged".
    for (const outcome of [
      laneOutcome({ floor: ok, suitesPassed: true }),
      laneOutcome({ floor: ok, suitesPassed: true, probe }),
      laneOutcome({ floor: ok, suitesPassed: false }),
    ])
      expect(outcome.verdict).not.toBe("merged");
  });

  it("a failed suite blocks the lane, and a probe that did not move it fails it", () => {
    expect(laneOutcome({ floor: ok, suitesPassed: false })).toMatchObject({
      verdict: "blocked",
      reason: "a required suite did not pass",
    });
    const outcome = laneOutcome({
      floor: ok,
      suitesPassed: true,
      probe: {
        code: "FALSE_DONE",
        pass: false,
        reasons: [{ code: "NOT_IMPROVED" }],
        before: { k: 6, n: 24, rate: 0.25 },
        after: { k: 5, n: 24, rate: 0.21 },
        p: 0.4,
      } as unknown as CycleResults["probe"],
    });
    expect(outcome).toMatchObject({ verdict: "failed" });
    expect(outcome.reason).toMatch(/NOT_IMPROVED/);
  });

  it("parks a class after three lanes that did not move it", () => {
    let state = emptyLoopState();
    const failed = { verdict: "failed" as const, reason: "probe" };
    for (let i = 0; i < LOOP_LIMITS.parkAfter - 1; i++)
      state = recordLane(state, "FALSE_DONE", failed);
    expect(state.classes.FALSE_DONE.parked).toBeFalsy();
    // A lane that reached review does not count against the class.
    state = recordLane(state, "FALSE_DONE", {
      verdict: "review",
      reason: "no probe was run",
    });
    expect(state.classes.FALSE_DONE.failedLanes).toBe(
      LOOP_LIMITS.parkAfter - 1,
    );
    state = recordLane(state, "FALSE_DONE", failed);
    expect(state.classes.FALSE_DONE.parked).toBe(true);
    // Parked, so the next cycle plans no lane for it.
    expect(selectLanes(cycle([cls({ code: "FALSE_DONE" })]), state)).toEqual(
      [],
    );
  });

  it("calls a class fixed only when the interval, not just the rate, is under the bar", () => {
    // A quiet night: 1 in 20 looks fixed, but the interval says nothing yet.
    expect(
      classFixed(cls({ code: "A", attemptRate: 0.05, wilson95: [0.01, 0.24] })),
    ).toBe(false);
    expect(
      classFixed(cls({ code: "A", attemptRate: 0.02, wilson95: [0, 0.09] })),
    ).toBe(true);
    // The classes a user feels as a breach of trust need a stricter bar.
    expect(strictClass("FALSE_DONE")).toBe(true);
    expect(fixedThreshold("FALSE_DONE")).toBe(LOOP_LIMITS.strictFixedAt);
    expect(fixedThreshold("UNIDENTIFIED_TARGET")).toBe(LOOP_LIMITS.fixedAt);
    expect(
      classFixed(
        cls({ code: "FALSE_DONE", attemptRate: 0.02, wilson95: [0, 0.09] }),
      ),
    ).toBe(false);
    expect(
      classFixed(
        cls({ code: "FALSE_DONE", attemptRate: 0, wilson95: [0, 0.04] }),
      ),
    ).toBe(true);
  });

  it("reports what it planned and says plainly that it merges nothing", () => {
    const state = recordLane(emptyLoopState(), "OLD", {
      verdict: "failed",
      reason: "probe",
    });
    const report = loopReport({
      cycle: cycle([cls()]),
      lanes: [
        {
          lane: selectLanes(cycle([cls()]), emptyLoopState())[0],
          outcome: { verdict: "review", reason: "probe ok" },
        },
      ],
      state: {
        ...state,
        classes: {
          ...state.classes,
          P: { code: "P", failedLanes: 3, parked: true },
        },
      },
    });
    expect(report).toMatch(/UNIDENTIFIED_TARGET/);
    expect(report).toMatch(/review: probe ok/);
    expect(report).toMatch(/Parked: P/);
    expect(report).toMatch(/merges nothing/);
    expect(report).toMatch(/weakens a safety floor is refused/);
  });
});

describe("fix loop: the script", () => {
  const root = new URL("..", import.meta.url).pathname;
  const run = (args: string[], cwd: string) =>
    spawnSync("node", [join(root, "scripts/harness-loop.mjs"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

  /** A checkout-shaped temp dir holding one recorded cycle. */
  function withCycle(classes: FailureClass[]) {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const id = "20260919-0100-abc1234";
    mkdirSync(join(dir, "output", "harness", id), { recursive: true });
    writeFileSync(
      join(dir, "output", "harness", id, "results.json"),
      JSON.stringify(cycle(classes, id)),
    );
    return { dir, id };
  }

  it("plans from the newest cycle and writes a brief per lane", () => {
    const { dir, id } = withCycle([
      cls({ code: "FALSE_DONE", attemptRate: 0.3 }),
      cls({ code: "UNIDENTIFIED_TARGET", attemptRate: 0.2 }),
    ]);
    try {
      const result = run(["--output", join(dir, "output", "harness")], root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/FALSE_DONE/);
      expect(result.stdout).toMatch(/fix\/false-done-/);
      // The probe is printed for the operator, never run here.
      expect(result.stdout).toMatch(/npm run cycle -- --probe FALSE_DONE/);
      expect(result.stdout).toMatch(/merges nothing/);
      const brief = readFileSync(
        join(dir, "output", "harness", id, "lanes", "false_done.md"),
        "utf8",
      );
      expect(brief).toMatch(/# Fix lane: FALSE_DONE/);
      expect(brief).toMatch(/failing test first/i);
      // It remembers the cycle, so a second run is not a second plan.
      const state = JSON.parse(
        readFileSync(join(dir, "output", "harness", "loop-state.json"), "utf8"),
      ) as { cycles: string[] };
      expect(state.cycles).toEqual([id]);
      // Planning creates no worktree and no branch.
      expect(existsSync(join(root, ".claude/worktrees/fix-false-done"))).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plans nothing when every class belongs to the user or the provider", () => {
    const { dir } = withCycle([
      cls({ code: "USER_CANCELLED", owner: "user", attemptRate: 0.4 }),
      cls({ code: "PROVIDER_TIMEOUT", owner: "environment", attemptRate: 0.3 }),
    ]);
    try {
      const result = run(["--output", join(dir, "output", "harness")], root);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/0 lane\(s\) planned/);
      expect(result.stdout).not.toMatch(/npm run cycle -- --probe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a cycle it cannot read", () => {
    const { dir } = withCycle([cls()]);
    try {
      const result = run(
        ["--output", join(dir, "output", "harness"), "--cycle", "nope"],
        root,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/No results\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never merges, pushes or relaxes a floor: not a line of it says so", () => {
    const source = readFileSync(join(root, "scripts/harness-loop.mjs"), "utf8");
    expect(source).not.toMatch(/"merge"|git merge|--no-ff/);
    expect(source).not.toMatch(/"push"|git push/);
    // The floor check runs before the suites, and a lane that fails it stops.
    expect(source).toMatch(/floorVerdict\(diff\)/);
    expect(source).toMatch(/floor\.ok \? SUITES : \[\]/);
    // The probe is the operator's own command, printed, never spawned here.
    expect(source).not.toMatch(/spawnSync\([^)]*--probe/);
    expect(source).toMatch(/probeFor\(lane\.code\)/);
  });

  it("is registered as a script and documented", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.loop).toBe("node scripts/harness-loop.mjs");
    const docs = readFileSync(join(root, "docs/HARNESS_LOOP.md"), "utf8");
    expect(docs).toMatch(/harness-loop\.mjs/);
    expect(docs).toMatch(/merges nothing|never merges/i);
  });
});
