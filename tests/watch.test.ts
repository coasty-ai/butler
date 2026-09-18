import { describe, it, expect, vi } from "vitest";
import {
  ANCHORLESS_MAX_MS,
  CHAIN_WAKES_MAX,
  HeldNews,
  NOT_VISIBLE_MS,
  WAKES_HOURLY,
  WAKES_PER_WINDOW_HOURLY,
  WAKE_PENDING_MAX_MS,
  WAKE_RETRY_MS,
  WATCHES_MAX,
  WatchManager,
  WatchRefusedError,
  droppedLine,
  factsLine,
  fallbackReport,
  handoffNotes,
  relayLine,
  wakeTask,
  type RelayGone,
  type RelayRequest,
  type WatchManagerOptions,
} from "../electron/watch";
import { pasteRequested } from "../src/core/runner";
import type { Presence, PresenceService } from "../electron/presence";
import { RELAY_POLL_MS } from "../src/core/monitor";
import {
  defaultSettings,
  type Action,
  type OcrLine,
  type ProbeResult,
  type Region,
  type Settings,
  type WatchBinding,
} from "../src/core/schema";
import type { ProgressFacts } from "../src/assistant/types";

// setImmediate rather than a zero timeout: the same hops through pending
// promises, without the timer's millisecond floor on hour-long scripts.
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
/** Manual timers so a two-hour watch runs in milliseconds. */
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
const line = (t: string, y = 0.9): OcrLine => ({
  t,
  x: 0.7,
  y,
  w: 0.25,
  h: 0.02,
});
const panel = (...texts: string[]) =>
  texts.map((t, i) => line(t, 0.8 + i * 0.02));
const claude = {
  working: panel("Running npm test", "Queue another message…"),
  idle: panel(
    "I updated the endpoint and the tests pass.",
    "Ask Claude to edit…",
  ),
  permission: panel(
    "Do you want to proceed with Bash?",
    "npm test",
    "1. Yes",
    "2. Yes, and don't ask again",
    "Esc to interrupt",
  ),
  unknown: panel("export function foo() {}"),
};
const ok = (lines: OcrLine[], frontmost = false): ProbeResult => ({
  ok: true,
  frontmost,
  title: "users.ts — project",
  lines,
  idleMs: 0,
});
const binding: WatchBinding = {
  token: "tok-1234-abcd",
  appId: "com.microsoft.VSCode",
  pid: 7,
  windowId: 42,
  title: "users.ts — project",
};
function presence(initial: Presence = "away") {
  const state = {
    value: initial,
    idle: undefined as number | undefined,
    locked: false,
    onRefresh: undefined as (() => void) | undefined,
  };
  const service: PresenceService = {
    current: () => state.value,
    idleMs: () => state.idle,
    locked: () => state.locked,
    refresh: async () => {
      state.onRefresh?.();
      return state.value;
    },
  };
  return { service, state };
}
/** A watch manager over scripted probes; probes answer in order, repeating the last. */
function harness(
  results: (ProbeResult | Error)[],
  o: {
    presence?: Presence;
    settings?: Partial<Settings>;
    onRelay?: (r: RelayRequest) => void;
    canWake?: () => boolean;
  } = {},
) {
  const c = clock();
  const p = presence(o.presence);
  const answers = [...results];
  const controller = {
    probe: vi.fn(async (_token: string, _region?: Region) => {
      const next = answers.length > 1 ? answers.shift()! : answers[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    unbindWatch: vi.fn(async () => {}),
    setWatchMode: vi.fn(async () => {}),
    focusWatch: vi.fn(async () => {}),
  };
  const wakes: Parameters<WatchManagerOptions["onWake"]>[] = [];
  const facts: Parameters<WatchManagerOptions["onFacts"]>[] = [];
  const relays: RelayRequest[] = [];
  const gone: { id: string; reason: RelayGone }[] = [];
  const manager = new WatchManager({
    controller,
    presence: p.service,
    settings: () => ({ ...defaultSettings, ...o.settings }),
    onWake: (...args) => wakes.push(args),
    onFacts: (...args) => facts.push(args),
    onRelay: (r) => {
      relays.push(r);
      o.onRelay?.(r);
    },
    onRelayGone: (id, reason) => gone.push({ id, reason }),
    ...(o.canWake ? { canWake: o.canWake } : {}),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  const start = (
    spec: Partial<Parameters<WatchManager["start"]>[1]> = {},
    bound: WatchBinding = binding,
  ) =>
    manager.start(bound, {
      reason: "tests",
      everyMs: 10000,
      maxMs: 30 * 60000,
      until: "done",
      runId: "run-1",
      task: "keep an eye on Claude Code and tell me when it's done",
      taskSource: "user_words",
      origin: "voice",
      appName: "Code",
      notes: [],
      ...spec,
    });
  return { c, p, controller, manager, wakes, facts, relays, gone, start };
}

describe("a detached watch", () => {
  it("reads the bound window by its token, and only after the first interval", async () => {
    const h = harness([ok(claude.working)]);
    const id = h.start();
    expect(h.controller.setWatchMode).toHaveBeenCalledWith(true);
    expect(h.controller.probe).not.toHaveBeenCalled();
    await h.c.advance(9999);
    expect(h.controller.probe).not.toHaveBeenCalled();
    await h.c.advance(1);
    expect(h.controller.probe).toHaveBeenCalledTimes(1);
    expect(h.controller.probe.mock.calls[0][0]).toBe(binding.token);
    // The first read is the whole window; the next ones only the panel column.
    expect(h.controller.probe.mock.calls[0][1]).toBeUndefined();
    await h.c.advance(10000);
    expect(h.controller.probe.mock.calls[1][1]).toEqual({
      x: 0.67,
      y: 0,
      w: 0.33,
      h: 1,
    });
    for (const call of h.controller.probe.mock.calls)
      expect(call[0]).toBe(binding.token);
    const [state] = h.manager.list();
    expect(state).toMatchObject({
      id,
      runId: "run-1",
      app: "Code",
      agent: "claude-code",
      state: "working",
    });
    // Nothing read from the panel is in the state.
    expect(JSON.stringify(state)).not.toContain("npm test");
    expect(h.wakes).toHaveLength(0);
  });

  it("wakes with done once the agent finishes, bringing the window forward when nobody is at the Mac", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    h.start();
    await h.c.advance(30000);
    expect(h.wakes).toHaveLength(1);
    const [state, cause, ctx] = h.wakes[0];
    expect(cause).toBe("done");
    expect(state.state).toBe("idle");
    expect(ctx).toMatchObject({
      task: "keep an eye on Claude Code and tell me when it's done",
      taskSource: "user_words",
      origin: "voice",
      appName: "Code",
      notes: [],
      corrections: [],
      // The first wake of a chain that began with this watch.
      chain: { startedAt: 1_000_000, wakes: 1, origin: "voice" },
    });
    expect(ctx.panelTail).toContain("ask claude to edit");
    expect(h.controller.focusWatch).toHaveBeenCalledWith(binding.token);
    expect(h.controller.unbindWatch).toHaveBeenCalledWith(binding.token);
    expect(h.controller.setWatchMode).toHaveBeenLastCalledWith(false);
    expect(h.manager.list()).toEqual([]);
    // Ended: no more reads.
    const reads = h.controller.probe.mock.calls.length;
    await h.c.advance(60000);
    expect(h.controller.probe.mock.calls.length).toBe(reads);
  });

  it("waits to take the screen while someone is at the Mac, telling the reporter once", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)], {
      presence: "present",
    });
    h.start();
    await h.c.advance(30000);
    expect(h.wakes).toHaveLength(0);
    expect(h.controller.focusWatch).not.toHaveBeenCalled();
    const waiting = h.facts.filter(([, hint]) => hint?.kind === "final");
    expect(waiting).toHaveLength(1);
    expect(waiting[0][1]).toEqual({
      kind: "final",
      cause: "done",
      held: "presence",
    });
    expect(waiting[0][0]).toMatchObject({
      runId: "run-1",
      status: "watching",
      watch: { agent: "claude-code", state: "idle" },
    });
    // Nothing read from the panel is traced anywhere but the facts' tail.
    expect(waiting[0][0].watch?.panelTail).toContain("tests pass");
    await h.c.advance(5 * 60000);
    expect(h.wakes).toHaveLength(0);
    expect(h.facts.filter(([, hint]) => hint?.kind === "final")).toHaveLength(
      1,
    );
    h.p.state.value = "away";
    await h.c.advance(WAKE_RETRY_MS);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0][1]).toBe("done");
    expect(h.controller.focusWatch).toHaveBeenCalledTimes(1);
  });

  it("takes the screen after a long pause when presence is unknown, not before", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)], {
      presence: "unknown",
    });
    h.p.state.idle = 5000;
    h.start();
    await h.c.advance(60000);
    expect(h.wakes).toHaveLength(0);
    h.p.state.idle = 20000;
    await h.c.advance(WAKE_RETRY_MS);
    expect(h.wakes).toHaveLength(1);
  });

  it("drops a wake nobody let through for half an hour, and says so", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)], {
      presence: "present",
    });
    h.start();
    await h.c.advance(30000 + WAKE_PENDING_MAX_MS + WAKE_RETRY_MS);
    expect(h.wakes).toHaveLength(0);
    expect(h.controller.focusWatch).not.toHaveBeenCalled();
    expect(h.controller.unbindWatch).toHaveBeenCalledWith(binding.token);
    expect(h.manager.list()).toEqual([]);
    // The user heard it was waiting, and then that it was let go.
    const finals = h.facts.filter(([, hint]) => hint?.kind === "final");
    expect(finals.map(([, hint]) => hint)).toEqual([
      { kind: "final", cause: "done", held: "presence" },
      { kind: "final", cause: "done", dropped: true },
    ]);
    expect(factsLine(finals[1][0], finals[1][1]!)).toBe(
      "Claude Code looks finished. You were at the Mac, so I left it to you.",
    );
  });

  it("tells the reporter again when what holds the wake back changes", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    h.start();
    h.manager.setRunActive(true);
    await h.c.advance(30000 + 2 * WAKE_RETRY_MS);
    // The run ends with the user at the Mac: the line that said "once the
    // current task is done" is no longer true.
    h.p.state.value = "present";
    h.manager.setRunActive(false);
    await h.c.advance(3 * WAKE_RETRY_MS);
    expect(
      h.facts.filter(([, hint]) => hint?.kind === "final").map((f) => f[1]),
    ).toEqual([
      { kind: "final", cause: "done", held: "run" },
      { kind: "final", cause: "done", held: "presence" },
    ]);
    expect(h.wakes).toHaveLength(0);
  });

  it("puts the agent's question to the user once and never answers it", async () => {
    const h = harness([
      ok(claude.working),
      ok(claude.permission),
      ok(claude.permission),
      ok(claude.permission),
      ok(claude.working),
    ]);
    h.start();
    await h.c.advance(20000);
    expect(h.relays).toHaveLength(1);
    expect(h.relays[0]).toMatchObject({
      agent: "claude-code",
      kind: "command",
      question: "do you want to proceed with bash? npm test",
      allowLabel: "Yes",
      decline: { type: "key", key: "ESC" },
    });
    // Polled quickly while it waits, without repeating the question.
    const reads = h.controller.probe.mock.calls.length;
    await h.c.advance(RELAY_POLL_MS);
    expect(h.controller.probe.mock.calls.length).toBe(reads + 1);
    await h.c.advance(RELAY_POLL_MS);
    expect(h.relays).toHaveLength(1);
    expect(h.gone).toEqual([]);
    // Answered in the editor: the panel moves on.
    await h.c.advance(RELAY_POLL_MS);
    expect(h.gone).toEqual([{ id: h.relays[0].id, reason: "answered" }]);
    // The reporter hears a fixed line by kind, never the question, under
    // the run's id and a sequence shared with the facts.
    expect(h.relays[0]).toMatchObject({ runId: "run-1" });
    expect(h.relays[0].seq).toBeGreaterThan(0);
    const line = relayLine(h.relays[0]);
    expect(line).toBe(
      "Claude Code is asking to run a command. Answer it in the editor.",
    );
    expect(line).not.toContain("npm test");
    expect(line).not.toContain("proceed");
    // The manager has no way to press anything: only reads and the focus
    // it does before a wake, which never happened here.
    expect(h.controller.focusWatch).not.toHaveBeenCalled();
    expect(h.wakes).toHaveLength(0);
    expect(Object.keys(h.controller).sort()).toEqual([
      "focusWatch",
      "probe",
      "setWatchMode",
      "unbindWatch",
    ]);
  });

  it("wakes without taking focus when the window is gone or the app became protected, still waiting for presence", async () => {
    // Someone is at the Mac: the run would take the screen from them, so
    // the wake waits like any other and the reporter hears why once.
    const gone = harness([{ ok: false, code: "window_gone" }], {
      presence: "present",
    });
    gone.start();
    await gone.c.advance(10000 + 3 * WAKE_RETRY_MS);
    expect(gone.wakes).toHaveLength(0);
    expect(gone.controller.unbindWatch).not.toHaveBeenCalled();
    expect(gone.facts.filter(([, hint]) => hint?.kind === "needs_you")).toEqual(
      [
        [
          expect.objectContaining({ runId: "run-1" }),
          { kind: "needs_you", cause: "window_gone", held: "presence" },
        ],
      ],
    );
    gone.p.state.value = "away";
    await gone.c.advance(WAKE_RETRY_MS);
    expect(gone.wakes.map((w) => w[1])).toEqual(["window_gone"]);
    expect(gone.controller.focusWatch).not.toHaveBeenCalled();
    expect(gone.controller.unbindWatch).toHaveBeenCalled();
    const locked = harness([{ ok: false, code: "protected" }]);
    locked.start();
    await locked.c.advance(10000);
    expect(locked.wakes.map((w) => w[1])).toEqual(["probe_failed"]);
    expect(locked.controller.focusWatch).not.toHaveBeenCalled();
  });

  it("waits for the current run to end before taking the screen, checking again after asking presence", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    h.start();
    h.manager.setRunActive(true);
    await h.c.advance(30000 + 3 * WAKE_RETRY_MS);
    expect(h.wakes).toHaveLength(0);
    expect(h.controller.focusWatch).not.toHaveBeenCalled();
    expect(h.manager.list()).toHaveLength(1);
    const waiting = h.facts.filter(([, hint]) => hint?.kind === "final");
    expect(waiting).toHaveLength(1);
    expect(waiting[0][1]).toEqual({
      kind: "final",
      cause: "done",
      held: "run",
    });
    // A run held it back for longer than the drop limit: it is not dropped,
    // since nobody at the Mac heard about it.
    await h.c.advance(WAKE_PENDING_MAX_MS + WAKE_RETRY_MS);
    expect(h.manager.list()).toHaveLength(1);
    h.manager.setRunActive(false);
    await h.c.advance(WAKE_RETRY_MS);
    expect(h.wakes.map((w) => w[1])).toEqual(["done"]);
    expect(h.controller.focusWatch).toHaveBeenCalledTimes(1);
    // A run that starts while presence is being asked is seen too.
    const race = harness([ok(claude.working), ok(claude.idle)]);
    race.start();
    race.p.state.onRefresh = () => race.manager.setRunActive(true);
    await race.c.advance(30000 + WAKE_RETRY_MS);
    expect(race.wakes).toHaveLength(0);
    expect(race.controller.focusWatch).not.toHaveBeenCalled();
  });

  it("waits while the Mac is locked, without giving up", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    h.p.state.locked = true;
    h.start();
    await h.c.advance(30000 + WAKE_PENDING_MAX_MS + 2 * WAKE_RETRY_MS);
    expect(h.wakes).toHaveLength(0);
    expect(h.controller.focusWatch).not.toHaveBeenCalled();
    expect(h.manager.list()).toHaveLength(1);
    expect(h.facts.filter(([, hint]) => hint?.kind === "final")[0][1]).toEqual({
      kind: "final",
      cause: "done",
      held: "locked",
    });
    h.p.state.locked = false;
    await h.c.advance(WAKE_RETRY_MS);
    expect(h.wakes.map((w) => w[1])).toEqual(["done"]);
  });

  it("waits for room in the queue instead of letting go of the window first", async () => {
    let room = false;
    const h = harness([ok(claude.working), ok(claude.idle)], {
      canWake: () => room,
    });
    h.start();
    await h.c.advance(30000 + 2 * WAKE_RETRY_MS);
    expect(h.wakes).toHaveLength(0);
    expect(h.controller.unbindWatch).not.toHaveBeenCalled();
    expect(h.facts.filter(([, hint]) => hint?.kind === "final")[0][1]).toEqual({
      kind: "final",
      cause: "done",
      held: "queue",
    });
    room = true;
    await h.c.advance(WAKE_RETRY_MS);
    expect(h.wakes.map((w) => w[1])).toEqual(["done"]);
    expect(h.controller.unbindWatch).toHaveBeenCalledTimes(1);
  });

  it("refuses to watch a window again once it has woken the model four times in an hour", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    // The scripted probe stays idle after its first answers, so a re-watch
    // sees idle from the start and needs a minute to call that done.
    const rewatch = async () => {
      h.start();
      await h.c.advance(70000);
    };
    for (let i = 0; i < WAKES_PER_WINDOW_HOURLY; i++) await rewatch();
    expect(h.wakes).toHaveLength(WAKES_PER_WINDOW_HOURLY);
    expect(() => h.start()).toThrow(WatchRefusedError);
    expect(() => h.start()).toThrow(
      /woken you 4 times in the last hour; watching it again is refused/,
    );
    expect(h.manager.list()).toEqual([]);
    // Another window is not this window's loop.
    const other = { ...binding, token: "tok-5678-efgh", windowId: 43 };
    expect(() => h.start({}, other)).not.toThrow();
    h.manager.stop();
    // An hour on, the window may be watched again.
    await h.c.advance(61 * 60000);
    expect(() => h.start()).not.toThrow();
  });

  it("refuses every watch once wakes from all windows pass ten in an hour", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    for (let i = 0; i < WAKES_HOURLY; i++) {
      h.start({}, { ...binding, token: `tok-${i}-abcdef`, windowId: 100 + i });
      await h.c.advance(70000);
    }
    expect(h.wakes).toHaveLength(WAKES_HOURLY);
    expect(() =>
      h.start({}, { ...binding, token: "tok-new-abcdef", windowId: 999 }),
    ).toThrow(/woken you 10 times in the last hour/);
  });

  it("probes each of two watches with its own token and releases only its own", async () => {
    const h = harness([ok(claude.working)]);
    const second: WatchBinding = {
      ...binding,
      token: "tok-5678-efgh",
      windowId: 43,
    };
    const first = h.start();
    h.start({ runId: "run-2" }, second);
    await h.c.advance(10000);
    expect(h.controller.probe.mock.calls.map((call) => call[0]).sort()).toEqual(
      [binding.token, second.token],
    );
    expect(h.manager.stop(first)).toBe(1);
    expect(h.controller.unbindWatch.mock.calls).toEqual([[binding.token]]);
    await h.c.advance(10000);
    expect(h.controller.probe.mock.calls.at(-1)![0]).toBe(second.token);
  });

  it("does not move the change baseline by being read", async () => {
    const h = harness([
      ok(claude.working),
      ok(panel("Running npm build", "Queue another message…")),
    ]);
    const id = h.start();
    // The first read reports a check-in (unknown → working): the baseline.
    await h.c.advance(10000);
    expect(h.facts.filter(([, hint]) => hint?.kind === "checkin")).toHaveLength(
      1,
    );
    // Same state, new text: the change is measured against the check-in,
    // however many times the facts are read before the next report.
    await h.c.advance(10000);
    const first = h.manager.facts(id)!.watch!.change;
    const second = h.manager.facts(id)!.watch!.change;
    expect(first).toBeCloseTo(2 / 3);
    expect(second).toBe(first);
  });

  it("says whether a question was answered or the watch merely ended", async () => {
    const stopped = harness([ok(claude.working), ok(claude.permission)]);
    stopped.start();
    await stopped.c.advance(20000);
    expect(stopped.relays).toHaveLength(1);
    stopped.manager.stop();
    expect(stopped.gone).toEqual([
      { id: stopped.relays[0].id, reason: "ended" },
    ]);
    const expired = harness([ok(claude.working), ok(claude.permission)]);
    expired.start({ maxMs: 60000 });
    await expired.c.advance(70000);
    expect(expired.wakes.map((w) => w[1])).toEqual(["expired"]);
    expect(expired.gone).toEqual([
      { id: expired.relays[0].id, reason: "ended" },
    ]);
  });

  it("expires under secure input like anywhere else", async () => {
    const h = harness([{ ok: false, code: "secure_input" }]);
    h.start({ maxMs: 2 * 60000 });
    await h.c.advance(2 * 60000 - 1);
    expect(h.wakes).toHaveLength(0);
    await h.c.advance(10000);
    expect(h.wakes.map((w) => w[1])).toEqual(["expired"]);
    expect(h.manager.list()).toEqual([]);
  });

  it("ends the watches on the helper's Escape stop, during a run too", async () => {
    const h = harness([ok(claude.working)]);
    h.start();
    h.start(
      { runId: "run-2" },
      { ...binding, token: "tok-9999-zzzz", windowId: 44 },
    );
    // The Escape that stops a run is as strong as a spoken "stop": no watch
    // is left to wake a run after it.
    h.manager.setRunActive(true);
    expect(h.manager.onEmergencyStop()).toBe(2);
    expect(h.manager.list()).toEqual([]);
    expect(h.controller.unbindWatch).toHaveBeenCalledWith(binding.token);
    await h.c.advance(60000);
    expect(h.controller.probe).not.toHaveBeenCalled();
    const idle = harness([ok(claude.working)]);
    idle.start();
    expect(idle.manager.onEmergencyStop()).toBe(1);
    expect(idle.manager.list()).toEqual([]);
  });

  it("lets no text leave a window that shows no agent panel", async () => {
    const h = harness([
      ok(claude.unknown),
      ok(panel("Build succeeded", "0 warnings")),
    ]);
    const id = h.start({ until: "change" });
    await h.c.advance(10000);
    expect(h.manager.facts(id)!.watch!.panelTail).toBeUndefined();
    await h.c.advance(10000);
    expect(h.wakes.map((w) => w[1])).toEqual(["changed"]);
    expect(h.wakes[0][2].panelTail).toBeUndefined();
    expect(JSON.stringify(h.facts)).not.toContain("Build succeeded");
  });

  it("keeps to the panel's band when it is docked at the bottom, leaving the editor's text behind", async () => {
    const wide = (t: string, y: number): OcrLine => ({
      t,
      x: 0.1,
      y,
      w: 0.8,
      h: 0.02,
    });
    const editor = wide("const apiBase = 'internal-editor-text'", 0.2);
    const h = harness([
      ok([
        editor,
        wide("npm test is going", 0.85),
        wide("Queue another message…", 0.9),
      ]),
      ok([
        editor,
        wide("I updated the endpoint.", 0.85),
        wide("Ask Claude to edit…", 0.9),
      ]),
    ]);
    const id = h.start();
    await h.c.advance(10000);
    expect(h.manager.facts(id)!.watch!.panelTail).not.toContain(
      "internal-editor-text",
    );
    // Idle twice after working: done.
    await h.c.advance(20000);
    expect(h.wakes.map((w) => w[1])).toEqual(["done"]);
    expect(h.wakes[0][2].panelTail).toContain("ask claude to edit");
    expect(h.wakes[0][2].panelTail).not.toContain("internal-editor-text");
    // The reads after the first asked for the band alone.
    expect(h.controller.probe.mock.calls[1][1]).toEqual({
      x: 0,
      y: 0.75,
      w: 1,
      h: 0.22,
    });
  });

  it("stays asleep on a static window with no agent when watched for a change", async () => {
    const h = harness([ok(claude.unknown)]);
    h.start({ until: "change" });
    await h.c.advance(60000);
    expect(h.wakes).toHaveLength(0);
    expect(h.controller.focusWatch).not.toHaveBeenCalled();
    expect(h.manager.list()).toHaveLength(1);
  });

  it("words the fixed lines by what happened and what holds the wake back", () => {
    const f = {
      watch: { agent: "claude-code", state: "idle", minutes: 3, change: 0 },
    };
    expect(factsLine(f, { kind: "checkin" })).toBeUndefined();
    expect(factsLine(f, { kind: "summary" })).toBeUndefined();
    expect(factsLine(f, { kind: "stalled" })).toBe(
      "Claude Code hasn’t changed anything for 3 minutes.",
    );
    expect(factsLine(f, { kind: "final", cause: "done" })).toBe(
      "Claude Code looks finished. I’ll take a look when you step away.",
    );
    expect(factsLine(f, { kind: "final", cause: "error", held: "run" })).toBe(
      "Claude Code looks stuck or failed. I’ll take a look once the current task is done.",
    );
    expect(
      factsLine(f, { kind: "needs_you", cause: "stalled", held: "locked" }),
    ).toBe("Claude Code needs you. I’ll take a look once the Mac is unlocked.");
    expect(
      factsLine(
        { watch: { state: "unknown", minutes: 1, change: 0.5 } },
        { kind: "needs_you", cause: "changed", held: "queue" },
      ),
    ).toBe("It changed. I’ll take a look once the queue has room.");
    expect(droppedLine({ agent: "copilot" }, "done")).toBe(
      "Copilot looks finished, but I couldn’t start a follow-up. The window is yours.",
    );
    for (const kind of [
      "command",
      "edit",
      "tool",
      "plan",
      "continue",
      "review",
    ] as const)
      expect(relayLine({ agent: "copilot", kind })).toMatch(
        /^Copilot is asking to [a-z ]+\. Answer it in the editor\.$/,
      );
  });

  it("skips reads under secure input or a locked screen without counting them", async () => {
    const h = harness([
      { ok: false, code: "secure_input" },
      { ok: false, code: "screen_locked" },
      { ok: false, code: "secure_input" },
      { ok: false, code: "secure_input" },
      { ok: false, code: "secure_input" },
    ]);
    h.start();
    await h.c.advance(60000);
    expect(h.wakes).toHaveLength(0);
    expect(h.manager.list()).toHaveLength(1);
    expect(h.controller.probe.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("slows down while the window is minimized and gives up after three failed reads", async () => {
    const hidden = harness([{ ok: false, code: "not_visible" }]);
    hidden.start();
    await hidden.c.advance(10000);
    expect(hidden.controller.probe).toHaveBeenCalledTimes(1);
    await hidden.c.advance(NOT_VISIBLE_MS - 1);
    expect(hidden.controller.probe).toHaveBeenCalledTimes(1);
    await hidden.c.advance(1);
    expect(hidden.controller.probe).toHaveBeenCalledTimes(2);
    expect(hidden.wakes).toHaveLength(0);
    const broken = harness([new Error("no image")]);
    broken.start();
    await broken.c.advance(30000);
    expect(broken.wakes.map((w) => w[1])).toEqual(["probe_failed"]);
  });

  it("expires by the setting's cap, and a monitor's own cap when shorter", async () => {
    const h = harness([ok(claude.working)], {
      settings: { watchMaxMinutes: 5 },
    });
    h.start();
    await h.c.advance(5 * 60000 + 30000);
    expect(h.wakes.map((w) => w[1])).toEqual(["expired"]);
    const own = harness([ok(claude.working)]);
    own.start({ maxMs: 2 * 60000 });
    await own.c.advance(2 * 60000 + 30000);
    expect(own.wakes.map((w) => w[1])).toEqual(["expired"]);
  });

  it("stop ends every watch, unbinds, and clears a question it had put to the user", async () => {
    const h = harness([ok(claude.working), ok(claude.permission)]);
    h.start();
    h.start({ runId: "run-2" });
    await h.c.advance(20000);
    expect(h.relays.length).toBeGreaterThanOrEqual(1);
    expect(h.manager.stop()).toBe(2);
    expect(h.manager.list()).toEqual([]);
    expect(h.controller.unbindWatch).toHaveBeenCalledTimes(2);
    expect(h.controller.setWatchMode).toHaveBeenLastCalledWith(false);
    expect(h.gone.map((g) => g.id).sort()).toEqual(
      h.relays.map((r) => r.id).sort(),
    );
    expect(h.gone.every((g) => g.reason === "ended")).toBe(true);
    expect(h.manager.stop()).toBe(0);
    const reads = h.controller.probe.mock.calls.length;
    await h.c.advance(60000);
    expect(h.controller.probe.mock.calls.length).toBe(reads);
  });

  it("stops one watch by id and leaves the other", async () => {
    const h = harness([ok(claude.working)]);
    const first = h.start();
    h.start({ runId: "run-2" });
    expect(h.manager.stop(first)).toBe(1);
    expect(h.manager.list().map((w) => w.runId)).toEqual(["run-2"]);
    expect(h.controller.setWatchMode).toHaveBeenLastCalledWith(true);
  });

  it("holds the double-Escape rule only while a watch is the only thing running", async () => {
    const h = harness([ok(claude.working)]);
    h.manager.setRunActive(true);
    expect(h.controller.setWatchMode).not.toHaveBeenCalled();
    h.start();
    // A run is active: one Escape must stay the emergency stop.
    expect(h.controller.setWatchMode).not.toHaveBeenCalled();
    h.manager.setRunActive(false);
    expect(h.controller.setWatchMode).toHaveBeenLastCalledWith(true);
    h.manager.setRunActive(true);
    expect(h.controller.setWatchMode).toHaveBeenLastCalledWith(false);
    h.manager.setRunActive(true);
    expect(h.controller.setWatchMode).toHaveBeenCalledTimes(2);
    h.manager.setRunActive(false);
    h.manager.stop();
    expect(h.controller.setWatchMode).toHaveBeenLastCalledWith(false);
  });

  it("pauses and resumes ticking", async () => {
    const h = harness([ok(claude.working)]);
    h.start();
    h.manager.pause();
    await h.c.advance(60000);
    expect(h.controller.probe).not.toHaveBeenCalled();
    h.manager.resume();
    await h.c.advance(1000);
    expect(h.controller.probe).toHaveBeenCalledTimes(1);
  });

  it("reports facts with a bounded, redacted tail and a rising sequence", async () => {
    const h = harness([
      ok(
        panel(
          "token=sk-fixtureSECRET1234567890abcdef",
          "Queue another message…",
        ),
      ),
    ]);
    const id = h.start();
    await h.c.advance(10000);
    const first = h.manager.facts(id)!;
    const second = h.manager.facts(id)!;
    expect(first).toMatchObject({
      runId: "run-1",
      task: "keep an eye on Claude Code and tell me when it's done",
      status: "watching",
      apps: ["com.microsoft.VSCode"],
      app: "Code",
      detail: "brief",
      watch: { agent: "claude-code", state: "working" },
    });
    expect(first.watch?.panelTail).toContain("queue another message");
    expect(first.watch?.panelTail).not.toContain("fixtureSECRET");
    expect(second.seq).toBe(first.seq + 1);
    expect(h.manager.facts("nope")).toBeUndefined();
    // A state change is reported as a check-in.
    expect(h.facts.some(([, hint]) => hint?.kind === "checkin")).toBe(true);
  });

  it("watches an unreadable window by the clock after telling the model once", async () => {
    const h = harness([ok(claude.unknown)]);
    h.start();
    await h.c.advance(30000);
    expect(h.wakes.map((w) => w[1])).toEqual(["unknown"]);
    // The model monitors the same window again: no second "unknown", and
    // the clock wakes it after fifteen minutes at most.
    h.start({ until: "done" });
    await h.c.advance(ANCHORLESS_MAX_MS - 1);
    expect(h.wakes).toHaveLength(1);
    await h.c.advance(30000);
    expect(h.wakes.map((w) => w[1])).toEqual(["unknown", "expired"]);
  });

  it("wakes on a material change of any window when asked to", async () => {
    const h = harness([
      ok(claude.unknown),
      ok(panel("Build succeeded", "0 warnings")),
    ]);
    h.start({ until: "change" });
    await h.c.advance(20000);
    expect(h.wakes.map((w) => w[1])).toEqual(["changed"]);
    expect(h.wakes[0][0].agent).toBeUndefined();
  });

  it("carries no more than five notes and keeps the facts free of the question text", async () => {
    const h = harness([ok(claude.working)]);
    const id = h.start({ notes: ["a", "b", "c", "d", "e", "f"] });
    await h.c.advance(10000);
    const f: ProgressFacts = h.manager.facts(id)!;
    expect(f.sinceLast).toEqual([]);
    expect(f.corrections).toEqual([]);
    expect(h.manager.list()[0]).not.toHaveProperty("notes");
  });

  it("lets no text leave once the agent's panel closes, even with the agent known", async () => {
    // Claude Code docked on the right for ten reads, then closed: the editor
    // shows a private file in the whole window.
    const left = (t: string, y: number): OcrLine => ({
      t,
      x: 0.05,
      y,
      w: 0.5,
      h: 0.02,
    });
    const editor = [
      left("customers.csv", 0.1),
      left("jane doe, 12 elm st, card ending 4242", 0.15),
      left("private notes: acquire initech in q3", 0.2),
    ];
    const h = harness([
      ...Array.from({ length: 10 }, () => ok(claude.working)),
      ok(editor),
    ]);
    h.start();
    await h.c.advance(15 * 60000);
    expect(h.controller.probe.mock.calls.length).toBeGreaterThan(10);
    expect(h.wakes.map((w) => w[1])).toEqual(["unknown"]);
    expect(h.wakes[0][0].agent).toBe("claude-code");
    expect(h.wakes[0][2].panelTail).toBeUndefined();
    const out = JSON.stringify([h.facts, h.wakes]);
    for (const leaked of ["customers.csv", "4242", "initech"])
      expect(out).not.toContain(leaked);
    // While the panel was there, its own text did leave.
    expect(h.facts[0][0].watch?.panelTail).toContain("queue another message");
  });

  it("reads no agent into a window outside a coding editor", async () => {
    // A download page with a Continue button is not Cascade asking.
    const page = panel(
      "Your download is ready",
      "Keep all files together",
      "Continue",
    );
    const h = harness([ok(page)]);
    h.start({}, { ...binding, appId: "com.apple.Safari" });
    await h.c.advance(60000);
    expect(h.relays).toEqual([]);
    expect(h.wakes.map((w) => w[1])).toEqual(["unknown"]);
    expect(h.wakes[0][0].agent).toBeUndefined();
    expect(h.wakes[0][2].panelTail).toBeUndefined();
    for (const call of h.controller.probe.mock.calls)
      expect(call[1]).toBeUndefined();
    expect(JSON.stringify(h.facts)).not.toContain("download");
    // The same lines in an editor are an agent's, as before.
    const editor = harness([ok(page)]);
    editor.start();
    await editor.c.advance(10000);
    expect(editor.relays).toHaveLength(1);
  });

  it("bounds a chain of watches and wakes by time and by count", async () => {
    const h = harness([ok(claude.working)]);
    const now = h.c.now();
    expect(() =>
      h.start({ chain: { startedAt: now, wakes: CHAIN_WAKES_MAX } }),
    ).toThrow(
      new RegExp(`woken you ${CHAIN_WAKES_MAX} times since the user asked`),
    );
    const max = defaultSettings.watchMaxMinutes * 60000;
    expect(() =>
      h.start({ chain: { startedAt: now - max, wakes: 1 } }),
    ).toThrow(WatchRefusedError);
    expect(() =>
      h.start({ chain: { startedAt: now - max + 30000, wakes: 1 } }),
    ).toThrow(/as long as the settings allow/);
    expect(h.manager.list()).toEqual([]);
    // Ten minutes left of the chain: a thirty-minute watch ends at ten.
    h.start({
      maxMs: 30 * 60000,
      chain: { startedAt: now - max + 10 * 60000, wakes: 2, origin: "message" },
    });
    await h.c.advance(10 * 60000 - 20000);
    expect(h.wakes).toHaveLength(0);
    await h.c.advance(40000);
    expect(h.wakes.map((w) => w[1])).toEqual(["expired"]);
    expect(h.wakes[0][2].chain).toEqual({
      startedAt: now - max + 10 * 60000,
      wakes: 3,
      origin: "message",
    });
    // The chain's first request decides how the answer comes back.
    expect(h.wakes[0][2].origin).toBe("message");
  });

  it("answers a chained watch the way the chain was asked for", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    h.start({
      origin: "watch",
      chain: { startedAt: h.c.now(), wakes: 1, origin: "voice" },
    });
    await h.c.advance(30000);
    expect(h.wakes[0][2].origin).toBe("voice");
    expect(h.wakes[0][2].chain.wakes).toBe(2);
    // Its news is reported as the chain's too.
    expect(h.facts.length).toBeGreaterThan(0);
    for (const [f] of h.facts) expect(f.origin).toBe("voice");
  });

  it("carries the user's corrections to the facts and the wake-up run", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    const id = h.start({
      corrections: ["don't delete anything, just move old files"],
    });
    await h.c.advance(10000);
    expect(h.manager.facts(id)!.corrections).toEqual([
      "don't delete anything, just move old files",
    ]);
    await h.c.advance(20000);
    expect(h.wakes[0][2].corrections).toEqual([
      "don't delete anything, just move old files",
    ]);
  });

  it("refuses a fifth window at once, as the helper would", async () => {
    const h = harness([ok(claude.working)]);
    for (let i = 0; i < WATCHES_MAX; i++)
      h.start({}, { ...binding, token: `tok-${i}-abcdef`, windowId: 200 + i });
    expect(() =>
      h.start({}, { ...binding, token: "tok-5-abcdef", windowId: 300 }),
    ).toThrow(/4 windows are already being watched/);
    expect(h.manager.list()).toHaveLength(WATCHES_MAX);
  });

  it("lets a stop end a wake whose window is still coming forward", async () => {
    const h = harness([ok(claude.working), ok(claude.idle)]);
    let release = () => {};
    h.controller.focusWatch.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    h.start();
    await h.c.advance(30000);
    expect(h.controller.focusWatch).toHaveBeenCalledTimes(1);
    expect(h.manager.list()).toEqual([]);
    // The user says stop while the window is being brought forward.
    expect(h.manager.stop()).toBe(1);
    release();
    await flush();
    expect(h.wakes).toHaveLength(0);
    // A later stop finds nothing left.
    expect(h.manager.stop()).toBe(0);
  });
});

describe("what a wake-up run starts with", () => {
  const request =
    "Paste my tracking number into the search box on the carrier site and keep an eye on the page until the status changes.";
  it("is a follow-up that quotes the request as carried out, never the request itself", () => {
    const text = wakeTask({ app: "Safari" }, "changed", {
      task: request,
      corrections: [],
    });
    expect(text).toBe(
      `A watch on Safari woke you: the window changed. The earlier request, already carried out before the watch began: “${request}”.\nLook at the window as it is now and tell the user what it shows; do not repeat the earlier request's steps.`,
    );
    expect(text).not.toMatch(new RegExp(`^${request.slice(0, 20)}`));
    // It still contains the word, which is why a wake-up run never reads
    // its own objective as the user asking for a paste (runner.ts).
    expect(pasteRequested(text)).toBe(true);
    const agent = wakeTask({ agent: "claude-code", app: "Code" }, "done", {
      task: "x".repeat(5000),
      corrections: ["don't delete anything", "y".repeat(500)],
    });
    expect(agent).toMatch(
      /^A watch on Claude Code woke you: it looks finished\./,
    );
    expect(agent).toContain(
      "\nUser corrections to that request, in order. Preserve these constraints:\ndon't delete anything\n",
    );
    expect(agent.length).toBeLessThan(1200);
  });
  it("words the watched run's steps without what was typed", () => {
    const steps = [
      { type: "open_app", name: "Notes", frame_id: "f" },
      { type: "type_text", text: "my secret plan", frame_id: "f" },
      { type: "wait", milliseconds: 500, frame_id: "f" },
      { type: "hotkey", keys: ["CMD", "V"], frame_id: "f" },
    ] as Action[];
    const notes = handoffNotes(steps);
    expect(notes).toEqual([
      "opened Notes",
      "typed 14 characters",
      "pressed CMD+V",
    ]);
    expect(JSON.stringify(notes)).not.toContain("secret");
    expect(
      handoffNotes(Array.from({ length: 9 }, () => steps[0])),
    ).toHaveLength(5);
  });
});

describe("watch news for the pill and the sinks", () => {
  it("is spoken for a watch asked for by voice and never texted", () => {
    const base = {
      runId: "r",
      seq: 1,
      kind: "final" as const,
      text: "t",
      at: 5,
    };
    expect(fallbackReport({ ...base, origin: "voice" })).toEqual({
      ...base,
      speak: true,
      send: false,
      fallback: true,
    });
    for (const origin of [
      "typed",
      "message",
      "remote",
      "watch",
      undefined,
    ] as const)
      expect(fallbackReport({ ...base, origin })).toMatchObject({
        speak: false,
        send: false,
      });
  });
  it("keeps the latest card the pill had no room for until it is free", () => {
    const news = new HeldNews<string>();
    expect(news.offer("now", false)).toBe("now");
    expect(news.take(false)).toBeUndefined();
    // A run is on the pill: the relay card waits, and a later line replaces it.
    expect(news.offer("relay card", true, "r1")).toBeUndefined();
    expect(news.take(true)).toBeUndefined();
    expect(news.take(false)).toEqual({ item: "relay card", relay: "r1" });
    expect(news.take(false)).toBeUndefined();
    news.offer("relay card", true, "r2");
    news.offer("finished line", true);
    news.forget("r2");
    expect(news.take(false)).toEqual({ item: "finished line" });
    // A question answered in the editor meanwhile is never shown late.
    news.offer("relay card", true, "r3");
    news.forget("r3");
    expect(news.take(false)).toBeUndefined();
    news.offer("line", true);
    news.clear();
    expect(news.take(false)).toBeUndefined();
  });
});
