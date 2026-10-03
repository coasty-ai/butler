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
    start = async () => {};
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
      ) {
        this.notify = notify;
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
import { main } from "../src/terminal/main";
let tty: PropertyDescriptor | undefined;
let root: string;
let listeners: Map<string, Set<Function>>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-runtime-test-"));
  f.store = { root, key: randomBytes(32) };
  f.tasks = [];
  f.confirmations = [];
  f.approval = false;
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
  expect(f.speak).toHaveBeenCalledWith(
    "The fixture task is complete.",
    false,
    true,
  );
});
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
test("spoken yes never approves a task; explicit typed approval still works", async () => {
  f.approval = true;
  await main([]);
  f.ui.submit("/run synthetic fixture task");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.voice.receive({
    text: "yes",
    confidence: 0.99,
    source: "followup",
    segments: 1,
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
});
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
