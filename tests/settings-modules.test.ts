/**
 * Settings › Modules (design modules.md §4, §7, §10): the settings block
 * and its defaults, the privacy rule modules share with the task model, the
 * pane rendered with a fake status (one row per stage, the picker listing a
 * connected server's ticked tools, the fixed sentence under each row, the
 * recipes file row), the bridge methods, and main.ts's wiring of the
 * registry, the recipes file and the recognizer command, pinned by source.
 * The recognizer's args reach the spawn: a Node script stands in for a
 * replacement command.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultSettings,
  modulesSettingsSchema,
  settingsSchema,
  toolServerSchema,
  type Settings,
  type ToolServer,
} from "../src/core/schema";
import {
  moduleReachesInternet,
  modulesWithoutServer,
  validateModuleSettings,
} from "../src/core/privacy";
import { PORTS, type PortName } from "../src/modules/contracts";
import {
  createModuleRegistry,
  type ModulesStatus,
} from "../src/modules/registry";
import {
  MODULE_ROWS,
  SettingsModules,
  adapterLabel,
  choiceFromValue,
  choiceValue,
  pickableTools,
  recipesLine,
  statusLine,
} from "../src/ui/settings-modules";
import type { AppInfo, Bridge, ToolsStatus } from "../src/ui/api";
import { previewBridge } from "../src/ui/preview";
import { NativeVoice } from "../electron/voice";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = (over: Partial<ToolServer> = {}): ToolServer =>
  toolServerSchema.parse({
    id: "memo",
    name: "Memo",
    transport: "stdio",
    command: "memo-server",
    enabled: true,
    network: "none",
    addedAt: 0,
    ...over,
  });
const tools: ToolsStatus = {
  apple: {
    state: "off",
    access: {
      calendar: "unknown",
      reminders: "unknown",
      notes: "unknown",
      mail: "unknown",
    },
  },
  servers: [
    {
      id: "memo",
      name: "Memo",
      transport: "stdio",
      recipe: "",
      argv: ["memo-server"],
      resolved: true,
      state: "on",
      trust: "ask",
      network: "none",
      sandboxed: true,
      disclaimed: true,
      toolCount: 3,
      tools: [
        {
          name: "decide_clause",
          title: "Decide",
          description: "",
          tier: "read",
          on: true,
          changed: false,
          denied: false,
        },
        {
          name: "speak",
          title: "Speak",
          description: "",
          tier: "read",
          on: true,
          changed: false,
          denied: false,
        },
        {
          name: "delete_all",
          title: "Delete",
          description: "",
          tier: "destructive",
          on: false,
          changed: false,
          denied: false,
        },
        {
          name: "moved",
          title: "Moved",
          description: "",
          tier: "read",
          on: true,
          changed: true,
          denied: false,
        },
      ],
    },
    {
      id: "down",
      name: "Down",
      transport: "stdio",
      recipe: "",
      argv: ["down"],
      resolved: true,
      state: "failed",
      trust: "ask",
      network: "none",
      sandboxed: true,
      disclaimed: true,
      toolCount: 0,
      tools: [
        {
          name: "x",
          title: "X",
          description: "",
          tier: "read",
          on: true,
          changed: false,
          denied: false,
        },
      ],
    },
  ],
};

describe("settings.modules", () => {
  it("parses a stored config without the block as all built-in, and each choice with its defaults", () => {
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    delete legacy.modules;
    expect(settingsSchema.parse(legacy).modules).toEqual({});
    expect(defaultSettings.modules).toEqual({});
    expect(
      modulesSettingsSchema.parse({
        fastDecider: {
          kind: "mcp",
          server: "memo",
          tool: "decide_clause",
          fallback: true,
        },
        tts: { kind: "http", url: "https://tts.example/speak" },
        choiceModel: {
          kind: "openrouter",
          model: "openai/gpt-5-mini",
          fallback: true,
        },
        recognizer: {
          kind: "command",
          command: "/usr/local/bin/whisper-voice",
        },
      }),
    ).toEqual({
      fastDecider: {
        kind: "mcp",
        server: "memo",
        tool: "decide_clause",
        fallback: true,
      },
      tts: { kind: "http", url: "https://tts.example/speak", fallback: true },
      choiceModel: {
        kind: "openrouter",
        model: "openai/gpt-5-mini",
        fallback: true,
      },
      recognizer: {
        kind: "command",
        command: "/usr/local/bin/whisper-voice",
        args: [],
      },
    });
    expect(() =>
      modulesSettingsSchema.parse({ tts: { kind: "cloud" } }),
    ).toThrow();
    expect(() =>
      modulesSettingsSchema.parse({ tts: { kind: "http", url: "not a url" } }),
    ).toThrow();
    expect(() =>
      modulesSettingsSchema.parse({
        fastDecider: { kind: "mcp", server: "", tool: "t" },
      }),
    ).toThrow();
    expect(() =>
      modulesSettingsSchema.parse({
        recognizer: { kind: "command", command: "" },
      }),
    ).toThrow();
    expect(() =>
      modulesSettingsSchema.parse({ appOpener: { kind: "builtin" } }),
    ).toThrow();
  });
  it("shares the task model's privacy rule: nothing leaves this Mac in Private local, and a tool choice names a connected server", () => {
    const servers = [
      server(),
      server({ id: "web", network: "internet" }),
      server({
        id: "remote",
        transport: "http",
        url: "https://mcp.example/mcp",
      }),
    ];
    expect(moduleReachesInternet(undefined, servers)).toBe(false);
    expect(moduleReachesInternet({ kind: "builtin" }, servers)).toBe(false);
    expect(moduleReachesInternet({ kind: "jev" }, servers)).toBe(false);
    expect(
      moduleReachesInternet(
        { kind: "openrouter", model: "m", fallback: true },
        servers,
      ),
    ).toBe(true);
    expect(
      moduleReachesInternet(
        { kind: "http", url: "https://tts.example/", fallback: true },
        servers,
      ),
    ).toBe(true);
    expect(
      moduleReachesInternet(
        { kind: "http", url: "http://127.0.0.1:5002/", fallback: true },
        servers,
      ),
    ).toBe(false);
    expect(
      moduleReachesInternet(
        { kind: "http", url: "http://localhost:5002/", fallback: true },
        servers,
      ),
    ).toBe(false);
    expect(
      moduleReachesInternet(
        { kind: "mcp", server: "memo", tool: "t", fallback: true },
        servers,
      ),
    ).toBe(false);
    expect(
      moduleReachesInternet(
        { kind: "mcp", server: "web", tool: "t", fallback: true },
        servers,
      ),
    ).toBe(true);
    expect(
      moduleReachesInternet(
        { kind: "mcp", server: "remote", tool: "t", fallback: true },
        servers,
      ),
    ).toBe(true);
    expect(
      moduleReachesInternet(
        { kind: "mcp", server: "gone", tool: "t", fallback: true },
        servers,
      ),
    ).toBe(true);
    const local = (modules: Settings["modules"]): Settings => ({
      ...defaultSettings,
      privacy: "PRIVATE_LOCAL",
      tools: { ...defaultSettings.tools, servers },
      modules,
    });
    expect(() => validateModuleSettings(local({}))).not.toThrow();
    expect(() =>
      validateModuleSettings(
        local({
          fastDecider: {
            kind: "mcp",
            server: "memo",
            tool: "t",
            fallback: true,
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateModuleSettings(
        local({
          tts: { kind: "http", url: "http://127.0.0.1:5002/", fallback: false },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateModuleSettings(
        local({
          tts: { kind: "http", url: "https://tts.example/", fallback: true },
        }),
      ),
    ).toThrow(/Private local/);
    expect(() =>
      validateModuleSettings(
        local({
          fastDecider: {
            kind: "mcp",
            server: "web",
            tool: "t",
            fallback: true,
          },
        }),
      ),
    ).toThrow(/Private local/);
    expect(() =>
      validateModuleSettings(
        local({
          choiceModel: { kind: "openrouter", model: "m", fallback: true },
        }),
      ),
    ).toThrow(/Private local/);
    expect(() =>
      validateModuleSettings(local({ choiceModel: { kind: "jev" } })),
    ).not.toThrow();
    expect(() =>
      validateModuleSettings({
        ...local({
          urlOpener: { kind: "mcp", server: "gone", tool: "t", fallback: true },
        }),
        privacy: "PRIVATE_BYOM",
      }),
    ).toThrow(/not connected/);
    expect(() =>
      validateModuleSettings({
        ...local({
          tts: { kind: "http", url: "https://tts.example/", fallback: true },
        }),
        privacy: "PRIVATE_BYOM",
      }),
    ).not.toThrow();
    // Forgetting a server resets every choice that named it, nothing else.
    expect(
      modulesWithoutServer(
        {
          fastDecider: {
            kind: "mcp",
            server: "memo",
            tool: "a",
            fallback: true,
          },
          tts: { kind: "mcp", server: "other", tool: "b", fallback: true },
          choiceModel: {
            kind: "mcp",
            server: "memo",
            tool: "c",
            fallback: true,
          },
          urlOpener: {
            kind: "http",
            url: "https://x.example/",
            fallback: true,
          },
        },
        "memo",
      ),
    ).toEqual({
      tts: { kind: "mcp", server: "other", tool: "b", fallback: true },
      urlOpener: { kind: "http", url: "https://x.example/", fallback: true },
    });
  });
});

describe("the Modules pane", () => {
  const status: ModulesStatus = {
    clauseSegmenter: { kind: "builtin", calls: 0, fallbacks: 0 },
    fastDecider: {
      kind: "mcp",
      target: "memo/decide_clause",
      server: "memo",
      tool: "decide_clause",
      fallback: true,
      lastCode: "timeout",
      lastMs: 620,
      calls: 3,
      fallbacks: 1,
    },
    // The choice model's built-in is Jev; the registry reports it as builtin.
    choiceModel: {
      kind: "builtin",
      lastCode: "ok",
      lastMs: 164,
      calls: 1,
      fallbacks: 0,
    },
    urlOpener: { kind: "builtin", calls: 0, fallbacks: 0 },
    tts: {
      kind: "http",
      target: "https://tts.example/speak",
      url: "https://tts.example/speak",
      fallback: false,
      lastCode: "ok",
      lastMs: 900,
      calls: 12,
      fallbacks: 0,
    },
  };
  it("has one row per port and stage, each with its fixed sentence", () => {
    for (const port of Object.keys(PORTS) as PortName[])
      expect(MODULE_ROWS.map((r) => r.row)).toContain(port);
    expect(MODULE_ROWS.map((r) => r.row)).toEqual(
      expect.arrayContaining([
        "recognizer",
        "recipes",
        "appOpener",
        "scroller",
        "dialogDecider",
        "taskModel",
        "memory",
      ]),
    );
    for (const row of MODULE_ROWS) {
      expect(row.fixed.length).toBeGreaterThan(30);
      expect(row.name).not.toMatch(/[A-Z][a-z]+[A-Z]/); // plain words, never a camelCase port name
    }
  });
  it("names the picker's values and the adapters and states in words", () => {
    expect(choiceValue(undefined, "fastDecider")).toBe("builtin");
    expect(choiceValue(undefined, "choiceModel")).toBe("jev");
    expect(
      choiceValue(
        { kind: "mcp", server: "memo", tool: "speak", fallback: true },
        "tts",
      ),
    ).toBe("mcp:memo:speak");
    expect(choiceFromValue("mcp:memo:speak", "tts", undefined)).toEqual({
      kind: "mcp",
      server: "memo",
      tool: "speak",
      fallback: true,
    });
    expect(
      choiceFromValue("mcp:memo:choose", "choiceModel", undefined),
    ).toEqual({ kind: "mcp", server: "memo", tool: "choose", fallback: true });
    expect(
      choiceFromValue("http", "tts", {
        kind: "mcp",
        server: "memo",
        tool: "speak",
        fallback: false,
      }),
    ).toEqual({ kind: "http", url: "", fallback: false });
    expect(
      choiceFromValue("builtin", "tts", {
        kind: "http",
        url: "https://x/",
        fallback: true,
      }),
    ).toBeUndefined();
    expect(choiceFromValue("command", "recognizer", undefined)).toEqual({
      kind: "command",
      command: "",
      args: [],
    });
    expect(choiceFromValue("openrouter", "choiceModel", undefined)).toEqual({
      kind: "openrouter",
      model: "",
      fallback: true,
    });
    expect(adapterLabel(status.fastDecider, undefined, tools)).toBe(
      "Memo · decide_clause",
    );
    expect(adapterLabel(status.tts, undefined, tools)).toBe("HTTP endpoint");
    expect(adapterLabel(undefined, undefined, tools)).toBe("Built-in");
    expect(
      adapterLabel(status.choiceModel, undefined, tools, "choiceModel"),
    ).toBe("Jev (OpenRouter)");
    expect(statusLine(status.fastDecider)).toBe(
      "Last call failed: timeout · 620 ms · 3 calls",
    );
    expect(statusLine(status.choiceModel)).toBe(
      "Last call ok · 164 ms · 1 call",
    );
    expect(statusLine(status.urlOpener)).toBe("Not called yet");
    expect(recipesLine(undefined)).toBe("Reading…");
    expect(
      recipesLine({
        path: "/p/recipes.json",
        exists: false,
        loaded: 0,
        builtin: 11,
        total: 11,
        rejected: [],
      }),
    ).toBe(
      "No file yet: 11 built-in sites. Add /p/recipes.json to add your own.",
    );
    expect(
      recipesLine({
        path: "/p",
        exists: true,
        loaded: 2,
        builtin: 11,
        total: 12,
        rejected: [
          { index: 1, code: "template_host" },
          { index: 4, code: "key" },
        ],
      }),
    ).toBe(
      "2 of your entries loaded over 11 built-in: 12 sites. Entries 1 (template_host), 4 (key) rejected.",
    );
    expect(
      recipesLine({
        path: "/p",
        exists: true,
        loaded: 0,
        builtin: 11,
        total: 11,
        rejected: [],
        error: "not_json",
      }),
    ).toBe("The file is not valid JSON; the built-ins stand.");
    // Only a connected server's ticked, unchanged tools may be picked.
    expect(pickableTools(tools)).toEqual([
      { server: "memo", name: "Memo", tool: "decide_clause" },
      { server: "memo", name: "Memo", tool: "speak" },
    ]);
  });
  it("renders every row, the picker with the server's tools, the fallback switch, and the recipes row", () => {
    const s: Settings = {
      ...defaultSettings,
      privacy: "PRIVATE_BYOM",
      modules: {
        fastDecider: {
          kind: "mcp",
          server: "memo",
          tool: "decide_clause",
          fallback: true,
        },
        tts: {
          kind: "http",
          url: "https://tts.example/speak",
          fallback: false,
        },
        recognizer: {
          kind: "command",
          command: "/opt/voice/whisper-voice",
          args: ["--model", "small"],
        },
      },
    };
    const info = { tools, settings: s } as unknown as AppInfo;
    const api = {
      ...previewBridge(),
      modulesStatus: async () => status,
    } as Bridge;
    const html = renderToStaticMarkup(
      React.createElement(SettingsModules, {
        s,
        set: () => {},
        api,
        busy: false,
        info,
      }),
    );
    for (const row of MODULE_ROWS) {
      expect(html).toContain(row.name);
      expect(html).toContain(
        row.fixed.replace(/'/g, "&#x27;").replace(/’/g, "’"),
      );
    }
    expect(html).toContain("3 changed");
    // The picker: Built-in, the connected server's ticked tools, an endpoint.
    expect(html).toContain('<option value="builtin">Built-in</option>');
    expect(html).toContain(
      '<option value="mcp:memo:decide_clause">Memo · decide_clause</option>',
    );
    expect(html).toContain(
      '<option value="mcp:memo:speak">Memo · speak</option>',
    );
    expect(html).not.toContain("delete_all");
    expect(html).not.toContain("mcp:down:");
    expect(html).toContain('<option value="http">HTTP endpoint</option>');
    expect(html).toContain(
      '<option value="openrouter">OpenRouter model</option>',
    );
    expect(html).toMatch(
      /<option value="jev" selected="">Jev \(OpenRouter\)<\/option>/,
    );
    expect(html).toMatch(
      /<option value="command" selected="">A command<\/option>/,
    );
    // The choices in force: the mcp decider selected, the endpoint's URL, the
    // command and its arguments, the fallback switch off for tts.
    expect(html).toContain('value="mcp:memo:decide_clause" selected=""');
    expect(html).toContain('value="https://tts.example/speak"');
    expect(html).toContain('value="/opt/voice/whisper-voice"');
    expect(html).toContain("--model\nsmall");
    expect(html).toContain("Fall back to Built-in when it fails");
    // Status arrives after mount; before it, nothing is claimed.
    expect(html).toContain("Not called yet");
    expect(html).toContain("Reading…");
    expect(html).toContain("Re-read");
    expect(html).toContain("Built-in only for now.");
    expect(html).toContain("Now: Memo · decide_clause");
    expect(html).toContain("Now: HTTP endpoint");
    expect(html).toContain("Now: Command");
  });
  it("is mounted after Tools, and the bridge and preview carry its two calls", () => {
    const ui = read("src/ui/main.tsx");
    const tools = ui.indexOf(
      "<SettingsTools s={s} set={set} api={api} busy={busy} info={info} />",
    );
    const modules = ui.indexOf(
      "<SettingsModules s={s} set={set} api={api} busy={busy} info={info} />",
    );
    expect(tools).toBeGreaterThan(0);
    expect(modules).toBeGreaterThan(tools);
    expect(modules - tools).toBeLessThan(200);
    const preload = read("electron/preload.ts");
    expect(preload).toContain('modulesStatus: () => invoke("modulesStatus")');
    expect(preload).toContain('recipesStatus: () => invoke("recipesStatus")');
    const api = read("src/ui/api.ts");
    expect(api).toContain("modulesStatus(): Promise<ModulesStatus>;");
    expect(api).toContain("recipesStatus(): Promise<RecipesStatus>;");
  });
});

describe("main.ts wiring", () => {
  const main = read("electron/main.ts");
  it("creates the registry beside the tool layer with the built-ins and diagnostics, and hands it to the three consumers", () => {
    expect(main).toContain("moduleRegistry ??= createModuleRegistry({");
    const registry = main.slice(
      main.indexOf("moduleRegistry ??= createModuleRegistry({"),
    );
    const block = registry.slice(0, registry.indexOf("return moduleRegistry;"));
    expect(block).toContain("tools: getTools(),");
    expect(block).toContain("trace: debug,");
    expect(block).toContain("builtin: moduleBuiltins({");
    expect(block).toContain("registry: () => moduleRegistry,");
    expect(block).toContain(
      "enabled: jevEnabled(settings, jevKey(credentials)),",
    );
    // streaming, speech and the assistant each take the registry lazily.
    const streaming = main.slice(
      main.indexOf("const streaming = new StreamingTurn({"),
      main.indexOf("function streamingBlocked()"),
    );
    expect(streaming).toContain("modules: () => getModules(),");
    const speech = main.slice(
      main.indexOf("const speech = createSpeechOutput({"),
      main.indexOf("let agendaClient"),
    );
    expect(speech).toContain("modules: () => getModules(),");
    const assistant = main.slice(
      main.indexOf("const assistant = new AssistantSession({"),
      main.indexOf("let agendaLines"),
    );
    expect(assistant).toContain("modules: () => getModules(),");
    // The two bridge calls, Settings window only, and the save-time rule.
    expect(main).toContain(
      'case "modulesStatus":\n      return getModules().status();',
    );
    expect(main).toContain(
      'case "recipesStatus":\n      return getRecipes().load();',
    );
    expect(main).toContain("validateModuleSettings(next);");
    expect(main).toContain(
      "modules: modulesWithoutServer(settings.modules, id),",
    );
    expect(main).not.toMatch(/"modulesStatus",\s*\n\s*"recipesStatus"/);
  });
  it("reads the recipes file at start, when Settings opens and on the bridge call, and closes the watch at quit", () => {
    expect(main).toContain(
      'path: join(app.getPath("userData"), RECIPES_FILE_NAME),',
    );
    const ready = main.slice(main.indexOf("getTools().startSoon();"));
    expect(ready.slice(0, 400)).toContain("getRecipes().load();");
    const show = main.slice(
      main.indexOf("function showSettings("),
      main.indexOf("function getVoice()"),
    );
    expect(show).toContain("getRecipes().load();");
    expect(main).toContain("recipesFile?.close();");
  });
  it("spawns a recognizer command with its arguments in place of coarena-voice", () => {
    const voice = main.slice(
      main.indexOf("function getVoice()"),
      main.indexOf("function getVoice()") + 2600,
    );
    expect(voice).toContain("const recognizer = settings.modules.recognizer;");
    expect(voice).toContain(
      'recognizer?.kind === "command" ? recognizer : undefined',
    );
    expect(voice).toContain("? command.command");
    expect(voice).toContain("command?.args ?? [],");
    expect(voice).toContain(
      'debug("RecognizerStarted", { kind: command ? "command" : "builtin" });',
    );
    const helper = read("electron/controller.ts");
    expect(helper).toContain("spawn(this.binary, this.options.args ?? [], {");
    const nativeVoice = read("electron/voice.ts");
    expect(nativeVoice).toContain("args: string[] = [],");
    expect(nativeVoice).toContain("      args,\n      diagnostics,");
    expect(nativeVoice).toContain("transcript_partial {text}");
    expect(nativeVoice).toContain("requestPermissions");
  });
  it("a replacement command's arguments reach the process: a Node script answers the protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "coarena-recognizer-"));
    const script = join(root, "recognizer.cjs");
    writeFileSync(
      script,
      `const reply = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  reply({id: request.id, result: {method: request.method, argv: process.argv.slice(2)}});
  if (request.method === 'configure') reply({event: 'transcript_partial', text: 'hello'});
});`,
    );
    const events: string[] = [];
    const voice = new NativeVoice(
      process.execPath,
      (e) => events.push(e.event),
      undefined,
      {},
      [script, "--model", "small"],
    );
    try {
      expect(await voice.call("status")).toEqual({
        method: "status",
        argv: ["--model", "small"],
      });
      await voice.call("configure", { handsFree: false });
      const started = Date.now();
      while (!events.length && Date.now() - started < 5000)
        await new Promise((r) => setTimeout(r, 10));
      expect(events).toEqual(["transcript_partial"]);
    } finally {
      voice.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the registry stub", () => {
  it("answers through the built-ins, parses their replies, and reports the choice, the last code and latency per port", async () => {
    let t = 0;
    const settings: Settings = {
      ...defaultSettings,
      modules: {
        fastDecider: {
          kind: "mcp",
          server: "memo",
          tool: "decide_clause",
          fallback: false,
        },
      },
    };
    const registry = createModuleRegistry({
      settings: () => settings,
      tools: { access: () => undefined, status: () => tools },
      credentials: { headers: () => ({}), openRouterKey: () => "" },
      builtin: {
        clauseSegmenter: async () => ({ clauses: [], events: [] }),
        fastDecider: async () => ({ kind: "none", reason: "unsure" }),
        choiceModel: async () => {
          throw new Error("jev_off");
        },
        urlOpener: async () => ({ navigated: true, method: "open" }),
        tts: async () => ({ played: false, ms: 0 }),
      },
      now: () => (t += 5),
    });
    expect(
      await registry.port("urlOpener").call({ url: "https://x.example/" }),
    ).toEqual({ navigated: true, method: "open" });
    // A throwing built-in is a fallback to the port's NONE (undefined for the
    // choice model), traced as builtin_error; the call itself never rejects.
    expect(
      await registry.port("choiceModel").call({
        question: { id: "a", choices: ["x", "y"], prompt: "p" },
        state: {},
      }),
    ).toBeUndefined();
    const status = registry.status();
    expect(Object.keys(status).sort()).toEqual(Object.keys(PORTS).sort());
    expect(status.urlOpener).toMatchObject({
      kind: "builtin",
      lastCode: "ok",
      calls: 1,
      fallbacks: 0,
    });
    expect(status.choiceModel).toMatchObject({
      kind: "builtin",
      lastCode: "builtin_error",
      calls: 1,
    });
    expect(status.fastDecider).toEqual({
      kind: "mcp",
      target: "memo/decide_clause",
      server: "memo",
      tool: "decide_clause",
      fallback: false,
      calls: 0,
      fallbacks: 0,
    });
  });
});
