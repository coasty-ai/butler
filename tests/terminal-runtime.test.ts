import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  handoff: undefined as "paused" | "takeover" | undefined,
  stops: 0,
  toolAnswer: vi.fn(async () => undefined as any),
  noteUser: vi.fn(),
  noteAssistant: vi.fn(),
  speak: vi.fn(async (..._args: any[]) => {}),
  decide: vi.fn(),
  assistantOptions: undefined as any,
  holdTask: false,
  conversationCanOverlap: false,
  runners: [] as any[],
  revisions: [] as string[],
  resumes: 0,
  memory: undefined as any,
  connectionsStart: vi.fn(async () => {}),
  setupConnections: vi.fn(
    async (..._args: any[]) =>
      ({
        connected: ["gmail"],
        pending: [] as string[],
        browserTask: undefined as string | undefined,
        browserApp: undefined as "gmail" | "slack" | "github" | undefined,
      }) as import("../src/terminal/connections").ConnectionSetup,
  ),
  ask: vi.fn(async (..._args: any[]) => ""),
  nativeRequest: vi.fn(async (..._args: any[]) => ({
    screen: true,
    accessibility: true,
  })),
  briefingCheck: vi.fn(async () => ({ on: true, state: "waiting" })),
  briefingOptions: undefined as any,
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
      clock: () => ({
        now: new Date("2026-10-03T08:00:00Z"),
        zone: "America/Los_Angeles",
      }),
      status: () => ({ servers: [], apple: { state: "off" } }),
      configure: async () => {},
      closeAll: async () => {},
    };
    start = f.connectionsStart;
    setup = f.setupConnections;
    labels = () => [];
    connectionWarnings = () => [];
  },
}));
vi.mock("../electron/tools", () => ({ answerByTool: f.toolAnswer }));
vi.mock("../src/terminal/voice", () => ({
  VOICE_READ_MIN_CONFIDENCE: 0.65,
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
    ask = f.ask;
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
    constructor(options: any) {
      f.assistantOptions = options;
    }
    interrupt = () => {};
    reset = () => {};
    proposal = () => undefined;
    decide = f.decide;
    noteUser = f.noteUser;
    noteAssistant = f.noteAssistant;
  },
}));
vi.mock("../electron/briefings", async (load) => {
  const original = await load<typeof import("../electron/briefings")>();
  return {
    ...original,
    createBriefings: (options: any) => {
      f.briefingOptions = options;
      return {
        ...original.createBriefings(options),
        checkNow: f.briefingCheck,
      };
    },
  };
});
vi.mock("../electron/controller", () => ({
  NativeController: class {
    configure = async () => {};
    request = f.nativeRequest;
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
      get conversationCanOverlap() {
        return f.conversationCanOverlap;
      }
      private notify: any;
      private release?: () => void;
      private latest: any;
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
        f.runners.push(this);
        f.memory = memory;
      }
      start = async (task: string, options: any) => {
        f.tasks.push({ task, options });
        this.latest = {
          run: {
            id: `fixture-run-${f.tasks.length}`,
            task,
            createdAt: new Date().toISOString(),
            actions: 3,
            summary: "The fixture note contains both requested paragraphs.",
            status:
              f.handoff ||
              (f.approval
                ? "confirming"
                : f.holdTask
                  ? "executing"
                  : "completed"),
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
        };
        this.notify(this.latest);
        if (f.approval || f.handoff || f.holdTask)
          await new Promise<void>((resolve) => {
            this.release = resolve;
          });
        this.settled = true;
      };
      confirm = (yes: boolean) => {
        f.confirmations.push(yes);
        this.release?.();
      };
      revise = async (text: string) => {
        f.revisions.push(text);
      };
      resume = async () => {
        f.resumes++;
        this.latest.run.status = "executing";
        this.notify(this.latest);
        return true;
      };
      pause = () => {
        this.latest.run.status = "paused";
        this.notify(this.latest);
      };
      interruptForVoice = () => this.pause();
      finish = () => {
        this.latest.run.status = "completed";
        this.notify(this.latest);
        this.release?.();
      };
      stop = () => {
        if (this.settled) return;
        f.stops++;
        this.release?.();
        this.settled = true;
        if (this.latest)
          this.notify({
            ...this.latest,
            run: { ...this.latest.run, status: "cancelled" },
          });
      };
    },
  };
});
import { main, briefingRequest } from "../src/terminal/main";
import { TerminalStore } from "../src/terminal/store";
import { freshOnboarding } from "../src/terminal/onboarding";
import { initialSettings } from "../src/terminal/store";
let tty: PropertyDescriptor | undefined;
let root: string;
let listeners: Map<string, Set<Function>>;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  root = mkdtempSync(join(tmpdir(), "butler-runtime-test-"));
  f.store = { root, key: randomBytes(32) };
  // Existing-session cases should not re-enter a first-launch workflow.
  const existing = new TerminalStore();
  delete existing.profile.onboarding;
  existing.save();
  f.ask.mockReset().mockResolvedValue("");
  f.nativeRequest
    .mockReset()
    .mockResolvedValue({ screen: true, accessibility: true });
  f.tasks = [];
  f.holdTask = false;
  f.conversationCanOverlap = false;
  f.runners = [];
  f.revisions = [];
  f.resumes = 0;
  f.confirmations = [];
  f.approval = false;
  f.handoff = undefined;
  f.stops = 0;
  f.toolAnswer.mockReset().mockResolvedValue(undefined);
  f.noteUser.mockClear();
  f.noteAssistant.mockClear();
  f.memory = undefined;
  f.connectionsStart.mockClear();
  f.setupConnections.mockReset().mockResolvedValue({
    connected: ["gmail"],
    pending: [],
    browserTask: undefined,
  });
  f.briefingCheck.mockClear();
  f.briefingOptions = undefined;
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
  process.exitCode = exitCode;
});
test("startup with saved access loads it without asking to connect again", async () => {
  const store = new TerminalStore();
  store.profile.settings.tools.apple.notes = true;
  store.save();
  await main([]);
  expect(f.ui.screen.message).toHaveBeenCalledWith(
    "Butler",
    expect.stringContaining("saved connections and settings are loaded"),
  );
  expect(f.ui.screen.ask).not.toHaveBeenCalled();
  expect(f.setupConnections).not.toHaveBeenCalled();
});
const firstLaunch = () => {
  const store = new TerminalStore();
  store.profile.onboarding = freshOnboarding();
  store.profile.settings = initialSettings({ OPENAI_API_KEY: "SYNTHETIC-key" });
  store.save();
};
test("first launch offers app setup once and Later persists without granting access", async () => {
  firstLaunch();
  f.ask.mockResolvedValueOnce("later");
  await main([]);
  expect(f.ask).toHaveBeenCalledOnce();
  expect(f.setupConnections).not.toHaveBeenCalled();
  expect(f.store.instance.profile.onboarding.phase).toBe("later");
  expect(Object.values(f.store.instance.profile.settings.tools.apple)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  await f.ui.quit();
  await vi.waitFor(() =>
    expect(existsSync(join(root, "engine.pid"))).toBe(false),
  );
  await main([]);
  expect(f.ask).toHaveBeenCalledOnce();
  expect(f.tasks).toEqual([]);
});
test("quitting during first-launch consent cannot restart greeting output", async () => {
  firstLaunch();
  let answer!: (value: string) => void;
  f.ask.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  const launch = main([]);
  await vi.waitFor(() => expect(f.ask).toHaveBeenCalledOnce());
  f.ui.quit();
  answer("later");
  await launch;
  expect(f.speak.mock.calls.map(([text]) => text)).not.toContain(
    "At your service. What shall we attend to?",
  );
  expect(f.setupConnections).not.toHaveBeenCalled();
  expect(f.tasks).toEqual([]);
});
test("first-launch approval automatically prepares apps with desktop fallback, not developer keys", async () => {
  firstLaunch();
  f.ask.mockResolvedValueOnce("yes");
  f.handoff = "takeover";
  f.setupConnections.mockResolvedValueOnce({
    connected: ["calendar"],
    pending: ["gmail"],
    browserApp: "gmail",
    browserTask:
      "In Safari, verify SYNTHETIC Gmail app access and wait for sign-in.",
  });
  await main([]);
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  expect(f.setupConnections.mock.calls[0][0]).toContain("gmail");
  expect(f.setupConnections.mock.calls[0][6]).toMatchObject({
    desktopFirst: true,
  });
  expect(f.tasks[0].options).toMatchObject({
    toolsFirst: false,
    taskSource: "user_words",
  });
  expect(f.store.instance.profile.onboarding).toMatchObject({
    phase: "waiting",
    activeApp: "gmail",
    pending: ["gmail"],
  });
  expect(f.decide).not.toHaveBeenCalled();
});
test("missing desktop permissions save progress before any model-driven computer task", async () => {
  firstLaunch();
  f.ask.mockResolvedValueOnce("yes");
  f.setupConnections.mockResolvedValueOnce({
    connected: ["calendar"],
    pending: ["gmail"],
    browserApp: "gmail",
    browserTask: "In Safari, prepare SYNTHETIC Gmail access.",
  });
  f.nativeRequest.mockResolvedValue({ screen: false, accessibility: false });
  await main([]);
  expect(f.tasks).toEqual([]);
  expect(f.nativeRequest.mock.calls.map(([method]) => method)).toEqual([
    "permissions",
    "requestPermissions",
    "permissions",
  ]);
  expect(f.store.instance.profile.onboarding.phase).toBe("waiting");
  f.ui.submit("Done");
  await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledTimes(2));
  expect(f.store.instance.profile.onboarding.phase).toBe("ready");
  expect(f.ask).toHaveBeenCalledOnce();
});
test.each(["Connect Slack", "/connect auto"])(
  "conversational setup uses the first-launch desktop flow and permission checks: %s",
  async (request) => {
    const store = new TerminalStore();
    store.profile.settings = initialSettings({
      OPENAI_API_KEY: "SYNTHETIC-key",
    });
    store.save();
    await main([]);
    f.setupConnections.mockResolvedValueOnce({
      connected: [],
      pending: ["slack"],
      browserApp: "slack",
      browserTask: "In Slack, prepare SYNTHETIC signed-in desktop access.",
    });
    f.nativeRequest.mockResolvedValue({ screen: false, accessibility: false });
    f.ui.submit(request);
    await vi.waitFor(() => expect(f.nativeRequest).toHaveBeenCalledTimes(3));
    expect(f.setupConnections.mock.calls[0][6]).toMatchObject({
      desktopFirst: true,
    });
    expect(f.store.instance.profile.onboarding).toMatchObject({
      phase: "waiting",
      activeApp: "slack",
      desktopFirst: true,
    });
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.tasks).toEqual([]);
  },
);
test.each(["", "SYNTHETIC-provider-key"])(
  "model setup stays hidden, allows deferral and preserves other preferences (key=%s)",
  async (key) => {
    firstLaunch();
    const store = new TerminalStore();
    store.profile.settings = initialSettings({});
    store.profile.settings.memory = false;
    store.profile.settings.voiceReplies = "off";
    store.save();
    f.ask.mockResolvedValueOnce("yes").mockResolvedValueOnce(key);
    f.setupConnections.mockResolvedValueOnce({
      connected: [],
      pending: ["gmail"],
      browserApp: "gmail",
      browserTask: "In Safari, prepare SYNTHETIC Gmail access.",
    });
    f.nativeRequest.mockResolvedValue({ screen: false, accessibility: false });
    const health = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [] }), { status: 200 }),
      );
    try {
      await main([]);
      expect(f.ask.mock.calls[1][1]).toBe(true);
      expect(f.tasks).toEqual([]);
      expect(f.store.instance.profile.settings.memory).toBe(false);
      expect(f.store.instance.profile.settings.voiceReplies).toBe("off");
      expect(f.store.instance.profile.onboarding.phase).toBe("waiting");
      if (key) {
        expect(f.store.instance.profile.settings.provider).toBe("openai");
        expect(f.store.instance.profile.secrets["provider:openai"]).toBe(key);
      } else {
        expect(f.store.instance.profile.settings.provider).toBe("ollama");
        expect(f.nativeRequest).not.toHaveBeenCalled();
      }
    } finally {
      health.mockRestore();
    }
  },
);
test("restart and Done resume the selected setup scope without adding accounts or prompting again", async () => {
  const store = new TerminalStore();
  store.profile.onboarding = {
    phase: "waiting",
    apps: ["gmail"],
    pending: ["gmail"],
    activeApp: "gmail",
    desktopReady: [],
    desktopFirst: true,
  };
  store.save();
  await main([]);
  expect(f.ask).not.toHaveBeenCalled();
  f.ui.submit("Done");
  await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledOnce());
  expect(f.setupConnections.mock.calls[0][0]).toEqual(["gmail"]);
  expect(f.store.instance.profile.onboarding.phase).toBe("ready");
});
test("verified app preparation advances to the next account and records desktop rather than MCP access", async () => {
  firstLaunch();
  f.ask.mockResolvedValueOnce("yes");
  f.holdTask = true;
  f.setupConnections.mockResolvedValueOnce({
    connected: [],
    pending: ["gmail", "slack"],
    browserApp: "gmail",
    browserTask: "In Safari, verify SYNTHETIC Gmail app access.",
  });
  await main([]);
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.runners[0].finish();
  await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledTimes(2));
  expect(f.setupConnections.mock.calls[1][6]).toMatchObject({
    desktopReady: ["gmail"],
  });
  expect(f.store.instance.profile.onboarding.desktopReady).toEqual(["gmail"]);
  expect(f.store.instance.profile.settings.tools.servers).toEqual([]);
});
test("a setup task that finishes during the initial prompt advances when that turn releases", async () => {
  firstLaunch();
  f.ask.mockResolvedValueOnce("yes");
  f.setupConnections.mockResolvedValueOnce({
    connected: [],
    pending: ["gmail", "slack"],
    browserApp: "gmail",
    browserTask: "In Safari, verify SYNTHETIC Gmail app access.",
  });
  await main([]);
  await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledTimes(2));
  expect(f.store.instance.profile.onboarding.desktopReady).toEqual(["gmail"]);
  expect(f.store.instance.profile.onboarding.phase).toBe("ready");
});
test("Skip setup aborts the setup check without allowing its delayed result to overwrite saved progress", async () => {
  await main([]);
  f.ask.mockResolvedValueOnce("yes");
  let checking!: () => void;
  const started = new Promise<void>((resolve) => {
    checking = resolve;
  });
  f.setupConnections.mockImplementationOnce(async (...args: any[]) => {
    checking();
    await new Promise<void>((resolve) =>
      args[3].addEventListener("abort", () => resolve(), { once: true }),
    );
    return {
      connected: [],
      pending: ["gmail"],
      browserApp: "gmail",
      browserTask: "SYNTHETIC delayed setup.",
    };
  });
  f.ui.submit("Get me ready");
  await started;
  f.ui.submit("Skip setup");
  await vi.waitFor(() =>
    expect(f.store.instance.profile.onboarding.phase).toBe("later"),
  );
  f.ui.submit("Help");
  await vi.waitFor(() =>
    expect(f.ui.screen.message).toHaveBeenCalledWith(
      "Butler",
      expect.stringContaining("Technical commands are optional"),
    ),
  );
  expect(f.tasks).toEqual([]);
  expect(f.stops).toBe(0);
});
test.each([false, true])(
  "spoken Done resumes saved setup only for confirmed speech (recovered=%s)",
  async (recovered) => {
    const store = new TerminalStore();
    store.profile.onboarding = {
      ...freshOnboarding(),
      phase: "waiting",
      apps: ["gmail"],
      pending: ["gmail"],
    };
    store.save();
    await main([]);
    f.voice.receive({
      text: "Done",
      confidence: 0.98,
      recovered,
      source: "wake",
      segments: 1,
    });
    if (!recovered)
      await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledOnce());
    else {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.setupConnections).not.toHaveBeenCalled();
    }
    expect(f.confirmations).toEqual([]);
    expect(f.tasks).toEqual([]);
    expect(f.decide).not.toHaveBeenCalled();
  },
);
test.each(["check my reminders", "check my inbox"])(
  "recovered read cannot fall through to a computer task when tools are unavailable: %s",
  async (text) => {
    await main([]);
    f.voice.receive({
      text,
      confidence: 0.7,
      recovered: true,
      source: "wake",
      segments: 2,
    });
    await vi.waitFor(() =>
      expect(f.ui.screen.message).toHaveBeenCalledWith(
        "Butler",
        expect.stringContaining("through your connected tools"),
      ),
    );
    expect(f.tasks).toEqual([]);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.confirmations).toEqual([]);
  },
);
test("plain setup uses saved connections without a planner or native task and remembers its verified result", async () => {
  await main([]);
  f.ui.submit("Connect Gmail and Slack");
  await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledOnce());
  expect(f.setupConnections.mock.calls[0][0]).toEqual(["gmail", "slack"]);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.tasks).toHaveLength(0);
  expect(f.ui.screen.ask).not.toHaveBeenCalled();
  expect(f.noteAssistant).toHaveBeenCalledWith(
    expect.stringContaining("ready gmail"),
    "app",
    { untrusted: true },
  );
});
test("missing setup enters normal CUA and a paused setup can be rechecked after owner handoff", async () => {
  const store = new TerminalStore();
  store.profile.settings = initialSettings({ OPENAI_API_KEY: "SYNTHETIC-key" });
  store.save();
  f.handoff = "paused";
  f.setupConnections.mockResolvedValueOnce({
    connected: [],
    pending: ["gmail"],
    browserApp: "gmail",
    browserTask:
      "In Safari, prepare synthetic setup and stop for access approval.",
  });
  await main([]);
  f.ui.submit("Set up Gmail");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  expect(f.tasks[0].options).toMatchObject({
    toolsFirst: false,
    taskSource: "user_words",
  });
  f.ui.submit("Set up Gmail");
  await vi.waitFor(() => expect(f.setupConnections).toHaveBeenCalledTimes(2));
  expect(f.stops).toBe(1);
  expect(f.tasks).toHaveLength(1);
  expect(f.decide).not.toHaveBeenCalled();
});
test.each(["Update Slack token", "Connect Slack with OAuth"])(
  "voice keeps credential setup in the typed local lane: %s",
  async (text) => {
    await main([]);
    f.voice.receive({
      text,
      confidence: 0.98,
      recovered: false,
      source: "wake",
      segments: 1,
    });
    await vi.waitFor(() =>
      expect(f.ui.screen.message).toHaveBeenCalledWith(
        "Butler",
        expect.stringContaining("Please type that connection request"),
      ),
    );
    expect(f.tasks).toEqual([]);
    expect(f.setupConnections).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.ask).not.toHaveBeenCalled();
  },
);
test("setup cannot replace an unrelated active task", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run synthetic task");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.ui.submit("Connect my apps");
  await vi.waitFor(() =>
    expect(f.ui.screen.message).toHaveBeenCalledWith(
      "Butler",
      expect.stringContaining("current task finish"),
    ),
  );
  expect(f.setupConnections).not.toHaveBeenCalled();
  expect(f.stops).toBe(0);
});
test("everyday controls persist without a model request and help uses plain examples", async () => {
  await main([]);
  f.ui.submit("Read replies aloud");
  await vi.waitFor(() =>
    expect(f.store.instance.profile.settings.voiceReplies).toBe("always"),
  );
  f.ui.submit("Brief me every 2 hours");
  await vi.waitFor(() =>
    expect(f.store.instance.profile.settings.briefings.intervalMinutes).toBe(
      120,
    ),
  );
  const saved = new TerminalStore();
  expect(saved.profile.settings.voiceReplies).toBe("always");
  expect(saved.profile.settings.briefings.on).toBe(true);
  f.ui.submit("Help");
  await vi.waitFor(() =>
    expect(f.ui.screen.message).toHaveBeenCalledWith(
      "Butler",
      expect.stringContaining("Connect my apps"),
    ),
  );
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.tasks).toHaveLength(0);
});
test.each(["Connect Gmail", "Read replies aloud", "Brief me every 30 minutes"])(
  "uncertain voice cannot change setup or preferences: %s",
  async (text) => {
    await main([]);
    const before = JSON.stringify(f.store.instance.profile);
    f.voice.receive({
      text,
      confidence: 0.3,
      recovered: true,
      source: "wake",
      segments: 1,
    });
    await vi.waitFor(() =>
      expect(f.ui.screen.message).toHaveBeenCalledWith("You", text),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(f.store.instance.profile)).toBe(before);
    expect(f.setupConnections).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
  },
);
test("stable recovered speech can enable spoken output without granting app or task access", async () => {
  await main([]);
  f.voice.receive({
    text: "Read replies aloud",
    confidence: 0.7,
    recovered: true,
    source: "wake",
    segments: 2,
  });
  await vi.waitFor(() =>
    expect(f.store.instance.profile.settings.voiceReplies).toBe("always"),
  );
  expect(f.setupConnections).not.toHaveBeenCalled();
  expect(f.tasks).toEqual([]);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.confirmations).toEqual([]);
});
test("a stable recovered read uses the existing trusted fast path instead of another computer task", async () => {
  f.toolAnswer.mockResolvedValueOnce({
    said: "SYNTHETIC no reminders due.",
    outcome: {},
  });
  await main([]);
  f.voice.receive({
    text: "check my reminders",
    confidence: 0.7,
    recovered: true,
    source: "wake",
    segments: 2,
  });
  await vi.waitFor(() => expect(f.toolAnswer).toHaveBeenCalledOnce());
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.tasks).toEqual([]);
  expect(f.setupConnections).not.toHaveBeenCalled();
});
test("plain Yes approves only an existing typed task confirmation", async () => {
  f.approval = true;
  await main([]);
  f.ui.submit("/run synthetic task");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.ui.submit("Yes");
  await vi.waitFor(() => expect(f.confirmations).toEqual([true]));
});
test("completed task facts and live progress are supplied to subsequent conversation", async () => {
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() =>
    expect(f.noteAssistant).toHaveBeenCalledWith(
      "The fixture note contains both requested paragraphs.",
      "app",
      { untrusted: true },
    ),
  );
  expect(f.assistantOptions.view().lastFinished).toMatchObject({
    outcome: "completed",
    task: "create the fixture note",
  });
  expect(f.assistantOptions.history).toBe(f.store.instance.conversation);
});
test.each(["same", "fresh", "changed"] as const)(
  "restart restores a finished task only within the %s conversation scope",
  async (scope) => {
    const store = new TerminalStore();
    const at = Date.now() - 5000;
    store.conversation.save([
      {
        role: "user",
        channel: "app",
        text: "Create the fixture note",
        at,
        untrusted: false,
      },
    ]);
    store.vault.begin({
      id: "a9a867b6-b045-4567-914f-a57993982609",
      task: "Create the fixture note",
      createdAt: new Date(at + 1000).toISOString(),
      status: "completed",
      privacy: store.profile.settings.privacy,
      provider: store.profile.settings.provider,
      model: store.profile.settings.model,
      synthetic: true,
      actions: 1,
      frames: 0,
      summary: "The fixture note is saved.",
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    });
    if (scope === "fresh") {
      store.conversation.save([]);
      store.conversation.save([
        {
          role: "user",
          channel: "app",
          text: "Hello",
          at: Date.now(),
          untrusted: false,
        },
      ]);
    }
    if (scope === "changed")
      store.profile.settings.model = "fixture-other-model";
    store.save();
    await main([]);
    const last = f.assistantOptions.view().lastFinished;
    if (scope === "same") expect(last).toMatchObject({ outcome: "completed" });
    else expect(last).toBeUndefined();
  },
);
test("continue with no active task replies locally instead of launching a targetless task", async () => {
  await main([]);
  f.ui.submit("continue");
  await vi.waitFor(() =>
    expect(f.speak).toHaveBeenCalledWith(
      expect.stringContaining("paused task"),
      false,
      true,
    ),
  );
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.tasks).toHaveLength(0);
});
test("a conversational correction reaches the running task", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.decide.mockResolvedValueOnce({
    acting: true,
    plan: { kind: "revise", text: "Use the second paragraph too" },
  });
  f.ui.submit("Add the second paragraph too");
  await vi.waitFor(() =>
    expect(f.revisions).toEqual(["Use the second paragraph too"]),
  );
  expect(f.tasks).toHaveLength(1);
});
test("an explicitly queued task starts after the first task has settled", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.decide.mockResolvedValueOnce({
    acting: true,
    plan: { kind: "queue", text: "Read the fixture note" },
  });
  f.ui.submit("Then read the fixture note");
  await vi.waitFor(() =>
    expect(f.assistantOptions.view().queued).toEqual(["Read the fixture note"]),
  );
  expect(f.tasks).toHaveLength(1);
  f.holdTask = false;
  f.runners[0].finish();
  await vi.waitFor(() =>
    expect(f.tasks.map((t) => t.task)).toEqual([
      "create the fixture note",
      "Read the fixture note",
    ]),
  );
});
test("the user's stop cancels both the running task and its queue", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.decide.mockResolvedValueOnce({
    acting: true,
    plan: { kind: "queue", text: "Read the fixture note" },
  });
  f.ui.submit("Then read the fixture note");
  await vi.waitFor(() =>
    expect(f.assistantOptions.view().queued).toHaveLength(1),
  );
  f.ui.interrupt();
  await vi.waitFor(() => expect(f.assistantOptions.view().queued).toEqual([]));
  expect(f.tasks).toHaveLength(1);
});
test("an ordinary spoken question resumes only the hold created by listening", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.voice.activity("listening");
  expect(f.assistantOptions.view()).toMatchObject({
    running: true,
    status: "working",
    steps: 3,
  });
  f.decide.mockResolvedValueOnce({
    acting: false,
    plan: { kind: "reply" },
    sentences: (async function* () {
      yield "Three steps so far.";
    })(),
  });
  f.voice.receive({
    text: "How is it going?",
    source: "wake",
    confidence: 0.95,
    segments: 4,
  });
  await vi.waitFor(() => expect(f.resumes).toBe(1));
});
test("conversation and a direct read leave independent background work running", async () => {
  f.holdTask = true;
  f.conversationCanOverlap = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.voice.activity("listening");
  f.decide.mockResolvedValueOnce({
    acting: false,
    plan: { kind: "reply" },
    sentences: (async function* () {
      yield "It is still running.";
    })(),
  });
  f.voice.receive({
    text: "How is it going?",
    source: "wake",
    confidence: 0.95,
    segments: 1,
  });
  await vi.waitFor(() =>
    expect(f.speak).toHaveBeenCalledWith("It is still running.", false, true),
  );
  expect(f.resumes).toBe(0);
  expect(f.assistantOptions.view().status).toBe("working");
  f.toolAnswer.mockResolvedValueOnce({
    said: "Nothing is due today.",
    outcome: {},
  });
  f.ui.submit("check my reminders");
  await vi.waitFor(() => expect(f.toolAnswer).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(f.noteAssistant).toHaveBeenCalledWith(
      "Nothing is due today.",
      "app",
      { untrusted: true },
    ),
  );
  expect(f.tasks).toHaveLength(1);
  expect(f.stops).toBe(0);
  expect(f.revisions).toEqual([]);
  expect(f.decide).toHaveBeenCalledOnce();
});
test("a failed parallel read does not revise, queue or replace the existing task", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.ui.submit("check my reminders");
  await vi.waitFor(() =>
    expect(f.speak).toHaveBeenCalledWith(
      expect.stringContaining("couldn't check"),
      false,
      true,
    ),
  );
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.revisions).toEqual([]);
  expect(f.stops).toBe(0);
  expect(f.assistantOptions.view().queued).toEqual([]);
});
test("a new unrelated task waits instead of silently replacing background work", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.decide.mockResolvedValueOnce({
    acting: true,
    plan: { kind: "replace", text: "Open Calendar" },
    taskSource: "user_words",
  });
  f.ui.submit("Open Calendar");
  await vi.waitFor(() =>
    expect(f.assistantOptions.view().queued).toEqual(["Open Calendar"]),
  );
  expect(f.stops).toBe(0);
  expect(f.tasks).toHaveLength(1);
  f.holdTask = false;
  f.runners[0].finish();
  await vi.waitFor(() => expect(f.tasks).toHaveLength(2));
  expect(f.tasks[1].task).toBe("Open Calendar");
});
test("an explicit replacement still stops the old task and keeps its requested scope", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.decide.mockResolvedValueOnce({
    acting: true,
    plan: { kind: "replace", text: "Open Calendar" },
    taskSource: "user_words",
  });
  f.ui.submit("Forget that, open Calendar instead");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(2));
  expect(f.stops).toBe(1);
  expect(f.assistantOptions.view().queued).toEqual([]);
});
test("explicit desktop tasks retain desktop-only routing when queued", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.ui.submit("/cua Open Calendar");
  await vi.waitFor(() =>
    expect(f.assistantOptions.view().queued).toEqual(["Open Calendar"]),
  );
  f.holdTask = false;
  f.runners[0].finish();
  await vi.waitFor(() => expect(f.tasks).toHaveLength(2));
  expect(f.tasks[1].options).toMatchObject({
    toolsFirst: false,
    background: true,
    taskSource: "user_words",
  });
});
test("cancelled or unheard speech releases its temporary task hold", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.voice.activity("listening");
  f.voice.activity("idle");
  await vi.waitFor(() => expect(f.resumes).toBe(1));
  expect(f.decide).not.toHaveBeenCalled();
});
test("a manual pause is not resumed by an unrelated spoken question", async () => {
  f.holdTask = true;
  await main([]);
  f.ui.submit("/run create the fixture note");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  f.ui.submit("/pause");
  await vi.waitFor(() =>
    expect(f.assistantOptions.view().status).toBe("paused"),
  );
  f.voice.activity("listening");
  f.decide.mockResolvedValueOnce({
    acting: false,
    plan: { kind: "reply" },
    sentences: (async function* () {
      yield "It is paused.";
    })(),
  });
  f.voice.receive({
    text: "How is it going?",
    source: "wake",
    confidence: 0.95,
    segments: 4,
  });
  await vi.waitFor(() =>
    expect(f.speak).toHaveBeenCalledWith("It is paused.", false, true),
  );
  expect(f.resumes).toBe(0);
});
test.each(["paused", "takeover"] as const)(
  "one-shot %s ends with an interactive-session message instead of hanging",
  async (status) => {
    f.handoff = status;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    await main(["--ask", "/run synthetic fixture task"]);
    expect(f.stops).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(f.ui.screen.message).toHaveBeenCalledWith(
      "Butler",
      "This task needs your input. Run butler in a terminal to continue.",
    );
  },
);
test("interactive handoffs continue waiting for the owner's input", async () => {
  f.handoff = "takeover";
  await main([]);
  f.ui.submit("/run synthetic fixture task");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  expect(f.stops).toBe(0);
  f.ui.submit("/stop");
  await vi.waitFor(() => expect(f.stops).toBe(1));
});
test("simple reminder reads bypass the model and retain their result as untrusted conversation data", async () => {
  f.toolAnswer.mockResolvedValue({ said: "Nothing’s due today.", outcome: {} });
  await main(["--ask", "check my reminders"]);
  expect(f.connectionsStart).toHaveBeenCalledWith(
    expect.objectContaining({ firstPartyOnly: true }),
  );
  expect(f.toolAnswer).toHaveBeenCalledOnce();
  expect(f.noteUser).toHaveBeenCalledWith("check my reminders", "app");
  expect(f.noteAssistant).toHaveBeenCalledWith("Nothing’s due today.", "app", {
    untrusted: true,
  });
  expect(f.tasks).toEqual([]);
  expect(f.decide).not.toHaveBeenCalled();
});
test("a failed direct read retains normal model routing", async () => {
  await main(["--ask", "check my reminders"]);
  expect(f.toolAnswer).toHaveBeenCalledOnce();
  expect(f.decide).toHaveBeenCalledOnce();
});
test("compound requests keep the full tool catalogue and normal model routing", async () => {
  await main(["--ask", "check my reminders and then check my email"]);
  expect(f.toolAnswer).not.toHaveBeenCalled();
  expect(f.connectionsStart).toHaveBeenCalledWith(
    expect.objectContaining({ firstPartyOnly: false }),
  );
  expect(f.decide).toHaveBeenCalledOnce();
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
    multiWindow: true,
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
test("an explicit browser carries the same initial window and URL routing into a CLI task", async () => {
  await main([]);
  f.ui.submit("/cua In Google Chrome, open the SYNTHETIC website");
  await vi.waitFor(() => expect(f.tasks).toHaveLength(1));
  expect(f.tasks[0].options).toMatchObject({
    multiWindow: true,
    initialApp: "Google Chrome",
    browser: { name: "Google Chrome", bundleId: "com.google.Chrome" },
  });
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
test.each([["--ask", "/briefing"], ["--ask", "Brief me"], ["briefing"]])(
  "one-shot briefing %j holds the engine lock through collection and releases it on exit",
  async (...args) => {
    const file = join(root, "engine.pid");
    f.briefingCheck.mockImplementationOnce(async () => {
      expect(readFileSync(file, "utf8")).toBe(String(process.pid));
      return { on: true, state: "waiting" };
    });
    await main(args);
    expect(f.briefingCheck).toHaveBeenCalledOnce();
    expect(existsSync(file)).toBe(false);
  },
);
test("a competing engine cannot perform a one-shot briefing or remove the existing lock", async () => {
  const file = join(root, "engine.pid");
  writeFileSync(file, String(process.pid));
  await expect(main(["--ask", "/briefing"])).rejects.toThrow("already running");
  expect(f.briefingCheck).not.toHaveBeenCalled();
  await f.ui.quit();
  expect(readFileSync(file, "utf8")).toBe(String(process.pid));
});
test.each([
  {
    mode: "local",
    note: "The model allowance is used; showing a local recap.",
  },
  { mode: "local", note: "The model did not answer; showing a local recap." },
  { mode: "model", note: undefined },
] as const)(
  "briefing delivery preserves the fallback explanation in the saved copy, display and speech: %j",
  async ({ mode, note }) => {
    await main([]);
    const briefing = {
      at: Date.now(),
      since: Date.now(),
      mode,
      text: "A synthetic meeting begins in an hour.",
      ...(note ? { note } : {}),
      sources: [
        { id: "fixture", title: "Calendar", state: "ok", detail: "Read only" },
      ],
    };
    const spoken = [note, briefing.text].filter(Boolean).join("\n\n");
    f.store.instance.profile.settings.briefings.delivery = "both";
    await f.briefingOptions.deliver(briefing);
    expect(f.store.instance.latestBriefing()).toBe(
      spoken + "\n\nCoverage: Calendar: ok (Read only)",
    );
    expect(f.ui.screen.message).toHaveBeenLastCalledWith("Briefing", spoken);
    expect(f.speak).toHaveBeenLastCalledWith(spoken, true, false);
    f.speak.mockClear();
    f.store.instance.profile.settings.briefings.delivery = "notification";
    await f.briefingOptions.deliver(briefing);
    expect(f.store.instance.latestBriefing()).toContain(spoken);
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.tasks).toEqual([]);
  },
);
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
