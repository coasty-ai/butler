// The fix loop: turn a cycle's failures into fix lanes, one branch each.
//
//   node scripts/harness-loop.mjs                       # plan only (default)
//   node scripts/harness-loop.mjs --create-lanes        # + worktrees and branches
//   node scripts/harness-loop.mjs --create-lanes \
//     --agent "claude -p --permission-mode acceptEdits" # + hand each brief to that agent
//   node scripts/harness-loop.mjs --lane HANDOFF_TAKEOVER --check   # suites + floor check
//
// It reads the newest cycle in output/harness (or --cycle <id>), picks the
// failure classes worth fixing (src/gym/loop.ts), writes a brief per lane,
// and stops. With --create-lanes it also makes a git worktree and branch per
// lane; with --agent it runs that command in each worktree with the brief on
// stdin, then runs the required suites and checks the diff against the
// safety floors.
//
// Two things it never does: merge a lane (every lane ends as a branch for a
// person to review), and accept a diff that removes a refusal from a safety
// floor. It spends no money: the probe that validates a lane is a cycle run,
// which stays the operator's own command, printed at the end.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { register } = await import("tsx/esm/api");
register();
const {
  emptyLoopState,
  floorVerdict,
  laneBrief,
  laneOutcome,
  loopReport,
  recordLane,
  selectLanes,
} = await import("../src/gym/loop.ts");

const { values } = parseArgs({
  options: {
    cycle: { type: "string" },
    output: { type: "string" },
    lane: { type: "string" },
    agent: { type: "string" },
    "create-lanes": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    `Usage: node scripts/harness-loop.mjs [--cycle <id>] [--create-lanes] [--agent "<cmd>"] [--lane <CODE> --check] [--json]

  Plans fix lanes from a harness cycle and, when asked, creates them.

  --cycle <id>     Which cycle in output/harness to read (default: newest).
  --output <dir>   Read cycles from here instead of output/harness.
  --create-lanes   Create a git worktree and branch per lane.
  --agent "<cmd>"  Run this command inside each lane's worktree with the
                   brief on stdin. Implies --create-lanes. The loop then runs
                   the suites and the floor check for that lane.
  --lane <CODE>    Only this class.
  --check          Run the suites and the floor check for existing lanes
                   without calling an agent.
  --json           Print the plan as JSON instead of Markdown.

  The loop never merges a lane and never relaxes a safety floor. The probe
  that validates a lane costs money and stays your command; it is printed.`,
  );
  process.exit(0);
}

const outputDir = values.output
  ? resolve(values.output)
  : join(root, "output", "harness");
const statePath = join(outputDir, "loop-state.json");
const SUITES = [
  "npx tsc --noEmit",
  "npm test",
  "npm run test:native-safety",
  "node scripts/build-native.mjs",
  "node scripts/bench.mjs --dry-run",
];

function newestCycle() {
  if (!existsSync(outputDir)) return undefined;
  const cycles = readdirSync(outputDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(outputDir, name, "results.json")))
    .sort();
  return cycles.at(-1);
}

const cycleId = values.cycle ?? newestCycle();
if (!cycleId) {
  console.error(
    `No cycle to learn from: ${outputDir} holds no results.json yet.\nRun one first (docs/HARNESS_LOOP.md): npm run cycle -- --dry-run`,
  );
  process.exit(2);
}
const resultsPath = join(outputDir, cycleId, "results.json");
if (!existsSync(resultsPath)) {
  console.error(`No results.json for cycle ${cycleId} (${resultsPath}).`);
  process.exit(2);
}
const cycle = JSON.parse(readFileSync(resultsPath, "utf8"));
if (cycle.schema_version !== 2) {
  console.error(`Cycle ${cycleId} is schema ${cycle.schema_version}, not 2.`);
  process.exit(2);
}
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : emptyLoopState();

let lanes = selectLanes(cycle, state, cycleId);
if (values.lane)
  lanes = lanes.filter((lane) => lane.code === values.lane.toUpperCase());

const laneDir = join(outputDir, cycleId, "lanes");
mkdirSync(laneDir, { recursive: true });
const probeFor = (code) =>
  `npm run cycle -- --probe ${code} --baseline ${cycleId} --repeat 3`;
for (const lane of lanes) {
  writeFileSync(
    join(laneDir, `${lane.code.toLowerCase()}.md`),
    `${laneBrief(lane, cycle, { probeCommand: probeFor(lane.code), suites: SUITES })}\n`,
  );
}

const git = (args, cwd = root) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const createLanes = values["create-lanes"] || !!values.agent;
const outcomes = new Map();
let nextState = state;

for (const lane of lanes) {
  const worktree = join(root, lane.worktree);
  if (createLanes && !existsSync(worktree)) {
    try {
      git(["worktree", "add", "-b", lane.branch, worktree, "HEAD"]);
      // Lanes run the suites, which need the installed modules.
      const modules = join(worktree, "node_modules");
      if (!existsSync(modules))
        execFileSync("ln", ["-s", join(root, "node_modules"), modules]);
      console.log(`lane ${lane.code}: ${lane.branch} in ${lane.worktree}`);
    } catch (error) {
      console.error(`lane ${lane.code}: could not create the worktree`, error);
      continue;
    }
  }
  if (values.agent) {
    const brief = readFileSync(
      join(laneDir, `${lane.code.toLowerCase()}.md`),
      "utf8",
    );
    const [command, ...args] = values.agent.split(" ").filter(Boolean);
    const run = spawnSync(command, args, {
      cwd: worktree,
      input: brief,
      encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (run.status !== 0)
      console.error(`lane ${lane.code}: the agent exited ${run.status}`);
  }
  if (values.agent || values.check) {
    if (!existsSync(worktree)) {
      console.error(`lane ${lane.code}: no worktree at ${lane.worktree}`);
      continue;
    }
    const diff = git(["diff", "HEAD", "--", "."], worktree);
    const floor = floorVerdict(diff);
    let suitesPassed = floor.ok;
    for (const suite of floor.ok ? SUITES : []) {
      const [command, ...args] = suite.split(" ");
      const run = spawnSync(command, args, {
        cwd: worktree,
        encoding: "utf8",
        stdio: "pipe",
      });
      const failed =
        run.status !== 0 || / failed/.test(`${run.stdout}${run.stderr}`);
      console.log(`lane ${lane.code}: ${suite} ${failed ? "FAILED" : "ok"}`);
      if (failed) {
        suitesPassed = false;
        break;
      }
    }
    const outcome = laneOutcome({ floor, suitesPassed });
    outcomes.set(lane.code, outcome);
    if (!floor.ok)
      for (const line of floor.removed)
        console.error(`  refusal removed in ${line.file}: ${line.line}`);
    nextState = recordLane(nextState, lane.code, outcome);
  }
}

nextState = {
  ...nextState,
  cycles: nextState.cycles.includes(cycleId)
    ? nextState.cycles
    : [...nextState.cycles, cycleId],
};
writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);

const plan = lanes.map((lane) => ({
  lane,
  outcome: outcomes.get(lane.code),
}));
if (values.json) {
  console.log(JSON.stringify({ cycle: cycleId, lanes: plan }, null, 2));
} else {
  console.log("");
  console.log(loopReport({ cycle, lanes: plan, state: nextState }));
  if (lanes.length) {
    console.log("");
    console.log("Next, for each lane (each costs money and drives this Mac):");
    for (const lane of lanes) console.log(`  ${probeFor(lane.code)}`);
    console.log("");
    console.log(
      "Then review each branch yourself and merge it, or say why not. The loop merges nothing.",
    );
  }
}
process.exit(
  [...outcomes.values()].some((o) => o.verdict === "blocked") ? 1 : 0,
);
