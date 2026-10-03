import { expect, test } from "vitest";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

// A fake compiler exercises installation/cache/failure behavior on every OS;
// it never compiles or launches a Mac helper.
test("native installs rebuild changed sources and metadata, preserve good binaries on failure, and reuse unchanged helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-build-test-"));
  try {
    cpSync("native/macos", join(root, "native/macos"), { recursive: true });
    cpSync("scripts/build-native.mjs", join(root, "build-native.mjs"));
    mkdirSync(join(root, "fake-bin"));
    const record = join(root, "compiles.jsonl");
    writeFileSync(
      join(root, "fake-bin/swiftc"),
      `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === '--version') { console.log('Synthetic Swift compiler 1'); process.exit(0); }
const args = process.argv.slice(2), output = args[args.indexOf('-o') + 1], target = path.basename(output);
fs.writeFileSync(output, Buffer.from('synthetic-binary-' + Date.now() + '-' + Math.random()));
if (process.env.BUTLER_FIXTURE_FAIL === target) process.exit(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({target}) + '\\n');
`,
      { mode: 0o700 },
    );
    const run = (fail?: string, terminal = true) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'Object.defineProperty(process, "platform", { value: "darwin" }); await import("./build-native.mjs");',
          "--",
          ...(terminal ? ["--terminal"] : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: join(root, "fake-bin") + delimiter + process.env.PATH,
            BUTLER_FIXTURE_FAIL: fail || "",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
    const built = () =>
      readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).target);
    expect(run().status).toBe(0);
    expect(built()).toEqual([
      "coarena-controller",
      "coarena-voice",
      "coarena-apple",
      "coarena-launch",
    ]);
    expect(run().status).toBe(0);
    expect(built()).toHaveLength(4);
    writeFileSync(
      join(root, "native/macos/InputSafety.swift"),
      "// changed dependency",
    );
    expect(run().status).toBe(0);
    expect(built().slice(4)).toEqual(["coarena-controller"]);
    writeFileSync(
      join(root, "native/macos/Voice-Info.plist"),
      "changed metadata",
    );
    expect(run().status).toBe(0);
    expect(built().slice(5)).toEqual(["coarena-voice"]);
    writeFileSync(join(root, "native/bin/coarena-apple"), "tampered binary");
    expect(run().status).toBe(0);
    expect(built().slice(6)).toEqual(["coarena-apple"]);
    const launcher = join(root, "native/bin/coarena-launch");
    const previous = readFileSync(launcher);
    writeFileSync(
      join(root, "native/macos/Launch.swift"),
      "// changed launcher",
    );
    expect(run(basename(launcher)).status).toBe(2);
    expect(readFileSync(launcher)).toEqual(previous);
    expect(
      readdirSync(join(root, "native/bin")).some((name) =>
        name.startsWith(".build-"),
      ),
    ).toBe(false);
    expect(run().status).toBe(0);
    expect(built().slice(7)).toEqual(["coarena-launch"]);
    // The broader native build still supports the legacy test/helpers.
    expect(run(undefined, false).status).toBe(0);
    expect(built().slice(8)).toEqual(["coarena-messages", "coarena-agenda"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
