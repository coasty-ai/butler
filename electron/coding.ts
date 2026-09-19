/**
 * Coding delegation: the owner hands a task to Claude Code or Codex by voice
 * and Butler drives the CLI for them, the way a person would at a terminal,
 * without a screen run and without a model call of its own. With tmux
 * installed, every (agent, project) pair gets one detached session the owner
 * can attach to from any terminal; the task is typed into the agent's own
 * interactive CLI and its pane is read back once a second. Without tmux, the
 * CLIs' non-interactive modes run one turn per process and their JSON lines
 * feed the same state machine (src/coding/classify.ts, src/coding/state.ts).
 *
 * What the agent asks, Butler relays and never answers: a permission or
 * yes-or-no prompt stays on screen until the owner says "tell it yes" or
 * "tell it no", which is the only path that presses a key into such a prompt
 * (answer()), whatever the autonomy setting. The CLI runs with its own
 * default permission mode; nothing here passes a flag that widens it. No
 * text with a credential in it is ever typed (scanText), and a delegation
 * targets only a folder the owner named or the editor in front has open
 * (src/coding/project.ts). Pane and stream text never enter a trace: the
 * events carry the agent, a hash of the folder, the state and a code.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
  INTERRUPT_KEY,
  binaryCandidates,
  binaryDirs,
  codingAgents,
  printTurn,
  sessionName,
  attachCommand,
  tmuxCapture,
  tmuxHasSession,
  tmuxKillSession,
  tmuxNewSession,
  tmuxSendKey,
  tmuxSendText,
  type Argv,
  type CodingAgentId,
} from "../src/coding/agents";
import { classifyPane, readStreamLine } from "../src/coding/classify";
import { resolveProject, type ProjectResolution } from "../src/coding/project";
import {
  applyReading,
  busy,
  markSent,
  markStatus,
  type CodingTransport,
  type Delegation,
  type DelegationStatus,
} from "../src/coding/state";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";
import { fnv1a } from "../src/core/monitor";
import { scanText } from "../src/core/sanitize";
import type { RunOrigin } from "../src/core/schema";

/** A CLI turn running in print mode: its stdout by lines, its end, and two signals. */
export interface CodingProcess {
  onLine(fn: (line: string) => void): void;
  onExit(fn: (code: number | null) => void): void;
  interrupt(): void;
  kill(): void;
}
export interface CodingIo {
  exists(path: string): boolean;
  isDir(path: string): boolean;
  entries(dir: string): string[];
  /** One command, no shell; ok is a zero exit. */
  exec(
    argv: Argv,
    o: { cwd?: string; env: Record<string, string> },
  ): Promise<{ ok: boolean; stdout: string }>;
  spawn(
    argv: Argv,
    o: { cwd: string; env: Record<string, string> },
  ): CodingProcess;
}
export type CodingEvent =
  /** The words went in, or the session is up and will take them at its prompt. */
  | { type: "started"; d: Delegation }
  /** The status moved: a question, idle, finished, an error, working again. */
  | { type: "changed"; d: Delegation; from: DelegationStatus }
  /** The session is gone: quit by the owner, or ended on its own. */
  | { type: "ended"; d: Delegation };
export interface CodingDelegateOptions {
  home: string;
  io: CodingIo;
  /** The parent's environment; only a fixed few names are passed on. */
  env?: Record<string, string | undefined>;
  onEvent(e: CodingEvent): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  trace?: DiagnosticSink;
}
export type StartResult =
  | { ok: true; d: Delegation }
  | {
      ok: false;
      reason: "secret" | "no_binary" | "busy" | "too_many" | "failed";
    };
export type TellResult = "sent" | "queued" | "yes_no" | "secret" | "gone";
export type AnswerResult = "sent" | "no_question" | "cannot" | "gone";

/** How often a pane is read. */
export const POLL_MS = 1000;
/**
 * After typing into a pane, reads that say idle or finished are ignored this
 * long: the agent has not drawn its answer yet, and its prompt is still on
 * screen.
 */
export const SETTLE_MS = 3000;
/** Sessions at once; each is a process of its own on the owner's Mac. */
export const DELEGATIONS_MAX = 4;
/** The process' `exec` timeout: tmux answers at once or not at all. */
const EXEC_TIMEOUT_MS = 5000;

/**
 * The environment the CLIs run with: the home folder (their own login and
 * settings live there), a fixed PATH, a terminal type for the interactive
 * CLIs, and the locale. Never the parent's environment whole: Butler's own
 * variables are not the agent's business.
 */
export function childEnv(
  home: string,
  parent: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    PATH: binaryDirs(home).join(":"),
    TERM: "xterm-256color",
    LANG: parent.LANG || "en_US.UTF-8",
  };
  for (const key of ["TMPDIR", "LC_ALL"])
    if (parent[key]) env[key] = parent[key]!;
  return env;
}
/** A folder as a trace code: a prefix and twelve hex digits, never the path. */
export function projectCode(dir: string): string {
  return `p${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}
const hasSecret = (text: string) =>
  scanText(text).some((f) => f.action === "BLOCK_UPLOAD");

interface Live {
  d: Delegation;
  timer?: unknown;
  /** The last pane text's hash, to notice change. */
  paneHash?: string;
  /** Print mode: the turn under way. */
  proc?: CodingProcess;
  /** Typed once a fresh session shows its prompt (after any trust question). */
  pendingTask?: string;
  settleUntil: number;
  /** A capture is in flight. */
  reading: boolean;
}

export class CodingDelegate {
  private live = new Map<string, Live>();
  private counter = 0;
  private binaries = new Map<string, string | undefined>();
  private readonly env: Record<string, string>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  constructor(private o: CodingDelegateOptions) {
    this.env = childEnv(o.home, o.env);
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Where a CLI is, looked up once against the fixed directories. */
  private binary(name: string): string | undefined {
    if (!this.binaries.has(name))
      this.binaries.set(
        name,
        binaryCandidates(name, this.o.home).find((path) =>
          this.o.io.exists(path),
        ),
      );
    return this.binaries.get(name);
  }
  /** Attachable tmux sessions when tmux is installed; the CLIs' print modes otherwise. */
  transport(): CodingTransport {
    return this.binary("tmux") ? "tmux" : "print";
  }
  available(agent: CodingAgentId): boolean {
    return !!this.binary(codingAgents[agent].binary);
  }
  resolveProject(
    named: string | undefined,
    editor?: { appId?: string; title?: string },
  ): ProjectResolution {
    return resolveProject(
      { named, editor },
      {
        home: this.o.home,
        isDir: (path) => this.o.io.isDir(path),
        entries: (dir) => this.o.io.entries(dir),
      },
    );
  }
  list(): Delegation[] {
    return [...this.live.values()].map((l) => l.d);
  }
  /** The named agent's delegation, or the one most recently active. */
  find(agent?: CodingAgentId): Delegation | undefined {
    const all = this.list()
      .filter((d) => !agent || d.agent === agent)
      .sort((a, b) => b.lastChangeAt - a.lastChangeAt);
    return all[0];
  }

  /**
   * Hands the task over. A session for the same agent and folder is reused
   * when it is idle or done; one still busy refuses, so two tasks are never
   * typed over each other. The task is the owner's words and is scanned for
   * credentials first; nothing else is ever typed.
   */
  async start(
    agent: CodingAgentId,
    dir: string,
    task: string,
    origin?: RunOrigin,
  ): Promise<StartResult> {
    if (hasSecret(task)) return { ok: false, reason: "secret" };
    const binary = this.binary(codingAgents[agent].binary);
    if (!binary) return { ok: false, reason: "no_binary" };
    const key = `${agent}:${dir}`;
    let live = this.live.get(key);
    if (live && busy(live.d.status)) return { ok: false, reason: "busy" };
    if (!live && this.live.size >= DELEGATIONS_MAX)
      return { ok: false, reason: "too_many" };
    const transport = this.transport();
    const now = this.now();
    const project = projectCode(dir);
    if (transport === "print") {
      live ??= this.create(agent, dir, task, origin, "print", now);
      this.live.set(key, live);
      live.d = markSent(live.d, now, task);
      this.spawnTurn(live, task);
      trace(this.o.trace, "CodingDelegated", {
        source: codingAgents[agent].short,
        mode: transport,
        project,
        code: live.d.resumeId ? "resumed" : "new",
      });
      this.o.onEvent({ type: "started", d: live.d });
      return { ok: true, d: live.d };
    }
    const session = sessionName(agent, dir);
    if (!live) {
      live = this.create(agent, dir, task, origin, "tmux", now, session);
      this.live.set(key, live);
      const exists = (await this.exec(tmuxHasSession(session))).ok;
      if (!exists) {
        const created = await this.exec(
          tmuxNewSession(session, dir, binary),
          dir,
        );
        if (!created.ok) {
          this.live.delete(key);
          trace(this.o.trace, "CodingStartFailed", {
            source: codingAgents[agent].short,
            mode: transport,
            project,
          });
          return { ok: false, reason: "failed" };
        }
        // Typed once the CLI shows its prompt (after any trust question).
        live.pendingTask = task;
        trace(this.o.trace, "CodingDelegated", {
          source: codingAgents[agent].short,
          mode: transport,
          project,
          code: "new",
        });
        this.o.onEvent({ type: "started", d: live.d });
        this.schedule(live, POLL_MS);
        return { ok: true, d: live.d };
      }
    }
    // A session already at its prompt: the words go straight in.
    if (!(await this.type(live, task, task)))
      return { ok: false, reason: "failed" };
    trace(this.o.trace, "CodingDelegated", {
      source: codingAgents[agent].short,
      mode: transport,
      project,
      code: "reused",
    });
    this.o.onEvent({ type: "started", d: live.d });
    this.schedule(live, POLL_MS);
    return { ok: true, d: live.d };
  }

  /** Relays the owner's words to the agent, as they said them. */
  async tell(id: string, text: string): Promise<TellResult> {
    const live = this.byId(id);
    if (!live) return "gone";
    if (hasSecret(text)) return "secret";
    // A permission prompt takes a yes or a no, nothing typed.
    if (live.d.status === "asks_yes_no") return "yes_no";
    if (live.d.transport === "tmux")
      return (await this.type(live, text)) ? "sent" : "gone";
    if (live.proc) {
      live.d = { ...live.d, pending: [...live.d.pending, text] };
      return "queued";
    }
    live.d = markSent(live.d, this.now());
    this.spawnTurn(live, text);
    return "sent";
  }

  /**
   * The owner's yes or no to the question the agent is showing: the one and
   * only path that presses a key into a permission prompt. It exists for the
   * owner's explicit words and is never called by a tick, a timer or a
   * setting. Print mode has no prompt to answer: the CLI decided already.
   */
  async answer(id: string, yes: boolean): Promise<AnswerResult> {
    const live = this.byId(id);
    if (!live) return "gone";
    if (live.d.status !== "asks_yes_no") return "no_question";
    if (live.d.transport !== "tmux" || !live.d.keys) return "cannot";
    const key = yes ? live.d.keys.yes : live.d.keys.no;
    const sent = await this.exec(tmuxSendKey(live.d.session!, key));
    if (!sent.ok) {
      this.end(live, "gone");
      return "gone";
    }
    trace(this.o.trace, "CodingAnswered", {
      source: codingAgents[live.d.agent].short,
      code: yes ? "yes" : "no",
    });
    const now = this.now();
    live.d = markStatus(live.d, "working", now);
    live.settleUntil = now + SETTLE_MS;
    return "sent";
  }

  /** Ctrl-C to the pane, or SIGINT to the turn: the agent stops, the session stays. */
  async interrupt(id: string): Promise<boolean> {
    const live = this.byId(id);
    if (!live) return false;
    if (live.d.transport === "tmux") {
      const sent = await this.exec(tmuxSendKey(live.d.session!, INTERRUPT_KEY));
      if (!sent.ok) {
        this.end(live, "gone");
        return false;
      }
    } else live.proc?.interrupt();
    trace(this.o.trace, "CodingInterrupted", {
      source: codingAgents[live.d.agent].short,
      status: live.d.status,
    });
    const now = this.now();
    live.d = markStatus(live.d, "stopped", now);
    live.settleUntil = now + SETTLE_MS;
    return true;
  }
  /** The owner's stop, with nothing else to stop: every agent at work is interrupted. */
  interruptWorking(): number {
    const working = [...this.live.values()].filter((l) => busy(l.d.status));
    for (const live of working) void this.interrupt(live.d.id);
    return working.length;
  }
  /** Ends the session: the tmux session is killed, or the print turn with its process. */
  async quit(id: string): Promise<boolean> {
    const live = this.byId(id);
    if (!live) return false;
    if (live.d.transport === "tmux")
      await this.exec(tmuxKillSession(live.d.session!));
    else live.proc?.kill();
    this.end(live, "quit");
    return true;
  }
  /**
   * At quit: print turns die with Butler (their process is Butler's), tmux
   * sessions stay for the owner to attach to; a later start finds them again.
   */
  closeAll() {
    for (const live of this.live.values()) {
      this.unschedule(live);
      live.proc?.kill();
    }
    this.live.clear();
  }

  private byId(id: string): Live | undefined {
    return [...this.live.values()].find((l) => l.d.id === id);
  }
  private keyOf(live: Live) {
    return `${live.d.agent}:${live.d.dir}`;
  }
  private create(
    agent: CodingAgentId,
    dir: string,
    task: string,
    origin: RunOrigin | undefined,
    transport: CodingTransport,
    now: number,
    session?: string,
  ): Live {
    return {
      d: {
        id: `c${++this.counter}`,
        agent,
        dir,
        task,
        ...(origin ? { origin } : {}),
        transport,
        ...(session ? { session, attach: attachCommand(session) } : {}),
        status: "starting",
        startedAt: now,
        since: now,
        lastChangeAt: now,
        pending: [],
        seq: 0,
      },
      settleUntil: 0,
      reading: false,
    };
  }
  private exec(argv: Argv, cwd?: string) {
    const command = this.binary(argv.command);
    if (!command) return Promise.resolve({ ok: false, stdout: "" });
    return this.o.io.exec(
      { command, args: argv.args },
      { ...(cwd ? { cwd } : {}), env: this.env },
    );
  }
  /** Types the words and Enter; the agent is working on them from now. */
  private async type(live: Live, text: string, task?: string) {
    for (const argv of tmuxSendText(live.d.session!, text)) {
      const sent = await this.exec(argv);
      if (!sent.ok) {
        this.end(live, "gone");
        return false;
      }
    }
    const now = this.now();
    live.d = markSent(live.d, now, task);
    live.settleUntil = now + SETTLE_MS;
    trace(this.o.trace, "CodingTyped", {
      source: codingAgents[live.d.agent].short,
      textLength: text.length,
    });
    return true;
  }
  private schedule(live: Live, ms: number) {
    this.unschedule(live);
    live.timer = this.setTimer(() => void this.tick(live), ms);
  }
  private unschedule(live: Live) {
    if (live.timer !== undefined) this.clearTimer(live.timer);
    live.timer = undefined;
  }
  /** One read of the pane, and whatever it changes. */
  private async tick(live: Live) {
    if (live.reading || !this.live.has(this.keyOf(live))) return;
    live.reading = true;
    try {
      const captured = await this.exec(tmuxCapture(live.d.session!));
      if (!this.live.has(this.keyOf(live))) return;
      if (!captured.ok) {
        this.end(live, "gone");
        return;
      }
      const now = this.now();
      const hash = fnv1a(captured.stdout);
      if (hash !== live.paneHash) {
        live.paneHash = hash;
        live.d = { ...live.d, lastChangeAt: now };
      }
      const reading = classifyPane(live.d.agent, captured.stdout);
      // Right after typing, the prompt still shows and the answer has not
      // been drawn: idle and finished are last tick's news.
      if (
        now < live.settleUntil &&
        (reading.status === "idle" || reading.status === "finished")
      )
        return;
      const from = live.d.status;
      const t = applyReading(live.d, reading, now);
      live.d = t.next;
      if (live.pendingTask && live.d.status === "idle") {
        const task = live.pendingTask;
        live.pendingTask = undefined;
        await this.type(live, task, task);
        return;
      }
      if (t.changed) {
        trace(this.o.trace, "CodingStateChanged", {
          source: codingAgents[live.d.agent].short,
          status: live.d.status,
        });
        this.o.onEvent({ type: "changed", d: live.d, from });
      }
    } finally {
      live.reading = false;
      if (this.live.has(this.keyOf(live))) this.schedule(live, POLL_MS);
    }
  }
  /** One print-mode turn: the CLI runs the words and its JSON lines are read as they come. */
  private spawnTurn(live: Live, text: string) {
    const binary = this.binary(codingAgents[live.d.agent].binary)!;
    const argv = printTurn(live.d.agent, text, live.d.resumeId);
    const proc = this.o.io.spawn(
      { command: binary, args: argv.args },
      { cwd: live.d.dir, env: this.env },
    );
    live.proc = proc;
    trace(this.o.trace, "CodingTurnStarted", {
      source: codingAgents[live.d.agent].short,
      code: live.d.resumeId ? "resumed" : "new",
      textLength: text.length,
    });
    proc.onLine((line) => {
      if (live.proc !== proc) return;
      const reading = readStreamLine(live.d.agent, line);
      if (!reading) return;
      const from = live.d.status;
      const t = applyReading(live.d, reading, this.now());
      live.d = t.next;
      if (t.changed) {
        trace(this.o.trace, "CodingStateChanged", {
          source: codingAgents[live.d.agent].short,
          status: live.d.status,
        });
        this.o.onEvent({ type: "changed", d: live.d, from });
      }
    });
    proc.onExit((code) => {
      if (live.proc !== proc) return;
      live.proc = undefined;
      const now = this.now();
      trace(this.o.trace, "CodingTurnEnded", {
        source: codingAgents[live.d.agent].short,
        exitCode: code ?? -1,
        status: live.d.status,
      });
      // A turn that ended without its result line: the exit code says how.
      if (busy(live.d.status)) {
        const from = live.d.status;
        live.d = markStatus(live.d, code === 0 ? "finished" : "error", now);
        this.o.onEvent({ type: "changed", d: live.d, from });
      }
      if (live.d.pending.length) {
        const next = live.d.pending.join("\n");
        live.d = markSent({ ...live.d, pending: [] }, now);
        this.spawnTurn(live, next);
      }
    });
  }
  private end(live: Live, reason: "quit" | "gone") {
    if (!this.live.delete(this.keyOf(live))) return;
    this.unschedule(live);
    live.d = markStatus(live.d, "ended", this.now());
    trace(this.o.trace, "CodingEnded", {
      source: codingAgents[live.d.agent].short,
      code: reason,
      durationMs: this.now() - live.d.startedAt,
    });
    this.o.onEvent({ type: "ended", d: live.d });
  }
}

/** The real file system and processes, for main. */
export function nodeCodingIo(): CodingIo {
  return {
    exists: (path) => existsSync(path),
    isDir: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    entries: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    exec: (argv, o) =>
      new Promise((resolve) =>
        execFile(
          argv.command,
          argv.args,
          {
            ...(o.cwd ? { cwd: o.cwd } : {}),
            env: o.env,
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout) =>
            resolve({ ok: !error, stdout: String(stdout ?? "") }),
        ),
      ),
    spawn: (argv, o) => {
      const child = spawn(argv.command, argv.args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lineHandlers: ((line: string) => void)[] = [];
      const exitHandlers: ((code: number | null) => void)[] = [];
      let rest = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        rest += chunk;
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        for (const part of parts)
          if (part.trim()) for (const fn of lineHandlers) fn(part);
      });
      // The agent's stderr is its own diagnostics: read so it never blocks, kept nowhere.
      child.stderr.resume();
      child.on("error", () => {});
      child.on("close", (code) => {
        if (rest.trim()) for (const fn of lineHandlers) fn(rest);
        rest = "";
        for (const fn of exitHandlers) fn(code);
      });
      return {
        onLine: (fn) => void lineHandlers.push(fn),
        onExit: (fn) => void exitHandlers.push(fn),
        interrupt: () => void child.kill("SIGINT"),
        kill: () => void child.kill("SIGTERM"),
      };
    },
  };
}
