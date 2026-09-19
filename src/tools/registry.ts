import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import type { Settings, ToolServer } from "../core/schema";
import {
  TOOL_DENYLIST,
  TOOL_LIMITS,
  toolsAllowed,
  type AccessState,
  type AppleConsent,
  type BuiltinServer,
  type ProviderResult,
  type ProviderState,
  type ServerRecipe,
  type ToolAccess,
  type ToolClock,
  type ToolList,
  type ToolOutcome,
  type ToolPrepared,
  type ToolSpec,
  type ToolTier,
  type ToolUnavailable,
  type ToolsStatus,
} from "../core/tools";
import { toolClock } from "./clock";
import {
  createMcpProvider,
  type McpProvider,
  type ProviderSource,
  type ServerSource,
} from "./mcp";
import { commandHash, secretsDigest } from "./pins";
import { BUILTIN_SERVERS, RECIPES } from "./providers";
import { resolveCommand, type ResolveFs } from "./resolve";
import { resultLines, resultText, sanitizeResult } from "./result";

/**
 * Every tool a run may call, behind one door (src/core/tools.ts ToolAccess):
 * the first-party bridges (BUILTIN_SERVERS) first, then the user's own
 * servers, each a long-lived McpProvider the registry starts and stops as
 * settings change. The registry decides what is usable (consent, approval,
 * privacy, a resolvable command), ranks and caps what the model sees,
 * validates arguments before policy, and bounds every result before the
 * model reads it. Nothing here throws into a run.
 */
export interface RegistryOptions {
  settings: () => Settings;
  /** One server's vault secrets (electron/credentials.ts toolSecrets), read at spawn or connect. */
  credentials: (id: string) => {
    env: Record<string, string>;
    headers: Record<string, string>;
  };
  /** The absolute path of a first-party helper binary by name. */
  helper: (name: string) => string;
  /** The coarena-launch shim when the build has it. */
  launch: () => string | undefined;
  home: string;
  version: string;
  trace?: (event: string, data: Record<string, unknown>) => void;
  clock?: () => ToolClock;
  /** Runs a helper's one-shot command (status, request <consent>) and returns its stdout. */
  exec?: (binary: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Saves the first ticks of a server that just listed its tools (the recipe's defaults, pinned). */
  onTicks?: (id: string, tools: ToolServer["tools"]) => void;
  fs?: ResolveFs;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Tests: fake providers and tables in place of the MCP client and src/tools/providers. */
  createProvider?: typeof createMcpProvider;
  builtin?: readonly BuiltinServer[];
  recipes?: readonly ServerRecipe[];
}
export interface ToolServerTest {
  ok: boolean;
  toolCount: number;
  argv: string[];
  tools: {
    name: string;
    description: string;
    tier: ToolTier;
    denied: boolean;
  }[];
  code?: string;
}
export type AppleAccess = Record<AppleConsent, AccessState>;
export interface ToolRegistry {
  clock(): ToolClock;
  /** The run's door; undefined for practice runs and when tools are off. */
  access(o: { synthetic: boolean }): ToolAccess | undefined;
  /** Starts and stops providers to match settings; safe to call often. */
  configure(): Promise<void>;
  status(): ToolsStatus;
  /** The exact argv a stdio row runs as ([] for HTTP), for the consent sheet. */
  argv(row: ToolServer): string[];
  /** What approving a row pins (approvedCommand). */
  approval(row: ToolServer): string;
  /** The row's ticks after ticking one tool at its current pin. */
  tick(id: string, tool: string, on: boolean): ToolServer["tools"];
  /** Connects once, lists, disconnects: the consent sheet's preview. */
  test(id: string): Promise<ToolServerTest>;
  retry(id: string): Promise<void>;
  /** Re-reads what macOS has granted the Apple bridge; never prompts. */
  appleAccess(): Promise<AppleAccess>;
  /** Asks macOS for one grant; the only prompting call (Settings window only). */
  requestApple(consent: AppleConsent): Promise<AppleAccess>;
  /** Closes one server's process (forget or disable). */
  forget(id: string): Promise<void>;
  undoLast(signal: AbortSignal): Promise<ToolOutcome | undefined>;
  closeAll(): Promise<void>;
}

const ACCESS_STATES = new Set<AccessState>([
  "granted",
  "denied",
  "restricted",
  "notDetermined",
]);
const UNKNOWN_ACCESS: AppleAccess = {
  calendar: "unknown",
  reminders: "unknown",
  notes: "unknown",
  mail: "unknown",
};
const CONSENTS: AppleConsent[] = ["calendar", "reminders", "notes", "mail"];
const STOP_WORDS = new Set(
  "the a an and or of to in on for with my me is are was what whats which show list open please can you".split(
    " ",
  ),
);
const usable = (state: ProviderState) => state === "on" || state === "changed";
const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
const defaultExec = (binary: string, args: string[], timeoutMs: number) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  );
/** The helper's {"access": {…}} line, field by field; anything malformed reads as unknown. */
export function parseAppleAccess(stdout: string): AppleAccess {
  let access: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.access &&
      typeof parsed.access === "object"
    )
      access = parsed.access as Record<string, unknown>;
  } catch {
    /* Malformed output is treated as nothing granted. */
  }
  return Object.fromEntries(
    CONSENTS.map((consent) => [
      consent,
      ACCESS_STATES.has(access[consent] as AccessState)
        ? (access[consent] as AccessState)
        : "unknown",
    ]),
  ) as AppleAccess;
}
/** Why a configured row cannot start right now, or the source it starts from. */
type Startable =
  | { ok: true; source: ServerSource }
  | { ok: false; state: ProviderState; code?: string };

export function createToolRegistry(o: RegistryOptions): ToolRegistry {
  const now = o.now ?? Date.now;
  const exec = o.exec ?? defaultExec;
  const clock = o.clock ?? (() => toolClock());
  const createProvider = o.createProvider ?? createMcpProvider;
  const builtinServers = o.builtin ?? BUILTIN_SERVERS;
  const recipes = o.recipes ?? RECIPES;
  const trace = (event: string, data: Record<string, unknown> = {}) => {
    try {
      o.trace?.(event, data);
    } catch {}
  };
  const providers = new Map<
    string,
    { provider: McpProvider; signature: string }
  >();
  /** One call in flight per server: later calls queue behind the first. */
  const inFlight = new Map<string, Promise<unknown>>();
  const undos: { token: string; spec: ToolSpec; expiresAt: number }[] = [];
  let appleAccess: AppleAccess = UNKNOWN_ACCESS;

  const row = (id: string) =>
    o.settings().tools.servers.find((r) => r.id === id);
  const recipeOf = (r: ToolServer) =>
    recipes.find((recipe) => recipe.id === r.recipe);
  const resolved = (r: ToolServer) =>
    r.transport === "stdio" ? resolveCommand(r.command, o.home, o.fs) : {};
  const argv = (r: ToolServer): string[] => {
    if (r.transport !== "stdio") return [];
    const command = resolved(r).path ?? r.command;
    const launch = o.launch();
    return launch
      ? [
          launch,
          ...(r.network === "none" ? ["--no-network"] : []),
          "--",
          command,
          ...r.args,
        ]
      : [command, ...r.args];
  };
  const approval = (r: ToolServer) =>
    commandHash({
      argv: argv(r),
      cwd: r.cwd,
      envNames: [...Object.keys(r.env), ...r.secretEnv],
      url: r.url,
    });
  const source = (r: ToolServer): ServerSource => ({
    kind: "server",
    row: r,
    recipe: recipeOf(r),
    command: resolved(r).path,
    launch: r.transport === "stdio" ? o.launch() : undefined,
    secrets: o.credentials(r.id),
  });
  /**
   * The privacy gate (contract §2.4) for one row: in Private local only a
   * stdio server declared network "none" and started under the sandbox may
   * run, or even be connected to for a preview.
   */
  const blockedLocal = (r: ToolServer, s: Settings) =>
    s.privacy === "PRIVATE_LOCAL" &&
    (r.transport === "http" || r.network !== "none" || !o.launch());
  const startable = (r: ToolServer, s: Settings): Startable => {
    if (!s.tools.enabled || !r.enabled) return { ok: false, state: "off" };
    if (!r.consented || r.approvedCommand !== approval(r))
      return { ok: false, state: "needs_approval" };
    if (r.transport === "http") {
      if (blockedLocal(r, s)) return { ok: false, state: "blocked_local" };
      const headers = o.credentials(r.id).headers;
      if (r.secretHeaders.some((name) => !headers[name]))
        return { ok: false, state: "needs_sign_in" };
      return { ok: true, source: source(r) };
    }
    const found = resolved(r);
    if (!found.path)
      return { ok: false, state: "needs_install", code: found.code };
    if (blockedLocal(r, s)) return { ok: false, state: "blocked_local" };
    return { ok: true, source: source(r) };
  };
  /** The consents that are on and granted: what the Apple bridge may list. */
  const consents = () => {
    const apple = o.settings().tools.apple;
    return new Set(
      CONSENTS.filter((c) => apple[c] && appleAccess[c] === "granted"),
    );
  };
  const create = (
    src: ProviderSource,
    extra: Partial<Parameters<typeof createMcpProvider>[1]> = {},
  ) =>
    createProvider(src, {
      home: o.home,
      version: o.version,
      trace,
      fs: o.fs,
      now,
      setTimer: o.setTimer,
      clearTimer: o.clearTimer,
      ...(src.kind === "server"
        ? { ticks: () => row(src.row.id)?.tools ?? {} }
        : { consents }),
      ...extra,
    });
  /**
   * What a running provider was built from; a change restarts it. Secrets
   * enter as a content-free digest, so a rotated token reaches a server that
   * read its environment once or set its headers at connect.
   */
  const signatureOf = (src: ProviderSource) =>
    src.kind === "builtin"
      ? JSON.stringify([src.helper, src.server.args])
      : JSON.stringify([
          approval(src.row),
          src.row.trust,
          src.row.network,
          src.command,
          src.launch,
          secretsDigest(src.secrets),
        ]);
  const stop = async (id: string) => {
    const running = providers.get(id);
    if (!running) return;
    providers.delete(id);
    await running.provider.close();
  };
  const ensure = async (id: string, wanted: ProviderSource | undefined) => {
    const running = providers.get(id);
    const signature = wanted ? signatureOf(wanted) : "";
    if (running && (!wanted || running.signature !== signature)) await stop(id);
    if (!wanted || providers.has(id)) return;
    const provider = create(wanted, {
      onStarted: () => {
        if (wanted.kind !== "server") return;
        // The recipe's default tools are ticked at their first listing;
        // everything else stays off until the user ticks it.
        const current = row(wanted.row.id);
        if (!current || Object.keys(current.tools).length) return;
        const defaults = new Set(wanted.recipe?.defaultTools ?? []);
        const ticks: ToolServer["tools"] = {};
        for (const entry of provider.catalog())
          if (defaults.has(entry.name) && !entry.denied)
            ticks[entry.name] = {
              on: true,
              pin: provider.pinOf(entry.name) ?? "",
            };
        if (Object.keys(ticks).length) o.onTicks?.(wanted.row.id, ticks);
      },
    });
    providers.set(id, { provider, signature });
    void provider.start();
  };
  const readAppleAccess = async (server: BuiltinServer) => {
    try {
      appleAccess = parseAppleAccess(
        await exec(o.helper(server.helper), ["status"], 3_000),
      );
    } catch {
      appleAccess = UNKNOWN_ACCESS;
    }
    return appleAccess;
  };
  const configure = async () => {
    const s = o.settings();
    const wanted = new Set<string>();
    for (const server of builtinServers) {
      const on = s.tools.enabled && CONSENTS.some((c) => s.tools.apple[c]);
      if (on) await readAppleAccess(server);
      const src: ProviderSource | undefined =
        on && consents().size
          ? { kind: "builtin", server, helper: o.helper(server.helper) }
          : undefined;
      if (src) wanted.add(server.id);
      await ensure(server.id, src);
    }
    for (const r of s.tools.servers) {
      const check = startable(r, s);
      if (check.ok) wanted.add(r.id);
      await ensure(r.id, check.ok ? check.source : undefined);
    }
    for (const id of [...providers.keys()]) if (!wanted.has(id)) await stop(id);
  };

  const outcome = (
    spec: ToolSpec,
    result: ProviderResult,
    startedAt: number,
  ): ToolOutcome => {
    const body = sanitizeResult(result.raw, result.items);
    return {
      code: result.code,
      text: resultText(spec, result.code, {
        body: body.text,
        verified: result.verified,
      }),
      resultBytes: body.bytes,
      resultItems: body.items,
      durationMs: now() - startedAt,
      ...(result.lines ? { lines: resultLines(result.lines) } : {}),
      ...(result.verified !== undefined ? { verified: result.verified } : {}),
      ...(result.facts ? { facts: result.facts } : {}),
      ...(result.undoToken ? { undoToken: result.undoToken } : {}),
    };
  };
  const refusal = (
    spec: ToolSpec,
    code: ToolOutcome["code"],
    startedAt: number,
  ) => outcome(spec, { code, raw: "", items: 0 }, startedAt);
  const serialised = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = inFlight.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    inFlight.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  };
  /** A provider's tool list, or nothing once the run's budget is spent. */
  const within = <T>(work: Promise<T>, ms: number, fallback: T) =>
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(fallback);
        },
      );
    });

  const access: ToolAccess = {
    clock,
    async list(task, signal): Promise<ToolList> {
      const s = o.settings();
      const deadline = now() + TOOL_LIMITS.listBudgetMs;
      const builtin: ToolSpec[] = [];
      const mcp: ToolSpec[] = [];
      const unavailable: ToolUnavailable[] = [];
      for (const server of builtinServers) {
        const running = providers.get(server.id)?.provider;
        for (const consent of CONSENTS) {
          if (!s.tools.apple[consent] || appleAccess[consent] === "granted")
            continue;
          const title = Object.values(server.tools).find(
            (t) => t.consent === consent,
          )?.title;
          if (title) unavailable.push({ title, state: "needs_permission" });
        }
        if (!running) continue;
        const state = running.state().state;
        if (usable(state))
          builtin.push(
            ...(await within(running.tools(signal), deadline - now(), [])),
          );
        else if (state !== "off") unavailable.push({ title: server.id, state });
      }
      for (const r of s.tools.servers) {
        const running = providers.get(r.id)?.provider;
        if (!running) {
          const check = startable(r, s);
          if (!check.ok && check.state !== "off")
            unavailable.push({ title: r.name, state: check.state });
          continue;
        }
        const state = running.state().state;
        if (!usable(state)) {
          unavailable.push({ title: r.name, state });
          continue;
        }
        const specs = await within(
          running.tools(signal),
          deadline - now(),
          undefined,
        );
        if (!specs) {
          unavailable.push({ title: r.name, state: "starting" });
          continue;
        }
        mcp.push(...specs.filter((spec) => toolsAllowed(s, spec)));
      }
      const words = tokens(task);
      const score = (spec: ToolSpec) =>
        [...tokens(`${spec.name} ${spec.does}`)].filter((w) => words.has(w))
          .length;
      const ranked = mcp
        .map((spec, index) => ({ spec, index, score: score(spec) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.spec);
      return {
        tools: [
          ...builtin.filter((spec) => toolsAllowed(s, spec)),
          ...ranked,
        ].slice(0, TOOL_LIMITS.list),
        unavailable: unavailable.slice(0, TOOL_LIMITS.unavailable),
      };
    },
    prepare(spec, args): ToolPrepared {
      if (TOOL_DENYLIST.test(spec.name))
        return { ok: false, problem: "denylisted" };
      const running = providers.get(spec.provider)?.provider;
      if (!running) return { ok: false, problem: "unknown_tool" };
      if (Buffer.byteLength(JSON.stringify(args)) > TOOL_LIMITS.argsBytes)
        return { ok: false, problem: "too_large" };
      if (!usable(running.state().state))
        return { ok: false, problem: "unavailable" };
      return running.prepare(spec, args);
    },
    async call(spec, args, signal) {
      const startedAt = now();
      const running = providers.get(spec.provider)?.provider;
      if (
        !running ||
        !usable(running.state().state) ||
        !toolsAllowed(o.settings(), spec)
      )
        return refusal(spec, "unavailable", startedAt);
      // The pin the user ticked is what the frozen list was built from; a
      // tool that changed since then is not called.
      const saved = row(spec.provider)?.tools[spec.name]?.pin;
      if (spec.transport !== "builtin" && saved !== running.pinOf(spec.name)) {
        trace("ToolPinMismatch", {
          server: spec.trace.server,
          tool: spec.trace.tool,
        });
        return refusal(spec, "pin_mismatch", startedAt);
      }
      const result = await serialised(spec.provider, () =>
        running.call(spec, args, { signal, timeoutMs: spec.timeoutMs }),
      ).catch((): ProviderResult => ({ code: "error", raw: "", items: 0 }));
      if (result.code === "ok" && result.undoToken)
        undos.push({
          token: result.undoToken,
          spec,
          expiresAt: now() + TOOL_LIMITS.undoWindowMs,
        });
      return outcome(spec, result, startedAt);
    },
    undoLast,
  };
  async function undoLast(
    signal: AbortSignal,
  ): Promise<ToolOutcome | undefined> {
    const at = now();
    while (undos.length && undos[undos.length - 1].expiresAt <= at) undos.pop();
    const last = undos.pop();
    if (!last) return undefined;
    const startedAt = now();
    const running = providers.get(last.spec.provider)?.provider;
    const result = running
      ? await running
          .undo(last.token, signal)
          .catch((): ProviderResult => ({ code: "error", raw: "", items: 0 }))
      : { code: "unavailable" as const, raw: "", items: 0 };
    trace("ToolUndo", {
      tool: last.spec.trace.tool,
      server: last.spec.trace.server,
      outcome: result.code,
    });
    return outcome(last.spec, result, startedAt);
  }

  return {
    clock,
    access: ({ synthetic }) =>
      synthetic || !o.settings().tools.enabled ? undefined : access,
    configure,
    argv,
    approval,
    status(): ToolsStatus {
      const s = o.settings();
      const bridge = builtinServers[0];
      const running = bridge ? providers.get(bridge.id)?.provider : undefined;
      const missing = CONSENTS.find(
        (c) => s.tools.apple[c] && appleAccess[c] !== "granted",
      );
      const apple: ToolsStatus["apple"] = !bridge
        ? { state: "needs_install", code: "no_bridge", access: appleAccess }
        : !CONSENTS.some((c) => s.tools.apple[c])
          ? { state: "off", access: appleAccess }
          : running
            ? { ...running.state(), access: appleAccess }
            : missing
              ? {
                  state: "needs_permission",
                  code: missing,
                  access: appleAccess,
                }
              : { state: "off", access: appleAccess };
      return {
        apple: { state: apple.state, code: apple.code, access: apple.access },
        servers: s.tools.servers.map((r) => {
          const live = providers.get(r.id)?.provider;
          const check = startable(r, s);
          const state = live ? live.state() : undefined;
          const launch = r.transport === "stdio" ? o.launch() : undefined;
          return {
            id: r.id,
            name: r.name,
            transport: r.transport,
            recipe: r.recipe,
            argv: argv(r),
            resolved: r.transport === "http" || !!resolved(r).path,
            state: state?.state ?? (check.ok ? "off" : check.state),
            code: state?.code ?? (check.ok ? undefined : check.code),
            trust: r.trust,
            network: r.network,
            sandboxed: !!launch && r.network === "none",
            disclaimed: !!launch,
            toolCount: state?.toolCount ?? 0,
            tools: live?.catalog() ?? [],
          };
        }),
      };
    },
    tick(id, tool, on) {
      const current = row(id);
      if (!current) throw new Error("That server is no longer configured.");
      const pin = providers.get(id)?.provider.pinOf(tool);
      if (!pin)
        throw new Error(
          "That tool is not listed right now; start the server and try again.",
        );
      if (TOOL_DENYLIST.test(tool))
        throw new Error("That tool is never called from here.");
      const ticks = { ...current.tools };
      if (on) ticks[tool] = { on: true, pin };
      else delete ticks[tool];
      return ticks;
    },
    async test(id) {
      const current = row(id);
      if (!current) throw new Error("That server is no longer configured.");
      const list = argv(current);
      // The preview is a connection like any other: the privacy gate that
      // keeps a server from starting keeps it from being probed.
      if (blockedLocal(current, o.settings()))
        return {
          ok: false,
          toolCount: 0,
          argv: list,
          tools: [],
          code: "blocked_local",
        };
      if (current.transport === "stdio" && !resolved(current).path)
        return {
          ok: false,
          toolCount: 0,
          argv: list,
          tools: [],
          code: "needs_install",
        };
      const probe = create(source(current));
      try {
        await probe.start();
        const state = probe.state();
        return {
          ok: usable(state.state),
          toolCount: state.toolCount,
          argv: list,
          tools: probe.catalog().map(({ name, description, tier, denied }) => ({
            name,
            description,
            tier,
            denied,
          })),
          code: state.code,
        };
      } finally {
        await probe.close();
      }
    },
    async retry(id) {
      const running = providers.get(id)?.provider;
      if (running) await running.retry();
      else await configure();
    },
    async appleAccess() {
      const bridge = builtinServers[0];
      return bridge ? readAppleAccess(bridge) : UNKNOWN_ACCESS;
    },
    async requestApple(consent) {
      const bridge = builtinServers[0];
      if (!bridge) return UNKNOWN_ACCESS;
      try {
        appleAccess = parseAppleAccess(
          await exec(o.helper(bridge.helper), ["request", consent], 120_000),
        );
      } catch {
        appleAccess = UNKNOWN_ACCESS;
      }
      await configure();
      return appleAccess;
    },
    forget: stop,
    undoLast,
    async closeAll() {
      for (const id of [...providers.keys()]) await stop(id);
    },
  };
}
