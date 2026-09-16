import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seedTask, gradeTask } from "./workflow";
const [command = "seed", arg = "1", path = ".data/gym"] = process.argv.slice(2);
if (command === "seed") {
  const seed = Number(arg);
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error("Seed must be a nonnegative integer");
  mkdirSync(path, { recursive: true });
  const task = seedTask(seed);
  writeFileSync(join(path, "task.json"), JSON.stringify(task, null, 2));
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify(task.initial, null, 2),
  );
  writeFileSync(join(path, "trajectory.json"), JSON.stringify([]));
  console.log(task.instruction);
} else if (command === "grade") {
  const root = arg;
  const task = JSON.parse(readFileSync(join(root, "task.json"), "utf8"));
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  const trace = JSON.parse(readFileSync(join(root, "trajectory.json"), "utf8"));
  const result = gradeTask(task, state, trace);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 1;
} else
  throw new Error(
    "Usage: npm run gym -- seed <number> <directory> | grade <directory>",
  );
