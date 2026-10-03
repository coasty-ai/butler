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
import { TerminalConnections } from "./connections";
import { UrlOpener } from "../../electron/open-url";
import { NativeController } from "../../electron/controller";
import { AssistantSession } from "../../electron/assistant";
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
} from "../core/schema";
import { fileFactsReader } from "../storage/files";
import { deliverableTextReader } from "../tools/providers/files";
import { planVoiceTurn, voiceIntent } from "../voice/turns";
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
/help /quit    help / quit
/new           start a fresh conversation
Ctrl-C interrupts work. Ctrl-D quits. Coding tools use this project folder.
Run 'butler daemon start' to keep briefings running after closing your terminal.`;

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args[0] === "help") {
    console.log(
      `Butler — a macOS terminal assistant\n\nUsage: butler [--cwd folder] [--ask text] [--listen] [--demo]\n       butler status | connect <name> | briefing | daemon start|stop|status\n\n${HELP}`,
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
  const connections = new TerminalConnections(store, project, ROOT);
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
  const view = (): RunView => ({
    running: !!isRunning(),
    status:
      snapshot.run?.status === "confirming"
        ? "waiting_for_approval"
        : snapshot.run?.status === "paused"
          ? "paused"
          : isRunning()
            ? "working"
            : "idle",
    task: snapshot.run?.task,
    recent: [],
    queued: [],
    watches: [],
  });
  const interrupt = () => {
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
    dialog.reset();
    briefings.close();
    clearInterval(healthTimer);
    voice.close();
    native?.close();
    screen.close();
    await connections.registry.closeAll();
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
    fetch,
    view,
    context: () => ({
      briefing: briefings.status().latest || store.briefingContext(),
    }),
    heldByVoice: () => heldByVoice,
  });
  const briefings = createBriefings({
    settings,
    busy: () =>
      busy || !!isRunning() || voice.speaking || voice.listeningToTurn,
    locked: async () => {
      const p = await getNative().request("presence");
      return !!(p.locked || p.displayAsleep);
    },
    collect: async (since, signal) => {
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
      fetch,
    }),
    modelReady: () =>
      settings().provider === "ollama" || !!store.keyForProvider(),
    deliver: async (briefing) => {
      store.saveBriefing(
        briefing.text +
          "\n\nCoverage: " +
          briefing.sources
            .map((s) => `${s.title}: ${s.state} (${s.detail})`)
            .join("; "),
      );
      show(briefing.text, "Briefing");
      if (settings().briefings.delivery !== "notification")
        await speak(briefing.text, true, false);
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
    runner = new Runner(
      lazy,
      new HttpProvider(settings(), store.keyForProvider()),
      store.vault,
      settings(),
      (state) => {
        snapshot = state;
        if (state.run?.status === "confirming" && !process.stdin.isTTY) {
          queueMicrotask(() => runner?.confirm(false));
          show(
            "That action needs your approval in an interactive Butler terminal.",
          );
        }
        screen.state.phase = isRunning() ? "working" : "idle";
        screen.state.status = state.message;
        if (state.message !== lastStatus) {
          lastStatus = state.message;
          if (state.run?.status === "confirming")
            announce(
              `${state.message}\nType /yes to approve or /no to decline.`,
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
      undefined,
      {
        tools: connections.registry.access({ synthetic: false }),
        deliverables: fileFactsReader(process.env.HOME || ""),
        deliverableText: deliverableTextReader(process.env.HOME || ""),
      },
    );
    briefings.interrupt();
    const opening = leadingClause(text);
    runningWork = runner.start(text, {
      ...(opening?.target === "app" &&
      ["boundary", "end"].includes(opening.next)
        ? { initialApp: opening.name }
        : {}),
      toolsFirst,
      background: settings().workInBackground,
      origin: spoken ? "voice" : "typed",
      taskSource,
    });
    await runningWork;
  };
  async function dispatch(text: string, spoken?: SpokenInput) {
    // Voice never enters the slash-command or credential/approval lane.
    if (spoken) {
      if (text.startsWith("/")) return;
      const intent = voiceIntent(text);
      if (intent.kind === "stop") {
        interrupt();
        return;
      }
      if (intent.kind === "pause") {
        runner?.interruptForVoice("control");
        return;
      }
      if (snapshot.run?.status === "confirming") {
        announce(
          "This action is waiting for typed approval. Use /yes or /no.",
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
      if (word === "/help") show(HELP);
      else if (word === "/new") {
        dialog.reset();
        screen.clearMessages();
        announce("A fresh conversation. What shall we attend to?");
      } else if (word === "/apps")
        show(
          installedApps()
            .map(
              (app) =>
                `${app.name}: ${app.connection}; desktop: ${app.desktop}`,
            )
            .join("\n") ||
            "No app bundles found in the standard Applications folders.",
        );
      else if (word === "/doctor")
        show(JSON.stringify(await doctor(), null, 2));
      else if (word === "/connections") {
        screen.state.connections = connections.labels();
        show(
          connections.labels().join("\n") ||
            "No servers connected. Use /connect github, then the other services you use.",
        );
      } else if (word === "/connect") {
        await connections.connectCommand(
          rest,
          screen.ask.bind(screen),
          show,
          activeTurn.signal,
        );
        briefings.apply();
        screen.state.connections = connections.labels();
      } else if (word === "/disconnect") {
        if (!rest) throw new Error("Name the connection after /disconnect.");
        await connections.disconnect(rest);
        briefings.apply();
        screen.state.connections = connections.labels();
        show(`${rest} disconnected.`);
      } else if (word === "/tools") {
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
        announce("Certainly. I'll attend to that.");
        if (process.stdin.isTTY)
          void task(rest, "user_words", false, word !== "/cua").catch(
            reportError,
          );
        else await task(rest, "user_words", false, word !== "/cua");
      } else if (word === "/briefing") {
        busy = false;
        const report = await briefings.checkNow();
        if (report.error) show(report.error);
      } else if (word === "/latest") show(store.latestBriefing(), "Briefing");
      else if (word === "/briefings") {
        const minutes = Number(rest);
        if (
          rest !== "off" &&
          (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)
        )
          throw new Error("Choose 5–1440 minutes, or /briefings off.");
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
        show(
          rest === "off"
            ? "Regular briefings are off."
            : `Every ${minutes} minutes: a spoken briefing and a readable copy. Checks wait while you're busy or the Mac is locked.`,
        );
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
        dialog.reset();
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
        dialog.reset();
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
        dialog.reset();
        show(
          `Fast mode is ${rest}${rest === "on" ? "; token prices are twice Standard" : ""}.`,
        );
      } else if (word.startsWith("/"))
        throw new Error(
          "I don't recognise that command. /help lists the available ones.",
        );
      else {
        show(text, "You");
        const base = planVoiceTurn({
          text,
          source: spoken?.source || "text",
          confidence: spoken?.confidence ?? 1,
          segments: spoken?.segments,
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
        else if (decision.acting)
          show(
            "Use /run to start that task or /stop, /pause and /resume to control it.",
          );
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
    await connections.start();
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
  const interactive =
    process.stdin.isTTY &&
    !args.includes("--daemon") &&
    !args.includes("--ask");
  if (interactive || args.includes("--daemon"))
    releaseLock = claimEngine(store.root);
  if (interactive) screen.start();
  await connections.start();
  for (const warning of connections.connectionWarnings()) show(warning);
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
    "At your service. /connect adds your apps; /briefings 30 enables spoken and readable updates. /help shows the controls.",
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
