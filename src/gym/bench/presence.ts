import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PresenceReport } from "../../../electron/controller";
import { analyze, parseDiagnostics } from "./analyze";

export type { PresenceReport };

/**
 * The presence gate: is anyone at this Mac, and may an unattended attempt
 * start? The signals come from the native helper's "presence" method when a
 * controller is running, and from read-only system commands otherwise
 * (`--dry-run` and `--preflight` have no helper). Every parser here is pure
 * over command output, so the rules are tested against captured fixtures
 * rather than the live machine. Nothing in this module sends input or
 * changes focus, and the only file it writes is the desktop lock.
 */

/** What the gate looks at, from whichever source could answer. */
export interface GateReport extends PresenceReport {
  /** Display-sleep holders other than our own caffeinate (a call, a video). */
  displayHolders: number;
  /** Open Assist app processes: a second agent on the same desktop. */
  appProcesses: number;
  /** Other harness processes (a cycle or a bench, from any checkout). */
  harnessProcesses: number;
  /** App runs in the diagnostics log whose last status is not terminal. */
  unsettledAppRuns: number;
  /**
   * ps or pmset failed or timed out, so the counts above are no evidence of
   * absence: an empty read is not an empty desktop.
   */
  unreadable: boolean;
  /** Where the idle numbers came from. */
  source: "helper" | "system";
}

/** Seconds since any HID event, from `ioreg -c IOHIDSystem -d 4`. */
export function parseHidIdle(text: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text);
  return match ? Number(match[1]) / 1e9 : undefined;
}

/**
 * Whether the console session is locked, from `ioreg -n Root -d1 -a` as
 * JSON: the root's IOConsoleLocked, or a console user carrying
 * CGSSessionScreenIsLocked. No entry on console at all also counts as locked
 * (a fast-user-switch, a login window).
 */
export function parseConsoleLocked(json: unknown): boolean {
  if (!json || typeof json !== "object") return true;
  const root = json as Record<string, unknown>;
  if (root.IOConsoleLocked === true) return true;
  const users = Array.isArray(root.IOConsoleUsers)
    ? (root.IOConsoleUsers as Record<string, unknown>[])
    : [];
  const onConsole = users.filter(
    (user) => user && user.kCGSSessionOnConsoleKey === true,
  );
  if (!onConsole.length) return true;
  return onConsole.every((user) => user.CGSSessionScreenIsLocked === true);
}

/** The screensaver idle time in seconds from `defaults -currentHost read com.apple.screensaver idleTime`; 0 means never. */
export function parseScreensaverIdle(text: string): number | undefined {
  const match = /^\s*(\d+)\s*$/.exec(text);
  return match ? Number(match[1]) : undefined;
}

export interface AssertionHolder {
  pid: number;
  name: string;
  kind: string;
}

/** Holders the gate does not count. */
export interface HolderExclusions {
  /** The harness's own caffeinate. */
  ownPids?: number[];
  /**
   * Holders the person vouched for with --allow-display-holder, by the pid
   * seen when the cycle started: a holder of the same name that appears
   * later (another cycle's caffeinate) is not vouched for.
   */
  allowedPids?: number[];
  /** By name, for --preflight and the start, before any pid is pinned. */
  allowedNames?: string[];
}

/**
 * Processes holding the display awake, from `pmset -g assertions`. Both the
 * current and the legacy assertion names count: Chrome's "Video Wake Lock"
 * is a NoDisplaySleepAssertion, caffeinate's a PreventUserIdleDisplaySleep.
 * The harness's own caffeinate is excluded by pid; anything else means a
 * person may be watching (a shared screen, a video) even with idle hands.
 * The name ends at the last "):" before the bracket, since helper processes
 * carry parentheses of their own ("Google Chrome Helper (GPU)").
 */
export function parseAssertions(
  text: string,
  exclude: HolderExclusions = {},
): AssertionHolder[] {
  const holders: AssertionHolder[] = [];
  const line =
    /^\s*pid\s+(\d+)\((.*)\):\s+\[[^\]]*\]\s+\S+\s+(PreventUserIdleDisplaySleep|NoDisplaySleepAssertion)\b/;
  for (const raw of text.split("\n")) {
    const match = line.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    if (
      exclude.ownPids?.includes(pid) ||
      exclude.allowedPids?.includes(pid) ||
      exclude.allowedNames?.includes(match[2])
    )
      continue;
    holders.push({ pid, name: match[2], kind: match[3] });
  }
  return holders;
}

/**
 * Whether the Open Assist app is running, from `ps -axo pid=,command=`: the
 * packaged bundle's main executable, or a development Electron started from
 * one of this repository's checkouts (a worktree shares the main checkout's
 * node_modules, so its Electron lives there). Helper processes, VS Code
 * (whose main executable is also called Electron, inside its own bundle) and
 * the `open` launcher are not the app, and neither is this process.
 */
export function appProcesses(
  text: string,
  roots: string[],
  ownPid = -1,
): number[] {
  const pids: number[] = [];
  for (const raw of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === ownPid) continue;
    const command = match[2];
    const packaged =
      /Open Assist\.app\/Contents\/MacOS\/Open Assist(\s|$)/.test(command);
    const development =
      /(^|\/)Electron\.app\/Contents\/MacOS\/Electron(\s|$)/.test(command) &&
      (roots.some((root) => command.includes(root + "/")) ||
        command.includes("dist-electron/main.cjs"));
    if (packaged || development) pids.push(pid);
  }
  return pids;
}

/**
 * Other harness processes, from `ps -axo pid=,command=`: a node running
 * scripts/harness-cycle.mjs or scripts/bench.mjs from any checkout. The
 * desktop lock keeps a second one from starting; this catches one that never
 * took it (a checkout from before the lock). Its helper marks its input like
 * ours, so no tap here would ever see it. A dry run, a preflight or --help
 * drives nothing, and the npm and sh wrappers around a script are not node.
 */
export function harnessProcesses(text: string, ownPid = -1): number[] {
  const pids: number[] = [];
  for (const raw of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)(.*)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === ownPid || !/(^|\/)node$/.test(match[2])) continue;
    const args = match[3];
    if (!/(^|[\s/])scripts\/(harness-cycle|bench)\.mjs(\s|$)/.test(args))
      continue;
    if (/\s--(dry-run|preflight|help)(\s|=|$)/.test(args)) continue;
    pids.push(pid);
  }
  return pids;
}

/** App runs in a diagnostics log tail whose last status is not terminal. */
export function unsettledRuns(text: string): number {
  const parsed = parseDiagnostics(text);
  const report = analyze(parsed.lines);
  return report.runs.byOutcome.unsettled ?? 0;
}

/* -------------------------------------------------------------- the rules */

export interface GateState {
  /** --idle: seconds of human idle required at the start and after any input. */
  idleSeconds: number;
  /** When a person was last seen (a gate refusal for input, a manual takeover). */
  humanSeenAt?: number;
  /** When the harness last posted input itself; unset at start and after a resume. */
  lastAgentInputAt?: number;
  /** Slack under the agent's last input, so its own trailing events do not count. */
  slackSeconds?: number;
}

/**
 * How much human idle the next attempt needs. The full --idle at the start,
 * after a resume and after any human input; between attempts only "no input
 * since the agent's last input", because the tap counts unmarked input only
 * and the agent's own events cannot fool it.
 */
export function idleRequired(state: GateState, now: number): number {
  if (state.humanSeenAt !== undefined || state.lastAgentInputAt === undefined)
    return state.idleSeconds;
  const slack = state.slackSeconds ?? 3;
  const sinceAgent = (now - state.lastAgentInputAt) / 1000;
  return Math.min(state.idleSeconds, Math.max(0, sinceAgent - slack));
}

/** The gate passed: a person seen earlier has now been away for the full --idle. */
export function gatePassed(state: GateState): void {
  state.humanSeenAt = undefined;
}

export type GateReason =
  | "HID_ACTIVE"
  | "LOCKED"
  | "DISPLAY_OFF"
  | "PRESENCE_UNKNOWN"
  | "DISPLAY_HELD_BY_OTHER"
  | "HARNESS_RUNNING"
  | "APP_RUNNING"
  | "APP_RUN_ACTIVE"
  | "TIME_BOX";

export interface GateDecision {
  ok: boolean;
  reason?: GateReason;
  /** The reason ends the cycle rather than waiting. */
  stop?: boolean;
  /** The idle the check wanted and the idle it saw. */
  idle?: { required: number; seen: number };
}

export interface GateCaps {
  now: number;
  /** Cycle deadline as a timestamp. */
  deadline: number;
  /** The task's wall-clock budget. */
  taskSeconds: number;
  cooldownSeconds: number;
  /** --allow-app-running: the person accepted a second agent on the desktop. */
  allowAppRunning?: boolean;
}

/**
 * The gate, checked before every attempt and while waiting. The order is
 * cheapest-to-recover first: a time box is final, a lock or a dark display
 * waits without a person, a held display and an app run wait for something
 * to finish, and idle is checked last so a wait is logged under its cause.
 * Without a tap (before the helper's first resume, or in a dry run) HID idle
 * stands in and the full --idle is required, because it counts the agent's
 * own input too.
 */
export function gateDecision(
  report: GateReport,
  state: GateState,
  caps: GateCaps,
): GateDecision {
  const margin = (caps.taskSeconds + caps.cooldownSeconds + 30) * 1000;
  if (caps.now + margin > caps.deadline)
    return { ok: false, reason: "TIME_BOX", stop: true };
  if (report.locked) return { ok: false, reason: "LOCKED" };
  if (report.displayAsleep) return { ok: false, reason: "DISPLAY_OFF" };
  // A failed ps or pmset read is not an empty desktop: wait for one that
  // answers, like an unreadable lock counts as locked.
  if (report.unreadable) return { ok: false, reason: "PRESENCE_UNKNOWN" };
  if (report.displayHolders > 0)
    return { ok: false, reason: "DISPLAY_HELD_BY_OTHER" };
  // Another harness marks its helper's input like ours, and so does the app:
  // this harness's tap would never see either. Two agents on one desktop.
  if (report.harnessProcesses > 0)
    return { ok: false, reason: "HARNESS_RUNNING" };
  // The app starts a texted task at once.
  if (report.appProcesses > 0 && !caps.allowAppRunning)
    return { ok: false, reason: "APP_RUNNING" };
  // A run the log never saw settle is in flight only while the app runs:
  // one a crash or a force-quit left unsettled never finishes.
  if (report.unsettledAppRuns > 0 && report.appProcesses > 0)
    return { ok: false, reason: "APP_RUN_ACTIVE" };
  const tapped = report.tapIdleSeconds !== null;
  const required = tapped ? idleRequired(state, caps.now) : state.idleSeconds;
  const seen = tapped
    ? (report.tapIdleSeconds as number)
    : report.hidIdleSeconds;
  if (seen < required)
    return { ok: false, reason: "HID_ACTIVE", idle: { required, seen } };
  return { ok: true, idle: { required, seen } };
}

/* -------------------------------------------------------------- preflight */

/**
 * Refusals of the whole cycle. Conditions that concern only some tasks (the
 * agenda grant and local source, the fixture port, applications missing or
 * open) skip those tasks instead: preflight.ts.
 */
export type PreflightCode =
  | "APP_RUNNING"
  | "HARNESS_RUNNING"
  | "SCREENSAVER_TOO_SOON"
  | "LOCKED"
  | "DISPLAY_OFF"
  | "DISPLAY_HELD_BY_OTHER"
  | "APP_RUN_ACTIVE"
  | "PRESENCE_UNKNOWN";

export interface PreflightInput {
  appPids: number[];
  allowAppRunning: boolean;
  /** Other harness processes driving this desktop. */
  harnessPids?: number[];
  /** ps or pmset could not be read. */
  unreadable?: boolean;
  /** Display-sleep holders other than ours and the ones the person allowed. */
  displayHolders: number;
  /** Seconds; 0 or undefined means the screensaver never starts. */
  screensaverIdleSeconds?: number;
  timeBoxSeconds: number;
  locked: boolean;
  displayAsleep: boolean;
  /** undefined when the app's diagnostics log does not exist. */
  unsettledAppRuns?: number;
}

/**
 * Refusals, not warnings. Every one names a condition that would make an
 * unattended run either unsafe (two agents on one desktop) or pointless (a
 * lock that stalls the gate until morning), and every one is something the
 * person can fix before leaving.
 */
export function preflight(input: PreflightInput): PreflightCode[] {
  const codes: PreflightCode[] = [];
  if (input.unreadable) codes.push("PRESENCE_UNKNOWN");
  if (input.harnessPids?.length) codes.push("HARNESS_RUNNING");
  if (input.appPids.length && !input.allowAppRunning) codes.push("APP_RUNNING");
  const saver = input.screensaverIdleSeconds ?? 0;
  // The screensaver leads to a lock; caffeinate -d keeps the display on, not
  // the saver off. Anything shorter than the time box will fire mid-cycle.
  if (saver > 0 && saver < input.timeBoxSeconds)
    codes.push("SCREENSAVER_TOO_SOON");
  if (input.locked) codes.push("LOCKED");
  if (input.displayAsleep) codes.push("DISPLAY_OFF");
  // The gate waits while anything else holds the display awake, because a
  // person may be watching it; a holder that never lets go (a forgotten
  // caffeinate) would hold the cycle until morning, so it is refused here.
  if (input.displayHolders > 0) codes.push("DISPLAY_HELD_BY_OTHER");
  // Only a running app can have a run in flight; an unsettled run in the log
  // of an app that is not running was cut off by a crash and never ends.
  if ((input.unsettledAppRuns ?? 0) > 0 && input.appPids.length)
    codes.push("APP_RUN_ACTIVE");
  return codes;
}

/* --------------------------------------------------------------- readers */

/**
 * Runs a read-only command and returns its stdout, or undefined when it
 * failed or timed out: a failed read must never look like an empty one.
 */
export type Exec = (
  command: string,
  args: string[],
) => Promise<string | undefined>;

export interface PresenceSource {
  /** The native controller, when the cycle has one. */
  presence?: () => Promise<PresenceReport>;
  exec: Exec;
  /** Pids whose display-sleep assertions are ours (the caffeinate child). */
  ownPids: () => number[];
  /** Holder names the person allowed (--allow-display-holder). */
  allowedHolders?: string[];
  /** The allowed holders' pids as the start saw them; the gate uses these. */
  allowedHolderPids?: () => number[];
  /** This repository's checkouts, to recognise a development app. */
  roots: string[];
  /** This process's pid, never counted as the app. */
  pid: number;
  /** The app's diagnostics log text (last part), or undefined when absent. */
  appDiagnostics: () => string | undefined;
}

/**
 * The screensaver delay macOS uses when nobody ever set one (UNCONFIRMED for
 * every release; 20 minutes on the Macs checked). An unset delay is taken to
 * be this, not "never": the refusal side, since the lock that follows would
 * stall the gate all night.
 */
export const SCREENSAVER_DEFAULT_SECONDS = 1200;

/** What the system says without the helper: for --dry-run, --preflight and the start. */
export interface SystemFacts {
  hidIdleSeconds?: number;
  locked: boolean;
  /** 0: the screensaver never starts. */
  screensaverIdleSeconds: number;
  /** No setting was found and the macOS default was assumed. */
  screensaverAssumed: boolean;
  displayHolders: AssertionHolder[];
  /** Holders the names in --allow-display-holder matched, by pid. */
  allowedHolders: AssertionHolder[];
  appPids: number[];
  harnessPids: number[];
  /** ps or pmset could not be read. */
  unreadable: boolean;
}

/** Read-only probes: ioreg, plutil, defaults, pmset and ps. */
export async function readSystem(source: PresenceSource): Promise<SystemFacts> {
  const [idle, root, hostSaver, userSaver, assertions, ps] = await Promise.all([
    source.exec("ioreg", ["-c", "IOHIDSystem", "-d", "4"]),
    source.exec("sh", [
      "-c",
      "ioreg -n Root -d1 -a | plutil -convert json -o - -",
    ]),
    source.exec("defaults", [
      "-currentHost",
      "read",
      "com.apple.screensaver",
      "idleTime",
    ]),
    source.exec("defaults", ["read", "com.apple.screensaver", "idleTime"]),
    source.exec("pmset", ["-g", "assertions"]),
    source.exec("ps", ["-axo", "pid=,command="]),
  ]);
  // `defaults read` fails when the key was never set: that is the unset
  // case below, not an unreadable one.
  const saver =
    parseScreensaverIdle(hostSaver ?? "") ??
    parseScreensaverIdle(userSaver ?? "");
  let json: unknown;
  try {
    json = JSON.parse(root ?? "");
  } catch {
    json = undefined;
  }
  const holders = parseAssertions(assertions ?? "", {
    ownPids: source.ownPids(),
  });
  const allowed = new Set(source.allowedHolders ?? []);
  return {
    hidIdleSeconds: parseHidIdle(idle ?? ""),
    // Unreadable reads as locked: the refusal side.
    locked: parseConsoleLocked(json),
    screensaverIdleSeconds: saver ?? SCREENSAVER_DEFAULT_SECONDS,
    screensaverAssumed: saver === undefined,
    displayHolders: holders.filter((holder) => !allowed.has(holder.name)),
    allowedHolders: holders.filter((holder) => allowed.has(holder.name)),
    appPids: appProcesses(ps ?? "", source.roots, source.pid),
    harnessPids: harnessProcesses(ps ?? "", source.pid),
    unreadable: assertions === undefined || ps === undefined,
  };
}

/**
 * One gate report. The helper answers idle, lock and display when it can;
 * otherwise the same facts come from ioreg, with tapIdleSeconds null so the
 * rules require the full --idle. pmset, ps and the app log are read either
 * way.
 */
export async function readGate(source: PresenceSource): Promise<GateReport> {
  let base: PresenceReport | undefined;
  if (source.presence) {
    try {
      base = await source.presence();
    } catch {
      base = undefined;
    }
  }
  const [assertions, ps] = await Promise.all([
    source.exec("pmset", ["-g", "assertions"]),
    source.exec("ps", ["-axo", "pid=,command="]),
  ]);
  let from: GateReport["source"] = "helper";
  if (!base) {
    from = "system";
    const system = await readSystem(source);
    base = {
      // No reading is no evidence of absence.
      hidIdleSeconds: system.hidIdleSeconds ?? 0,
      tapIdleSeconds: null,
      locked: system.locked,
      displayAsleep: false,
      displayHeldAwake: false,
    };
  }
  const log = source.appDiagnostics();
  return {
    ...base,
    displayHolders: parseAssertions(assertions ?? "", {
      ownPids: source.ownPids(),
      allowedPids: source.allowedHolderPids?.() ?? [],
    }).length,
    appProcesses: appProcesses(ps ?? "", source.roots, source.pid).length,
    harnessProcesses: harnessProcesses(ps ?? "", source.pid).length,
    unsettledAppRuns: log === undefined ? 0 : unsettledRuns(log),
    unreadable: assertions === undefined || ps === undefined,
    source: from,
  };
}

/* ------------------------------------------------------------ the lock */

/** Who is driving this Mac's desktop with a model. */
export interface DesktopLockOwner {
  pid: number;
  /** "harness-cycle" or "bench". */
  script: string;
  cycle?: string;
  startedAt: string;
}

/**
 * One lock for the whole Mac, whichever checkout or --out-dir a harness runs
 * from: a lock inside one checkout's output folder cannot see a cycle in a
 * worktree next to it.
 */
export function desktopLockPath(home = homedir()): string {
  return join(home, "Library", "Caches", "open-assist", "desktop.lock");
}

/** Whether a pid is a live process; EPERM means alive but someone else's. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwner(file: string): DesktopLockOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as DesktopLockOwner;
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0
      ? owner
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the desktop lock before anything waits or drives the desktop, or
 * says who holds it. The owner is written in full under a temporary name and
 * linked into place, and a link fails when the lock exists: two harnesses
 * starting at the same moment cannot both win, and nobody ever reads a
 * half-written owner. A lock whose owner is gone (a crash, a power loss) is
 * taken over; one that cannot be read is left for the person to remove.
 */
export function acquireDesktopLock(
  file: string,
  owner: DesktopLockOwner,
  alive: (pid: number) => boolean = pidAlive,
): { ok: true } | { ok: false; holder?: DesktopLockOwner } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${owner.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(owner) + "\n", { mode: 0o600 });
  try {
    for (let tries = 0; tries < 2; tries++) {
      try {
        linkSync(temp, file);
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = lockOwner(file);
      if (!holder) return { ok: false };
      // Our own pid in an old lock is a reused pid, not a second harness.
      if (holder.pid !== owner.pid && alive(holder.pid))
        return { ok: false, holder };
      rmSync(file, { force: true });
    }
    return { ok: false, holder: lockOwner(file) };
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Gives the lock up, only if it is still this process's. */
export function releaseDesktopLock(file: string, pid: number): void {
  if (lockOwner(file)?.pid === pid) rmSync(file, { force: true });
}
