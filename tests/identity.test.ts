/**
 * Identity guard. The product was renamed from Open Assist to Butler, but these
 * identifiers deliberately kept the old name, because something outside the
 * repository is keyed to each of them:
 *
 * - The former app's bundle id: macOS permission records (Accessibility, Screen Recording,
 *   Microphone, Speech, Automation, Full Disk Access, Calendars, Reminders),
 *   and six Swift checks that keep the agent from screenshotting, targeting or
 *   launching its own app.
 * - The npm name: the historical desktop data folder and Keychain namespace.
 *   The CLI now has its own encrypted profile; retiring the app does not
 *   rename these existing identities.
 * - The bench root, calendar, list, lock and token ledger: harness state and
 *   the one desktop lock per Mac, shared by every checkout and worktree.
 * - The OPEN_ASSIST_* switches and the bench memory stores: the owner's shell
 *   setup and what the bench has learned so far.
 *
 * A search-and-replace that touches any of them fails here instead of
 * silently revoking permissions or orphaning a profile. Changing one on
 * purpose needs a migration first (.data/design/isa-rename-map.md, group C).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { desktopLockPath } from "../src/gym/bench/presence";
import { tokenLedgerDir } from "../src/gym/bench/sweep";
import { BENCH_ROOT, MUSIC_READER_ENV } from "../src/gym/bench/readers";
import { BENCH_CONTAINER } from "../src/gym/bench/catalogue-long";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("identity guard: identifiers that stay after the Butler rename", () => {
  it("keeps the npm identity while exposing only the CLI entry point", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("coarena-open-assist");
    expect(pkg.main).toBe("dist-terminal/main.cjs");
    expect(pkg.bin).toEqual({ butler: "dist-terminal/main.cjs" });
    expect(pkg.build).toBeUndefined();
    // Keep the historical npm identity; the terminal profile has its own
    // encrypted storage and Keychain item, independent of app display names.
    expect(pkg.productName).toBeUndefined();
    const lock = JSON.parse(read("package-lock.json"));
    expect([lock.name, lock.packages[""].name]).toEqual([
      "coarena-open-assist",
      "coarena-open-assist",
    ]);
  });

  it("keeps the helper bundle ids", () => {
    const id = (plist: string) =>
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
        read(plist),
      )?.[1];
    expect(id("native/macos/Voice-Info.plist")).toBe(
      "ai.coarena.openassist.voice",
    );
    expect(id("native/macos/Agenda-Info.plist")).toBe(
      "ai.coarena.openassist.agenda",
    );
  });

  it("keeps the nine self-protection checks keyed to the app's own bundle id", () => {
    const literal = '"ai.coarena.openassist"';
    // Controller: the applications listed for the model, the window a spoken
    // scroll may move, the windows a capture leaves out, the app remembered
    // before a turn and restored after it, and the one check a bound run
    // shares (butlerOwn): never a target, never given the front back, never
    // counted as covering the target.
    expect({
      controller: count(read("native/macos/Controller.swift"), literal),
      input: count(read("native/macos/InputSafety.swift"), literal),
      launch: count(read("native/macos/LaunchSafety.swift"), literal),
      // The seventh controller check is the observer's: it never records
      // Butler's own windows (native/macos/Controller.swift, observe glue).
    }).toEqual({ controller: 7, input: 1, launch: 1 });
    expect(read("native/macos/Controller.swift")).toMatch(
      /func butlerOwn\(pid: pid_t\) -> Bool \{[^}]*"ai\.coarena\.openassist"/,
    );
    const launch = read("native/macos/LaunchSafety.swift");
    expect(launch).toMatch(/launchFloorDenied[^\n]*"ai\.coarena\.openassist"/);
    const input = read("native/macos/InputSafety.swift");
    expect(input).toMatch(/id != "ai\.coarena\.openassist"/);
  });

  it("keeps the Mac-wide desktop lock and the token ledger", () => {
    expect(desktopLockPath("/h")).toBe(
      "/h/Library/Caches/open-assist/desktop.lock",
    );
    expect(tokenLedgerDir("/h")).toBe(
      "/h/Library/Caches/open-assist/bench-tokens",
    );
  });

  it("keeps the bench root, calendar and list", () => {
    expect(BENCH_ROOT).toBe("OpenAssistBench");
    expect(BENCH_CONTAINER).toBe("OpenAssistBench");
    expect(read("src/gym/bench/readers.ts")).toContain(
      'const AGENDA_CONTAINER = "OpenAssistBench";',
    );
    expect(read("src/gym/bench/attempt.ts")).toContain(
      'join(home, "OpenAssistBench")',
    );
    expect(read("native/macos/AgendaRules.swift")).toContain(
      'let benchContainerName = "OpenAssistBench"',
    );
  });

  it("keeps the OPEN_ASSIST_* switches", () => {
    expect(MUSIC_READER_ENV).toBe("OPEN_ASSIST_BENCH_MUSIC");
    expect(read("scripts/eval-dialog.mjs")).toContain(
      'process.env.OPEN_ASSIST_DIALOG_EVAL !== "1"',
    );
    expect(read("scripts/eval-jev.mjs")).toContain(
      'process.env.OPEN_ASSIST_JEV_EVAL !== "1"',
    );
    expect(read("scripts/bench-fixtures.mjs")).toContain(
      'const CHILD_ENV = "OPEN_ASSIST_FIXTURE_CHILD";',
    );
  });

  it("keeps the bench and live-task memory stores", () => {
    for (const script of ["scripts/bench.mjs", "scripts/harness-cycle.mjs"])
      expect([script, read(script)]).toEqual([
        script,
        expect.stringContaining('join(tmpdir(), "open-assist-bench-memory")'),
      ]);
    expect(read("scripts/live-task.mjs")).toContain(
      'join(tmpdir(), "open-assist-live-memory")',
    );
  });
});
