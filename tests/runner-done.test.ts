import { describe, it, expect, vi, afterEach } from "vitest";
import {
  defaultSettings,
  type Action,
  type Controller,
  type Frame,
  type JournalEvent,
  type Observation,
  type ProviderResult,
  type Recorder,
  type Run,
  type Settings,
  type Surface,
} from "../src/core/schema";
import {
  Runner,
  declinedResult,
  doneChallenge,
  failureCode,
  MODEL_RESULT_CHARS,
} from "../src/core/runner";
import { ModelFailedError } from "../src/core/errors";
import { approvalCode } from "../src/core/approval-codes";
import {
  deliverableChallenge,
  deliverableMissing,
  type FileFacts,
} from "../src/core/deliverables";

type Decision = { kind: string; reason: string };
// Pins the policy decision for the steps around the one under test, so the
// runner's reaction is tested independently of the policy vocabulary; a
// reply of undefined falls through to the real policy.
const policy = vi.hoisted(() => ({
  evaluate: undefined as
    | undefined
    | ((
        a: Action,
        s: Surface,
        st: Settings,
        synthetic: boolean,
      ) => Decision | undefined),
}));
vi.mock("../src/core/policy", async (original) => {
  const actual = await original<typeof import("../src/core/policy")>();
  return {
    ...actual,
    evaluate: (a: Action, s: Surface, st: Settings, synthetic: boolean) =>
      policy.evaluate?.(a, s, st, synthetic) ??
      actual.evaluate(a, s, st, synthetic),
  };
});
afterEach(() => {
  policy.evaluate = undefined;
});

const geometry = {
  display_id: 1,
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
  native_width: 2880,
  native_height: 1800,
  model_width: 1280,
  model_height: 720,
  scale_factor: 2,
};
/** The Finder, as the helper reports it with a file row selected and nothing focused. */
const finder: Surface = {
  appId: "com.apple.finder",
  pid: 42,
  secureInput: false,
  unknown: false,
};
const settings = structuredClone(defaultSettings);
const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (condition: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out waiting for condition.");
    await tick();
  }
};
function memory() {
  const events: JournalEvent[] = [];
  let run: Run;
  const recorder: Recorder = {
    begin: (r) => {
      run = r;
    },
    save: (r) => {
      run = r;
    },
    frame: () => {},
    append: (id, type, data = {}) => {
      const e: JournalEvent = {
        event_id: crypto.randomUUID(),
        run_id: id,
        type,
        data,
        sequence_number: events.length + 1,
        schema_version: 1,
        monotonic_timestamp: performance.now(),
        wall_clock_timestamp: new Date().toISOString(),
      };
      events.push(e);
      return e;
    },
  };
  const of = (type: string) => events.filter((e) => e.type === type);
  return { recorder, events, of, getRun: () => run! };
}
let captures = 0;
/** Every capture is a new frame with new pixels: the screen keeps changing. */
function controller(surface: Surface = finder): Controller {
  return {
    kind: "native",
    surface: async () => surface,
    capture: async () => ({
      id: `frame-${++captures}`,
      sha256: `sha-${captures}`,
      image: "",
      geometry,
      capturedAt: 0,
      synthetic: false,
      appId: surface.appId,
    }),
    execute: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
  };
}
/** Provider that plays scripted replies, then says done. */
function scripted(
  replies: ((o: Observation) => Partial<ProviderResult>)[],
  finish = { type: "done", summary: "Done." },
) {
  const observations: Observation[] = [];
  const next = vi.fn(async (o: Observation, _signal: AbortSignal) => {
    observations.push(structuredClone(o));
    const reply = replies[observations.length - 1];
    const value = reply
      ? reply(o)
      : { action: { ...finish, frame_id: o.frame.id } };
    return { usage, ...value } as ProviderResult;
  });
  return { next, observations };
}
const act =
  (action: Record<string, unknown>) =>
  (o: Observation): Partial<ProviderResult> => ({
    action: { ...action, frame_id: o.frame.id },
  });
const enter = act({ type: "key", key: "ENTER" });
const click = act({ type: "click", x: 0.48, y: 0.46 });
const typed = act({ type: "type_text", text: "abc12345678-a.txt" });
const done = (summary: string) => act({ type: "done", summary });
const fail = (reason: string) => act({ type: "fail", reason });
const ALLOW = { kind: "ALLOW", reason: "Test." };
/** The real policy decides Return; every other step runs. */
const realReturn = () => {
  policy.evaluate = (a) => (a.type === "key" ? undefined : ALLOW);
};
const ACTIVATE = "Activate this control? It may submit or change content.";
const declineEach = async (
  runner: Runner,
  m: ReturnType<typeof memory>,
  prompts: number,
) => {
  for (let asked = 1; asked <= prompts; asked++) {
    await until(() => m.of("PolicyConfirmationRequested").length === asked);
    runner.confirm(false);
  }
};
const rejected = (o: Observation) =>
  o.history.filter((entry) => entry.type === "rejected");
const challenges = (m: ReturnType<typeof memory>) =>
  m.of("ActionFailed").filter((e) => e.data.code === "DONE_CHALLENGED");

/**
 * Cycle 20260919-0816-a839d34 (gpt-5.4-mini, every approval declined):
 * files-rename-pattern #2 and #3 each had six approvals asked and declined,
 * five of them the policy's question for Return in the Finder (the key that
 * starts and commits a rename), typed the new names, clicked around and
 * said done with the files not renamed. The sequence below is the run's own
 * shape, content-free: Return declined through the real policy, a click and
 * a typed name executed, Return declined again, a click, then done.
 */
describe("a done after a declined step (cycle 20260919-0816-a839d34)", () => {
  it("is not accepted bare: the model is shown the declined question once more on a fresh screenshot, and its fail ends the run honestly", async () => {
    realReturn();
    const m = memory();
    const c = controller();
    const p = scripted([
      enter,
      click,
      typed,
      enter,
      click,
      done("The three files are renamed."),
      fail("Renaming needed approval to press Return, which was declined."),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start(
      "In the folder, rename the three draft files so each one starts with the token instead of draft.",
    );
    await declineEach(runner, m, 2);
    await running;
    // The mechanism: Return in the Finder asks the activation question,
    // whatever is focused, and the bench declines it (ACTIVATE_CONTROL).
    const asked = m.of("PolicyConfirmationRequested");
    expect(asked.map((e) => e.data.reason)).toEqual([ACTIVATE, ACTIVATE]);
    expect(asked.map((e) => e.data.approvalCode)).toEqual([
      "ACTIVATE_CONTROL",
      "ACTIVATE_CONTROL",
    ]);
    expect(approvalCode(ACTIVATE)).toBe("ACTIVATE_CONTROL");
    expect(m.of("UserDenied")).toHaveLength(2);
    expect(c.execute).toHaveBeenCalledTimes(3);
    // The done was not accepted: no completion, one check, and the model
    // read why on the next step, with the question it had declined.
    expect(m.of("RunCompleted")).toHaveLength(0);
    const checked = challenges(m);
    expect(checked).toHaveLength(1);
    expect(checked[0].data).toEqual({
      code: "DONE_CHALLENGED",
      actionType: "done",
      reason: "refused_step",
    });
    expect(p.observations).toHaveLength(7);
    const after = p.observations[6];
    expect(after.history.at(-1)).toEqual({
      type: "rejected",
      action: { type: "done" },
      result: doneChallenge(ACTIVATE),
    });
    const line = after.history.at(-1)!.result;
    expect(line).toContain(ACTIVATE);
    expect(line).toContain("fresh screenshot");
    expect(line).toContain("say fail");
    expect(line).not.toContain("request_user");
    expect(line.length).toBeLessThan(MODEL_RESULT_CHARS);
    // The check is made on a new capture, not the frame the done named.
    expect(after.frame.id).not.toBe(p.observations[5].frame.id);
    // The model's own summary never reached the user as a completion.
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(m.getRun().summary).toBe(
      "Renaming needed approval to press Return, which was declined.",
    );
    // The bench reads this ActionProposed as MODEL_FAILED, an honest failure.
    expect(
      m
        .of("ActionProposed")
        .filter((e) => (e.data.action as Action).type === "fail"),
    ).toHaveLength(1);
  });
  it("accepts the done said again after the one check, with the second summary", async () => {
    realReturn();
    const m = memory();
    const c = controller();
    const p = scripted([
      enter,
      click,
      done("Renamed them."),
      done(
        "The three files now start with the token; the Finder shows the new names.",
      ),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("rename the drafts");
    await declineEach(runner, m, 1);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.getRun().summary).toBe(
      "The three files now start with the token; the Finder shows the new names.",
    );
    expect(challenges(m)).toHaveLength(1);
    expect(m.of("RunCompleted")).toHaveLength(1);
    expect(p.next).toHaveBeenCalledTimes(4);
  });
  it("checks once per refusal: a step taken after the check answers it, and a later decline arms it again", async () => {
    realReturn();
    const m = memory();
    const c = controller();
    const p = scripted([
      enter, // declined
      done("Done."), // checked
      click, // the model chose to keep working
      done("Done now."), // accepted: the check was answered by acting
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("rename the drafts");
    await declineEach(runner, m, 1);
    await running;
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.getRun().summary).toBe("Done now.");
    expect(challenges(m)).toHaveLength(1);

    const m2 = memory();
    const p2 = scripted([
      enter, // declined
      done("Done."), // checked
      enter, // declined again
      done("Done."), // checked again
      done("Done at last."),
    ]);
    const runner2 = new Runner(
      controller(),
      p2,
      m2.recorder,
      settings,
      () => {},
    );
    const running2 = runner2.start("rename the drafts");
    await declineEach(runner2, m2, 2);
    await running2;
    expect(runner2.snapshot.run?.status).toBe("completed");
    expect(m2.getRun().summary).toBe("Done at last.");
    expect(challenges(m2)).toHaveLength(2);
    expect(rejected(p2.observations[4])).toHaveLength(2);
  });
  it("checks a done after a step the policy refused outright the same way", async () => {
    const refusal =
      "No input was sent. Clipboard access is disabled. Pasting is allowed only when the user asked for a paste and a text field is focused; copying and cutting never are.";
    policy.evaluate = (a) =>
      a.type === "hotkey" ? { kind: "DENY", reason: refusal } : ALLOW;
    const m = memory();
    const c = controller();
    const p = scripted([
      act({ type: "hotkey", keys: ["CMD", "C"] }),
      done("Copied the total."),
      fail("Copying is not allowed here."),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("copy the total");
    expect(m.of("UserDenied")).toHaveLength(1);
    expect(challenges(m)).toHaveLength(1);
    expect(p.observations[2].history.at(-1)).toEqual({
      type: "rejected",
      action: { type: "done" },
      result: doneChallenge(refusal),
    });
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(c.execute).not.toHaveBeenCalled();
  });
  it("tells the model at the decline that a done will be checked and what its summary must say", () => {
    const line = declinedResult(ACTIVATE);
    expect(line).toContain("Do not propose this step again");
    expect(line).toContain("fail and say what needed approval");
    expect(line).toContain("checked once more against a fresh screenshot");
    expect(line).toContain("what on screen shows it");
    expect(line).not.toContain("request_user");
    expect(line.length).toBeLessThan(MODEL_RESULT_CHARS - 150);
  });
});

describe("what the check leaves alone", () => {
  it("still accepts a legitimate done after a decline worked around another way, after the one check", async () => {
    const question = "Click “Zeta”?";
    policy.evaluate = (a) =>
      a.type === "click_control"
        ? { kind: "CONFIRM", reason: question }
        : ALLOW;
    const m = memory();
    const c = controller();
    const p = scripted([
      act({ type: "click_control", label: "Zeta" }), // declined
      act({ type: "menu_item", path: ["File", "Zeta"] }), // the route around it
      done("Zeta is open."),
      done("Zeta is open; its window is in front."),
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("open zeta");
    await declineEach(runner, m, 1);
    await running;
    expect(c.execute).toHaveBeenCalledTimes(1);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.getRun().summary).toBe("Zeta is open; its window is in front.");
    expect(m.of("RunFailed")).toHaveLength(0);
    expect(m.of("UserTakeoverStarted")).toHaveLength(0);
    expect(m.of("RunPaused")).toHaveLength(0);
    // One model call is the whole cost of the check.
    expect(p.next).toHaveBeenCalledTimes(4);
    expect(challenges(m)).toHaveLength(1);
  });
  it("leaves a done with no declined step and a changed screen untouched", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = scripted([typed, done("Typed the name.")]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("type the name");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.getRun().summary).toBe("Typed the name.");
    expect(p.next).toHaveBeenCalledTimes(2);
    expect(challenges(m)).toHaveLength(0);
    expect(m.of("ActionFailed")).toHaveLength(0);
    expect(rejected(p.observations[1])).toHaveLength(0);
    // The two frames the model saw were different screens.
    expect(p.observations[1].frame.sha256).not.toBe(
      p.observations[0].frame.sha256,
    );
  });
  it("starts every run unarmed: a decline in the last run never checks the next run's done", async () => {
    realReturn();
    const m = memory();
    const c = controller();
    const p = scripted([enter, done("Done."), done("Done.")]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start("first");
    await declineEach(runner, m, 1);
    await running;
    expect(challenges(m)).toHaveLength(1);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.next).toHaveBeenCalledTimes(3);
    // The same runner again: the provider's next reply is a bare done.
    await runner.start("second");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(p.next).toHaveBeenCalledTimes(4);
    expect(challenges(m)).toHaveLength(1);
  });
});

/**
 * Cycle 20260919-1646-09c5412 (gpt-5.4-mini, the owner's regime): six dones,
 * five false. memory-log-expense-ledger #1 said done after three actions
 * with the ledger's row not appended; ops-kpi-snapshot-note #1 after
 * eighteen with the note's header lost; mail-find-fact #2 and
 * msg-group-chat-digest #2 with the fact not in the notes file. Each task
 * named the file in its own words, and the file had not been changed as
 * asked. The sequence below is that shape, content-free: a step or two, then
 * done with the file exactly as it was when the run began.
 */
const LEDGER = "~/OpenAssistBench/abc12345678/abc12345678-ledger.csv";
const LEDGER_TASK = `Log an expense in ${LEDGER}: today, taxi, 12 dollars. Keep the rows that are there.`;
const SAME: FileFacts = { exists: true, size: 64, mtimeMs: 1_700_000_000_000 };
/**
 * A reader over a fake disk: answers the facts in order, the last one for
 * every later read, and remembers every path it was asked. It has no write.
 */
function disk(...facts: (FileFacts | null)[]) {
  const asked: string[] = [];
  let reads = 0;
  return {
    asked,
    reads: () => reads,
    read: vi.fn(async (path: string) => {
      asked.push(path);
      return facts[Math.min(reads++, facts.length - 1)] ?? null;
    }),
  };
}
const deliverable = (m: ReturnType<typeof memory>) =>
  challenges(m).filter((e) => e.data.reason === "deliverable_unchanged");
const withDisk = (
  c: Controller,
  p: ReturnType<typeof scripted>,
  m: ReturnType<typeof memory>,
  read: (path: string) => Promise<FileFacts | null>,
) =>
  new Runner(c, p, m.recorder, settings, () => {}, [], undefined, {
    deliverables: read,
  });

describe("a done with the task's file unchanged (cycle 20260919-1646-09c5412)", () => {
  it("is not accepted: one challenge naming the file and the fact, then a second done fails the run as DELIVERABLE_MISSING", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const fs = disk(SAME);
    const p = scripted([
      typed,
      done("Logged the taxi expense in the ledger."),
      done("The ledger has the taxi row."),
    ]);
    const runner = withDisk(c, p, m, fs.read);
    await runner.start(LEDGER_TASK);
    // The facts were read at the start and at each done, for the path
    // alone: never the task's words, never anything else.
    expect(fs.asked).toEqual([LEDGER, LEDGER, LEDGER]);
    expect(c.execute).toHaveBeenCalledTimes(1);
    // One check, with its code and reason and nothing else.
    const checked = deliverable(m);
    expect(checked).toHaveLength(1);
    expect(checked[0].data).toEqual({
      code: "DONE_CHALLENGED",
      actionType: "done",
      reason: "deliverable_unchanged",
    });
    expect(challenges(m)).toHaveLength(1);
    // The model read the fact on its next step, on a fresh capture.
    expect(p.observations).toHaveLength(3);
    const after = p.observations[2];
    expect(after.history.at(-1)).toEqual({
      type: "rejected",
      action: { type: "done" },
      result: deliverableChallenge([{ path: LEDGER, before: SAME }]),
    });
    const line = after.history.at(-1)!.result;
    expect(line).toContain(LEDGER);
    expect(line).toContain("has not changed since the run began");
    expect(line).toContain("say fail");
    expect(line).not.toContain("request_user");
    expect(line.length).toBeLessThan(MODEL_RESULT_CHARS);
    expect(after.frame.id).not.toBe(p.observations[1].frame.id);
    // The second done with the file still the same: the runner's verdict.
    expect(m.of("RunCompleted")).toHaveLength(0);
    expect(m.of("RunFailed")).toHaveLength(1);
    expect(m.of("RunFailed")[0].data).toEqual({ code: "DELIVERABLE_MISSING" });
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(m.getRun().summary).toBe(
      deliverableMissing([{ path: LEDGER, before: SAME }]),
    );
    expect(m.getRun().summary).toBe(
      `Not done: ${LEDGER} has not changed since the run began.`,
    );
    // Nothing was written, deleted or sent by the check itself.
    expect(m.of("ActionExecuted")).toHaveLength(1);
  });
  it("accepts the done said again once the file changed, with the second summary", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    // Start and first done read the same facts; after the model went back
    // and saved, the size and time differ.
    const fs = disk(SAME, SAME, {
      ...SAME,
      size: 91,
      mtimeMs: SAME.mtimeMs + 4000,
    });
    const p = scripted([
      done("Logged it."),
      typed,
      done(
        "The ledger now ends with today's taxi row and TextEdit shows it saved.",
      ),
    ]);
    const runner = withDisk(c, p, m, fs.read);
    await runner.start(LEDGER_TASK);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.getRun().summary).toBe(
      "The ledger now ends with today's taxi row and TextEdit shows it saved.",
    );
    expect(deliverable(m)).toHaveLength(1);
    expect(m.of("RunFailed")).toHaveLength(0);
    expect(m.of("RunCompleted")).toHaveLength(1);
    expect(p.next).toHaveBeenCalledTimes(3);
    expect(fs.reads()).toBe(3);
  });
  it("accepts a file absent at the start and created by the run, unchallenged", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const fs = disk({ exists: false, size: 0, mtimeMs: 0 }, SAME);
    const p = scripted([typed, done("Saved the summary to the notes file.")]);
    const runner = withDisk(c, p, m, fs.read);
    await runner.start(
      "Read the page and write a three-line summary into ~/OpenAssistBench/abc12345678/abc12345678-notes.txt. Save it.",
    );
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(challenges(m)).toHaveLength(0);
    expect(m.of("ActionFailed")).toHaveLength(0);
    expect(p.next).toHaveBeenCalledTimes(2);
  });
  it("fails a file absent at the start and still absent at two dones", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const fs = disk({ exists: false, size: 0, mtimeMs: 0 });
    const p = scripted([done("Wrote the summary."), done("Wrote it.")]);
    const runner = withDisk(c, p, m, fs.read);
    await runner.start(
      "Write the total into ~/OpenAssistBench/abc12345678/abc12345678-notes.txt and save.",
    );
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(m.of("RunFailed")[0].data).toEqual({ code: "DELIVERABLE_MISSING" });
    const line = p.observations[1].history.at(-1)!.result;
    expect(line).toContain("it still does not exist");
  });
  it("lets the model withdraw the claim after the check with an honest fail", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const fs = disk(SAME);
    const p = scripted([
      done("Logged it."),
      fail("The ledger could not be saved; TextEdit refused the format."),
    ]);
    const runner = withDisk(c, p, m, fs.read);
    await runner.start(LEDGER_TASK);
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(m.getRun().summary).toBe(
      "The ledger could not be saved; TextEdit refused the format.",
    );
    // The model's own fail, not the runner's verdict and not a crash.
    expect(m.of("RunFailed")[0].data).toEqual({ code: "MODEL_FAILED" });
    expect(deliverable(m)).toHaveLength(1);
  });
  it("checks a refused step first and the file second, each once, in one run", async () => {
    realReturn();
    const m = memory();
    const c = controller();
    const fs = disk(SAME);
    const p = scripted([
      enter, // declined
      done("Done."), // the refusal check
      done("Done."), // the file check
      done("Done."), // the runner's verdict
    ]);
    const runner = withDisk(c, p, m, fs.read);
    const running = runner.start(LEDGER_TASK);
    await declineEach(runner, m, 1);
    await running;
    expect(challenges(m).map((e) => e.data.reason)).toEqual([
      "refused_step",
      "deliverable_unchanged",
    ]);
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(m.of("RunFailed")[0].data).toEqual({ code: "DELIVERABLE_MISSING" });
    expect(p.next).toHaveBeenCalledTimes(4);
  });
});

describe("what the file check leaves alone", () => {
  it("never asks the disk for a task that names no file, and starts every run fresh", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const fs = disk(SAME);
    const p = scripted([typed, done("Typed the name."), done("Done.")]);
    const runner = withDisk(c, p, m, fs.read);
    await runner.start("type the name");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(fs.read).not.toHaveBeenCalled();
    expect(challenges(m)).toHaveLength(0);
    // The same runner, a task with a file, the file unchanged: checked once
    // and then failed; the earlier run left nothing armed or disarmed.
    const m2 = memory();
    const runner2 = new Runner(
      controller(),
      scripted([done("Done."), done("Done.")]),
      m2.recorder,
      settings,
      () => {},
      [],
      undefined,
      { deliverables: fs.read },
    );
    await runner2.start(LEDGER_TASK);
    expect(runner2.snapshot.run?.status).toBe("failed");
    expect(deliverable(m2)).toHaveLength(1);
    expect(fs.asked).toEqual([LEDGER, LEDGER, LEDGER]);
  });
  it("never challenges a task whose file may rightly stay as it is: a read-only ask, or a conditional write", async () => {
    policy.evaluate = () => ALLOW;
    for (const task of [
      "Open ~/OpenAssistBench/abc12345678/abc12345678-budget.txt in TextEdit and tell me the total on its last line.",
      "In Safari, check the status page at http://127.0.0.1:8765/status. If anything is down, write which service in ~/OpenAssistBench/abc12345678/abc12345678-alerts.txt and save it. If everything is fine, leave that file alone.",
      "Open the file ~/OpenAssistBench/abc12345678/abc12345678-todo.txt, then add a reminder in Reminders with the text of its TODO line.",
    ]) {
      const m = memory();
      const fs = disk(SAME);
      const p = scripted([
        click,
        done("Nothing is down; the file is untouched."),
      ]);
      const runner = withDisk(controller(), p, m, fs.read);
      await runner.start(task);
      expect(runner.snapshot.run?.status, task).toBe("completed");
      expect(fs.read, task).not.toHaveBeenCalled();
      expect(challenges(m), task).toHaveLength(0);
    }
  });
  it("checks nothing when the reader declines the path, throws, or is not configured", async () => {
    policy.evaluate = () => ALLOW;
    for (const read of [
      async () => null,
      async () => {
        throw new Error("EACCES");
      },
      undefined,
    ]) {
      const m = memory();
      const p = scripted([done("Logged it.")]);
      const runner = new Runner(
        controller(),
        p,
        m.recorder,
        settings,
        () => {},
        [],
        undefined,
        read ? { deliverables: read } : {},
      );
      await runner.start(LEDGER_TASK);
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(challenges(m)).toHaveLength(0);
      expect(p.next).toHaveBeenCalledTimes(1);
    }
    // A read that fails at the done is not evidence either way.
    const m = memory();
    let reads = 0;
    const p = scripted([done("Logged it.")]);
    const runner = withDisk(controller(), p, m, async () => {
      if (reads++ === 0) return SAME;
      throw new Error("EIO");
    });
    await runner.start(LEDGER_TASK);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(challenges(m)).toHaveLength(0);
  });
  it("still accepts a done with no file in the task and a changed screen, as before", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = scripted([typed, done("Typed the name.")]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("type the name");
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.of("ActionFailed")).toHaveLength(0);
  });
  it("names both checks' requirement of a summary that points at the evidence", () => {
    expect(doneChallenge(ACTIVATE)).toContain(
      "what on screen, or in the file the objective names, shows the objective met",
    );
    expect(deliverableChallenge([{ path: LEDGER, before: SAME }])).toContain(
      "names what in the file or on screen shows the objective met",
    );
  });
});

describe("the code a failed run is journaled under", () => {
  it("is the model's own MODEL_FAILED for a fail action, with the reason as the summary", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = scripted([fail("The page asks for a sign-in I cannot do.")]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start("read the balance");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(m.getRun().summary).toBe("The page asks for a sign-in I cannot do.");
    // Live 2026-09-19 02:41:08: a declined request was journaled RUN_ERROR,
    // beside real crashes. The model's fail is its own code.
    expect(m.of("RunFailed").map((e) => e.data)).toEqual([
      { code: "MODEL_FAILED" },
    ]);
    expect(c.execute).not.toHaveBeenCalled();
  });
  it("keeps RUN_ERROR for a plain error and maps an error that names itself by a code", () => {
    expect(failureCode(new Error("boom"))).toBe("RUN_ERROR");
    expect(failureCode("not even an error")).toBe("RUN_ERROR");
    expect(failureCode(undefined)).toBe("RUN_ERROR");
    expect(failureCode(new ModelFailedError("no"))).toBe("MODEL_FAILED");
    expect(failureCode({ code: "HELPER_UNAVAILABLE" })).toBe(
      "HELPER_UNAVAILABLE",
    );
    // A code is a fixed upper-case word, never a sentence or a number.
    expect(failureCode({ code: "the file was not there" })).toBe("RUN_ERROR");
    expect(failureCode({ code: 18 })).toBe("RUN_ERROR");
    expect(failureCode({ code: "x" })).toBe("RUN_ERROR");
    expect(new ModelFailedError("why").message).toBe("why");
    expect(new ModelFailedError("why").name).toBe("ModelFailedError");
  });
});
