import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { TerminalScreen, screenLines } from "./screen";
import { TerminalStore, terminalHome } from "./store";
import { TerminalVoice, type SpokenInput } from "./voice";
import { installedApps } from "./apps";
import { providerDiagnostics, probeModel } from "./doctor";
import { nativeModelFetch } from "./transport";
import {
  terminalMemory,
  conversationMemory,
  rememberPreference,
  rememberRequest,
} from "./memory";
import { TerminalConnections } from "./connections";
import {
  setupRequest,
  naturalControl,
  openSetupPage,
  SETUP_APPS,
  type SetupApp,
} from "./concierge";
import { UrlOpener } from "../../electron/open-url";
import { NativeController } from "../../electron/controller";
import { AssistantSession } from "../../electron/assistant";
import { TaskQueue } from "../../electron/task-queue";
import { runView } from "../assistant/run-view";
import { answerByTool } from "../../electron/tools";
import { toolFastPath } from "../assistant/tool-answers";
import { inboxRequest, readInbox, summarizeInbox } from "./inbox";
import {
  createBriefings,
  createBriefingSummarizer,
} from "../../electron/briefings";
import { collectBriefing } from "../briefings/collect";
import { Runner, terminal } from "../core/runner";
import { HttpProvider } from "../providers/http";
import { providerDefaults, modelPrice } from "../providers/catalog";
import {
  settingsSchema,
  type Controller,
  type Snapshot,
  type ProviderKind,
  type TaskSource,
  type Run,
} from "../core/schema";
import { fileFactsReader } from "../storage/files";
import { deliverableTextReader } from "../tools/providers/files";
import {
  APPROVAL_MIN_CONFIDENCE,
  planVoiceTurn,
  voiceIntent,
} from "../voice/turns";
import { leadingClause } from "../voice/early";
import { redactSecrets } from "../core/sanitize";
import type { RunView } from "../assistant/types";

const ROOT =
  typeof __dirname === "string" ? resolve(__dirname, "..") : process.cwd();
let cleanup: () => Promise<void> = async () => {};
const HELP = `Just type to converse. Butler uses connected tools before desktop control.
/connect [name]|all|mcp|import <path>   connection catalog and setup
/connect slack bot|oauth   bot token or account OAuth
/connections   connection status
/apps          installed Mac apps and connection paths
/disconnect <name>   remove a connection
/tools /tool <server__tool> on|off   discover and select tools
/trust <server> reads|ask   choose background read access
/run <task>    explicitly start a computer task
/cua <task>    use desktop control directly (name the app, e.g. 'in Notes')
/yes /no       answer the current task approval
/stop /pause /resume   control a task
/briefings <minutes>|off   scheduled spoken + readable briefings
/briefing-reads [clear]   saved queries; /briefing-read <tool> <JSON> adds one
/briefing      check now; /latest shows the readable copy
/permissions   check or request macOS screen/control access
/notifications on|off    observe notification banners
/model openai|anthropic|google|ollama [model] [fast]   choose provider
/fast on|off   OpenAI Fast mode (twice the standard token price)
/key           store a provider key securely (masked input)
/voice on|off|test|list|<name>   spoken replies and installed voices
/listen on|off|status   'Hey Butler' and spoken commands; Option-Space if permitted
/doctor       desktop and voice permission status
/doctor model test the model connection with a generated image (uses API credits)
/remember <preference>  save an encrypted preference; /memory on|off shows its switch
/memory       saved memory counts and preferences; /forget <id>|all removes them
/help /quit    help / quit
/new           start a fresh conversation
Ctrl-C interrupts work. Ctrl-D quits. Coding tools use this project folder.
Run 'butler daemon start' to keep briefings running after closing your terminal.`;
const CHAT_HELP = `Tell me what you'd like done, or try:
“Connect my apps” or “Set up Gmail and Slack”
“Read replies aloud” or “Listen for me”
“Brief me every 30 minutes” or “Catch me up”
“Create a note for tomorrow's meeting”
“Do that next”, “Pause”, “Continue” or “Stop”
“Show my connections” or “What do you remember about me?”
Type “Start a fresh conversation” to clear this thread.
Account sign-ins and access approvals stay with you.
Technical commands are optional; /help advanced lists them.`;

/** Exact generic requests use the existing batched read-only briefing path. */
export function briefingRequest(text: string): boolean {
  return /^(?:please\s+)?(?:brief me|give me (?:a|my) briefing|what needs my attention|catch me up)[.!?]*$/i.test(
    text.trim(),
  );
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args[0] === "help") {
    console.log(
      `Butler — a macOS terminal assistant\n\nStart: butler\n\n${args.includes("--advanced") ? HELP : CHAT_HELP}`,
    );
    return;
  }
  if (args.includes("--demo")) {
    const demo = new TerminalScreen(
      () => {},
      () => {},
      () => {
        demo.close();
      },
    );
    cleanup = async () => demo.close();
    process.once("SIGINT", () => demo.close());
    process.once("SIGTERM", () => demo.close());
    demo.state = {
      phase: "thinking",
      model: "British wit / terminal edition",
      connections: [
        "GitHub [demo]",
        "Claude Code [demo]",
        "Codex bridge [demo]",
      ],
      nextBriefing: "every 30 min",
      messages: [
        {
          who: "Butler",
          text: "Good evening. Your terminal is rather more becoming now. What shall we attend to?",
        },
      ],
      status: "MCP first. A little discretion.",
    };
    if (!process.stdout.isTTY) {
      console.log(
        screenLines(demo.state, 90, 30, 12, "What needs my attention?").join(
          "\n",
        ),
      );
      return;
    }
    demo.start();
    return;
  }
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {}
  }
  const command = args[0];
  const interactive =
    process.stdin.isTTY &&
    !args.includes("--daemon") &&
    !args.includes("--ask");
  if (command === "daemon") {
    await daemon(args[1] || "status");
    return;
  }
  const cwdFlag = args.indexOf("--cwd");
  const project = resolve(
    cwdFlag >= 0 ? args[cwdFlag + 1] || process.cwd() : process.cwd(),
  );
  if (!existsSync(project))
    throw new Error("The project folder does not exist.");
  const store = new TerminalStore();
  const modelFetch = nativeModelFetch();
  const providerTrace = providerDiagnostics(
    join(store.root, "diagnostics"),
    () => [store.keyForProvider(), ...Object.values(store.profile.secrets)],
  );
  const connections = new TerminalConnections(store, project, ROOT, (url) =>
    openSetupPage(url, store.profile.settings.protectedDomains),
  );
  const askText = args.includes("--ask")
    ? args[args.indexOf("--ask") + 1] || ""
    : "";
  const passiveConnections =
    command === "briefing" ||
    args.includes("--daemon") ||
    briefingRequest(askText) ||
    askText === "/briefing";
  const firstPartyConnections =
    toolFastPath(askText, connections.registry.clock())?.kind === "answer";
  let connectionsReady: Promise<void> | undefined;
  const readyConnections = () =>
    (connectionsReady ??= connections.start({
      briefingsOnly: passiveConnections,
      firstPartyOnly: firstPartyConnections,
      ...(inboxRequest(askText) && { onlyServers: ["gmail"] }),
    }));
  let native: NativeController | undefined;
  let nativeSetup: Promise<void> | undefined;
  let runner: Runner | undefined;
  let runningWork: Promise<void> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let activeTurn: AbortController | undefined;
  let stopped = false;
  let busy = false;
  let snapshot: Snapshot = {
    run: null,
    frame: null,
    events: [],
    message: "Ready when you are.",
  };
  let lastStatus = "";
  const taskQueue = new TaskQueue();
  const rememberedTurns = store.conversation.load();
  let lastFinished: Run | undefined = rememberedTurns.length
    ? store.vault
        .list()
        .find(
          (r) =>
            terminal(r.status) &&
            r.privacy === store.profile.settings.privacy &&
            r.provider === store.profile.settings.provider &&
            r.model === store.profile.settings.model &&
            Date.parse(r.createdAt) >= rememberedTurns[0].at &&
            Date.now() - Date.parse(r.createdAt) < 24 * 60 * 60_000,
        )
    : undefined;
  const recordedResults = new Set<string>();
  const isRunning = () =>
    !!snapshot.run &&
    snapshot.run.status !== "idle" &&
    !terminal(snapshot.run.status);
  const settings = () => store.profile.settings;
  const show = (text: string, who = "Butler") => {
    if (!args.includes("--daemon"))
      return screen.message(who, redactSecrets(text));
  };
  const urls = new UrlOpener();
  const getNative = () => {
    if (!native) {
      native = new NativeController(
        join(ROOT, "native/bin/coarena-controller"),
        () => interrupt(),
        (scope) => runner?.manualTakeover(scope),
        undefined,
        {
          openUrl: (action, browser) =>
            urls.open(
              action.url,
              browser || { name: "Safari", bundleId: "com.apple.Safari" },
            ),
        },
      );
      nativeSetup = native.configure(settings());
      void nativeSetup.catch(() => {});
    }
    return native;
  };
  const view = (): RunView =>
    runView(isRunning() ? snapshot : undefined, {
      queued: taskQueue.list(Date.now()),
      watches: [],
      lastFinished,
      now: Date.now(),
      heldByVoice,
    });
  const interrupt = () => {
    taskQueue.clear();
    heldByVoice = false;
    activeTurn?.abort();
    runner?.stop();
    briefings.interrupt();
    void voice.interruptOutput();
    screen.state.phase = "idle";
    screen.state.status = "Interrupted. Ready when you are.";
    screen.draw();
  };
  const quit = async () => {
    if (stopped) return;
    stopped = true;
    interrupt();
    dialog.interrupt();
    briefings.close();
    clearInterval(healthTimer);
    voice.close();
    native?.close();
    screen.close();
    await connectionsReady?.catch(() => {});
    await connections.registry.closeAll();
    store.memory.flush();
    releaseLock();
    if (
      args.includes("--daemon") &&
      existsSync(join(store.root, "daemon.pid"))
    ) {
      try {
        unlinkSync(join(store.root, "daemon.pid"));
      } catch {}
    }
  };
  let releaseLock = () => {};
  let engineClaimed = false;
  const ownEngine = () => {
    if (engineClaimed) return;
    releaseLock = claimEngine(store.root);
    engineClaimed = true;
  };
  cleanup = quit;
  const screen = new TerminalScreen(
    (text) => void dispatch(text).catch((error) => reportError(error)),
    interrupt,
    () => void quit(),
  );
  screen.state.model = `${settings().provider} / ${settings().model}`;
  let heldByVoice = false;
  const voice = new TerminalVoice({
    root: ROOT,
    settings,
    trace: providerTrace,
    receive: (input) => void dispatch(input.text, input).catch(reportError),
    notice: show,
    activity: (phase) => {
      if (stopped) return;
      if (phase === "listening" && screen.prompting) return;
      if (phase === "listening") {
        activeTurn?.abort();
        void voice.interruptOutput();
      }
      if (phase === "listening" && isRunning() && view().status === "working") {
        heldByVoice = true;
        runner?.interruptForVoice("control");
      }
      screen.state.phase =
        phase === "idle"
          ? busy
            ? "thinking"
            : isRunning()
              ? "working"
              : "idle"
          : phase;
      screen.state.status =
        phase === "listening"
          ? "Listening to you."
          : phase === "speaking"
            ? "Speaking."
            : snapshot.message;
      screen.draw();
      if (phase === "idle")
        queueMicrotask(() => {
          // A rejected or cancelled utterance never reaches dispatch's finally.
          if (
            heldByVoice &&
            !busy &&
            !voice.listeningToTurn &&
            snapshot.run?.status === "paused" &&
            !stopped
          ) {
            heldByVoice = false;
            void runner?.resume().catch(reportError);
          }
        });
    },
  });
  const speak = (text: string, force = false, followUp = true) =>
    voice.speak(text, force, followUp);
  const announce = (text: string, spoken = text) => {
    show(text);
    void speak(spoken).catch((error) => show(safeError(error)));
  };
  const reportError = (error: unknown) => announce(safeError(error));
  const doctor = async () => ({
    desktop: await getNative().request("permissions"),
    voice: await voice.status(),
    selectedVoice: settings().voiceId || "automatic British voice",
    spokenReplies: settings().voiceReplies !== "off",
    model: settings().model,
    providerKeyPresent: !!store.keyForProvider(),
  });
  if (process.env.BUTLER_VOICE) settings().voiceId = process.env.BUTLER_VOICE;
  const dialog = new AssistantSession({
    settings,
    providerKey: () => store.keyForProvider(),
    fetch: modelFetch,
    trace: providerTrace,
    history: store.conversation,
    view,
    context: (words) => ({
      briefing: briefings.status().latest || store.briefingContext(),
      memory: conversationMemory(store, words),
    }),
    heldByVoice: () => heldByVoice,
  });
  const resetConversation = () => {
    dialog.reset();
    lastFinished = undefined;
  };
  const briefings = createBriefings({
    settings,
    budget: store.briefingBudget,
    busy: () =>
      busy || !!isRunning() || voice.speaking || voice.listeningToTurn,
    locked: async () => {
      const p = await getNative().request("presence");
      return !!(p.locked || p.displayAsleep);
    },
    collect: async (since, signal) => {
      await readyConnections();
      await connections.refreshCredentials();
      await getNative().configure(settings());
      return collectBriefing({
        settings: settings(),
        since,
        signal,
        workspace: (n) => getNative().request("briefingContext", { since: n }),
        agenda: async () => ({
          access: { calendar: "off", reminders: "off" },
          lines: [],
        }),
        tools: connections.registry.access({ synthetic: false }),
      });
    },
    summarize: createBriefingSummarizer({
      settings,
      key: () => store.keyForProvider(),
      fetch: modelFetch,
      trace: providerTrace,
    }),
    modelReady: () =>
      settings().provider === "ollama" || !!store.keyForProvider(),
    deliver: async (briefing) => {
      const text = [briefing.note, briefing.text].filter(Boolean).join("\n\n");
      store.saveBriefing(
        text +
          "\n\nCoverage: " +
          briefing.sources
            .map((s) => `${s.title}: ${s.state} (${s.detail})`)
            .join("; "),
      );
      show(text, "Briefing");
      if (settings().briefings.delivery !== "notification")
        await speak(text, true, false);
    },
    onChange: () => {
      const status = briefings.status();
      screen.state.nextBriefing = status.on
        ? status.nextAt
          ? new Date(status.nextAt).toLocaleTimeString()
          : status.state
        : "off";
      screen.draw();
    },
  });
  const lazy = new Proxy(
    { kind: "native" },
    {
      get: (_target, key) => {
        if (key === "kind") return "native";
        if (key === "stop") return () => native?.stop();
        const c = getNative() as any;
        return typeof c[key] === "function"
          ? async (...args: unknown[]) => {
              await nativeSetup;
              return c[key](...args);
            }
          : c[key];
      },
    },
  ) as Controller;
  const task = async (
    text: string,
    taskSource: TaskSource = "user_words",
    spoken = false,
    toolsFirst = true,
  ) => {
    if (isRunning())
      throw new Error("A task is active. Use /stop, /pause or /resume first.");
    if (runner && !runner.settled) await runningWork;
    if (!store.keyForProvider() && settings().provider !== "ollama")
      throw new Error("Choose a model with /model and add its key with /key.");
    const helper = join(ROOT, "native/bin/coarena-controller");
    if (!existsSync(helper))
      throw new Error(
        "Build the macOS helpers with npm run build:native first.",
      );
    if (toolsFirst) await readyConnections();
    runner = new Runner(
      lazy,
      new HttpProvider(
        settings(),
        store.keyForProvider(),
        modelFetch,
        providerTrace,
      ),
      store.vault,
      settings(),
      (state) => {
        snapshot = state;
        if (state.run && terminal(state.run.status)) {
          lastFinished = state.run;
          if (!recordedResults.has(state.run.id)) {
            recordedResults.add(state.run.id);
            if (recordedResults.size > 24)
              recordedResults.delete(recordedResults.values().next().value!);
            if (state.run.summary?.trim())
              dialog.noteAssistant(
                state.run.summary,
                spoken ? "voice" : "app",
                { untrusted: true },
              );
          }
        }
        if (state.run?.status === "confirming" && !process.stdin.isTTY) {
          queueMicrotask(() => runner?.confirm(false));
          show(
            "That action needs your approval in an interactive Butler terminal.",
          );
        }
        if (
          ["paused", "takeover"].includes(state.run?.status || "") &&
          !process.stdin.isTTY
        ) {
          process.exitCode = 1;
          queueMicrotask(() =>
            runner?.stop("This task needs an interactive Butler terminal."),
          );
          show(
            "This task needs your input. Run butler in a terminal to continue.",
          );
        }
        screen.state.phase = isRunning() ? "working" : "idle";
        screen.state.status = state.message;
        if (state.message !== lastStatus) {
          lastStatus = state.message;
          if (state.run?.status === "confirming")
            announce(
              `${state.message}\nType Yes to approve or No to decline.`,
              `${state.message} Please approve or decline in the terminal.`,
            );
          else if (
            ["completed", "failed", "cancelled", "paused", "takeover"].includes(
              state.run?.status || "",
            )
          )
            announce(state.message);
        }
        screen.draw();
      },
      [],
      settings().memory
        ? terminalMemory(store, async (query) => {
            try {
              return await getNative().request("index", query ? { query } : {});
            } catch {
              return undefined;
            }
          })
        : undefined,
      {
        tools: connections.registry.access({ synthetic: false }),
        deliverables: fileFactsReader(process.env.HOME || ""),
        deliverableText: deliverableTextReader(process.env.HOME || ""),
      },
    );
    briefings.interrupt();
    const opening = leadingClause(text);
    const currentRunner = runner;
    const work = currentRunner.start(text, {
      ...(opening?.target === "app" &&
      ["boundary", "end"].includes(opening.next)
        ? { initialApp: opening.name }
        : {}),
      toolsFirst,
      background: settings().workInBackground,
      origin: spoken ? "voice" : "typed",
      taskSource,
    });
    runningWork = work;
    await work;
    if (stopped || runner !== currentRunner) return;
    if (snapshot.run?.status === "completed") {
      const next = taskQueue.next(Date.now());
      if (next) await task(next.text, next.taskSource, next.origin === "voice");
    } else if (taskQueue.clear()) {
      const line =
        "The queued tasks were cancelled because this one did not finish. Tell me when you'd like to retry them.";
      dialog.noteAssistant(line, spoken ? "voice" : "app");
      show(line);
    }
  };
  let setupGoal: string | undefined;
  const setupApps = async (
    apps: SetupApp[],
    signal: AbortSignal,
    spoken = false,
  ) => {
    // Recheck after the owner completes a paused browser setup handoff.
    if (
      setupGoal &&
      snapshot.run?.task === setupGoal &&
      ["paused", "takeover"].includes(snapshot.run.status)
    ) {
      runner?.stop();
      await runningWork;
      setupGoal = undefined;
    }
    if (isRunning()) {
      announce(
        "Let the current task finish, then I can set up your connections.",
      );
      return;
    }
    ownEngine();
    await readyConnections();
    const browser = installedApps().some((app) => app.name === "Google Chrome")
      ? "Google Chrome"
      : "Safari";
    const result = await connections.setup(
      apps,
      browser,
      show,
      signal,
      undefined,
      screen.ask.bind(screen),
    );
    briefings.apply();
    screen.state.connections = connections.labels();
    dialog.noteAssistant(
      `Connection check: ready ${result.connected.join(", ") || "none"}; still needs attention ${result.pending.join(", ") || "none"}.`,
      spoken ? "voice" : "app",
      { untrusted: true },
    );
    if (result.browserTask) {
      setupGoal = result.browserTask;
      announce(
        "I'll prepare the browser setup. I'll stop when it's your turn to sign in or approve access.",
      );
      const work = task(result.browserTask, "user_words", spoken, false);
      if (interactive) void work.catch(reportError);
      else await work;
    } else if (result.pending.length)
      announce(
        "Some accounts still need attention. Tell me which one you'd like to sort out next.",
      );
    else announce("Your requested connections are ready.");
  };
  const setRegularBriefings = (rest: string) => {
    const minutes = Number(rest);
    if (
      rest !== "off" &&
      (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)
    )
      throw new Error("Briefings can run every 5 minutes to once a day.");
    store.profile.settings = settingsSchema.parse({
      ...settings(),
      briefings: {
        ...settings().briefings,
        on: rest !== "off",
        intervalMinutes:
          rest === "off" ? settings().briefings.intervalMinutes : minutes,
        delivery: "speech",
      },
    });
    store.save();
    briefings.apply();
    announce(
      rest === "off"
        ? "Regular briefings are off."
        : `I'll brief you every ${minutes} minutes, with a readable copy.`,
    );
  };
  async function dispatch(text: string, spoken?: SpokenInput) {
    if (!spoken && snapshot.run?.status === "confirming") {
      const answer = text
        .trim()
        .toLowerCase()
        .replace(/[.!]+$/, "");
      if (["yes", "approve", "no", "decline"].includes(answer)) {
        show(text, "You");
        return dispatch(["yes", "approve"].includes(answer) ? "/yes" : "/no");
      }
    }
    const control = !spoken ? naturalControl(text) : undefined;
    if (control) {
      show(text, "You");
      return dispatch(control);
    }
    // Voice never enters the slash-command or credential/approval lane.
    if (spoken) {
      if (text.startsWith("/")) return;
      const intent = voiceIntent(text);
      if (intent.kind === "stop") {
        interrupt();
        return;
      }
      if (intent.kind === "pause") {
        heldByVoice = false;
        runner?.interruptForVoice("control");
        return;
      }
      if (snapshot.run?.status === "confirming") {
        announce(
          "This action is waiting for typed approval. Type Yes or No.",
          "Please approve or decline this action in the terminal.",
        );
        return;
      }
      if (screen.prompting) {
        show("Please finish the terminal prompt first.");
        return;
      }
    }
    await voice.interruptOutput();
    if (text === "/quit") return quit();
    if (text === "/stop") {
      interrupt();
      return;
    }
    if (text === "/yes" || text === "/no") {
      if (snapshot.run?.status !== "confirming")
        throw new Error("There is no pending task approval.");
      runner?.confirm(text === "/yes");
      return;
    }
    if (text === "/pause") {
      heldByVoice = false;
      runner?.pause(undefined, "manual");
      return;
    }
    if (text === "/resume") {
      heldByVoice = false;
      await runner?.resume();
      return;
    }
    if (busy)
      throw new Error(
        "One moment, please. Ctrl-C interrupts the current request.",
      );
    if (
      isRunning() &&
      [
        "/connect",
        "/disconnect",
        "/tool",
        "/trust",
        "/model",
        "/fast",
        "/key",
        "/permissions",
        "/forget",
      ].includes(text.split(/\s+/)[0])
    )
      throw new Error(
        "Stop the active task before changing its configuration.",
      );
    busy = true;
    activeTurn = new AbortController();
    briefings.interrupt();
    screen.state.phase = "thinking";
    screen.state.status = "Attending to your request.";
    try {
      const [word, ...parts] = text.split(/\s+/);
      const rest = text.slice(word.length).trim();
      const preference = rememberRequest(text);
      if (
        preference &&
        spoken &&
        (spoken.recovered || spoken.confidence < APPROVAL_MIN_CONFIDENCE)
      ) {
        announce("Please repeat that preference so I can save it accurately.");
        return;
      }
      if (word === "/help") show(rest === "advanced" ? HELP : CHAT_HELP);
      else if (word === "/remember" || preference) {
        rememberPreference(store, preference || rest);
        announce("I'll remember that preference.");
      } else if (word === "/memory") {
        if (rest === "on" || rest === "off") {
          settings().memory = rest === "on";
          store.save();
          resetConversation();
          show(`Memory ${rest}.`);
        } else if (rest && rest !== "advanced")
          throw new Error("Use /memory, /memory on, or /memory off.");
        else {
          const preferences = store.memory
            .data()
            .preferences.filter((p) => !p.status || p.status === "approved");
          show(
            [
              settings().memory
                ? `Memory is on. I have ${preferences.length} saved preferences and ${store.memory.data().episodes.length} task records. I also keep our recent conversation across restarts.`
                : "Memory is off. Your saved preferences remain here until you ask me to forget them.",
              ...preferences.map((p) =>
                rest === "advanced"
                  ? `${p.id}: ${redactSecrets(p.text)}`
                  : `• ${redactSecrets(p.text)}`,
              ),
            ].join("\n"),
          );
        }
      } else if (word === "/forget") {
        if (rest === "all") store.memory.clear();
        else {
          if (!store.memory.data().preferences.some((p) => p.id === rest))
            throw new Error(
              "Use /forget with an ID shown by /memory, or /forget all.",
            );
          store.memory.update((data) => {
            data.preferences = data.preferences.filter((p) => p.id !== rest);
          });
          store.memory.flush();
        }
        resetConversation();
        announce("That saved memory has been forgotten.");
      } else if (word === "/new") {
        resetConversation();
        screen.clearMessages();
        announce("A fresh conversation. What shall we attend to?");
      } else if (word === "/apps")
        show(
          installedApps()
            .map((app) => app.name)
            .join(", ") ||
            "No app bundles found in the standard Applications folders.",
        );
      else if (word === "/doctor") {
        show(JSON.stringify(await doctor(), null, 2));
        if (rest === "model")
          show(
            JSON.stringify(
              await probeModel(
                settings(),
                store.keyForProvider(),
                providerTrace,
                modelFetch,
                activeTurn.signal,
              ),
              null,
              2,
            ),
          );
      } else if (word === "/connections") {
        await readyConnections();
        screen.state.connections = connections.labels();
        show(
          connections.labels().join("\n") ||
            "No apps connected yet. Tell me ‘Connect my apps’ to get started.",
        );
      } else if (word === "/connect") {
        if (rest === "auto") {
          await setupApps([...SETUP_APPS], activeTurn.signal);
          return;
        }
        await readyConnections();
        await connections.connectCommand(
          rest,
          screen.ask.bind(screen),
          show,
          activeTurn.signal,
        );
        briefings.apply();
        screen.state.connections = connections.labels();
      } else if (word === "/disconnect") {
        await readyConnections();
        if (!rest) throw new Error("Name the connection after /disconnect.");
        await connections.disconnect(rest);
        briefings.apply();
        screen.state.connections = connections.labels();
        show(`${rest} disconnected.`);
      } else if (word === "/tools") {
        await readyConnections();
        const access = connections.registry.access({ synthetic: false });
        if (!access) throw new Error("Connected tools are disabled.");
        const listed = await access.list("", activeTurn.signal);
        show(
          listed.tools
            .map(
              (t) => `${t.id} [${t.tier}${t.trusted ? ", trusted reads" : ""}]`,
            )
            .join("\n") || "No selected tools. Connect a server first.",
        );
        for (const server of connections.registry.status().servers)
          show(
            `${server.name}: ` +
              server.tools
                .map(
                  (t) =>
                    `${server.id}__${t.name} [${t.tier}${t.denied ? ", blocked" : ""}]`,
                )
                .join(", "),
          );
      } else if (word === "/tool") {
        const [id, setting] = parts;
        const at = id?.indexOf("__") ?? -1;
        if (at < 1 || !["on", "off"].includes(setting))
          throw new Error("Use /tool server__tool on or off.");
        const row = settings().tools.servers.find(
          (r) => r.id === id.slice(0, at),
        );
        if (!row)
          throw new Error(
            "Select a configured MCP server's tool. Apple tools follow /connect apple permissions.",
          );
        row.tools = connections.registry.tick(
          row.id,
          id.slice(at + 2),
          setting === "on",
        );
        store.save();
        show(`${id} is ${setting}.`);
      } else if (word === "/trust") {
        const [id, setting] = parts;
        const row = settings().tools.servers.find((r) => r.id === id);
        if (!row || !["reads", "ask"].includes(setting))
          throw new Error("Use /trust <server> reads or ask.");
        row.trust = setting === "reads" ? "reads_unattended" : "ask";
        store.save();
        show(
          `${row.name}: ${setting === "reads" ? "trusted read tools can run in briefings" : "tools ask for approval"}.`,
        );
      } else if (word === "/permissions") {
        const p = await getNative().request("permissions");
        show(
          `Screen recording: ${p.screen ? "granted" : "unavailable to this terminal session"}. Accessibility: ${p.accessibility ? "granted" : "missing"}.`,
        );
        if (!p.screen || !p.accessibility) {
          show(
            "Approve the terminal that runs Butler in macOS Privacy & Security, then fully quit and reopen that terminal. An old Butler.app grant does not cover a new terminal host. Requesting access now.",
          );
          await getNative().request("requestPermissions");
        }
      } else if (word === "/briefing-reads") {
        if (rest === "clear") {
          settings().briefings.reads = [];
          store.save();
          briefings.apply();
          show("Saved briefing queries cleared.");
        } else show(JSON.stringify(settings().briefings.reads, null, 2));
      } else if (word === "/briefing-read") {
        const at = rest.indexOf(" ");
        if (at < 1)
          throw new Error("Use /briefing-read server__tool {JSON arguments}.");
        const id = rest.slice(0, at);
        const args = JSON.parse(rest.slice(at + 1));
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Arguments must be a JSON object.");
        const access = connections.registry.access({ synthetic: false });
        if (!access) throw new Error("Enable connected tools first.");
        const catalog = await access.list("", activeTurn.signal, {
          readsOnly: true,
        });
        const spec = catalog.tools.find((t) => t.id === id);
        if (!spec || !spec.trusted || spec.tier !== "read" || spec.longRunning)
          throw new Error(
            "Choose an enabled trusted read tool. Coding tasks cannot run unattended.",
          );
        const prepared = access.prepare(spec, args, {
          userWords: JSON.stringify(args),
        });
        if (!prepared.ok)
          throw new Error(
            "Those arguments do not match the tool's schema or access rules.",
          );
        const reads = settings().briefings.reads.filter(
          (read) => read.tool !== id,
        );
        reads.push({ tool: id, args });
        store.profile.settings = settingsSchema.parse({
          ...settings(),
          briefings: { ...settings().briefings, reads },
        });
        store.save();
        briefings.apply();
        show("Read query saved for the next briefing.");
      } else if (word === "/run" || word === "/cua") {
        if (!rest) throw new Error("Tell me the task after /run.");
        show(rest, "You");
        dialog.noteUser(rest, "app");
        announce("Certainly. I'll attend to that.");
        if (process.stdin.isTTY)
          void task(rest, "user_words", false, word !== "/cua").catch(
            reportError,
          );
        else await task(rest, "user_words", false, word !== "/cua");
      } else if (word === "/briefing" || briefingRequest(text)) {
        if (spoken && spoken.confidence < APPROVAL_MIN_CONFIDENCE) {
          announce("Please repeat that if you'd like a fresh briefing.");
          return;
        }
        if (word !== "/briefing") show(text, "You");
        ownEngine();
        await voice.interruptOutput();
        busy = false;
        const report = await briefings.checkNow();
        if (report.error) show(report.error);
      } else if (word === "/latest") show(store.latestBriefing(), "Briefing");
      else if (word === "/briefings") {
        setRegularBriefings(rest);
      } else if (word === "/notifications") {
        if (rest !== "on" && rest !== "off")
          throw new Error("Use /notifications on or off.");
        settings().notifications = rest === "on";
        store.save();
        await getNative().configure(settings());
        briefings.apply();
        show(
          `Notification banner observation is ${rest}. macOS Accessibility access is required.`,
        );
      } else if (word === "/voice") {
        if (rest === "off" || rest === "on") {
          settings().voiceReplies = rest === "on" ? "always" : "off";
          store.save();
          announce(`Spoken replies are ${rest}.`);
        } else if (rest === "test") {
          const line =
            "Good evening. Butler at your service. Your voice output is working.";
          show(line);
          await speak(line, true);
        } else if (rest === "list") {
          show(
            (await voice.voices())
              .map((v) => `${v.name} (${v.language})`)
              .join("\n"),
          );
        } else {
          const chosen = (await voice.voices()).find(
            (v) => v.id === rest || v.name.toLowerCase() === rest.toLowerCase(),
          );
          if (!chosen)
            throw new Error(
              "Use /voice on, off, test, list, or an installed voice name.",
            );
          settings().voiceId = chosen.id;
          store.save();
          announce(`Voice selected: ${chosen.name}.`);
        }
      } else if (word === "/listen") {
        if (rest === "status")
          show(JSON.stringify(await voice.status(), null, 2));
        else if (rest === "on" || rest === "off") {
          if (rest === "on")
            show(
              "Requesting Microphone and Speech Recognition access for Butler's standalone voice helper.",
            );
          const status = await voice.setListening(
            rest === "on",
            true,
            activeTurn.signal,
          );
          settings().handsFree = rest === "on";
          store.save();
          announce(
            rest === "on"
              ? `Listening enabled. Say “Hey Butler” followed by your request.${status.shortcut ? " You can also hold Option-Space." : " Option-Space needs Accessibility access for the voice helper."}`
              : "Voice input is off.",
          );
        } else throw new Error("Use /listen on, off or status.");
      } else if (word === "/key") {
        const key = await screen.ask("Provider API key", true);
        if (!key) throw new Error("No key supplied.");
        store.profile.secrets[`provider:${settings().provider}`] = key;
        store.save();
        resetConversation();
        show("Provider key stored in Butler's encrypted terminal profile.");
      } else if (word === "/model") {
        const provider = parts[0] as ProviderKind;
        if (!["openai", "anthropic", "google", "ollama"].includes(provider))
          throw new Error("Choose openai, anthropic, google or ollama.");
        const model =
          parts[1] ||
          (provider === "openai"
            ? "gpt-6.1-sol"
            : providerDefaults[provider].model);
        const fast =
          provider === "openai" &&
          (parts[2] === "fast" || (!parts[1] && model === "gpt-6.1-sol"));
        const rates = modelPrice(provider, model);
        store.profile.settings = settingsSchema.parse({
          ...settings(),
          ...providerDefaults[provider],
          provider,
          privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
          model,
          dialogModel: "",
          openaiServiceTier: fast ? "fast" : "auto",
          ...(rates
            ? {
                inputPrice: rates.inputPrice * (fast ? 2 : 1),
                outputPrice: rates.outputPrice * (fast ? 2 : 1),
              }
            : {}),
        });
        store.save();
        resetConversation();
        briefings.apply();
        await connections.registry.configure();
        screen.state.model = `${provider} / ${settings().model}`;
        show(
          `Model selected: ${settings().model}${fast ? " / Fast mode (2× standard token price)" : ""}. Use /key if it needs an API key.`,
        );
      } else if (word === "/fast") {
        if (settings().provider !== "openai" || !["on", "off"].includes(rest))
          throw new Error("Select an OpenAI model, then use /fast on or off.");
        const rates = modelPrice("openai", settings().model);
        if (!rates)
          throw new Error(
            "Known model rates are required before changing the processing tier.",
          );
        settings().openaiServiceTier = rest === "on" ? "fast" : "auto";
        settings().inputPrice = rates.inputPrice * (rest === "on" ? 2 : 1);
        settings().outputPrice = rates.outputPrice * (rest === "on" ? 2 : 1);
        store.save();
        resetConversation();
        show(
          `Fast mode is ${rest}${rest === "on" ? "; token prices are twice Standard" : ""}.`,
        );
      } else if (word.startsWith("/"))
        throw new Error(
          "I don't recognise that command. Tell me what you'd like to do, or type help.",
        );
      else {
        show(text, "You");
        const preference = spoken ? naturalControl(text) : undefined;
        if (
          spoken &&
          preference &&
          ["/voice on", "/voice off", "/listen off", "/briefings"].some(
            (prefix) =>
              preference === prefix || preference.startsWith(prefix + " "),
          )
        ) {
          if (spoken.recovered || spoken.confidence < APPROVAL_MIN_CONFIDENCE) {
            announce("Please repeat that setting change clearly, or type it.");
            return;
          }
          dialog.noteUser(text, "voice");
          if (preference.startsWith("/voice ")) {
            settings().voiceReplies = preference.endsWith(" on")
              ? "always"
              : "off";
            store.save();
            announce(
              preference.endsWith(" on")
                ? "I'll read my replies aloud."
                : "I'll keep my replies on screen.",
            );
          } else if (preference === "/listen off") {
            await voice.setListening(false);
            settings().handsFree = false;
            store.save();
            announce("Voice input is off.");
          } else setRegularBriefings(preference.slice("/briefings ".length));
          return;
        }
        const setup = setupRequest(text);
        if (setup) {
          if (
            spoken &&
            (spoken.recovered || spoken.confidence < APPROVAL_MIN_CONFIDENCE)
          ) {
            announce(
              "Please type that setup request so I can confirm which accounts you want connected.",
            );
            return;
          }
          dialog.noteUser(text, spoken ? "voice" : "app");
          await setupApps(setup, activeTurn.signal, !!spoken);
          return;
        }
        const inbox = inboxRequest(text);
        if (
          !isRunning() &&
          inbox &&
          (!spoken || spoken.confidence >= APPROVAL_MIN_CONFIDENCE)
        ) {
          await readyConnections();
          const tools = connections.registry.access({ synthetic: false });
          const reading =
            tools &&
            (await readInbox({
              tools,
              settings,
              request: inbox,
              words: text,
              signal: activeTurn.signal,
            }));
          if (activeTurn.signal.aborted) return;
          if (reading && !activeTurn.signal.aborted) {
            const clock = connections.registry.clock();
            const answered = await summarizeInbox({
              reading,
              settings: settings(),
              key: store.keyForProvider(),
              fetch: modelFetch,
              signal: activeTurn.signal,
              now: clock.now,
              zone: clock.zone,
              trace: providerTrace,
            });
            if (activeTurn.signal.aborted) return;
            const channel = spoken ? "voice" : "app";
            dialog.noteUser(text, channel);
            dialog.noteAssistant(answered.said, channel, { untrusted: true });
            announce(answered.said);
            return;
          }
        }
        const fast = toolFastPath(text, connections.registry.clock());
        if (
          !isRunning() &&
          fast?.kind === "answer" &&
          (!spoken || spoken.confidence >= APPROVAL_MIN_CONFIDENCE)
        ) {
          await readyConnections();
          const answered = await answerByTool(
            connections.registry,
            fast,
            text,
            activeTurn.signal,
          ).catch(() => undefined);
          if (answered && !activeTurn.signal.aborted) {
            const channel = spoken ? "voice" : "app";
            dialog.noteUser(text, channel);
            dialog.noteAssistant(answered.said, channel, { untrusted: true });
            announce(answered.said);
            return;
          }
        }
        const base = planVoiceTurn({
          text,
          source: spoken?.source || "text",
          confidence: spoken?.confidence ?? 1,
          segments: spoken?.segments,
          recovered: spoken?.recovered,
          followUpWindow: settings().followUpWindow,
          gateMatches: false,
          now: Date.now(),
          proposal: dialog.proposal(),
          run:
            snapshot.run && isRunning()
              ? {
                  id: snapshot.run.id,
                  status: snapshot.run.status,
                  task: snapshot.run.task,
                  actions: snapshot.events.length,
                  held: ["paused", "takeover"].includes(snapshot.run.status),
                  pendingReason: snapshot.pending?.reason,
                }
              : undefined,
        });
        if (base.kind === "stop") {
          interrupt();
          return;
        }
        if (base.kind === "pause") {
          heldByVoice = false;
          runner?.pause(undefined, "manual");
          return;
        }
        if (base.kind === "resume") {
          heldByVoice = false;
          await runner?.resume();
          return;
        }
        if (base.kind === "endConversation") {
          await voice.endFollowUp();
          return;
        }
        if (base.kind === "nothingRunning" || base.kind === "stillWorking") {
          const line =
            base.kind === "stillWorking"
              ? "The task is already running."
              : lastFinished?.status === "completed"
                ? "The last task has finished. What would you like next?"
                : "There isn't a paused task. Tell me what you'd like to do next.";
          dialog.noteUser(text, spoken ? "voice" : "app");
          dialog.noteAssistant(line, spoken ? "voice" : "app");
          announce(line);
          return;
        }
        if (
          ["needClick", "confirmAgain", "nothingToApprove"].includes(base.kind)
        ) {
          announce(
            "Please use /yes or /no for a pending task approval, or tell me the next task.",
          );
          return;
        }
        const decision = await dialog.decide({
          turnId: randomUUID(),
          text,
          base,
          view: view(),
          channel: spoken ? "voice" : "app",
          confidence: spoken?.confidence ?? 1,
          signal: activeTurn.signal,
        });
        if (activeTurn.signal.aborted) return;
        if (
          decision.acting &&
          (decision.plan.kind === "start" || decision.plan.kind === "replace")
        ) {
          if (decision.plan.kind === "replace") runner?.stop();
          announce("Certainly. I’ll attend to that.");
          const work = task(
            decision.plan.text,
            decision.taskSource ||
              (decision.plan.kind === "start"
                ? decision.plan.taskSource
                : undefined) ||
              "user_words",
            !!spoken,
          );
          if (process.stdin.isTTY) void work.catch(reportError);
          else await work;
        } else if (decision.plan.kind === "clarify")
          announce(decision.plan.question);
        else if (
          decision.acting &&
          (decision.plan.kind === "revise" ||
            decision.plan.kind === "amendTask")
        ) {
          await runner?.revise(decision.plan.text);
          heldByVoice = false;
          announce("Understood. I've updated the task.");
        } else if (decision.acting && decision.plan.kind === "queue") {
          const added = taskQueue.add(
            decision.plan.text,
            spoken ? "voice" : "typed",
            Date.now(),
            decision.taskSource,
          );
          announce(
            "position" in added
              ? "I'll do that next."
              : "full" in added
                ? "Three tasks are already waiting. Let one finish first."
                : "Enter credentials through /key or /connect.",
          );
        } else if (decision.acting && decision.plan.kind === "resume") {
          heldByVoice = false;
          await runner?.resume();
        } else if (decision.acting && decision.plan.kind === "pause") {
          heldByVoice = false;
          runner?.pause(undefined, "manual");
        } else if (decision.acting) show("Tell me the next task.");
        else if (decision.sentences) {
          let reply = "";
          let replyIndex: number | undefined;
          const spokenReplies: Promise<void>[] = [];
          for await (const sentence of decision.sentences) {
            if (activeTurn.signal.aborted) break;
            reply += (reply ? " " : "") + sentence;
            if (replyIndex === undefined) replyIndex = show(reply);
            else screen.updateMessage(replyIndex, redactSecrets(reply));
            const delivery = speak(sentence);
            void delivery.catch(() => {});
            spokenReplies.push(delivery);
          }
          await Promise.all(spokenReplies);
        } else if (!activeTurn.signal.aborted)
          show(
            "I'm ready. Use /run for a computer task, or configure a model with /model to converse.",
          );
      }
    } finally {
      if (
        heldByVoice &&
        !voice.listeningToTurn &&
        snapshot.run?.status === "paused" &&
        !stopped
      ) {
        heldByVoice = false;
        try {
          await runner?.resume();
        } catch (error) {
          reportError(error);
        }
      }
      busy = false;
      activeTurn = undefined;
      screen.state.phase = isRunning() ? "working" : "idle";
      screen.state.status = isRunning()
        ? snapshot.message
        : "Ready when you are.";
      screen.draw();
    }
  }
  process.once("SIGTERM", () => void quit());
  process.once("SIGINT", () => void quit());
  if (command === "status") {
    await readyConnections();
    console.log(
      JSON.stringify(
        {
          model: settings().model,
          connections: connections.registry
            .status()
            .servers.map(({ name, state, code, toolCount }) => ({
              name,
              state,
              code,
              toolCount,
            })),
          briefings: settings().briefings.on,
          intervalMinutes: settings().briefings.intervalMinutes,
        },
        null,
        2,
      ),
    );
    await quit();
    return;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await doctor(), null, 2));
    if (args.includes("--model"))
      console.log(
        JSON.stringify(
          await probeModel(
            settings(),
            store.keyForProvider(),
            providerTrace,
            modelFetch,
          ),
          null,
          2,
        ),
      );
    await quit();
    return;
  }
  if (command === "apps") {
    console.log(JSON.stringify(installedApps(), null, 2));
    await quit();
    return;
  }
  if (command === "voice" && args[1] === "test") {
    await dispatch("/voice test");
    await quit();
    return;
  }
  if (command === "permissions") {
    const p = await getNative().request("permissions");
    console.log(JSON.stringify(p, null, 2));
    await quit();
    return;
  }
  if (command === "latest") {
    console.log(store.latestBriefing());
    await quit();
    return;
  }
  if (interactive || args.includes("--daemon")) ownEngine();
  if (interactive) screen.start();
  if (interactive)
    void readyConnections()
      .then(() => {
        for (const warning of connections.connectionWarnings()) show(warning);
      })
      .catch(reportError);
  else if (args.includes("--daemon") || command === "connect")
    await readyConnections();
  screen.state.connections = connections.labels();
  healthTimer = setInterval(() => {
    screen.state.connections = connections.labels();
    screen.draw();
  }, 1000);
  healthTimer.unref();
  if (args.includes("--daemon")) {
    const keepAlive = setInterval(() => {}, 60_000);
    const previousCleanup = cleanup;
    cleanup = async () => {
      clearInterval(keepAlive);
      await previousCleanup();
    };
    process.once("SIGTERM", () => clearInterval(keepAlive));
    process.once("SIGINT", () => clearInterval(keepAlive));
    briefings.start();
    return;
  }
  if (command === "connect") {
    await dispatch(`/connect ${args.slice(1).join(" ")}`);
    await quit();
    return;
  }
  if (command === "briefing") {
    await dispatch("/briefing");
    await quit();
    return;
  }
  const askIndex = args.indexOf("--ask");
  if (askIndex >= 0) {
    await dispatch(args[askIndex + 1] || "");
    if (isRunning()) {
      show(
        "A computer task needs an interactive session. Run butler and submit the task there.",
      );
      runner?.stop();
      process.exitCode = 1;
    }
    await voice.flush();
    await quit();
    return;
  }
  if (!interactive) {
    console.log("Run butler in a terminal, or use --ask, status, or --demo.");
    await quit();
    return;
  }
  show(
    settings().tools.servers.some((row) => row.enabled && row.consented) ||
      Object.values(settings().tools.apple).some(Boolean)
      ? "At your service. Your saved connections and settings are loaded. Tell me what you'd like done, or say ‘Help’ for examples."
      : "At your service. Tell me what you'd like done. Say ‘Connect my apps’ to get started, or ‘Help’ for examples.",
  );
  await speak("At your service. What shall we attend to?", false, false).catch(
    reportError,
  );
  if (settings().handsFree || args.includes("--listen")) {
    busy = true;
    activeTurn = new AbortController();
    try {
      await voice.setListening(
        true,
        args.includes("--listen"),
        activeTurn.signal,
      );
    } catch (error) {
      show(safeError(error));
    } finally {
      busy = false;
      activeTurn = undefined;
    }
  }
  briefings.start();
}
function safeError(error: unknown) {
  return redactSecrets(
    error instanceof Error ? error.message : "That request could not finish.",
  );
}
async function daemon(command: string) {
  const root = terminalHome();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "daemon.pid");
  const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  const alive = () => {
    try {
      if (!Number.isSafeInteger(pid) || pid < 2) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (command === "status") {
    console.log(
      alive()
        ? `Butler daemon is running (${pid}).`
        : "Butler daemon is stopped.",
    );
    return;
  }
  if (command === "stop") {
    if (alive()) {
      const same = await new Promise<boolean>((resolve) =>
        execFile(
          "/bin/ps",
          ["-p", String(pid), "-o", "command="],
          { timeout: 2000 },
          (_e, out) =>
            resolve(
              out.includes(join(ROOT, "dist-terminal/main.cjs")) &&
                out.includes("--daemon"),
            ),
        ),
      );
      if (!same)
        throw new Error(
          "The saved PID belongs to another process. It was left untouched.",
        );
      process.kill(pid, "SIGTERM");
    }
    if (existsSync(file)) unlinkSync(file);
    console.log("Butler daemon stopped.");
    return;
  }
  if (command !== "start")
    throw new Error("Use daemon start, stop, or status.");
  if (alive()) {
    console.log("Butler daemon is already running.");
    return;
  }
  const store = new TerminalStore();
  if (!store.profile.settings.briefings.on)
    throw new Error("Enable a briefing interval with /briefings 30 first.");
  const engine = join(root, "engine.pid");
  if (existsSync(engine)) {
    try {
      process.kill(Number(readFileSync(engine, "utf8")), 0);
      throw new Error(
        "Butler is active in a terminal. Quit that session before starting its background service.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const log = openSync(join(root, "daemon.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [join(ROOT, "dist-terminal/main.cjs"), "--daemon"],
    { detached: true, stdio: ["ignore", log, log], cwd: process.cwd() },
  );
  closeSync(log);
  if (!child.pid) throw new Error("Butler daemon could not start.");
  writeFileSync(file, String(child.pid), { mode: 0o600 });
  child.unref();
  console.log(
    `Butler daemon started (${child.pid}). Use butler latest for the readable briefing.`,
  );
}
function claimEngine(root: string): () => void {
  const file = join(root, "engine.pid");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    let alive = false;
    try {
      if (Number.isSafeInteger(pid) && pid > 1) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {}
    if (alive)
      throw new Error(
        "Butler is already running. Use butler daemon stop to leave background mode, or close the other terminal session.",
      );
    unlinkSync(file);
  }
  writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
  return () => {
    try {
      if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
    } catch {}
  };
}
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
)
  void main().catch(async (error) => {
    process.stderr.write(safeError(error) + "\n");
    await cleanup();
    process.exitCode = 1;
  });
