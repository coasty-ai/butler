import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeController } from "../electron/controller";

test("a native stop signal preserves the process for resuming and later commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "coarena-native-protocol-"));
  const binary = join(root, "controller.cjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
process.on('SIGUSR1', () => {});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'human') process.stdout.write(JSON.stringify({event: 'user_takeover'}) + '\\n');
  process.stdout.write(JSON.stringify({id: request.id, result: {method: request.method}}) + '\\n');
});
`,
    { mode: 0o700 },
  );
  let exits = 0;
  let takeovers = 0;
  const controller = new NativeController(
    binary,
    () => {
      exits++;
    },
    () => {
      takeovers++;
    },
  );
  try {
    expect(await controller.request("surface")).toEqual({ method: "surface" });
    controller.stop();
    await controller.resume();
    expect(await controller.request("capture")).toEqual({ method: "capture" });
    controller.stop();
    await controller.resume();
    expect(exits).toBe(0);
    await controller.request("human");
    expect(takeovers).toBe(1);
  } finally {
    controller.close();
    rmSync(root, { recursive: true, force: true });
  }
});
