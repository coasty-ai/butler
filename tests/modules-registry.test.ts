import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiagnostics } from "../electron/diagnostics";
import {
  defaultSettings,
  loopbackHost,
  moduleEndpoint,
  settingsSchema,
  type Settings,
} from "../src/core/schema";
import {
  TOOL_LIMITS,
  TOOL_RESULT_TEXT,
  type ProviderState,
  type ToolSpec,
  type ToolTier,
  type ToolsStatus,
} from "../src/core/tools";
import {
  NONE,
  PORTS,
  PORT_NAMES,
  chooseInputOf,
  type PortName,
} from "../src/modules/contracts";
import {
  createModuleRegistry,
  toolResultBody,
  type ModuleBuiltins,
  type ModuleRegistryOptions,
} from "../src/modules/registry";
import {
  DECISIONS_ENDPOINT,
  JEV_MODEL,
  JEV_PROVIDER,
  JEV_SERVED_MODEL,
} from "../src/providers/jev";
import {
  CLAUSE_ACTS,
  CLAUSE_QUESTION,
  clauseOf,
  decideFast,
  decideFastWithJev,
  type FastContext,
  type JevAnswer,
  type JevClient,
  type JevQuestion,
} from "../src/voice/fast";
import { fakeTools, failed, ok } from "./tool-fakes";

// A module server "mods" with the four tools, as the tool layer would list them.
const modTool = (name: string, tier: ToolTier): ToolSpec => ({
  id: `mods__${name}`,
  provider: "mods",
  name,
  title: "Modules",
  does: `${name} for the assistant.`,
  params: "clause (object), context (object)",
  tier,
  trusted: false,
  local: true,
  openWorld: false,
  undoable: false,
  longRunning: false,
  transport: "stdio",
  timeoutMs: TOOL_LIMITS.callTimeoutMs,
  dateKeys: [],
  trace: { tool: "tabcdef012345", server: "sabcdef012345" },
});
const DECIDE = modTool("decide_clause", "read");
const OPEN = modTool("open_url", "write");
const SEGMENT = modTool("segment_clauses", "read");
const CHOOSE = modTool("choose", "read");
const MOD_TOOLS = [DECIDE, OPEN, SEGMENT, CHOOSE];

type ToolOver = Partial<{ on: boolean; tier: ToolTier; denied: boolean }>;
function status(
  over: { state?: ProviderState; tools?: Record<string, ToolOver> } = {},
): ToolsStatus {
  return {
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
        id: "mods",
        name: "Modules",
        transport: "stdio",
        recipe: "",
        argv: [],
        resolved: true,
        state: over.state ?? "on",
        trust: "ask",
        network: "none",
        sandboxed: true,
        disclaimed: false,
        toolCount: MOD_TOOLS.length,
        tools: MOD_TOOLS.map((spec) => ({
          name: spec.name,
          title: spec.title,
          description: "",
          tier: over.tools?.[spec.name]?.tier ?? spec.tier,
          on: over.tools?.[spec.name]?.on ?? true,
          changed: false,
          denied: over.tools?.[spec.name]?.denied ?? false,
        })),
      },
    ],
  };
}

const ctx = (o: Partial<FastContext> = {}): FastContext => ({
  protectedHosts: [...defaultSettings.protectedDomains],
  ...o,
});
const decideInput = (text: string, context = ctx()) => ({
  clause: clauseOf(text),
  context,
});
const YOUTUBE = {
  kind: "open_url",
  url: "https://www.youtube.com/",
  siteKey: "youtube",
  label: "YouTube",
} as const;
/** The line the tool registry writes for an MCP result, the write reminder included for a non-read tool. */
const resultLine = (spec: ToolSpec, body: string) =>
  TOOL_RESULT_TEXT.ok.replace("{id}", spec.id).replace("{body}", body) +
  (spec.tier === "read" ? "" : TOOL_RESULT_TEXT.mcp_write_verify);
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const HTTP = "https://modules.example/decide";
const LOCAL = "http://127.0.0.1:8787/decide";

interface Harness {
  modules?: Settings["modules"];
  privacy?: Settings["privacy"];
  status?: ToolsStatus;
  toolsOff?: boolean;
  listed?: ToolSpec[];
  fetch?: typeof fetch;
  builtin?: ModuleBuiltins;
  headers?: Record<string, string>;
  key?: string;
  now?: () => number;
}
function harness(o: Harness = {}) {
  const settings: Settings = {
    ...defaultSettings,
    privacy: o.privacy ?? defaultSettings.privacy,
    modules: o.modules ?? {},
  };
  const tools = fakeTools({ tools: o.listed ?? MOD_TOOLS });
  const traces: { event: string; data: Record<string, unknown> }[] = [];
  const builtinCalls: string[] = [];
  const builtin: ModuleBuiltins = o.builtin ?? {
    fastDecider: (input) => {
      builtinCalls.push("fastDecider");
      return decideFast(input.clause, input.context);
    },
    urlOpener: async () => {
      builtinCalls.push("urlOpener");
      return { navigated: true, method: "open" };
    },
  };
  const fetchSpy = vi.fn(
    o.fetch ??
      (async () => {
        throw new Error("no network in tests");
      }),
  );
  const options: ModuleRegistryOptions = {
    settings: () => settings,
    tools: {
      status: () => o.status ?? status(),
      access: () => (o.toolsOff ? undefined : tools.access),
    },
    credentials: {
      headers: (url) =>
        new URL(url).host === "modules.example" ? (o.headers ?? {}) : {},
      openRouterKey: () => o.key ?? "",
    },
    trace: (event, data) => traces.push({ event, data }),
    builtin,
    fetch: fetchSpy as unknown as typeof fetch,
    now: o.now,
  };
  const registry = createModuleRegistry(options);
  const events = (name: string) =>
    traces.filter((t) => t.event === name).map((t) => t.data);
  return { registry, tools, traces, events, builtinCalls, fetch: fetchSpy };
}
const mcp = (tool: string, fallback = true): Settings["modules"] => ({
  fastDecider: { kind: "mcp", server: "mods", tool, fallback },
});
const http = (url: string, fallback = true): Settings["modules"] => ({
  fastDecider: { kind: "http", url, fallback },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the built-in adapter", () => {
  it("is today's code, validated, traced and slow-marked past the budget", async () => {
    let t = 0;
    const h = harness({
      now: () => t,
      builtin: {
        fastDecider: (input) => {
          t += 300;
          return decideFast(input.clause, input.context);
        },
      },
    });
    const port = h.registry.port("fastDecider");
    expect(port.kind()).toBe("builtin");
    expect(await port.call(decideInput("go to youtube"))).toEqual(YOUTUBE);
    expect(h.events("ModuleCall")).toEqual([
      { port: "fastDecider", kind: "builtin", ms: 300, ok: true },
    ]);
    expect(h.events("ModuleSlow")).toEqual([
      { port: "fastDecider", kind: "builtin", ms: 300 },
    ]);
    expect(h.events("ModuleFallback")).toEqual([]);
    expect(h.registry.status().fastDecider).toEqual({
      kind: "builtin",
      lastCode: "ok",
      lastMs: 300,
      calls: 1,
      fallbacks: 0,
    });
  });

  it("answers NONE when there is no built-in, when it throws, and when its answer fails the schema", async () => {
    const none = harness({ builtin: {} });
    expect(
      await none.registry
        .port("fastDecider")
        .call(decideInput("go to youtube")),
    ).toEqual(NONE.fastDecider);
    expect(none.registry.status().fastDecider.lastCode).toBe("no_builtin");
    const throws = harness({
      builtin: {
        fastDecider: () => {
          throw new Error("boom");
        },
      },
    });
    expect(
      await throws.registry
        .port("fastDecider")
        .call(decideInput("go to youtube")),
    ).toEqual(NONE.fastDecider);
    expect(throws.registry.status().fastDecider.lastCode).toBe("builtin_error");
    const bad = harness({
      builtin: {
        fastDecider: () =>
          ({ kind: "open_url", url: "ftp://x/" }) as unknown as ReturnType<
            typeof decideFast
          >,
      },
    });
    expect(
      await bad.registry.port("fastDecider").call(decideInput("go to youtube")),
    ).toEqual(NONE.fastDecider);
    expect(bad.registry.status().fastDecider.lastCode).toBe(
      "builtin_bad_reply",
    );
    expect(bad.events("ModuleCall")).toEqual([
      { port: "fastDecider", kind: "builtin", ms: 0, ok: false },
    ]);
  });

  it("refuses an input that fails the port's schema before any adapter", async () => {
    const h = harness({ modules: http(HTTP), privacy: "PRIVATE_BYOM" });
    const input = decideInput("go to youtube") as Record<string, unknown>;
    expect(
      await h.registry
        .port("fastDecider")
        .call({ ...input, extra: 1 } as unknown as ReturnType<
          typeof decideInput
        >),
    ).toEqual(NONE.fastDecider);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.builtinCalls).toEqual([]);
    expect(h.registry.status().fastDecider.lastCode).toBe("bad_input");
  });
});

describe("the MCP adapter", () => {
  it("calls the ticked tool through the tool layer's door and parses its result", async () => {
    const h = harness({ modules: mcp("decide_clause") });
    const reply = {
      kind: "open_url",
      url: "https://www.youtube.com/results?search_query=midwest+safety",
    };
    h.tools.script(DECIDE.id, () => ok(DECIDE, JSON.stringify(reply)));
    const port = h.registry.port("fastDecider");
    expect(port.kind()).toBe("mcp");
    const input = decideInput("play a midwest safety video");
    expect(await port.call(input)).toEqual({
      ...reply,
      siteKey: "youtube.com",
      label: "youtube.com",
    });
    expect(h.tools.listCalls).toEqual(["decide clause"]);
    expect(h.tools.calls).toEqual([{ id: DECIDE.id, args: input }]);
    expect(h.builtinCalls).toEqual([]);
    expect(h.events("ModuleCall")).toEqual([
      { port: "fastDecider", kind: "mcp", ms: expect.any(Number), ok: true },
    ]);
    expect(h.registry.status().fastDecider).toMatchObject({
      kind: "mcp",
      target: "mods/decide_clause",
      lastCode: "ok",
      calls: 1,
      fallbacks: 0,
    });
  });

  it("reads a write tool's result line, reminder included, and lets an acting port use a write tool", async () => {
    const h = harness({
      modules: {
        urlOpener: {
          kind: "mcp",
          server: "mods",
          tool: "open_url",
          fallback: true,
        },
      },
    });
    const line = resultLine(OPEN, '{"navigated":true,"method":"navigate"}');
    expect(line.endsWith(TOOL_RESULT_TEXT.mcp_write_verify)).toBe(true);
    expect(toolResultBody(line)).toBe('{"navigated":true,"method":"navigate"}');
    expect(toolResultBody("No input was sent.")).toBeUndefined();
    h.tools.script(OPEN.id, () => ({
      ...failed(OPEN, "error"),
      code: "ok",
      text: line,
    }));
    expect(
      await h.registry
        .port("urlOpener")
        .call({ url: "https://www.youtube.com/", browser: "Safari" }),
    ).toEqual({ navigated: true, method: "navigate" });
    expect(h.builtinCalls).toEqual([]);
  });

  it("refuses a tool that is ticked off, denied, of a write tier for a port that never acts, on a server that is not on, or not listed", async () => {
    const cases: [string, Harness, string][] = [
      [
        "off",
        { status: status({ tools: { decide_clause: { on: false } } }) },
        "tool_off",
      ],
      [
        "denied",
        { status: status({ tools: { decide_clause: { denied: true } } }) },
        "denied",
      ],
      [
        "write",
        { status: status({ tools: { decide_clause: { tier: "write" } } }) },
        "tier_write",
      ],
      [
        "destructive",
        {
          status: status({ tools: { decide_clause: { tier: "destructive" } } }),
        },
        "tier_destructive",
      ],
      ["starting", { status: status({ state: "starting" }) }, "server_off"],
      ["off-server", { status: status({ state: "off" }) }, "server_off"],
      ["tools off", { toolsOff: true }, "tools_off"],
      ["not listed", { listed: [OPEN, SEGMENT] }, "not_listed"],
      [
        "listed write",
        { listed: [modTool("decide_clause", "write")] },
        "tier_write",
      ],
    ];
    for (const [name, over, code] of cases) {
      const h = harness({ ...over, modules: mcp("decide_clause") });
      h.tools.script(DECIDE.id, () => ok(DECIDE, JSON.stringify(YOUTUBE)));
      expect(
        await h.registry.port("fastDecider").call(decideInput("go to youtube")),
        name,
      ).toEqual(YOUTUBE);
      expect(h.tools.calls, name).toEqual([]);
      expect(h.builtinCalls, name).toEqual(["fastDecider"]);
      expect(h.events("ModuleFallback"), name).toEqual([
        { port: "fastDecider", kind: "mcp", code },
      ]);
      expect(h.registry.status().fastDecider, name).toMatchObject({
        lastCode: code,
        calls: 1,
        fallbacks: 1,
      });
    }
    const unknown = harness({ modules: mcp("decide_clause") });
    unknown.registry; // the server named is not connected at all
    const none = harness({
      modules: {
        fastDecider: {
          kind: "mcp",
          server: "other",
          tool: "decide_clause",
          fallback: true,
        },
      },
    });
    await none.registry.port("fastDecider").call(decideInput("go to youtube"));
    expect(none.events("ModuleFallback")).toEqual([
      { port: "fastDecider", kind: "mcp", code: "no_server" },
    ]);
  });

  it("falls back on a tool error, a result that is not JSON, and a reply that fails the schema", async () => {
    const replies: [string, () => ReturnType<typeof ok>, string][] = [
      ["error", () => failed(DECIDE, "error"), "error"],
      ["timeout", () => failed(DECIDE, "timeout"), "timeout"],
      ["prose", () => ok(DECIDE, "I would open YouTube."), "bad_json"],
      ["shape", () => ok(DECIDE, '{"kind":"open_url"}'), "bad_reply"],
      ["type", () => ok(DECIDE, '{"kind":"type","text":"hi"}'), "bad_reply"],
      [
        "credentials",
        () =>
          ok(DECIDE, '{"kind":"open_url","url":"https://a:b@youtube.com/"}'),
        "bad_reply",
      ],
      [
        "protected",
        () => ok(DECIDE, '{"kind":"open_url","url":"https://www.paypal.com/"}'),
        "protected_host",
      ],
      [
        "protected by the clause's own list",
        () =>
          ok(DECIDE, '{"kind":"open_url","url":"https://intranet.example/"}'),
        "protected_host",
      ],
    ];
    for (const [name, reply, code] of replies) {
      const h = harness({ modules: mcp("decide_clause") });
      h.tools.script(DECIDE.id, reply);
      const context =
        name === "protected by the clause's own list"
          ? ctx({ protectedHosts: ["intranet.example"] })
          : ctx();
      expect(
        await h.registry
          .port("fastDecider")
          .call(decideInput("go to youtube", context)),
        name,
      ).toEqual(YOUTUBE);
      expect(h.builtinCalls, name).toEqual(["fastDecider"]);
      expect(h.events("ModuleFallback"), name).toEqual([
        { port: "fastDecider", kind: "mcp", code },
      ]);
      expect(h.events("ModuleCall"), name).toEqual([
        { port: "fastDecider", kind: "mcp", ms: expect.any(Number), ok: false },
        {
          port: "fastDecider",
          kind: "builtin",
          ms: expect.any(Number),
          ok: true,
        },
      ]);
    }
  });

  it("answers NONE without the built-in when fallback is off", async () => {
    const h = harness({ modules: mcp("decide_clause", false) });
    h.tools.script(DECIDE.id, () => ok(DECIDE, "nonsense"));
    expect(
      await h.registry.port("fastDecider").call(decideInput("go to youtube")),
    ).toEqual(NONE.fastDecider);
    expect(h.builtinCalls).toEqual([]);
    expect(h.events("ModuleFallback")).toEqual([
      { port: "fastDecider", kind: "mcp", code: "bad_json" },
    ]);
    expect(h.registry.status().fastDecider.fallbacks).toBe(1);
  });

  it("cuts a call at the port's timeout and falls back", async () => {
    vi.useFakeTimers();
    const h = harness({ modules: mcp("decide_clause") });
    let aborted = false;
    h.tools.script(
      DECIDE.id,
      (_args, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const pending = h.registry
      .port("fastDecider")
      .call(decideInput("go to youtube"));
    await vi.advanceTimersByTimeAsync(PORTS.fastDecider.timeoutMs - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toEqual(YOUTUBE);
    expect(aborted).toBe(true);
    expect(h.events("ModuleFallback")).toEqual([
      { port: "fastDecider", kind: "mcp", code: "timeout" },
    ]);
    expect(h.events("ModuleCall")[0]).toMatchObject({
      kind: "mcp",
      ok: false,
      ms: PORTS.fastDecider.timeoutMs,
    });
  });

  it("answers cancelled for a signal already aborted", async () => {
    const h = harness({ modules: mcp("decide_clause", false) });
    h.tools.script(DECIDE.id, () => ok(DECIDE, JSON.stringify(YOUTUBE)));
    const controller = new AbortController();
    controller.abort();
    expect(
      await h.registry
        .port("fastDecider")
        .call(decideInput("go to youtube"), controller.signal),
    ).toEqual(NONE.fastDecider);
    expect(h.events("ModuleFallback")).toEqual([
      { port: "fastDecider", kind: "mcp", code: "cancelled" },
    ]);
  });
});

describe("the HTTP adapter", () => {
  it("posts the input as JSON with the vault's headers for the host and reads the reply", async () => {
    const h = harness({
      modules: http(HTTP),
      privacy: "PRIVATE_BYOM",
      headers: { "X-Api-Key": "vault-value" },
      fetch: async () =>
        json({ kind: "open_url", url: "https://www.youtube.com/" }),
    });
    const input = decideInput("go to youtube");
    expect(await h.registry.port("fastDecider").call(input)).toEqual({
      kind: "open_url",
      url: "https://www.youtube.com/",
      siteKey: "youtube.com",
      label: "youtube.com",
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HTTP);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Api-Key": "vault-value",
    });
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.registry.status().fastDecider).toMatchObject({
      kind: "http",
      target: HTTP,
      lastCode: "ok",
    });
  });

  it("sends nothing to the internet in Private local, but reaches a loopback endpoint", async () => {
    const remote = harness({
      modules: http(HTTP),
      fetch: async () => json(YOUTUBE),
    });
    expect(
      await remote.registry
        .port("fastDecider")
        .call(decideInput("go to youtube")),
    ).toEqual(YOUTUBE);
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(remote.events("ModuleFallback")).toEqual([
      { port: "fastDecider", kind: "http", code: "privacy" },
    ]);
    expect(remote.builtinCalls).toEqual(["fastDecider"]);
    const local = harness({
      modules: http(LOCAL),
      fetch: async () => json({ kind: "scroll", direction: "up" }),
    });
    expect(
      await local.registry
        .port("fastDecider")
        .call(decideInput("go to youtube")),
    ).toEqual({ kind: "scroll", direction: "up" });
    expect(local.fetch).toHaveBeenCalledTimes(1);
    expect(local.builtinCalls).toEqual([]);
  });

  it("falls back on a status, a body that is not JSON, a network error, a bad reply and a protected host", async () => {
    const cases: [string, () => Promise<Response>, string][] = [
      ["500", async () => json({ error: "x" }, { status: 500 }), "http_500"],
      ["401", async () => json({}, { status: 401 }), "http_401"],
      ["html", async () => new Response("<html>", { status: 200 }), "bad_json"],
      [
        "network",
        async () => {
          throw new TypeError("fetch failed");
        },
        "network",
      ],
      ["reply", async () => json({ kind: "none" }), "bad_reply"],
      [
        "protected",
        async () => json({ kind: "open_url", url: "https://login.gov/" }),
        "protected_host",
      ],
    ];
    for (const [name, fetch, code] of cases) {
      const h = harness({
        modules: http(HTTP),
        privacy: "PRIVATE_BYOM",
        fetch,
      });
      expect(
        await h.registry.port("fastDecider").call(decideInput("go to youtube")),
        name,
      ).toEqual(YOUTUBE);
      expect(h.events("ModuleFallback"), name).toEqual([
        { port: "fastDecider", kind: "http", code },
      ]);
    }
  });

  it("times out at the port's budget", async () => {
    vi.useFakeTimers();
    const h = harness({
      modules: http(HTTP, false),
      privacy: "PRIVATE_BYOM",
      fetch: (_url, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    });
    const pending = h.registry
      .port("fastDecider")
      .call(decideInput("go to youtube"));
    await vi.advanceTimersByTimeAsync(PORTS.fastDecider.timeoutMs + 1);
    expect(await pending).toEqual(NONE.fastDecider);
    expect(h.events("ModuleFallback")).toEqual([
      { port: "fastDecider", kind: "http", code: "timeout" },
    ]);
  });
});

describe("the floors, before any adapter", () => {
  it("answers a consequential clause and a credential itself", async () => {
    const h = harness({ modules: http(HTTP), privacy: "PRIVATE_BYOM" });
    const port = h.registry.port("fastDecider");
    expect(await port.call(decideInput("and send it to dana"))).toEqual({
      kind: "none",
      reason: "not_navigational",
    });
    expect(h.registry.status().fastDecider.lastCode).toBe("consequential");
    expect(
      await port.call(decideInput("search google for me@example.com")),
    ).toEqual({ kind: "none", reason: "needs_final" });
    expect(h.registry.status().fastDecider.lastCode).toBe("credential");
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.builtinCalls).toEqual([]);
    expect(h.events("ModuleCall")).toEqual([
      { port: "fastDecider", kind: "http", ms: 0, ok: false },
      { port: "fastDecider", kind: "http", ms: 0, ok: false },
    ]);
    expect(h.events("ModuleFallback")).toEqual([]);
  });

  it("refuses to open a protected host whoever would open it", async () => {
    const h = harness({
      modules: {
        urlOpener: {
          kind: "mcp",
          server: "mods",
          tool: "open_url",
          fallback: true,
        },
      },
    });
    h.tools.script(OPEN.id, () => ok(OPEN, '{"navigated":true,"method":"x"}'));
    expect(
      await h.registry
        .port("urlOpener")
        .call({ url: "https://www.chase.com/login" }),
    ).toEqual({ navigated: false, method: "refused" });
    expect(h.tools.calls).toEqual([]);
    expect(h.builtinCalls).toEqual([]);
    expect(h.registry.status().urlOpener.lastCode).toBe("protected_host");
    const builtin = harness();
    expect(
      await builtin.registry
        .port("urlOpener")
        .call({ url: "https://paypal.com/" }),
    ).toEqual({ navigated: false, method: "refused" });
    expect(builtin.builtinCalls).toEqual([]);
    expect(
      await builtin.registry
        .port("urlOpener")
        .call({ url: "https://www.youtube.com/" }),
    ).toEqual({ navigated: true, method: "open" });
  });
});

describe("the choice model", () => {
  const answer = (choice: string, p = 0.9): JevAnswer => ({
    choice,
    probabilities: Object.fromEntries(
      CLAUSE_ACTS.map((act) => [act, act === choice ? p : 0.02]),
    ),
    confidence: p,
  });
  const jevClient = (reply: JevAnswer | undefined) => {
    const ask = vi.fn(
      async (_question: JevQuestion, _state: object, _signal?: AbortSignal) =>
        reply,
    );
    const client: JevClient = { ask };
    return { client, ask };
  };
  const state = {
    clause: "fire up slack",
    frontApp: null,
    frontHost: null,
    browser: null,
  };

  it("is served by the Jev client shape as its built-in", async () => {
    const { client, ask } = jevClient(answer("open_app"));
    const h = harness({ builtin: { choiceModel: client } });
    const input = chooseInputOf("clause", CLAUSE_QUESTION, state);
    expect(await h.registry.port("choiceModel").call(input)).toEqual({
      choice: "open_app",
      p: 0.9,
      probabilities: answer("open_app").probabilities,
      confidence: 0.9,
    });
    expect(ask).toHaveBeenCalledWith(CLAUSE_QUESTION, state, undefined);
    expect(h.registry.status().choiceModel).toMatchObject({
      kind: "builtin",
      lastCode: "ok",
      calls: 1,
    });
    // No answer is the port's none: undefined, as JevClient.ask has it.
    const silent = harness({
      builtin: { choiceModel: jevClient(undefined).client },
    });
    expect(
      await silent.registry.port("choiceModel").call(input),
    ).toBeUndefined();
    expect(silent.registry.status().choiceModel.lastCode).toBe("none");
  });

  it("serves the decider's JevClient through the port", async () => {
    const { client, ask } = jevClient(answer("open_app"));
    const h = harness({ builtin: { choiceModel: client } });
    const decided = await decideFastWithJev(
      clauseOf("fire up slack"),
      ctx(),
      h.registry.jevClient("clause"),
    );
    expect(decided).toEqual({ kind: "open_app", name: "slack" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual(CLAUSE_QUESTION);
  });

  it("asks another model on OpenRouter's Decisions wire with zero data retention and the vault's key", async () => {
    const fetch = vi.fn(async () =>
      json({
        model: "acme/chooser-1-20260901",
        provider: "Acme",
        answers: {
          clause: {
            type: "choice",
            choice: "search_on_site",
            probabilities: { search_on_site: 0.91 },
            confidence: 0.91,
          },
        },
      }),
    );
    const h = harness({
      modules: {
        choiceModel: {
          kind: "openrouter",
          model: "acme/chooser-1",
          fallback: true,
        },
      },
      privacy: "PRIVATE_BYOM",
      key: "sk-or-test",
      fetch,
      builtin: { choiceModel: jevClient(answer("open_app")).client },
    });
    const input = chooseInputOf("clause", CLAUSE_QUESTION, state);
    const out = await h.registry.port("choiceModel").call(input);
    expect(out).toMatchObject({ choice: "search_on_site", p: 0.91 });
    expect(out!.probabilities).toMatchObject({
      search_on_site: 0.91,
      open_app: 0,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DECISIONS_ENDPOINT);
    expect(init.headers).toEqual({
      Authorization: "Bearer sk-or-test",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("acme/chooser-1");
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      allow_fallbacks: false,
    });
    expect(body.state).toEqual(state);
    expect(body.questions.clause).toEqual(CLAUSE_QUESTION);
    expect(h.registry.status().choiceModel).toMatchObject({
      kind: "openrouter",
      target: "acme/chooser-1",
      lastCode: "ok",
    });
    // The bridge gives the decider a full Jev answer over the acts asked.
    const viaClient = await h.registry
      .jevClient("clause")
      .ask(CLAUSE_QUESTION, state);
    expect(viaClient).toEqual({
      choice: "search_on_site",
      probabilities: Object.fromEntries(
        CLAUSE_ACTS.map((act) => [act, act === "search_on_site" ? 0.91 : 0]),
      ),
      confidence: 0.91,
    });
  });

  it("falls back to Jev on a wrong model, no key, Private local, and holds Jev's own pin when Jev is the model", async () => {
    const jev = jevClient(answer("open_app"));
    const input = chooseInputOf("clause", CLAUSE_QUESTION, state);
    const cases: [string, Harness, string][] = [
      [
        "wrong model",
        {
          privacy: "PRIVATE_BYOM",
          key: "k",
          fetch: async () =>
            json({
              model: "other/model",
              answers: {
                clause: {
                  type: "choice",
                  choice: "open_app",
                  probabilities: { open_app: 1 },
                },
              },
            }),
        },
        "wrong_model",
      ],
      [
        "no key",
        { privacy: "PRIVATE_BYOM", fetch: async () => json({}) },
        "no_key",
      ],
      ["private local", { key: "k", fetch: async () => json({}) }, "privacy"],
      [
        "429",
        {
          privacy: "PRIVATE_BYOM",
          key: "k",
          fetch: async () => json({}, { status: 429 }),
        },
        "http_429",
      ],
      [
        "not an option",
        {
          privacy: "PRIVATE_BYOM",
          key: "k",
          fetch: async () =>
            json({
              model: "acme/chooser-1",
              answers: {
                clause: {
                  type: "choice",
                  choice: "start",
                  probabilities: { start: 1 },
                },
              },
            }),
        },
        "bad_choice",
      ],
    ];
    for (const [name, over, code] of cases) {
      const h = harness({
        ...over,
        modules: {
          choiceModel: {
            kind: "openrouter",
            model: "acme/chooser-1",
            fallback: true,
          },
        },
        builtin: { choiceModel: jev.client },
      });
      expect(
        await h.registry.port("choiceModel").call(input),
        name,
      ).toMatchObject({
        choice: "open_app",
        p: 0.9,
      });
      expect(h.events("ModuleFallback"), name).toEqual([
        { port: "choiceModel", kind: "openrouter", code },
      ]);
    }
    // Jev by this route keeps the provider and build pin: a body without the header is a wrong provider.
    const pinned = harness({
      modules: {
        choiceModel: { kind: "openrouter", model: JEV_MODEL, fallback: false },
      },
      privacy: "PRIVATE_BYOM",
      key: "k",
      fetch: async () =>
        json({
          model: JEV_SERVED_MODEL,
          provider: JEV_PROVIDER,
          answers: {
            clause: {
              type: "choice",
              choice: "open_app",
              probabilities: { open_app: 1 },
            },
          },
        }),
      builtin: { choiceModel: jev.client },
    });
    expect(
      await pinned.registry.port("choiceModel").call(input),
    ).toBeUndefined();
    expect(pinned.events("ModuleFallback")).toEqual([
      { port: "choiceModel", kind: "openrouter", code: "wrong_provider" },
    ]);
    // An openrouter choice on any other port is refused before anything is sent.
    const misplaced = harness({
      modules: { fastDecider: { kind: "http", url: HTTP, fallback: true } },
    });
    expect(misplaced.registry.port("fastDecider").kind()).toBe("http");
  });

  it("refuses an http choice that was not asked", async () => {
    const h = harness({
      modules: { choiceModel: { kind: "http", url: HTTP, fallback: false } },
      privacy: "PRIVATE_BYOM",
      fetch: async () => json({ choice: "start", p: 0.99 }),
    });
    expect(
      await h.registry
        .port("choiceModel")
        .call(chooseInputOf("clause", CLAUSE_QUESTION, state)),
    ).toBeUndefined();
    expect(h.events("ModuleFallback")).toEqual([
      { port: "choiceModel", kind: "http", code: "bad_choice" },
    ]);
  });
});

describe("status and traces", () => {
  it("reports every port with its adapter, target, last code, latency and counters", async () => {
    const h = harness({
      modules: {
        fastDecider: { kind: "http", url: HTTP, fallback: true },
        urlOpener: {
          kind: "mcp",
          server: "mods",
          tool: "open_url",
          fallback: true,
        },
        choiceModel: {
          kind: "openrouter",
          model: "acme/chooser-1",
          fallback: true,
        },
      },
      privacy: "PRIVATE_BYOM",
      fetch: async () => json({ kind: "none" }),
    });
    const before = h.registry.status();
    expect(Object.keys(before).sort()).toEqual([...PORT_NAMES].sort());
    expect(before.tts).toEqual({ kind: "builtin", calls: 0, fallbacks: 0 });
    expect(before.clauseSegmenter).toEqual({
      kind: "builtin",
      calls: 0,
      fallbacks: 0,
    });
    expect(before.urlOpener).toEqual({
      kind: "mcp",
      target: "mods/open_url",
      server: "mods",
      tool: "open_url",
      fallback: true,
      calls: 0,
      fallbacks: 0,
    });
    expect(before.choiceModel).toMatchObject({
      kind: "openrouter",
      target: "acme/chooser-1",
    });
    await h.registry.port("fastDecider").call(decideInput("go to youtube"));
    await h.registry.port("fastDecider").call(decideInput("go to youtube"));
    expect(h.registry.status().fastDecider).toEqual({
      kind: "http",
      url: "https://modules.example/decide",
      fallback: true,
      target: HTTP,
      lastCode: "bad_reply",
      lastMs: expect.any(Number),
      calls: 2,
      fallbacks: 2,
    });
  });

  it("traces codes, numbers and flags only, and the diagnostics allow-list keeps each event's own keys", async () => {
    const h = harness({
      modules: mcp("decide_clause"),
      status: status({ tools: { decide_clause: { on: false } } }),
    });
    await h.registry.port("fastDecider").call(decideInput("go to youtube"));
    const allowed: Record<string, string[]> = {
      ModuleCall: ["port", "kind", "ms", "ok"],
      ModuleFallback: ["port", "kind", "code"],
      ModuleSlow: ["port", "kind", "ms"],
    };
    expect(h.traces.length).toBeGreaterThan(1);
    for (const { event, data } of h.traces) {
      expect(Object.keys(allowed)).toContain(event);
      expect(Object.keys(data).sort()).toEqual([...allowed[event]].sort());
      expect(PORT_NAMES).toContain(data.port as PortName);
      expect(["builtin", "mcp", "http", "openrouter"]).toContain(data.kind);
      if ("code" in data)
        expect(data.code).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
      if ("ms" in data) expect(typeof data.ms).toBe("number");
      if ("ok" in data) expect(typeof data.ok).toBe("boolean");
    }
    const directory = mkdtempSync(join(tmpdir(), "assist-modules-"));
    try {
      const log = new LocalDiagnostics(
        directory,
        () => [],
        () => {},
      );
      log.write("ModuleFallback", {
        port: "fastDecider",
        kind: "mcp",
        code: "tool_off",
        url: HTTP,
        server: "mods",
      });
      log.write("ModuleSlow", {
        port: "tts",
        kind: "http",
        ms: 12000,
        text: "hello",
      });
      log.write("ModuleCall", {
        port: "urlOpener",
        kind: "builtin",
        ms: 40,
        ok: true,
        label: "x",
      });
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => l.data)).toEqual([
        { port: "fastDecider", kind: "mcp", code: "tool_off" },
        { port: "tts", kind: "http", ms: 12000 },
        { port: "urlOpener", kind: "builtin", ms: 40, ok: true },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("settings.modules", () => {
  const parse = (modules: unknown) =>
    settingsSchema.safeParse({ ...defaultSettings, modules });
  it("defaults to every built-in, for a fresh and a stored config alike", () => {
    expect(defaultSettings.modules).toEqual({});
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    delete legacy.modules;
    expect(settingsSchema.parse(legacy).modules).toEqual({});
    expect(parse({}).success).toBe(true);
    expect(
      settingsSchema.parse({
        ...defaultSettings,
        modules: {
          fastDecider: { kind: "builtin" },
          choiceModel: { kind: "jev" },
          recognizer: { kind: "builtin" },
        },
      }).modules,
    ).toEqual({
      fastDecider: { kind: "builtin" },
      choiceModel: { kind: "jev" },
      recognizer: { kind: "builtin" },
    });
  });

  it("accepts a ticked tool with fallback on by default, and never a shell", () => {
    const parsed = settingsSchema.parse({
      ...defaultSettings,
      modules: {
        fastDecider: { kind: "mcp", server: "mods", tool: "decide_clause" },
      },
    });
    expect(parsed.modules.fastDecider).toEqual({
      kind: "mcp",
      server: "mods",
      tool: "decide_clause",
      fallback: true,
    });
    expect(
      parse({
        tts: { kind: "mcp", server: "mods", tool: "speak", fallback: false },
      }).success,
    ).toBe(true);
    expect(
      parse({
        fastDecider: { kind: "mcp", server: "Mods", tool: "decide_clause" },
      }).success,
    ).toBe(false);
    expect(
      parse({ fastDecider: { kind: "mcp", server: "mods", tool: "bash" } })
        .success,
    ).toBe(false);
    expect(
      parse({ fastDecider: { kind: "mcp", server: "mods" } }).success,
    ).toBe(false);
  });

  it("accepts an https endpoint or http to this Mac, and refuses the rest", () => {
    for (const url of [
      "https://modules.example/decide",
      "https://modules.example:8443/v1/decide?x=1",
      "http://127.0.0.1:8787/decide",
      "http://localhost:3000/decide",
      "http://[::1]:3000/decide",
    ])
      expect(parse({ fastDecider: { kind: "http", url } }).success, url).toBe(
        true,
      );
    for (const url of [
      "http://modules.example/decide",
      "http://10.0.0.5/decide",
      "https://user:pw@modules.example/decide",
      "https://modules.example/decide#frag",
      "ftp://modules.example/decide",
      "modules.example",
      "",
    ])
      expect(parse({ fastDecider: { kind: "http", url } }).success, url).toBe(
        false,
      );
    expect(
      parse({
        urlOpener: {
          kind: "http",
          url: "https://o.example/open",
          fallback: false,
        },
      }).success,
    ).toBe(true);
    expect(moduleEndpoint("https://a.example/x")?.hostname).toBe("a.example");
    expect(moduleEndpoint("http://a.example/x")).toBeUndefined();
    expect(loopbackHost("127.0.0.1")).toBe(true);
    expect(loopbackHost("LOCALHOST")).toBe(true);
    expect(loopbackHost("127.evil.example")).toBe(false);
  });

  it("takes the choice model as jev, an OpenRouter model id, an endpoint or a tool", () => {
    const choice = (choiceModel: unknown) => parse({ choiceModel });
    expect(
      settingsSchema.parse({
        ...defaultSettings,
        modules: {
          choiceModel: { kind: "openrouter", model: "acme/chooser-1" },
        },
      }).modules.choiceModel,
    ).toEqual({ kind: "openrouter", model: "acme/chooser-1", fallback: true });
    expect(choice({ kind: "openrouter", model: "chooser" }).success).toBe(
      false,
    );
    expect(choice({ kind: "openrouter" }).success).toBe(false);
    expect(
      choice({ kind: "http", url: "https://c.example/choose" }).success,
    ).toBe(true);
    expect(
      choice({ kind: "mcp", server: "mods", tool: "choose" }).success,
    ).toBe(true);
    expect(choice({ kind: "builtin" }).success).toBe(false);
  });

  it("takes a recognizer command by absolute path only", () => {
    expect(
      settingsSchema.parse({
        ...defaultSettings,
        modules: {
          recognizer: {
            kind: "command",
            command: "/usr/local/bin/whisper-stream",
          },
        },
      }).modules.recognizer,
    ).toEqual({
      kind: "command",
      command: "/usr/local/bin/whisper-stream",
      args: [],
    });
    expect(
      parse({
        recognizer: {
          kind: "command",
          command: "/opt/rec",
          args: ["--model", "small"],
        },
      }).success,
    ).toBe(true);
    for (const command of [
      "whisper-stream",
      "./rec",
      "~/rec",
      "",
      "/bin/rec\nrm -rf",
    ])
      expect(
        parse({ recognizer: { kind: "command", command } }).success,
        command,
      ).toBe(false);
    expect(
      parse({ recognizer: { kind: "mcp", server: "mods", tool: "listen" } })
        .success,
    ).toBe(false);
  });

  it("refuses a port it does not know and a kind a port does not take", () => {
    expect(parse({ appOpener: { kind: "builtin" } }).success).toBe(false);
    expect(parse({ fastDecider: { kind: "jev" } }).success).toBe(false);
    expect(
      parse({ fastDecider: { kind: "openrouter", model: "a/b" } }).success,
    ).toBe(false);
    expect(
      parse({ fastDecider: { kind: "builtin", fallback: true } }).success,
    ).toBe(false);
  });
});
