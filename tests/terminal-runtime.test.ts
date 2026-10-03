import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const f = vi.hoisted(() => ({
  store: undefined as any,
  ui: undefined as any,
  voice: undefined as any,
  tasks: [] as any[],
  confirmations: [] as boolean[],
  approval: false,
  speak: vi.fn(async () => {}),
  decide: vi.fn(),
  memory: undefined as any,
  connectionsStart: vi.fn(async () => {}),
  briefingCheck: vi.fn(async () => ({ on: true, state: "waiting" })),
}));
vi.mock("node:fs", async (load) => {
  const fs = await load<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: (path: string) =>
      path.endsWith("native/bin/coarena-controller") || fs.existsSync(path),
  };
});
vi.mock("../src/terminal/store", async (load) => {
  const original = await load<typeof import("../src/terminal/store")>();
  return {
    ...original,
    TerminalStore: class extends original.TerminalStore {
      constructor() {
        super(f.store.root, f.store.key);
        f.store.instance = this;
      }
      keyForProvider() {
        return "fixture";
      }
    },
  };
});
vi.mock("../src/terminal/connections", () => ({
  TerminalConnections: class {
    registry = {
      access: () => undefined,
      status: () => ({ servers: [], apple: { state: "off" } }),
      configure: async () => {},
      closeAll: async () => {},
    };
    start = f.connectionsStart;
    labels = () => [];
    connectionWarnings = () => [];
  },
}));
vi.mock("../src/terminal/voice", () => ({
  TerminalVoice: class {
    constructor(options: any) {
      f.voice = options;
    }
    speak = f.speak;
    flush = async () => {};
    interruptOutput = async () => {};
    close = () => {};
    listeningToTurn = false;
    speaking = false;
    setListening = async () => ({
      microphone: true,
      speech: true,
      onDevice: true,
    });
    endFollowUp = async () => {};
  },
}));
vi.mock("../src/terminal/screen", () => ({
  TerminalScreen: class {
    state = {
      messages: [],
      model: "",
      connections: [],
      phase: "idle",
      nextBriefing: "off",
      status: "",
    };
    prompting = false;
    clearMessages = () => {
      this.state.messages = [];
    };
    message = vi.fn();
    updateMessage = vi.fn();
    start = () => {};
    close = () => {};
    draw = () => {};
    constructor(submit: any, interrupt: any, quit: any) {
      f.ui = { submit, interrupt, quit, screen: this };
    }
  },
}));
vi.mock("../electron/assistant", () => ({
  AssistantSession: class {
    reset = () => {};
    proposal = () => undefined;
    decide = f.decide;
  },
}));
vi.mock("../electron/briefings", async (load) => {
  const original = await load<typeof import("../electron/briefings")>();
  return {
    ...original,
    createBriefings: (options: any) => ({
      ...original.createBriefings(options),
      checkNow: f.briefingCheck,
    }),
  };
});
vi.mock("../electron/controller", () => ({
  NativeController: class {
    configure = async () => {};
    stop = () => {};
    close = () => {};
  },
}));
vi.mock("../src/core/runner", async (load) => {
  const original = await load<typeof import("../src/core/runner")>();
  return {
    ...original,
    Runner: class {
      settled = false;
      private notify: any;
      private release?: () => void;
      constructor(
        _controller: any,
        _provider: any,
        _vault: any,
        _settings: any,
        notify: any,
        _watches: any,
        memory: any,
      ) {
        this.notify = notify;
        f.memory = memory;
      }
      start = async (task: string, options: any) => {
        f.tasks.push({ task, options });
        this.notify({
          run: {
            id: "fixture-run",
            task,
            status: f.approval ? "confirming" : "completed",
          },
          events: [],
          frame: null,
          message: f.approval
            ? "A fixture action needs approval."
            : "The fixture task is complete.",
          ...(f.approval
            ? {
                pending: {
                  action: { type: "click" },
                  reason: "Fixture permission",
                },
              }
            : {}),
        });
        if (f.approval)
          await new Promise<void>((resolve) => {
            this.release = resolve;
          });
        this.settled = true;
      };
      confirm = (yes: boolean) => {
        f.confirmations.push(yes);
        this.release?.();
      };
      stop = () => {
        this.release?.();
        this.settled = true;
      };
    },
  };
});
import { main, briefingRequest } from "../src/terminal/main";
let tty: PropertyDescriptor | undefined;
let root: string;
let listeners: Map<string, Set<Function>>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-runtime-test-"));
  f.store = { root, key: randomBytes(32) };
  f.tasks = [];
  f.confirmations = [];
  f.approval = false;
  f.memory = undefined;
  f.connectionsStart.mockClear();
  f.briefingCheck.mockClear();
  f.speak.mockClear();
  f.decide.mockReset().mockImplementation(async (input: any) => ({
    acting: true,
    plan: { kind: "start", text: input.text },
    taskSource: "user_words",
  }));
  tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  listeners = new Map(
    ["SIGINT", "SIGTERM"].map((event) => [
      event,
      new Set(process.listeners(event as NodeJS.Signals)),
    ]),
  );
});
afterEach(async () => {
  f.ui?.quit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
  else delete (process.stdin as any).isTTY;
  for (const [event, old] of listeners)
    for (const listener of process.listeners(event as NodeJS.Signals))
      if (!old.has(listener)) process.removeListener(event, listener as any);
  rmSync(root, { recursive: true, force: true });
});
test("direct desktop tasks bypass MCP selection, preserve typed provenance, and speak completion", async () => {
  await main([]);
  f.ui.submit("/cua Open Slack and check recent activity");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  expect(f.tasks[0].options).toMatchObject({
    toolsFirst: false,
    background: true,
    origin: "typed",
    taskSource: "user_words",
    initialApp: "Slack",
  });
  expect(f.memory).toMatchObject({
    recall: expect.any(Function),
    learn: expect.any(Function),
  });
  expect(f.speak).toHaveBeenCalledWith(
    "The fixture task is complete.",
    false,
    true,
  );
});
test("an explicit personal preference is saved locally without a model or desktop task", async () => {
  await main([]);
  f.ui.submit("Remember that I prefer concise briefings");
  await vi.waitFor(() =>
    expect(f.store.instance.memory.data().preferences).toHaveLength(1),
  );
  expect(f.tasks).toEqual([]);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.speak).toHaveBeenCalledWith(
    "I'll remember that preference.",
    false,
    true,
  );
});
test("one-shot preference saving does not start connected MCP processes", async () => {
  await main(["--ask", "/remember I prefer concise briefings"]);
  expect(f.store.instance.memory.data().preferences).toHaveLength(1);
  expect(f.connectionsStart).not.toHaveBeenCalled();
  expect(f.tasks).toEqual([]);
});
test("natural briefing requests use one batched read instead of the action model loop", async () => {
  await main([]);
  f.ui.submit("What needs my attention?");
  await vi.waitFor(() => expect(f.briefingCheck).toHaveBeenCalledOnce());
  expect(f.tasks).toEqual([]);
  expect(f.decide).not.toHaveBeenCalled();
  expect(briefingRequest("Brief me on the GitHub pull requests")).toBe(false);
});
test.each([{ confidence: 0.3 }, { confidence: 0.7, recovered: true }])(
  "uncertain spoken preferences are repeated rather than stored or sent to a model: %j",
  async (heard) => {
    await main([]);
    f.voice.receive({
      text: "Remember that I prefer concise briefings",
      ...heard,
      source: "wake",
      segments: 1,
    });
    await vi.waitFor(() =>
      expect(f.speak).toHaveBeenCalledWith(
        "Please repeat that preference so I can save it accurately.",
        false,
        true,
      ),
    );
    expect(f.store.instance.memory.data().preferences).toHaveLength(0);
    expect(f.tasks).toEqual([]);
    expect(f.decide).not.toHaveBeenCalled();
  },
);
test("voice becomes a spoken dialog turn and task rather than impersonating typed input", async () => {
  await main([]);
  f.voice.receive({
    text: "Open Slack and check recent activity",
    confidence: 0.9,
    source: "wake",
    segments: 1,
  });
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  expect(f.decide).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "voice", confidence: 0.9 }),
  );
  expect(f.tasks[0].options).toMatchObject({
    origin: "voice",
    toolsFirst: true,
  });
});
test.each([false, true])(
  "spoken yes never approves a task, including recovered=%s; explicit typed approval still works",
  async (recovered) => {
    f.approval = true;
    await main([]);
    f.ui.submit("/run synthetic fixture task");
    await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
    f.voice.receive({
      text: "yes",
      confidence: 0.99,
      source: "followup",
      segments: 1,
      recovered,
    });
    await vi.waitFor(() =>
      expect(f.speak).toHaveBeenCalledWith(
        "Please approve or decline this action in the terminal.",
        false,
        true,
      ),
    );
    expect(f.confirmations).toEqual([]);
    f.ui.submit("/yes");
    await vi.waitFor(() => expect(f.confirmations).toEqual([true]));
  },
);
test("conversation streams into one message and never starts a task", async () => {
  f.decide.mockResolvedValue({
    acting: false,
    plan: { kind: "reply", act: "answer", resume: false },
    sentences: (async function* () {
      yield "Good evening.";
      yield "At your service.";
    })(),
  });
  await main([]);
  f.ui.screen.message.mockReturnValue(7);
  f.ui.submit("Hello Butler");
  await vi.waitFor(() =>
    expect(f.ui.screen.updateMessage).toHaveBeenCalledWith(
      7,
      "Good evening. At your service.",
    ),
  );
  expect(f.tasks).toEqual([]);
  expect(f.speak).toHaveBeenCalledWith("Good evening.", false, true);
});
