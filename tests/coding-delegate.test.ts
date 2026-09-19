import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingDelegate,
  DELEGATIONS_MAX,
  POLL_MS,
  SETTLE_MS,
  childEnv,
  projectCode,
  type CodingEvent,
  type CodingIo,
  type CodingProcess,
} from "../electron/coding";
import { LocalDiagnostics } from "../electron/diagnostics";
import { WIDENING_FLAGS } from "../src/coding/agents";

// Nothing here runs tmux or a CLI: every command is recorded, and the pane
// or stream is authored text handed back to the delegate.
const home = "/Users/nkov";
const dir = `${home}/open-assist`;
const claudeBin = `${home}/.local/bin/claude`;
const codexBin = `${home}/.local/bin/codex`;
const tmuxBin = "/opt/homebrew/bin/tmux";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
function clock() {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at);
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
class FakeProcess implements CodingProcess {
  lines: ((line: string) => void)[] = [];
  exits: ((code: number | null) => void)[] = [];
  interrupted = false;
  killed = false;
  constructor(
    readonly argv: { command: string; args: string[] },
    readonly cwd: string,
    readonly env: Record<string, string>,
  ) {}
  onLine(fn: (line: string) => void) {
    this.lines.push(fn);
  }
  onExit(fn: (code: number | null) => void) {
    this.exits.push(fn);
  }
  interrupt() {
    this.interrupted = true;
  }
  kill() {
    this.killed = true;
  }
  emit(line: string) {
    for (const fn of this.lines) fn(line);
  }
  exit(code: number) {
    for (const fn of this.exits) fn(code);
  }
}
/** A Mac with the two CLIs, with or without tmux, and one tmux server in a Set. */
function fixture(o: { tmux: boolean; pane?: () => string }) {
  const files = new Set([claudeBin, codexBin, ...(o.tmux ? [tmuxBin] : [])]);
  const dirs = new Set([home, dir, `${home}/code`]);
  const sessions = new Set<string>();
  const calls: string[][] = [];
  const envs: Record<string, string>[] = [];
  const procs: FakeProcess[] = [];
  const events: CodingEvent[] = [];
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const io: CodingIo = {
    exists: (path) => files.has(path),
    isDir: (path) => dirs.has(path),
    entries: (path) =>
      path === home
        ? ["open-assist", "code"]
        : path === `${home}/code`
          ? []
          : [],
    exec: async (argv, opts) => {
      calls.push([argv.command, ...argv.args]);
      envs.push(opts.env);
      const [sub] = argv.args;
      const target = argv.args[argv.args.indexOf("-t") + 1];
      if (sub === "has-session")
        return { ok: sessions.has(target), stdout: "" };
      if (sub === "new-session") {
        sessions.add(argv.args[argv.args.indexOf("-s") + 1]);
        return { ok: true, stdout: "" };
      }
      if (!sessions.has(target)) return { ok: false, stdout: "" };
      if (sub === "capture-pane") return { ok: true, stdout: o.pane?.() ?? "" };
      if (sub === "kill-session") sessions.delete(target);
      return { ok: true, stdout: "" };
    },
    spawn: (argv, opts) => {
      const proc = new FakeProcess(argv, opts.cwd, opts.env);
      procs.push(proc);
      return proc;
    },
  };
  const c = clock();
  const delegate = new CodingDelegate({
    home,
    io,
    env: { TMPDIR: "/tmp/x", COARENA_SECRET: "never", LANG: "en_US.UTF-8" },
    onEvent: (e) => events.push(e),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    trace: (event, data = {}) => traces.push({ event, data }),
  });
  /** What was pressed or typed: send-keys calls minus tmux, the verb and the target. */
  const sent = () =>
    calls
      .filter((call) => call[1] === "send-keys")
      .map((call) => call.slice(4));
  return {
    delegate,
    calls,
    envs,
    procs,
    events,
    traces,
    sessions,
    sent,
    clock: c,
    files,
  };
}

const welcome = `
╭───────────────────────────────╮
│ ✻ Welcome to Claude Code!     │
╰───────────────────────────────╯
╭───────────────────────────────╮
│ > Try "fix lint errors"       │
╰───────────────────────────────╯
  ? for shortcuts
`;
const working = `
> fix the failing test

✻ Thinking… (2s · esc to interrupt)

│ > │
  ? for shortcuts
`;
const permission = `
> fix the failing test

⏺ Bash(npm test)

╭──────────────────────────────────────────────────────╮
│ Bash command                                         │
│   npm test                                           │
│ Do you want to proceed?                              │
│ ❯ 1. Yes                                             │
│   2. Yes, and don't ask again for npm commands       │
│   3. No, and tell Claude what to do differently (esc)│
╰──────────────────────────────────────────────────────╯
`;
const finished = `
> fix the failing test

⏺ Bash(npm test)
  ⎿  13 passed

⏺ Fixed the failing test. All 13 tests pass.

│ > │
  ? for shortcuts
`;
const trust = `
╭──────────────────────────────────────────╮
│ Do you trust the files in this folder?   │
│ /Users/nkov/open-assist                  │
│ ❯ 1. Yes, proceed                        │
│   2. No, exit                            │
╰──────────────────────────────────────────╯
`;

describe("coding delegate: tmux sessions", () => {
  it("starts the agent's CLI detached, types the task once the prompt shows, and reads the pane every second", async () => {
    let pane = welcome;
    const f = fixture({ tmux: true, pane: () => pane });
    expect(f.delegate.transport()).toBe("tmux");
    expect(f.delegate.available("claude-code")).toBe(true);
    const started = await f.delegate.start(
      "claude-code",
      dir,
      "fix the failing test",
      "voice",
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.d).toMatchObject({
      agent: "claude-code",
      dir,
      transport: "tmux",
      session: "butler-claude-open-assist",
      attach: "tmux attach -t butler-claude-open-assist",
      status: "starting",
      origin: "voice",
    });
    expect(f.calls).toEqual([
      [tmuxBin, "has-session", "-t", "butler-claude-open-assist"],
      [
        tmuxBin,
        "new-session",
        "-d",
        "-s",
        "butler-claude-open-assist",
        "-c",
        dir,
        "-x",
        "160",
        "-y",
        "50",
        claudeBin,
      ],
    ]);
    expect(f.events.map((e) => e.type)).toEqual(["started"]);
    // The first read finds the prompt: the words go in, and Enter.
    await f.clock.advance(POLL_MS);
    expect(f.sent()).toEqual([["-l", "fix the failing test"], ["Enter"]]);
    expect(f.delegate.find()!.status).toBe("working");
    // Typing is not news; the reads go on.
    expect(f.events.map((e) => e.type)).toEqual(["started"]);
    expect(f.clock.pending()).toBe(1);
    pane = working;
    await f.clock.advance(SETTLE_MS + POLL_MS);
    expect(f.delegate.find()!.status).toBe("working");
    expect(
      f.calls.filter((c) => c[1] === "capture-pane").length,
    ).toBeGreaterThan(2);
  });

  it("relays a permission question and never answers it, however long it stays and whatever the settings", async () => {
    let pane = welcome;
    const f = fixture({ tmux: true, pane: () => pane });
    await f.delegate.start("claude-code", dir, "fix the failing test", "voice");
    await f.clock.advance(POLL_MS);
    pane = permission;
    await f.clock.advance(SETTLE_MS + POLL_MS);
    const asked = f.events.find(
      (e) => e.type === "changed" && e.d.status === "asks_yes_no",
    );
    expect(asked).toBeDefined();
    expect(asked!.d.question).toBe(
      "Bash command — npm test — Do you want to proceed?",
    );
    expect(asked!.d.keys).toEqual({ yes: "1", no: "Escape" });
    const before = f.sent().length;
    // A whole hour of reads: the prompt stays, nothing is pressed, and the
    // question is reported once. The delegate takes no settings at all, so
    // no autonomy mode can change this.
    await f.clock.advance(60 * 60 * 1000);
    expect(f.sent().length).toBe(before);
    expect(f.delegate.find()!.status).toBe("asks_yes_no");
    expect(
      f.events.filter(
        (e) => e.type === "changed" && e.d.status === "asks_yes_no",
      ),
    ).toHaveLength(1);
    // "Tell it something" is not an answer to a yes-or-no prompt.
    expect(await f.delegate.tell(asked!.d.id, "use pnpm")).toBe("yes_no");
    expect(f.sent().length).toBe(before);
    // The owner's own words press exactly the plain yes.
    expect(await f.delegate.answer(asked!.d.id, true)).toBe("sent");
    expect(f.sent().at(-1)).toEqual(["1"]);
    expect(f.delegate.find()!.status).toBe("working");
    expect(f.traces.find((t) => t.event === "CodingAnswered")?.data).toEqual({
      source: "claude",
      code: "yes",
    });
    // A second answer has nothing to answer.
    expect(await f.delegate.answer(asked!.d.id, false)).toBe("no_question");
    pane = finished;
    await f.clock.advance(SETTLE_MS + POLL_MS);
    const done = f.events.find(
      (e) => e.type === "changed" && e.d.status === "finished",
    );
    expect(done!.d.summary).toBe("Fixed the failing test. All 13 tests pass.");
  });

  it("answers no with Escape, and a trust question before the task goes in", async () => {
    let pane = trust;
    const f = fixture({ tmux: true, pane: () => pane });
    await f.delegate.start("claude-code", dir, "fix the failing test");
    await f.clock.advance(POLL_MS);
    const d = f.delegate.find()!;
    expect(d.status).toBe("asks_yes_no");
    expect(d.question).toBe("Do you trust the files in this folder?");
    // Nothing typed yet: the task waits for the prompt.
    expect(f.sent()).toEqual([]);
    expect(await f.delegate.answer(d.id, false)).toBe("sent");
    expect(f.sent()).toEqual([["Escape"]]);
    pane = welcome;
    await f.clock.advance(SETTLE_MS + POLL_MS);
    expect(f.sent()).toEqual([
      ["Escape"],
      ["-l", "fix the failing test"],
      ["Enter"],
    ]);
  });

  it("relays words, interrupts with Ctrl-C, reuses a session at its prompt and ends it on quit", async () => {
    let pane = finished;
    const f = fixture({ tmux: true, pane: () => pane });
    f.sessions.add("butler-codex-open-assist");
    // A session from earlier is found and typed into straight away.
    const started = await f.delegate.start(
      "codex",
      dir,
      "add a dark mode",
      "typed",
    );
    expect(started.ok).toBe(true);
    expect(f.calls.some((c) => c[1] === "new-session")).toBe(false);
    expect(f.sent()).toEqual([["-l", "add a dark mode"], ["Enter"]]);
    expect(f.traces.find((t) => t.event === "CodingDelegated")?.data).toEqual({
      source: "codex",
      mode: "tmux",
      project: projectCode(dir),
      code: "reused",
    });
    const d = f.delegate.find("codex")!;
    expect(d.status).toBe("working");
    // A second task while it works is refused, not typed over it.
    expect(await f.delegate.start("codex", dir, "and the tests")).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(await f.delegate.tell(d.id, "use CSS variables")).toBe("sent");
    expect(f.sent().at(-2)).toEqual(["-l", "use CSS variables"]);
    expect(await f.delegate.interrupt(d.id)).toBe(true);
    expect(f.sent().at(-1)).toEqual(["C-c"]);
    expect(f.delegate.find("codex")!.status).toBe("stopped");
    expect(await f.delegate.quit(d.id)).toBe(true);
    expect(f.calls.at(-1)).toEqual([
      tmuxBin,
      "kill-session",
      "-t",
      "butler-codex-open-assist",
    ]);
    expect(f.delegate.list()).toEqual([]);
    expect(f.events.at(-1)).toMatchObject({
      type: "ended",
      d: { status: "ended" },
    });
    expect(f.clock.pending()).toBe(0);
  });

  it("notices a session the owner closed", async () => {
    const f = fixture({ tmux: true, pane: () => welcome });
    await f.delegate.start("claude-code", dir, "fix it");
    await f.clock.advance(POLL_MS);
    f.sessions.clear();
    await f.clock.advance(POLL_MS);
    expect(f.delegate.list()).toEqual([]);
    expect(f.events.at(-1)?.type).toBe("ended");
    expect(f.traces.at(-1)).toMatchObject({
      event: "CodingEnded",
      data: { source: "claude", code: "gone" },
    });
  });

  it("interrupts every agent at work for the owner's stop, and no other", async () => {
    const f = fixture({ tmux: true, pane: () => finished });
    f.sessions.add("butler-claude-open-assist");
    await f.delegate.start("claude-code", dir, "fix it");
    expect(f.delegate.interruptWorking()).toBe(1);
    await flush();
    expect(f.sent().at(-1)).toEqual(["C-c"]);
    expect(f.delegate.interruptWorking()).toBe(0);
  });
});

describe("coding delegate: print mode", () => {
  const claudeLines = [
    `{"type":"system","subtype":"init","session_id":"5f0c-1","cwd":"${dir}"}`,
    `{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at the test."}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","content":"Claude requested permissions to use Bash, but you haven't granted it yet."}]}}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"I need permission to run npm test.","session_id":"5f0c-1"}`,
  ];
  it("runs one turn per process, reads its stream, and resumes the conversation for later words", async () => {
    const f = fixture({ tmux: false });
    expect(f.delegate.transport()).toBe("print");
    const started = await f.delegate.start(
      "codex",
      dir,
      "add a dark mode",
      "voice",
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.d).toMatchObject({ transport: "print", status: "working" });
    expect(started.d.attach).toBeUndefined();
    expect(f.procs).toHaveLength(1);
    expect(f.procs[0].argv).toEqual({
      command: codexBin,
      args: ["exec", "--json", "--", "add a dark mode"],
    });
    expect(f.procs[0].cwd).toBe(dir);
    // Words during the turn wait for it to end, then go in as the next turn.
    expect(await f.delegate.tell(started.d.id, "and the tests")).toBe("queued");
    f.procs[0].emit(`{"type":"thread.started","thread_id":"0199-abc"}`);
    f.procs[0].emit(
      `{"type":"item.completed","item":{"type":"agent_message","text":"Added a toggle."}}`,
    );
    f.procs[0].emit(`{"type":"turn.completed","usage":{}}`);
    expect(f.delegate.find()!.status).toBe("finished");
    expect(f.delegate.find()!.summary).toBe("Added a toggle.");
    f.procs[0].exit(0);
    expect(f.procs).toHaveLength(2);
    expect(f.procs[1].argv.args).toEqual([
      "exec",
      "--json",
      "resume",
      "0199-abc",
      "--",
      "and the tests",
    ]);
    expect(f.delegate.find()!.status).toBe("working");
    expect(f.delegate.find()!.pending).toEqual([]);
    f.procs[1].emit(`{"type":"turn.completed"}`);
    f.procs[1].exit(0);
    // Once the turn is over, more words start a resumed turn at once.
    expect(await f.delegate.tell(started.d.id, "thanks")).toBe("sent");
    expect(f.procs[2].argv.args.slice(2, 4)).toEqual(["resume", "0199-abc"]);
    // Typing is never news, in either transport: the two turns' ends are.
    expect(f.events.map((e) => e.type)).toEqual([
      "started",
      "changed",
      "changed",
    ]);
  });
  it("reports a permission Claude Code's print mode refused, which no one can answer", async () => {
    const f = fixture({ tmux: false });
    const started = await f.delegate.start("claude-code", dir, "fix the test");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(f.procs[0].argv).toEqual({
      command: claudeBin,
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--",
        "fix the test",
      ],
    });
    for (const line of claudeLines.slice(0, 3)) f.procs[0].emit(line);
    const d = f.delegate.find()!;
    expect(d.status).toBe("asks_yes_no");
    expect(d.question).toContain("requested permissions to use Bash");
    expect(d.keys).toBeUndefined();
    expect(await f.delegate.answer(d.id, true)).toBe("cannot");
    f.procs[0].emit(claudeLines[3]);
    f.procs[0].exit(0);
    expect(f.delegate.find()!).toMatchObject({
      status: "finished",
      summary: "I need permission to run npm test.",
      resumeId: "5f0c-1",
    });
    expect(f.delegate.list().at(-1)!.summary).toBe(
      "I need permission to run npm test.",
    );
  });
  it("reads a turn that died as an error, keeps an interruption as stopped, and kills its turns at quit", async () => {
    const f = fixture({ tmux: false });
    await f.delegate.start("codex", dir, "fix it");
    f.procs[0].exit(1);
    expect(f.delegate.find()!.status).toBe("error");
    expect(f.events.at(-1)).toMatchObject({
      type: "changed",
      d: { status: "error" },
    });
    // A finished session takes the next task as a resumed turn.
    await f.delegate.start("codex", dir, "try again");
    expect(f.procs).toHaveLength(2);
    expect(await f.delegate.interrupt(f.delegate.find()!.id)).toBe(true);
    expect(f.procs[1].interrupted).toBe(true);
    f.procs[1].exit(130);
    expect(f.delegate.find()!.status).toBe("stopped");
    await f.delegate.start("codex", dir, "once more");
    f.delegate.closeAll();
    expect(f.procs[2].killed).toBe(true);
    expect(f.delegate.list()).toEqual([]);
  });
});

describe("coding delegate: what it refuses and what it passes on", () => {
  it("types no credential, needs the CLI, and holds at most a few sessions", async () => {
    const f = fixture({ tmux: true, pane: () => welcome });
    expect(
      await f.delegate.start(
        "claude-code",
        dir,
        "use the token sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
      ),
    ).toEqual({ ok: false, reason: "secret" });
    expect(f.calls).toEqual([]);
    f.files.delete(codexBin);
    expect(await f.delegate.start("codex", dir, "fix it")).toEqual({
      ok: false,
      reason: "no_binary",
    });
    expect(f.delegate.available("codex")).toBe(false);
    for (let i = 0; i < DELEGATIONS_MAX; i++)
      expect(
        (await f.delegate.start("claude-code", `${dir}-${i}`, "fix it")).ok,
      ).toBe(true);
    expect(
      await f.delegate.start("claude-code", `${dir}-more`, "fix it"),
    ).toEqual({
      ok: false,
      reason: "too_many",
    });
    const d = f.delegate.find()!;
    expect(await f.delegate.tell(d.id, "password=hunter2hunter2")).toBe(
      "secret",
    );
    expect(await f.delegate.tell("nope", "hi")).toBe("gone");
    expect(await f.delegate.answer("nope", true)).toBe("gone");
  });
  it("gives the CLIs a small fixed environment, never Butler's own", async () => {
    const env = childEnv(home, {
      TMPDIR: "/tmp/x",
      LC_ALL: "C",
      COARENA_SECRET: "never",
      OPENAI_API_KEY: "never",
    });
    expect(env).toEqual({
      HOME: home,
      PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/x",
      LC_ALL: "C",
    });
    const f = fixture({ tmux: true, pane: () => welcome });
    await f.delegate.start("claude-code", dir, "fix it");
    for (const seen of f.envs)
      expect(Object.keys(seen)).not.toContain("COARENA_SECRET");
    const p = fixture({ tmux: false });
    await p.delegate.start("codex", dir, "fix it");
    expect(Object.keys(p.procs[0].env).sort()).toEqual(
      ["HOME", "LANG", "PATH", "TERM", "TMPDIR"].sort(),
    );
  });
  it("resolves a project only from a name the owner said or the editor in front", () => {
    const f = fixture({ tmux: true });
    expect(f.delegate.resolveProject("open assist")).toEqual({
      ok: true,
      dir,
      via: "named",
    });
    expect(f.delegate.resolveProject("/etc")).toEqual({
      ok: false,
      reason: "refused",
    });
    expect(
      f.delegate.resolveProject(undefined, {
        appId: "com.microsoft.VSCode",
        title: "ide.ts — open-assist",
      }),
    ).toEqual({ ok: true, dir, via: "editor" });
    expect(
      f.delegate.resolveProject(undefined, {
        appId: "com.apple.Safari",
        title: "open-assist",
      }),
    ).toEqual({ ok: false, reason: "no_project" });
  });
  it("traces the agent, the folder as a hash and the state, never the words", () => {
    const f = fixture({ tmux: false });
    void f.delegate.start(
      "codex",
      dir,
      "fix the secret thing in /Users/nkov/open-assist",
    );
    for (const t of f.traces) {
      const json = JSON.stringify(t.data);
      expect(json).not.toContain("open-assist");
      expect(json).not.toContain("secret");
    }
    expect(projectCode(dir)).toMatch(/^p[0-9a-f]{12}$/);
    const directory = mkdtempSync(join(tmpdir(), "assist-coding-"));
    const output: string[] = [];
    try {
      const log = new LocalDiagnostics(
        directory,
        () => [],
        (line) => output.push(line),
      );
      log.write("CodingDelegated", {
        source: "claude",
        mode: "tmux",
        project: projectCode(dir),
        code: "new",
      });
      log.write("CodingDelegated", { project: "the Zephyr secret plan" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const [kept, dropped] = output.map((line) => JSON.parse(line).data);
    expect(kept).toEqual({
      source: "claude",
      mode: "tmux",
      project: projectCode(dir),
      code: "new",
    });
    expect(dropped).toEqual({});
  });
});

describe("coding delegate: pins", () => {
  const coding = readFileSync(
    new URL("../electron/coding.ts", import.meta.url),
    "utf8",
  );
  const main = readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  it("knows nothing of autonomy and presses an answer key in answer() alone", () => {
    // No settings come in at all: nothing to read an autonomy mode from.
    expect(coding).not.toMatch(
      /withoutAsking|core\/policy|\.autonomy|\bSettings\b/,
    );
    const presses = [...coding.matchAll(/live\.d\.keys\.(?:yes|no)/g)];
    expect(presses).toHaveLength(2);
    const answer = coding.indexOf("async answer(");
    const next = coding.indexOf("\n  async ", answer + 1);
    for (const press of presses) {
      expect(press.index).toBeGreaterThan(answer);
      expect(press.index).toBeLessThan(next);
    }
    // No tick, timer or event handler answers: the pane loop only reads.
    const tick = coding.slice(
      coding.indexOf("private async tick("),
      coding.indexOf("private spawnTurn("),
    );
    expect(tick).not.toContain("tmuxSendKey");
  });
  it("passes no widening flag from anywhere but the list that forbids them", () => {
    const sources = [
      coding,
      ...["classify", "intents", "lines", "project", "state"].map((name) =>
        readFileSync(
          new URL(`../src/coding/${name}.ts`, import.meta.url),
          "utf8",
        ),
      ),
    ];
    for (const source of sources)
      for (const flag of WIDENING_FLAGS.filter((f) => f.startsWith("--")))
        expect(source).not.toContain(flag);
  });
  it("is wired into main before the router, into stop and the panic button, and into quit", () => {
    const plan = main.indexOf("async function planCommand(");
    const hook = main.indexOf(
      "await codingTurn(text, fromVoice, confidence, extra, context)",
      plan,
    );
    const router = main.indexOf("const base = planVoiceTurn({", plan);
    expect(hook).toBeGreaterThan(plan);
    expect(hook).toBeLessThan(router);
    const stop = main.indexOf('case "stop": {');
    expect(main.slice(stop, main.indexOf('case "pause":', stop))).toContain(
      "runActive() ? 0 : coding.interruptWorking()",
    );
    const quit = main.indexOf('app.on("before-quit"');
    expect(main.slice(quit, quit + 900)).toContain("coding.closeAll();");
    expect(main).toContain("const interrupted = coding.interruptWorking();");
    // A delegation's news and questions go to the reporter and the pill; the
    // start is the turn's own reply.
    expect(main).toContain("reporter.onWatchFacts(codingFacts(d))");
    expect(main).toContain('listen: conversation.listenWindow("answer")');
  });
});
