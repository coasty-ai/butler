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
import {
  auditApplies,
  DONE_AUDIT_DEADLINE_MS,
  DONE_AUDIT_MAX_OUTPUT_TOKENS,
  DONE_AUDIT_MAX_REQUIREMENTS,
  DONE_AUDIT_MIN_ACTIONS,
  DONE_AUDIT_PROMPT,
  DONE_AUDIT_REMINDER,
  doneAuditCall,
  doneAuditInput,
  multiClause,
  parseDoneAudit,
  requirementChallenge,
  requirementsUnmet,
  REQUIREMENT_KINDS,
  REQUIREMENT_UNMET,
  SCREEN_CHARS,
  type RequirementKind,
} from "../src/core/done-audit";
import type { ProviderTextCall, ProviderTextReply } from "../src/core/schema";

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

/**
 * Probe cycle 20260919-2144-9714f98 (FALSE_DONE re-run, autonomy all,
 * gpt-5.4-mini): three of four dones false and none sent back. Two hotel
 * runs said done after five actions (open_app, open_url, click_control, a
 * tool append, done) with the search never filled (no type_text in the
 * run) and both dates missing from the grade; a digest said done after
 * fifteen actions with two of its three named facts absent from the note.
 * The named file had changed in each, so the size-and-time check passed
 * it; only the objective's words say which clause was skipped. The shapes
 * below are that, content-free: three executed steps, then done on an
 * objective of two clauses, with the audit's reply scripted.
 */
const AUDIT_USAGE = { inputTokens: 900, outputTokens: 80, cost: 0.0021 };
/** Two sentences: the search, then the note. Synthetic words, no task's. */
const TWO_CLAUSES =
  "Open the listings page and search for the two dates I gave you. Then write the name and price of the best room into the notes and save.";
const ONE_CLAUSE = "type the name into the field";
const met = (
  text: string,
  evidence: string,
  kind: RequirementKind = "other",
) => ({ text, kind, met: true, evidence });
const unmet = (text: string, kind: RequirementKind = "other") => ({
  text,
  kind,
  met: false,
  evidence: null,
});
const reply = (requirements: object[]) => JSON.stringify({ requirements });
/** The hotel shape: the page opened and the note written; the search and the save never done. */
const HOTEL_AUDIT = reply([
  met("open the listings page", "1 click", "open"),
  unmet("search for the two dates", "enter"),
  met("write the name and price into the notes", "2 type_text", "write"),
  unmet("save the notes", "save"),
]);
/** The second audit's shape when the dates were searched since and the save still was not. */
const SAVE_UNMET = reply([
  met("open the listings page", "1 click", "open"),
  met("search for the two dates", "5 type_text", "enter"),
  met("write the name and price into the notes", "2 type_text", "write"),
  unmet("save the notes", "save"),
]);
const ALL_MET = reply([
  met("open the listings page", "1 click", "open"),
  met("search for the two dates", "2 type_text", "enter"),
]);
/** A scripted reply with its own code (a reply the cap cut, then a whole one). */
type AuditReply =
  string | Error | { text: string; code: ProviderTextReply["code"] };
/** The scripted provider given the text path: every audit reply scripted, the calls kept. */
function auditing(
  p: ReturnType<typeof scripted>,
  replies: AuditReply[],
  code: ProviderTextReply["code"] = "ok",
) {
  const calls: ProviderTextCall[] = [];
  const text = vi.fn(
    async (
      call: ProviderTextCall,
      _signal: AbortSignal,
    ): Promise<ProviderTextReply> => {
      calls.push(structuredClone(call));
      const next = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (next instanceof Error) throw next;
      if (typeof next === "object")
        return { text: next.text, usage: AUDIT_USAGE, code: next.code };
      return { text: next, usage: AUDIT_USAGE, code };
    },
  );
  return { next: p.next, observations: p.observations, text, calls };
}
/**
 * The hotel reply cut where a reply of market 1/3 at 55e4e83 was: at the
 * output cap, inside a requirement, with the list's object never closed.
 */
const CUT_AUDIT = HOTEL_AUDIT.slice(0, HOTEL_AUDIT.indexOf('"kind":"enter"'));
const audits = (m: ReturnType<typeof memory>) => m.of("DoneAudited");
const requirementChallenges = (m: ReturnType<typeof memory>) =>
  challenges(m).filter((e) => e.data.reason === REQUIREMENT_UNMET);
/**
 * Three executed steps, then done — and, in case of a challenge, one real
 * step and a second done, which is audited once more whatever ran since
 * (the scripted replies say whether it stands or fails REQUIREMENTS_UNMET).
 */
const threeThenDone = (first = "Found the room and noted it.") => [
  click,
  typed,
  enter,
  done(first),
  click,
  done("Searched the dates, noted the room, saved."),
];

describe("a done audited against the objective's clauses (cycle 20260919-2144-9714f98)", () => {
  it("makes one text call at the first done after three actions on a two-clause objective, sends the done back once with the unmet requirements, and accepts the second", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = auditing(scripted(threeThenDone()), [HOTEL_AUDIT, ALL_MET]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start(TWO_CLAUSES);
    // Three steps, the challenged done, one real step, the done that stood.
    expect(c.execute).toHaveBeenCalledTimes(4);
    // The first audit call: the prompt, the objective, the compact history
    // lines (no screenshot) and the claimed summary, as text.
    const [call] = p.calls;
    expect(call.system).toBe(DONE_AUDIT_PROMPT);
    expect(call.input).toContain(TWO_CLAUSES);
    expect(call.input).toContain("Steps (oldest first):");
    expect(call.input).toContain("1. click ");
    expect(call.input).toContain("2. type_text ");
    expect(call.input).toContain("3. key ");
    expect(call.input).toContain("Found the room and noted it.");
    expect(call.input).not.toContain("frame_id");
    expect(call.input).not.toContain("image");
    expect(call.effort).toBe("medium");
    expect(call.deadlineMs).toBeGreaterThan(0);
    expect(call.maxOutputTokens).toBeGreaterThan(0);
    // The done was sent back once with its code, reason and the count.
    const sent = requirementChallenges(m);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toEqual({
      code: "DONE_CHALLENGED",
      actionType: "done",
      reason: REQUIREMENT_UNMET,
      unmet: 2,
    });
    expect(challenges(m)).toHaveLength(1);
    // The model read the unmet requirements in the audit's own words on
    // its next step, with both routes and the once-only rule.
    expect(p.observations).toHaveLength(6);
    const after = p.observations[4];
    expect(after.history.at(-1)).toEqual({
      type: "rejected",
      action: { type: "done" },
      result: requirementChallenge([
        unmet("search for the two dates"),
        unmet("save the notes"),
      ]),
    });
    const line = after.history.at(-1)!.result;
    expect(line).toContain("2 were not met");
    expect(line).toContain("“search for the two dates”");
    expect(line).toContain("“save the notes”");
    expect(line).not.toContain("open the listings page");
    expect(line).toContain("say fail");
    expect(line).toContain("checked once more");
    expect(line).not.toContain("stands on your word");
    expect(line).not.toContain("request_user");
    expect(line.length).toBeLessThan(MODEL_RESULT_CHARS);
    // The second done, after a real step, is audited once more over its
    // new summary; all met, it stands: two calls, one challenge, the run
    // completed with the second summary.
    expect(p.text).toHaveBeenCalledTimes(2);
    expect(p.calls[1].input).toContain(
      "Searched the dates, noted the room, saved.",
    );
    expect(challenges(m)).toHaveLength(1);
    expect(m.of("RunCompleted")).toHaveLength(1);
    expect(runner.snapshot.run?.status).toBe("completed");
    expect(m.getRun().summary).toBe(
      "Searched the dates, noted the room, saved.",
    );
    // Two DoneAudited rows: counts, the code, the attempts and the unmet
    // requirements' kinds (the fixed list, in order) only; the audits'
    // tokens are the run's, added as any call.
    expect(audits(m)).toHaveLength(2);
    expect(audits(m)[0].data).toEqual({
      requirements: 4,
      unmet: 2,
      unmetKinds: ["enter", "save"],
      durationMs: expect.any(Number),
      code: "ok",
      attempts: 1,
    });
    expect(audits(m)[1].data).toEqual({
      requirements: 2,
      unmet: 0,
      unmetKinds: [],
      durationMs: expect.any(Number),
      code: "ok",
      attempts: 1,
    });
    expect(m.of("UsageAdded")).toHaveLength(2);
    expect(m.of("UsageAdded")[0].data).toEqual({ usage: AUDIT_USAGE });
    expect(m.getRun().usage).toEqual({
      inputTokens: AUDIT_USAGE.inputTokens * 2,
      outputTokens: AUDIT_USAGE.outputTokens * 2,
      cost: AUDIT_USAGE.cost * 2,
    });
    // The trace carries no requirement's words: they reach the model and
    // the history line only. A kind is a word from the fixed list, never
    // the requirement's own.
    const traced = JSON.stringify(
      [...audits(m), ...challenges(m), ...m.of("UsageAdded")].map(
        (e) => e.data,
      ),
    );
    expect(traced).not.toContain("listings");
    expect(traced).not.toContain("dates");
    expect(traced).not.toContain("notes");
    expect(traced).not.toContain("save the");
    for (const kind of audits(m).flatMap((e) => e.data.unmetKinds as string[]))
      expect(REQUIREMENT_KINDS).toContain(kind);
  });
  it("fails the run when the done is repeated after the challenge with nothing but a look between: REQUIREMENTS_UNMET, not a second claim", async () => {
    // Probe 20260920-0055-a897a04, travel-hotel-shortlist #1: the audit
    // found two of seven requirements unmet, the claim went back, the model
    // captured once and said done again, and the second done stood — graded
    // DATES_NOT_SEARCHED. The runner ends that run honestly now.
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = auditing(
      scripted([
        click,
        typed,
        enter,
        done("Found the room and noted it."),
        act({ type: "capture" }),
        done("Searched the dates, noted the room, saved."),
      ]),
      [HOTEL_AUDIT],
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start(TWO_CLAUSES);
    // The repeated claim got one hearing: a second audit over the new
    // summary, which found the same two unmet; then the run failed.
    expect(p.text).toHaveBeenCalledTimes(2);
    expect(audits(m)).toHaveLength(2);
    expect(requirementChallenges(m)).toHaveLength(1);
    expect(m.of("RunCompleted")).toHaveLength(0);
    expect(m.of("RunFailed")).toHaveLength(1);
    expect(m.of("RunFailed")[0].data).toEqual({
      code: "REQUIREMENTS_UNMET",
      unmetKinds: ["enter", "save"],
    });
    expect(audits(m).map((e) => e.data.unmetKinds)).toEqual([
      ["enter", "save"],
      ["enter", "save"],
    ]);
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.run?.summary).toBe(
      requirementsUnmet([
        unmet("search for the two dates"),
        unmet("save the notes"),
      ]),
    );
    expect(runner.snapshot.run?.summary).toMatch(/^Not done: 2 requirements/);
    // A wait is a look too; a real step between (the main case above) lets
    // the second done stand.
    const c2 = controller();
    const m2 = memory();
    const p2 = auditing(
      scripted([
        click,
        typed,
        enter,
        done("Found the room and noted it."),
        act({ type: "wait", ms: 200 }),
        done("Searched the dates, noted the room, saved."),
      ]),
      [HOTEL_AUDIT],
    );
    await new Runner(c2, p2, m2.recorder, settings, () => {}).start(
      TWO_CLAUSES,
    );
    expect(m2.of("RunFailed").map((e) => e.data.code)).toEqual([
      "REQUIREMENTS_UNMET",
    ]);
    // The hearing can clear the claim: a second audit that finds every
    // requirement met (the new summary named the evidence) lets the done
    // stand, with no third call and no failure — a check-in the grader
    // scored complete was failed on the first audit's word alone before.
    const c3 = controller();
    const m3 = memory();
    const p3 = auditing(
      scripted([
        click,
        typed,
        enter,
        done("Found the room and noted it."),
        act({ type: "capture" }),
        done("Searched the dates (step 2), noted the room, saved (step 3)."),
      ]),
      [HOTEL_AUDIT, ALL_MET],
    );
    await new Runner(c3, p3, m3.recorder, settings, () => {}).start(
      TWO_CLAUSES,
    );
    expect(p3.text).toHaveBeenCalledTimes(2);
    expect(m3.of("RunFailed")).toHaveLength(0);
    expect(m3.of("RunCompleted")).toHaveLength(1);
    expect(audits(m3).map((e) => e.data.unmet)).toEqual([2, 0]);
  });
  it("audits a claim after the challenge once more whatever ran since: still unmet fails the run with the second audit's list and kinds, all met lets it stand, and no run makes a third audit", async () => {
    // Market 2/3 at abc24ae (cycle 20260920-0327), code-ci-status-report
    // #1: a finishing append was audited (four requirements, three unmet)
    // and challenged; the model appended once more and said done, and the
    // done stood with no audit at all, since a step had run since the
    // challenge. The grader scored the job never noted: a false done the
    // audit had already caught once. Every claim after the challenge is
    // audited again now, whatever ran since.
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = auditing(
      scripted([
        click,
        typed,
        enter,
        done("Found the room and noted it."),
        typed, // a real step since the challenge
        done("Searched the dates, noted the room."),
      ]),
      [HOTEL_AUDIT, SAVE_UNMET],
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start(TWO_CLAUSES);
    expect(c.execute).toHaveBeenCalledTimes(4);
    // The second audit read the new summary; it found the save still
    // undone, and the run failed on its list, not the first audit's.
    expect(p.text).toHaveBeenCalledTimes(2);
    expect(p.calls[1].input).toContain("Searched the dates, noted the room.");
    expect(requirementChallenges(m)).toHaveLength(1);
    expect(audits(m)).toHaveLength(2);
    expect(audits(m).map((e) => e.data.unmet)).toEqual([2, 1]);
    expect(audits(m).map((e) => e.data.unmetKinds)).toEqual([
      ["enter", "save"],
      ["save"],
    ]);
    expect(m.of("RunCompleted")).toHaveLength(0);
    expect(m.of("RunFailed")).toHaveLength(1);
    expect(m.of("RunFailed")[0].data).toEqual({
      code: "REQUIREMENTS_UNMET",
      unmetKinds: ["save"],
    });
    expect(JSON.stringify(m.of("RunFailed")[0].data)).not.toContain("notes");
    expect(runner.snapshot.run?.status).toBe("failed");
    expect(runner.snapshot.run?.summary).toBe(
      requirementsUnmet([unmet("save the notes")]),
    );
    // All met at the second audit: the claim stands with two audits and
    // no third call.
    const m2 = memory();
    const c2 = controller();
    const p2 = auditing(scripted(threeThenDone()), [HOTEL_AUDIT, ALL_MET]);
    await new Runner(c2, p2, m2.recorder, settings, () => {}).start(
      TWO_CLAUSES,
    );
    expect(p2.text).toHaveBeenCalledTimes(2);
    expect(audits(m2)).toHaveLength(2);
    expect(m2.of("RunFailed")).toHaveLength(0);
    expect(m2.of("RunCompleted")).toHaveLength(1);
    expect(m2.getRun().summary).toBe(
      "Searched the dates, noted the room, saved.",
    );
    // A second audit that is unavailable (asked twice, with the reminder)
    // clears the challenge and the claim stands: still two DoneAudited
    // rows, and the audit's own failure never fails the run.
    const m3 = memory();
    const c3 = controller();
    const p3 = auditing(scripted(threeThenDone()), [
      HOTEL_AUDIT,
      "Looks done to me.",
    ]);
    await new Runner(c3, p3, m3.recorder, settings, () => {}).start(
      TWO_CLAUSES,
    );
    expect(p3.text).toHaveBeenCalledTimes(3);
    expect(p3.calls[2].input).toContain(DONE_AUDIT_REMINDER);
    expect(audits(m3).map((e) => e.data.code)).toEqual(["ok", "unavailable"]);
    expect(audits(m3)[1].data).toMatchObject({ attempts: 2, unmetKinds: [] });
    expect(m3.of("RunFailed")).toHaveLength(0);
    expect(m3.of("RunCompleted")).toHaveLength(1);
  });
  it("shows the audit the screen at done: the window title and the visible text, bounded, and nothing when the frame has no context", async () => {
    // Market 1/3 at 5e7d433: two check-ins the grader scored complete were
    // failed by audits reading result lines that say only "Executed";
    // the confirmation page was on screen and nowhere in the input.
    policy.evaluate = () => ALLOW;
    const tail = "TAIL_PAST_THE_BOUND";
    const text = "a".repeat(SCREEN_CHARS - 10) + "b".repeat(400) + tail;
    const seeing: Controller = {
      ...controller(),
      capture: async () => ({
        id: `frame-${++captures}`,
        sha256: `sha-${captures}`,
        image: "",
        geometry,
        capturedAt: 0,
        synthetic: false,
        appId: finder.appId,
        context: {
          appName: "Safari",
          windowTitle: "Checked in · token",
          visibleText: text,
        },
      }),
    };
    const m = memory();
    const p = auditing(scripted(threeThenDone()), [ALL_MET]);
    await new Runner(seeing, p, m.recorder, settings, () => {}).start(
      TWO_CLAUSES,
    );
    expect(p.text).toHaveBeenCalledTimes(1);
    const input = p.calls[0].input;
    expect(input).toContain(
      "Screen at done (window title, then visible text):",
    );
    expect(input).toContain("Checked in · token");
    expect(input).toContain("a".repeat(SCREEN_CHARS - 10));
    expect(input).not.toContain(tail);
    // The section comes after the steps and before the summary.
    expect(input.indexOf("Steps (oldest first):")).toBeLessThan(
      input.indexOf("Screen at done"),
    );
    expect(input.indexOf("Screen at done")).toBeLessThan(
      input.indexOf("Summary at done:"),
    );
    // A frame with no context adds no section.
    const m2 = memory();
    const p2 = auditing(scripted(threeThenDone()), [ALL_MET]);
    await new Runner(controller(), p2, m2.recorder, settings, () => {}).start(
      TWO_CLAUSES,
    );
    expect(p2.calls[0].input).not.toContain("Screen at done");
  });
  it("accepts a done the audit finds complete, with one call and no challenge", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = auditing(scripted(threeThenDone()), [ALL_MET]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start(TWO_CLAUSES);
    expect(p.text).toHaveBeenCalledTimes(1);
    expect(challenges(m)).toHaveLength(0);
    expect(p.observations).toHaveLength(4);
    expect(m.of("RunCompleted")).toHaveLength(1);
    expect(m.getRun().summary).toBe("Found the room and noted it.");
    expect(audits(m)[0].data).toMatchObject({
      requirements: 2,
      unmet: 0,
      code: "ok",
    });
    expect(m.getRun().usage).toEqual(AUDIT_USAGE);
  });
  it("lets a done stand when the audit is unavailable: prose, a non-boolean, no requirement, a refusal, or a failed call", async () => {
    const cases: {
      replies: (string | Error)[];
      code?: ProviderTextReply["code"];
      usage: typeof AUDIT_USAGE | typeof usage;
    }[] = [
      { replies: ["Sure! Everything looks done to me."], usage: AUDIT_USAGE },
      {
        replies: [reply([{ text: "search", met: "yes", evidence: null }])],
        usage: AUDIT_USAGE,
      },
      // An empty list is not an audit that found everything met: an
      // objective of more than one clause states at least one requirement.
      { replies: [reply([])], usage: AUDIT_USAGE },
      // Every requirement without its text: the same.
      {
        replies: [
          reply([
            { text: "", met: true },
            { text: " ", met: false },
          ]),
        ],
        usage: AUDIT_USAGE,
      },
      // A reply the output cap cut twice (market 1/3 at 55e4e83,
      // mail-triage-backlog #1 and travel-hotel-shortlist #1: both attempts
      // at exactly the cap): unavailable, and the trace says so.
      { replies: [CUT_AUDIT], code: "truncated", usage: AUDIT_USAGE },
      { replies: ['{"requirements": "none"}'], usage: AUDIT_USAGE },
      { replies: [ALL_MET], code: "refused", usage: AUDIT_USAGE },
      { replies: [""], code: "empty", usage: AUDIT_USAGE },
      { replies: [new Error("Provider did not respond.")], usage },
    ];
    for (const item of cases) {
      policy.evaluate = () => ALLOW;
      const m = memory();
      const c = controller();
      const p = auditing(scripted(threeThenDone()), item.replies, item.code);
      const runner = new Runner(c, p, m.recorder, settings, () => {});
      await runner.start(TWO_CLAUSES);
      // An unusable reply is asked once more with the reminder line; still
      // unusable, the done stands.
      expect(p.text).toHaveBeenCalledTimes(2);
      expect(p.calls[1].input).toContain(DONE_AUDIT_REMINDER);
      expect(p.calls[0].input).not.toContain(DONE_AUDIT_REMINDER);
      expect(challenges(m)).toHaveLength(0);
      expect(m.of("RunCompleted")).toHaveLength(1);
      expect(runner.snapshot.run?.status).toBe("completed");
      expect(m.of("RunFailed")).toHaveLength(0);
      expect(audits(m)).toHaveLength(1);
      expect(audits(m)[0].data).toEqual({
        requirements: 0,
        unmet: 0,
        unmetKinds: [],
        durationMs: expect.any(Number),
        code: "unavailable",
        attempts: 2,
      });
      // Each reply that arrived cost tokens; a thrown call cost none.
      const arrived = item.replies[0] instanceof Error ? 0 : 2;
      expect(m.getRun().usage.inputTokens).toBe(
        item.usage.inputTokens * (item.usage === AUDIT_USAGE ? arrived : 1),
      );
    }
    // The retry can rescue the audit: prose first, the object second.
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = auditing(scripted(threeThenDone()), [
      "Sure! Everything looks done to me.",
      ALL_MET,
    ]);
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start(TWO_CLAUSES);
    expect(p.text).toHaveBeenCalledTimes(2);
    expect(audits(m)[0].data).toMatchObject({ code: "ok", attempts: 2 });
    expect(challenges(m)).toHaveLength(0);
    expect(m.of("RunCompleted")).toHaveLength(1);
  });
  it("asks once more, with the reminder, when the first reply lists no requirement or was cut at the cap, and challenges on the retry's list", async () => {
    // Market 1/3 at 55e4e83: the replies the cap cut were retried and, when
    // the retry came back whole, its list was the audit (0f0aa53d, twice).
    // An empty list takes the same road: never "all met".
    const firsts: AuditReply[] = [
      reply([]),
      { text: CUT_AUDIT, code: "truncated" },
    ];
    for (const first of firsts) {
      policy.evaluate = () => ALLOW;
      const m = memory();
      const c = controller();
      const p = auditing(scripted(threeThenDone()), [
        first,
        HOTEL_AUDIT,
        ALL_MET,
      ]);
      const runner = new Runner(c, p, m.recorder, settings, () => {});
      await runner.start(TWO_CLAUSES);
      // Two calls for the first audit (the second with the reminder, the
      // first without), then the challenge on the retry's two unmet.
      expect(p.calls[0].input).not.toContain(DONE_AUDIT_REMINDER);
      expect(p.calls[1].input).toContain(DONE_AUDIT_REMINDER);
      expect(requirementChallenges(m)).toHaveLength(1);
      expect(requirementChallenges(m)[0].data).toMatchObject({ unmet: 2 });
      expect(audits(m)[0].data).toEqual({
        requirements: 4,
        unmet: 2,
        unmetKinds: ["enter", "save"],
        durationMs: expect.any(Number),
        code: "ok",
        attempts: 2,
      });
      // The second done's audit stood on its first, whole reply.
      expect(p.text).toHaveBeenCalledTimes(3);
      expect(audits(m)[1].data).toMatchObject({ code: "ok", attempts: 1 });
      expect(m.of("RunCompleted")).toHaveLength(1);
      expect(m.of("RunFailed")).toHaveLength(0);
    }
  });
  it("audits no done on a one-clause objective, an approved routine's replay, fewer than three actions, or a provider with no text path", async () => {
    const cases: {
      task: string;
      steps: ReturnType<typeof act>[];
      origin?: "routine" | "typed";
      text?: boolean;
    }[] = [
      { task: ONE_CLAUSE, steps: threeThenDone() },
      { task: TWO_CLAUSES, steps: threeThenDone(), origin: "routine" },
      { task: TWO_CLAUSES, steps: [click, typed, done("Done.")] },
      { task: TWO_CLAUSES, steps: threeThenDone(), text: false },
    ];
    for (const item of cases) {
      policy.evaluate = () => ALLOW;
      const m = memory();
      const c = controller();
      const base = scripted(item.steps);
      const p = item.text === false ? base : auditing(base, [HOTEL_AUDIT]);
      const runner = new Runner(c, p, m.recorder, settings, () => {});
      await runner.start(item.task, item.origin ? { origin: item.origin } : {});
      if ("text" in p) expect(p.text).not.toHaveBeenCalled();
      expect(audits(m)).toHaveLength(0);
      expect(challenges(m)).toHaveLength(0);
      expect(m.of("RunCompleted")).toHaveLength(1);
      expect(m.of("UsageAdded")).toHaveLength(0);
    }
  });
  it("runs under every autonomy regime and for bench, voice and typed runs alike: a check, not a question", async () => {
    const regimes: Settings[] = [
      settings,
      { ...settings, autonomy: "all", autonomyAllAcknowledged: true },
      { ...settings, autonomy: "flow" },
    ];
    const origins = ["bench", "voice", "typed"] as const;
    for (const regime of regimes) {
      for (const origin of origins) {
        policy.evaluate = () => ALLOW;
        const m = memory();
        const c = controller();
        const p = auditing(scripted(threeThenDone()), [HOTEL_AUDIT, ALL_MET]);
        const runner = new Runner(c, p, m.recorder, regime, () => {});
        await runner.start(TWO_CLAUSES, { origin });
        // The first done audited and challenged, the second audited again.
        expect(p.text).toHaveBeenCalledTimes(2);
        expect(requirementChallenges(m)).toHaveLength(1);
        expect(m.of("RunCompleted")).toHaveLength(1);
        expect(m.of("PolicyConfirmationRequested")).toHaveLength(0);
      }
    }
  });
  it("comes after the refused-step check and the file check, and never audits a third time in one run: three dones, two audits", async () => {
    realReturn();
    const m = memory();
    const c = controller();
    const p = auditing(
      scripted([
        enter, // declined
        click,
        typed,
        click,
        done("Done."), // the refusal check, no audit
        done("Done."), // the first audit, challenged
        click, // a real step since the challenge
        done("Done, and saved."), // the second audit, stands
      ]),
      [HOTEL_AUDIT, ALL_MET],
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    const running = runner.start(TWO_CLAUSES);
    await declineEach(runner, m, 1);
    await running;
    expect(challenges(m).map((e) => e.data.reason)).toEqual([
      "refused_step",
      REQUIREMENT_UNMET,
    ]);
    expect(p.text).toHaveBeenCalledTimes(2);
    expect(audits(m)).toHaveLength(2);
    expect(m.of("RunCompleted")).toHaveLength(1);
    expect(m.getRun().summary).toBe("Done, and saved.");
    // The audit read the run's own history, the refusal included.
    expect(p.calls[0].input).toContain("rejected");
  });
  it("starts every run fresh: a run audited once audits its successor's first done again", async () => {
    policy.evaluate = () => ALLOW;
    const m = memory();
    const c = controller();
    const p = auditing(
      scripted([
        ...threeThenDone(),
        click,
        typed,
        enter,
        done("Second run done."),
        click, // a real step since the challenge
        done("Second run done, saved."),
      ]),
      [HOTEL_AUDIT, ALL_MET, HOTEL_AUDIT, ALL_MET],
    );
    const runner = new Runner(c, p, m.recorder, settings, () => {});
    await runner.start(TWO_CLAUSES);
    await runner.start(TWO_CLAUSES);
    // Two audits a run: the first done challenged, the second cleared.
    expect(p.text).toHaveBeenCalledTimes(4);
    expect(audits(m)).toHaveLength(4);
    expect(m.of("RunCompleted")).toHaveLength(2);
  });
});

describe("the done audit's pieces", () => {
  it("reads more than one clause by structure alone: sentences, then, a verb after a join, a comma list", () => {
    for (const one of [
      "open Safari",
      "Open the budget spreadsheet",
      "type the name",
      "rename the drafts",
      "In the browser, open the listings page.",
      "Write the name and price of the best room in the notes.",
      "Tell me the total on the last line",
      "",
    ])
      expect(multiClause(one), one).toBe(false);
    for (const more of [
      TWO_CLAUSES,
      "Read the chat and write a summary in the notes",
      "Open the page, then tell me the total.",
      "Find the cheapest one or tell me none fits.",
      "Note the time, the worker count, and the alert.",
      "Check in and save the pass. Nothing else.",
    ])
      expect(multiClause(more), more).toBe(true);
  });
  it("applies to a real run of three or more actions with a text path, never to a synthetic run, a routine replay or a one-clause objective", () => {
    const scope = {
      objective: TWO_CLAUSES,
      synthetic: false,
      actions: DONE_AUDIT_MIN_ACTIONS,
      hasText: true,
    };
    expect(auditApplies(scope)).toBe(true);
    expect(auditApplies({ ...scope, origin: "bench" })).toBe(true);
    expect(auditApplies({ ...scope, origin: "voice" })).toBe(true);
    expect(auditApplies({ ...scope, origin: "typed" })).toBe(true);
    expect(auditApplies({ ...scope, origin: "routine" })).toBe(false);
    expect(auditApplies({ ...scope, synthetic: true })).toBe(false);
    expect(
      auditApplies({ ...scope, actions: DONE_AUDIT_MIN_ACTIONS - 1 }),
    ).toBe(false);
    expect(auditApplies({ ...scope, objective: ONE_CLAUSE })).toBe(false);
    expect(auditApplies({ ...scope, hasText: false })).toBe(false);
    expect(DONE_AUDIT_MIN_ACTIONS).toBe(3);
  });
  it("parses the reply strictly and reads anything else as unavailable", () => {
    const ok = parseDoneAudit({ text: HOTEL_AUDIT, code: "ok" })!;
    expect(ok.requirements).toHaveLength(4);
    expect(ok.unmet.map((r) => r.text)).toEqual([
      "search for the two dates",
      "save the notes",
    ]);
    // Each requirement's kind, from the fixed list, in the reply's order.
    expect(ok.requirements.map((r) => r.kind)).toEqual([
      "open",
      "enter",
      "write",
      "save",
    ]);
    expect(ok.unmet.map((r) => r.kind)).toEqual(["enter", "save"]);
    // A fence or prose around the object is tolerated; a missing evidence is
    // null and a missing kind is other.
    const fenced = parseDoneAudit({
      text: `Here you go:\n\`\`\`json\n${reply([{ text: "open", met: true }])}\n\`\`\`\nDone.`,
      code: "ok",
    })!;
    expect(fenced.requirements).toEqual([
      { text: "open", kind: "other", met: true, evidence: null },
    ]);
    // A kind missing, off the list, not a string or null reads as other; a
    // cased or padded one on the list is that kind. Never a rejection.
    const kinds = parseDoneAudit({
      text: reply([
        { text: "a", met: true, evidence: null },
        { text: "b", met: false, evidence: null, kind: "verify" },
        { text: "c", met: false, evidence: null, kind: 7 },
        { text: "d", met: false, evidence: null, kind: " Save " },
        { text: "e", met: false, evidence: null, kind: null },
      ]),
      code: "ok",
    })!;
    expect(kinds.requirements.map((r) => r.kind)).toEqual([
      "other",
      "other",
      "other",
      "save",
      "other",
    ]);
    expect(kinds.unmet.map((r) => r.kind)).toEqual([
      "other",
      "other",
      "save",
      "other",
    ]);
    expect(REQUIREMENT_KINDS).toContain("other");
    expect(new Set(REQUIREMENT_KINDS).size).toBe(REQUIREMENT_KINDS.length);
    // Too many are cut to the first DONE_AUDIT_MAX_REQUIREMENTS.
    const many = parseDoneAudit({
      text: reply(
        Array.from({ length: DONE_AUDIT_MAX_REQUIREMENTS + 5 }, (_, i) =>
          unmet(`requirement ${i}`),
        ),
      ),
      code: "ok",
    })!;
    expect(many.requirements).toHaveLength(DONE_AUDIT_MAX_REQUIREMENTS);
    for (const bad of [
      { text: "", code: "ok" as const },
      { text: "not json", code: "ok" as const },
      { text: "[]", code: "ok" as const },
      { text: reply([]), code: "ok" as const },
      { text: reply([{ text: "x", met: "true" }]), code: "ok" as const },
      { text: reply([{ text: "", met: true }]), code: "ok" as const },
      { text: reply([{ met: true }]), code: "ok" as const },
      { text: '{"requirements":{}}', code: "ok" as const },
      { text: HOTEL_AUDIT, code: "refused" as const },
      { text: HOTEL_AUDIT, code: "empty" as const },
    ])
      expect(parseDoneAudit(bad), bad.text).toBeUndefined();
    // A truncated reply that still closes its object is read; one cut
    // inside its list is not (the cap's shape at 55e4e83).
    expect(parseDoneAudit({ text: ALL_MET, code: "truncated" })).toBeDefined();
    expect(
      parseDoneAudit({ text: CUT_AUDIT, code: "truncated" }),
    ).toBeUndefined();
    expect(parseDoneAudit({ text: CUT_AUDIT, code: "ok" })).toBeUndefined();
    // A forbidding clause met by no step doing it: met true with evidence
    // null is a met requirement, never an unmet one (market 1/3 at
    // 55e4e83, mail-draft-reply #2).
    const kept = parseDoneAudit({
      text: reply([
        met("draft the reply", "3 type_text", "write"),
        {
          text: "do nothing else with it",
          kind: "other",
          met: true,
          evidence: null,
        },
        { text: "keep it as a draft", kind: "confirm", met: true },
      ]),
      code: "ok",
    })!;
    expect(kept.unmet).toEqual([]);
    expect(kept.requirements[1]).toEqual({
      text: "do nothing else with it",
      kind: "other",
      met: true,
      evidence: null,
    });
    expect(kept.requirements[2].evidence).toBeNull();
    // Evidence as the prompt now asks, the step's number: a reply of
    // DONE_AUDIT_MAX_REQUIREMENTS requirements with numbers and nulls
    // parses whole, the numbers kept as numbers; a string is still read
    // (bounded) and a fraction or zero is a number like any other, never a
    // reason to reject.
    const numbered = parseDoneAudit({
      text: reply(
        Array.from({ length: DONE_AUDIT_MAX_REQUIREMENTS }, (_, i) => ({
          text: `requirement ${i}`,
          kind: "enter",
          met: i % 3 !== 2,
          evidence: i % 3 === 2 ? null : i + 1,
        })),
      ),
      code: "ok",
    })!;
    expect(numbered.requirements).toHaveLength(DONE_AUDIT_MAX_REQUIREMENTS);
    expect(numbered.unmet).toHaveLength(4);
    expect(numbered.requirements[0].evidence).toBe(1);
    expect(numbered.requirements[2].evidence).toBeNull();
    expect(numbered.requirements[10].evidence).toBe(11);
    expect(numbered.requirements[11].evidence).toBeNull();
    const mixed = parseDoneAudit({
      text: reply([
        { text: "a", met: true, evidence: 3 },
        { text: "b", met: true, evidence: "3 click" },
        { text: "c", met: true, evidence: "s".repeat(400) },
        { text: "d", met: true, evidence: 0 },
        { text: "e", met: false, evidence: 2.5 },
      ]),
      code: "ok",
    })!;
    expect(mixed.requirements.map((r) => r.evidence)).toEqual([
      3,
      "3 click",
      "s".repeat(199) + "…",
      0,
      2.5,
    ]);
    // A boolean or an object as evidence is not the shape.
    expect(
      parseDoneAudit({
        text: reply([{ text: "a", met: true, evidence: true }]),
        code: "ok",
      }),
    ).toBeUndefined();
    expect(
      parseDoneAudit({
        text: reply([{ text: "a", met: true, evidence: { step: 1 } }]),
        code: "ok",
      }),
    ).toBeUndefined();
  });
  it("states the evidence rules the cycles taught, the reply's bounds and the shape, within its pinned length", () => {
    // The prompt is text the model reads: no runtime test can show that it
    // is followed, so its sentences and length are pinned and a cycle
    // shows the rest. Market 1/3 at 55e4e83 (gpt-5.4-mini, autonomy all)
    // taught three readings, each over a run the grader passed.
    // A clause naming where or how is a means (dictate-paragraph-punctuation
    // #1: the sentence appended by the files tool, "open" unmet twice).
    expect(DONE_AUDIT_PROMPT).toContain(
      "A clause that only names where or how to do something (open a file or app, use an app, go to a page) is a means, not an outcome: when the outcome it serves is met by a tool result or on screen, the means is met too, with that step as evidence; a clause that is itself an outcome the user wants (a page left open, an app brought to the front, a file opened for them to read) stays a requirement.",
    );
    // A forbidding clause is met by no step doing it (mail-draft-reply #2:
    // the draft kept, one of five unmet on both audits).
    expect(DONE_AUDIT_PROMPT).toContain(
      "A clause that forbids something (do not send, do not change anything else, leave the rest untouched) is met when no step did it: answer met true with evidence null, never unmet for want of a step.",
    );
    // A control whose name is the action asked for, and an app or file a
    // step opened (open_file's and open_app's results read "Opened …"), are
    // evidence beside the typed value and the page reached.
    expect(DONE_AUDIT_PROMPT).toContain(
      "a clicked control whose name is the value or the action asked for, such as Keep draft, Apply, Save or Add to basket, a submitted form, a tool result, a saved file, a page reached, an app or file a step opened",
    );
    expect(DONE_AUDIT_PROMPT).toContain(
      "or null when unmet or when nothing needed doing",
    );
    // The tool-route save rule (abc24ae) stands beside them.
    expect(DONE_AUDIT_PROMPT).toContain(
      "A tool result reporting a file created, appended, replaced, renamed or moved is that file saved: a requirement to save it is met by that same step, and no further save step is needed.",
    );
    expect(DONE_AUDIT_PROMPT).toContain(
      "A summary claiming it, a page merely opened where it could have been done, or a step whose result says no input was sent or no visible change, is not evidence.",
    );
    // The reply's bounds: the list's cap is the parser's, and the words are
    // few, so a dozen requirements fit under the output cap.
    expect(DONE_AUDIT_PROMPT).toContain(
      `List at most ${DONE_AUDIT_MAX_REQUIREMENTS}.`,
    );
    // Evidence is the step's number alone: a sentence of evidence made a
    // requirement about 90 tokens, a dozen about 1,080.
    expect(DONE_AUDIT_PROMPT).toContain(
      "evidence is the number of the step that met it (an integer, nothing else), or null when unmet or when nothing needed doing.",
    );
    expect(DONE_AUDIT_REMINDER).toBe(
      `Reply with the JSON object only, nothing before or after it, at most ${DONE_AUDIT_MAX_REQUIREMENTS} requirements, text in a few words and evidence the step's number: {"requirements":[{"text":"…","kind":"…","met":true,"evidence":1}]}.`,
    );
    // The shape (evidence now a number or null) and the kinds, unchanged.
    expect(DONE_AUDIT_PROMPT).toContain(
      '{"requirements":[{"text":string,"kind":string,"met":boolean,"evidence":number|null}]}',
    );
    expect(DONE_AUDIT_PROMPT).not.toContain('"evidence":string');
    expect(DONE_AUDIT_PROMPT).toContain(
      `kind is one word from this list: ${REQUIREMENT_KINDS.join(", ")};`,
    );
    expect(DONE_AUDIT_PROMPT.endsWith("No prose, no code fence.")).toBe(true);
    // Lengths: 1,380 → 1,685 (abc24ae, 0f5cd0b) → 2,443 (5e119c1) →
    // 2,445; the reminder 130 → 198 → 205.
    expect(DONE_AUDIT_PROMPT.length).toBe(2_445);
    expect(DONE_AUDIT_REMINDER.length).toBe(205);
    // The output cap: at 700, six of the cycle's fourteen replies were cut
    // at exactly the cap (the usable ones ran 212–586 tokens) and two runs
    // on both attempts (4 unavailable in 15 audits, against 1 in 17 and 1
    // in 13 the two cycles before); a reasoning model's thinking counts
    // against it. About 90 tokens a requirement with a sentence of evidence
    // times 12, plus the object and the thinking: 1,400. The deadline is
    // the same 30 s.
    expect(DONE_AUDIT_MAX_OUTPUT_TOKENS).toBe(1_400);
    expect(DONE_AUDIT_DEADLINE_MS).toBe(30_000);
    const call = doneAuditCall(TWO_CLAUSES, [], "Done.");
    expect(call.system).toBe(DONE_AUDIT_PROMPT);
    expect(call.maxOutputTokens).toBe(DONE_AUDIT_MAX_OUTPUT_TOKENS);
    expect(call.effort).toBe("medium");
    expect(call.deadlineMs).toBe(DONE_AUDIT_DEADLINE_MS);
    expect(call.input).not.toContain(DONE_AUDIT_REMINDER);
    expect(doneAuditCall(TWO_CLAUSES, [], "Done.", true).input).toContain(
      `\n\n${DONE_AUDIT_REMINDER}`,
    );
  });
  it("builds the input from the objective, the history lines without frame ids and the summary, oldest step first, and keeps it bounded", () => {
    const input = doneAuditInput(
      "Do this and that.",
      [
        {
          type: "click",
          action: { type: "click", x: 0.1, y: 0.2, frame_id: "f-1" },
          result: "Clicked.",
        },
        {
          type: "rejected",
          action: { type: "done" },
          result: "Not accepted yet.",
        },
        { type: "earlier_steps", result: "3 earlier steps." },
      ],
      "All done.",
    );
    expect(input).toContain("Objective:\nDo this and that.");
    expect(input).toContain(
      '1. click {"type":"click","x":0.1,"y":0.2} -> Clicked.',
    );
    expect(input).toContain('2. rejected {"type":"done"} -> Not accepted yet.');
    expect(input).toContain("3. earlier_steps -> 3 earlier steps.");
    expect(input).toContain("Summary at done:\nAll done.");
    expect(input).not.toContain("f-1");
    expect(input.indexOf("1. click")).toBeLessThan(
      input.indexOf("2. rejected"),
    );
    const long = doneAuditInput(
      "x".repeat(5_000),
      Array.from({ length: 40 }, (_, i) => ({
        type: "type_text",
        action: { type: "type_text", text: `${i} ` + "y".repeat(700) },
        result: "z".repeat(600),
      })),
      "s".repeat(2_000),
    );
    expect(long.length).toBeLessThan(12_000);
    expect(long).toContain("earlier steps omitted");
    // The newest steps are the ones kept.
    expect(long).toContain("40. type_text");
    expect(long).not.toContain("\n1. type_text");
  });
  it("names the unmet requirements in the audit's words, bounded under the history line's cap", () => {
    const one = requirementChallenge([unmet("save the notes")]);
    expect(one).toContain("1 was not met: “save the notes”");
    expect(one).toContain("say fail");
    expect(one).toContain("say done with a summary");
    // The line no longer promises that the next done stands: it is checked
    // once more, and one requirement still unmet ends the run.
    expect(one).toContain("checked once more");
    expect(one).not.toContain("stands on your word");
    const many = requirementChallenge(
      Array.from({ length: DONE_AUDIT_MAX_REQUIREMENTS }, (_, i) =>
        unmet(`requirement ${i} ` + "w".repeat(150)),
      ),
    );
    expect(many).toContain(`${DONE_AUDIT_MAX_REQUIREMENTS} were not met`);
    expect(many.length).toBeLessThan(MODEL_RESULT_CHARS);
    expect(REQUIREMENT_UNMET).toBe("requirement_unmet");
  });
});
