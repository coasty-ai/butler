#!/usr/bin/env node
// Stands in for coarena-launch in tests: records the argv and environment it
// was given to $TMPDIR/fake-launch-<pid>.json, then runs the child with its
// stdio passed through and exits with the child's status. Flags come before
// "--", exactly as the client passes them; nothing is sandboxed here.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const flags = separator < 0 ? [] : argv.slice(0, separator);
const [command, ...args] = separator < 0 ? argv : argv.slice(separator + 1);
writeFileSync(
  join(process.env.TMPDIR ?? tmpdir(), `fake-launch-${process.pid}.json`),
  JSON.stringify({ argv, flags, command, args, env: process.env }),
);
if (!command) {
  process.stderr.write("LAUNCH_BAD_COMMAND\n");
  process.exit(64);
}
const child = spawn(command, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", () => process.exit(64));
