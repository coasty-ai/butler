import { Buffer } from "node:buffer";
import { basename } from "node:path";
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { ToolServer } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import {
  TOOL_DENYLIST,
  TOOL_ID,
  TOOL_LIMITS,
  tierFromAnnotations,
  type AppleConsent,
  type BuiltinServer,
  type ProviderResult,
  type ProviderState,
  type ServerRecipe,
  type ToolCode,
  type ToolPrepared,
  type ToolProvider,
  type ToolQuestion,
  type ToolSpec,
  type ToolsStatus,
} from "../core/tools";
import { toolPin, traceCode } from "./pins";
import { childPath, type ResolveFs } from "./resolve";
import { stripInvisible } from "./result";

/**
 * One MCP server behind the registry, over @modelcontextprotocol/client:
 * a user's stdio or HTTP server, or a first-party bridge (BUILTIN_SERVERS)
 * spoken to through the same client. The process is long-lived and, like
 * the native helpers (electron/controller.ts HelperProcess), restarted in
 * place with backoff when it exits unexpectedly; callers keep this object.
 * Everything the server says is data: names, descriptions, schemas,
 * annotations and results are bounded and sanitised before anyone reads them.
 */
export interface ServerSource {
  kind: "server";
  row: ToolServer;
  recipe?: ServerRecipe;
  /** The absolute command a stdio row's name resolved to (src/tools/resolve.ts). */
  command?: string;
  /**
   * coarena-launch when it exists: the child is spawned through it with TCC
   * responsibility disclaimed, and inside the network sandbox when the row
   * declares network "none".
   */
  launch?: string;
  secrets: { env: Record<string, string>; headers: Record<string, string> };
}
export interface BuiltinSource {
  kind: "builtin";
  server: BuiltinServer;
  /** The helper binary (native/bin in development, Resources when packaged). */
  helper: string;
}
export type ProviderSource = ServerSource | BuiltinSource;

export interface McpProviderOptions {
  home: string;
  /** The app version the server sees in clientInfo. */
  version: string;
  trace?: (event: string, data: Record<string, unknown>) => void;
  /** The saved ticks and pins (settings.tools.servers[].tools), read live. */
  ticks?: () => Record<string, { on: boolean; pin: string }>;
  /** The consents that are on and granted, read live (builtin only). */
  consents?: () => ReadonlySet<AppleConsent>;
  /** Fires once the server is on and listed, so first-start ticks can be saved. */
  onStarted?: () => void;
  connectTimeoutMs?: number;
  fs?: ResolveFs;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
export type CatalogEntry = ToolsStatus["servers"][number]["tools"][number];
export interface McpProvider extends ToolProvider {
  /** Every tool the server lists, as the Settings pane shows it (descriptions never traced). */
  catalog(): CatalogEntry[];
  /** The pin of one listed tool, for a tick. */
  pinOf(name: string): string | undefined;
  /** Bytes the server wrote to stderr; the text itself is never kept. */
  stderrBytes(): number;
  /** Clears an exhausted restart budget and starts again (the pane's Retry). */
  retry(): Promise<void>;
}

const BACKOFF_MS = [500, 1000, 2000];
const RESTART_LIMIT = 5;
const RESTART_WINDOW_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** The launcher's own stderr line names why the child never ran; nothing else on stderr is read. */
const LAUNCH_CODE = /\bLAUNCH_(?:BAD_COMMAND|NO_SANDBOX|NO_DISCLAIM)\b/;
const LAUNCH_STDERR_BYTES = 256;
const DATE_FORMATS = new Set(["date", "date-time", "time"]);
/**
 * A pattern that pins a `YYYY-MM-DD` day, alone or followed by a time: how the
 * Apple bridge states its dates (AppleRules.dayPattern, momentPattern), since
 * `format: "date-time"` would have Ajv refuse the offset-less local form.
 */
const LOCAL_DATE_PATTERN =
  /^\^\\d\{4\}-\\d\{2\}-\\d\{2\}(\$$|\(.*[T:].*\)\?\$$)/;
const validators = new AjvJsonSchemaValidator();

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const clean = (text: unknown, max: number) =>
  typeof text === "string"
    ? redactSecrets(stripInvisible(text))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
const properties = (schema: unknown): Record<string, Schema> =>
  isObject(schema) && isObject(schema.properties)
    ? Object.fromEntries(
        Object.entries(schema.properties).filter(
          (entry): entry is [string, Schema] => isObject(entry[1]),
        ),
      )
    : {};
const required = (schema: unknown): Set<string> =>
  new Set(
    isObject(schema) && Array.isArray(schema.required)
      ? schema.required.filter((v): v is string => typeof v === "string")
      : [],
  );
/**
 * What kind of date a property takes, or undefined: its JSON Schema format
 * ("date", "date-time", "time"), or "date, local" / "date-time, local" for a
 * string pinned to the local form by pattern (the Apple bridge).
 */
function dateKind(p: Schema): string | undefined {
  if (typeof p.format === "string" && DATE_FORMATS.has(p.format))
    return p.format;
  if (typeof p.pattern !== "string") return undefined;
  const match = LOCAL_DATE_PATTERN.exec(p.pattern);
  if (!match) return undefined;
  return match[1] === "$" ? "date, local" : "date-time, local";
}
/** "title (text), start (date-time, local), end? (date-time, local)": required first, at most eight. */
function paramsLine(schema: unknown): string {
  const props = properties(schema);
  const must = required(schema);
  const names = Object.keys(props).sort(
    (a, b) => Number(must.has(b)) - Number(must.has(a)),
  );
  const kind = (p: Schema) => {
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    const word =
      type === "string"
        ? "text"
        : type === "integer" || type === "number"
          ? "number"
          : type === "array"
            ? "list"
            : typeof type === "string"
              ? type
              : "value";
    const date = dateKind(p);
    if (date) return `${word}, ${date}`;
    return typeof p.format === "string" && p.format
      ? `${word}, ${p.format}`
      : word;
  };
  return names
    .slice(0, 8)
    .map(
      (name) =>
        `${clean(name, 64)}${must.has(name) ? "" : "?"} (${kind(props[name])})`,
    )
    .join(", ")
    .slice(0, 300);
}
/** Argument keys the schema types as a date, date-time or time, by format or by the local pattern. */
function dateKeys(schema: unknown): string[] {
  return Object.entries(properties(schema))
    .filter(([, p]) => dateKind(p) !== undefined)
    .map(([name]) => name);
}
/** The title (or name) and the description's first sentence, ≤ 200 characters. */
function describe(tool: Tool): string {
  const sentence = clean(tool.description, 400).split(/(?<=[.!?])\s/)[0] ?? "";
  const head = clean(tool.title ?? tool.name, 60);
  return (sentence ? `${head}: ${sentence}` : head).slice(0, 200);
}
/** Every string in the arguments except validated date values, for grounding. */
function stringLeaves(
  value: unknown,
  skip: ReadonlySet<string>,
  depth = 0,
): string[] {
  if (depth > TOOL_LIMITS.argsDepth) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.flatMap((v) => stringLeaves(v, skip, depth + 1));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, v]) =>
    skip.has(key) && typeof v === "string" && !Number.isNaN(Date.parse(v))
      ? []
      : stringLeaves(v, skip, depth + 1),
  );
}
const argsBytes = (args: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify(args));
/** The tool result's text blocks joined, capped before anything else reads it. */
function rawText(result: CallToolResult): { raw: string; items: number } {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text);
  let raw = texts.join("\n");
  if (!raw && result.structuredContent !== undefined)
    raw = JSON.stringify(result.structuredContent);
  return {
    raw: raw.slice(0, TOOL_LIMITS.rawResultBytes),
    items: blocks.length,
  };
}
/** The code a refusal leads with: "DUPLICATE: An event titled … is already in Home." → DUPLICATE. */
const REFUSAL_CODE = /^([A-Z_]{2,40}):/;
/**
 * The code of an isError result: structuredContent.code when the server sets
 * one, else the leading code token of its text, as the Apple bridge writes
 * every refusal ("CODE: sentence", docs/TOOLS.md). Undefined when neither.
 */
export function refusalCode(
  result: Pick<CallToolResult, "structuredContent">,
  raw: string,
): string | undefined {
  const structured = result.structuredContent;
  if (isObject(structured) && typeof structured.code === "string")
    return structured.code;
  return REFUSAL_CODE.exec(raw.trimStart())?.[1];
}
/**
 * What a thrown call means to the run; the message is data for the body. An
 * input request (a 2026-era server asking the user something mid-call) is
 * never fulfilled here: the model is told to ask with request_user.
 */
export function failureCode(error: unknown, signal: AbortSignal): ToolCode {
  if (signal.aborted) return "interrupted";
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return "timeout";
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.SendFailed:
        return "unavailable";
      case SdkErrorCode.UnsupportedResultType:
        return isObject(error.data) &&
          error.data.resultType === "input_required"
          ? "input_required"
          : "error";
      default:
        return "error";
    }
  }
  return "error";
}
const errorCode = (error: unknown) =>
  error instanceof SdkError || error instanceof ProtocolError
    ? String(error.code)
    : isObject(error) && typeof error.code === "string"
      ? error.code
      : "failed";

export function createMcpProvider(
  source: ProviderSource,
  o: McpProviderOptions,
): McpProvider {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const connectTimeoutMs = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const id = source.kind === "server" ? source.row.id : source.server.id;
  const transport: ToolSpec["transport"] =
    source.kind === "server" ? source.row.transport : "builtin";
  const title = source.kind === "server" ? source.row.name : source.server.id;
  const disclaimed =
    source.kind === "server" &&
    source.row.transport === "stdio" &&
    !!source.launch;
  const sandboxed =
    disclaimed && source.kind === "server" && source.row.network === "none";
  const serverCode =
    source.kind === "server" ? traceCode("s", source.row.id) : source.server.id;
  const base = () => ({
    server: serverCode,
    transport,
    sandboxed,
    disclaimed,
    restarts: restarts.length,
  });
  const trace = (event: string, data: Record<string, unknown> = {}) => {
    try {
      o.trace?.(event, { ...base(), ...data });
    } catch {}
  };

  let client: Client | undefined;
  let listed: Tool[] = [];
  let stale = false;
  let state: ProviderState = "off";
  let code: string | undefined;
  let closing = false;
  let stderr = 0;
  let launchCode: string | undefined;
  let restarts: number[] = [];
  let exhausted = false;
  let timer: unknown;
  const compiled = new Map<
    string,
    ((input: unknown) => { valid: boolean }) | null
  >();

  const on = () => state === "on" || state === "changed";
  const listedTool = (name: string) => listed.find((t) => t.name === name);
  const pinOf = (name: string) => {
    const tool = listedTool(name);
    return tool ? toolPin(tool) : undefined;
  };
  /** An argument validator for one listed tool, compiled once per pin; null when the schema cannot be compiled. */
  const validator = (tool: Tool) => {
    const pin = toolPin(tool);
    if (!compiled.has(pin))
      try {
        compiled.set(pin, validators.getValidator(tool.inputSchema as never));
      } catch {
        compiled.set(pin, null);
      }
    return compiled.get(pin) ?? null;
  };

  const env = (command: string): Record<string, string> => {
    const fixed: Record<string, string | undefined> = {
      HOME: o.home,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      PATH: childPath(command, o.home, o.fs),
      // The SDK merges its own safe list from process.env underneath what is
      // passed; a key given as undefined is dropped by Node's spawn, so these
      // never reach the child either.
      LOGNAME: undefined,
      SHELL: undefined,
      TERM: undefined,
      USER: undefined,
    };
    return fixed as Record<string, string>;
  };
  const createTransport = () => {
    if (source.kind === "builtin")
      return new StdioClientTransport({
        command: source.helper,
        args: source.server.args,
        env: env(source.helper),
        stderr: "pipe",
      });
    const { row, secrets, launch } = source;
    if (row.transport === "http")
      return new StreamableHTTPClientTransport(new URL(row.url), {
        requestInit: { headers: secrets.headers },
      });
    const command = source.command ?? row.command;
    return new StdioClientTransport({
      command: launch ?? command,
      args: launch
        ? [
            ...(row.network === "none" ? ["--no-network"] : []),
            "--",
            command,
            ...row.args,
          ]
        : row.args,
      env: { ...env(command), ...row.env, ...secrets.env },
      cwd: row.cwd || undefined,
      stderr: "pipe",
    });
  };
  const countStderr = (
    t: StdioClientTransport | StreamableHTTPClientTransport,
  ) => {
    if (!(t instanceof StdioClientTransport) || !t.stderr) return;
    t.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (
        source.kind === "server" &&
        source.launch &&
        !launchCode &&
        stderr < LAUNCH_STDERR_BYTES
      )
        launchCode = LAUNCH_CODE.exec(text)?.[0];
      stderr += Buffer.byteLength(text);
    });
  };

  const refresh = async () => {
    if (!client) return;
    const result = await client.listTools(undefined, {
      timeout: connectTimeoutMs,
    });
    listed = result.tools;
    stale = false;
  };
  const exited = (from: Client) => {
    if (from !== client) return;
    client = undefined;
    if (closing) return;
    const wasOn = on();
    state = "failed";
    code = "exited";
    trace("ToolServerExited");
    // A connect that never got to "on" is reported by start(); only a server
    // that was running is brought back, within the helpers' budget.
    if (wasOn) scheduleRestart();
  };
  const scheduleRestart = () => {
    const at = now();
    restarts = restarts.filter((t) => at - t < RESTART_WINDOW_MS);
    if (restarts.length >= RESTART_LIMIT) {
      exhausted = true;
      code = "exhausted";
      trace("ToolServerFailed", { code });
      return;
    }
    const delay = BACKOFF_MS[Math.min(restarts.length, BACKOFF_MS.length - 1)];
    restarts.push(at);
    timer = setTimer(() => void start(), delay);
  };
  const start = async () => {
    if (closing || client || exhausted) return;
    const startedAt = now();
    state = "starting";
    code = undefined;
    launchCode = undefined;
    trace("ToolServerStarting");
    const next = new Client(
      { name: "butler", version: o.version },
      {
        capabilities: {},
        versionNegotiation: { mode: "auto", probe: { timeoutMs: 3000 } },
        inputRequired: { autoFulfill: false },
        listMaxPages: 8,
        enforceStrictCapabilities: true,
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => {
              stale = true;
            },
          },
        },
      },
    );
    next.onclose = () => exited(next);
    next.onerror = () => {};
    client = next;
    let wire: StdioClientTransport | StreamableHTTPClientTransport | undefined;
    try {
      wire = createTransport();
      countStderr(wire);
      await next.connect(wire, { timeout: connectTimeoutMs });
      await refresh();
      if (client !== next) return;
      state = "on";
      trace("ToolServerStarted", {
        durationMs: now() - startedAt,
        toolCount: listed.length,
        stderrBytes: stderr,
      });
      o.onStarted?.();
    } catch (error) {
      if (client === next) client = undefined;
      await wire?.close().catch(() => {});
      state = launchCode === "LAUNCH_NO_SANDBOX" ? "blocked_local" : "failed";
      code = launchCode ?? errorCode(error);
      trace("ToolServerFailed", { code, durationMs: now() - startedAt });
    }
  };

  const specOf = (tool: Tool): ToolSpec | undefined => {
    const id = `${source.kind === "server" ? source.row.id : source.server.id}__${tool.name}`;
    if (!TOOL_ID.test(id) || TOOL_DENYLIST.test(tool.name)) return undefined;
    const schema = tool.inputSchema;
    if (source.kind === "builtin") {
      const entry = source.server.tools[tool.name];
      if (!entry) return undefined;
      return {
        id,
        provider: source.server.id,
        name: tool.name,
        title: entry.title,
        does: entry.does,
        params: paramsLine(schema),
        tier: entry.tier,
        trusted: true,
        local: true,
        openWorld: false,
        undoable: entry.undoable,
        longRunning: !!entry.longRunning,
        transport: "builtin",
        timeoutMs: entry.longRunning
          ? TOOL_LIMITS.longRunningTimeoutMs
          : TOOL_LIMITS.callTimeoutMs,
        dateKeys: entry.dateKeys ?? dateKeys(schema),
        trace: { tool: tool.name, server: source.server.id },
      };
    }
    const { row, recipe } = source;
    const longRunning = recipe?.longRunning?.includes(tool.name) ?? false;
    return {
      id,
      provider: row.id,
      name: tool.name,
      title: row.name,
      does: describe(tool),
      params: paramsLine(schema),
      tier:
        recipe?.tierOverrides?.[tool.name] ??
        tierFromAnnotations({
          name: tool.name,
          title: tool.title,
          argKeys: Object.keys(properties(schema)),
          annotations: tool.annotations,
        }),
      trusted: row.trust === "reads_unattended",
      local: row.transport === "stdio" && row.network === "none" && sandboxed,
      openWorld: tool.annotations?.openWorldHint !== false,
      undoable: false,
      longRunning,
      transport: row.transport,
      timeoutMs: longRunning
        ? TOOL_LIMITS.longRunningTimeoutMs
        : TOOL_LIMITS.callTimeoutMs,
      dateKeys: dateKeys(schema),
      trace: { tool: traceCode("t", id), server: serverCode },
    };
  };
  /** Tools the recipe offers at all; a builtin exposes only what its table names. */
  const offered = (tool: Tool) =>
    source.kind === "builtin"
      ? tool.name in source.server.tools
      : !source.recipe?.allowTools ||
        source.recipe.allowTools.includes(tool.name);
  const question = (
    spec: ToolSpec,
    args: Record<string, unknown>,
  ): ToolQuestion => {
    if (source.kind === "builtin")
      return source.server.tools[spec.name].question(args);
    if (spec.longRunning)
      return {
        kind: "agent_run",
        server: spec.title,
        folder: basename(source.row.cwd) || "this folder",
      };
    const server = spec.title;
    if (spec.tier === "read")
      return { kind: "mcp_read", server, tool: spec.name };
    if (spec.tier === "destructive")
      return { kind: "mcp_destructive", server, tool: spec.name };
    return { kind: "mcp_write", server, tool: spec.name };
  };
  const fromResult = (
    spec: ToolSpec,
    result: CallToolResult,
  ): ProviderResult => {
    const { raw, items } = rawText(result);
    if (result.isError) {
      const failure = refusalCode(result, raw);
      const code: ToolCode =
        source.kind === "builtin" && failure === "DUPLICATE"
          ? "duplicate"
          : source.kind === "builtin" && failure === "NO_ACCESS"
            ? "denied"
            : "error";
      return { code, raw, items };
    }
    if (source.kind === "builtin") {
      const entry = source.server.tools[spec.name];
      const structured = result.structuredContent;
      const fields = isObject(structured) ? structured : {};
      return {
        code: "ok",
        raw,
        items,
        lines: entry?.lines?.(structured),
        facts: entry?.facts?.(structured),
        verified: fields.verified === true,
        undoToken:
          typeof fields.undoToken === "string" ? fields.undoToken : undefined,
      };
    }
    return { code: "ok", raw, items };
  };
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number },
  ): Promise<CallToolResult> => {
    if (!client || !on()) throw new SdkError(SdkErrorCode.NotConnected, "off");
    return client.callTool(
      { name, arguments: args },
      {
        timeout: timeoutMs,
        // Asking for progress is what lets a long call reset its timeout;
        // the notifications themselves carry nothing the run needs.
        onprogress: () => {},
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 3 * timeoutMs,
        signal,
      },
    );
  };

  return {
    id,
    transport,
    title,
    start,
    async retry() {
      clearTimer(timer);
      restarts = [];
      exhausted = false;
      await start();
    },
    state: () => ({
      state,
      toolCount: listed.length,
      restarts: restarts.length,
      code,
    }),
    stderrBytes: () => stderr,
    pinOf,
    catalog() {
      const ticks = o.ticks?.() ?? {};
      return listed.filter(offered).map((tool) => {
        const tick = ticks[tool.name];
        const pin = toolPin(tool);
        const spec = specOf(tool);
        return {
          name: tool.name,
          title: clean(tool.title ?? tool.name, 80),
          description: clean(tool.description, 1000),
          tier:
            spec?.tier ??
            tierFromAnnotations({
              name: tool.name,
              title: tool.title,
              argKeys: Object.keys(properties(tool.inputSchema)),
              annotations: tool.annotations,
            }),
          on: !!tick?.on,
          changed: !!tick?.on && tick.pin !== pin,
          denied: !spec,
        };
      });
    },
    async tools() {
      if (!on() || !client) return [];
      if (stale) await refresh().catch(() => {});
      const specs: ToolSpec[] = [];
      let changed = false;
      for (const tool of listed) {
        if (!offered(tool)) continue;
        const spec = specOf(tool);
        if (!spec) continue;
        if (source.kind === "builtin") {
          if (!o.consents?.().has(source.server.tools[tool.name].consent))
            continue;
          specs.push(spec);
          continue;
        }
        const tick = (o.ticks?.() ?? {})[tool.name];
        if (!tick?.on) continue;
        if (tick.pin !== toolPin(tool)) {
          changed = true;
          continue;
        }
        specs.push(spec);
      }
      state = changed ? "changed" : "on";
      return specs;
    },
    prepare(spec, args): ToolPrepared {
      const tool = listedTool(spec.name);
      if (!tool || !on()) return { ok: false, problem: "unavailable" };
      const check = validator(tool);
      if (!check || !check(args).valid)
        return { ok: false, problem: "invalid_args" };
      return {
        ok: true,
        question: question(spec, args),
        groundText: stringLeaves(args, new Set(spec.dateKeys)),
        argsBytes: argsBytes(args),
      };
    },
    async call(spec, args, options) {
      // A per-app consent switched off since the run's list was frozen is
      // enforced here too, not only at listing: the bridge is never asked.
      if (source.kind === "builtin") {
        const entry = source.server.tools[spec.name];
        if (!entry || !o.consents?.().has(entry.consent))
          return { code: "unavailable", raw: "", items: 0 };
      }
      try {
        return fromResult(spec, await callTool(spec.name, args, options));
      } catch (error) {
        return {
          code: failureCode(error, options.signal),
          raw: error instanceof Error ? error.message : "",
          items: 0,
        };
      }
    },
    async undo(token, signal) {
      if (source.kind !== "builtin")
        return { code: "error", raw: "", items: 0 };
      try {
        const result = await callTool(
          "undo",
          { token },
          { signal, timeoutMs: TOOL_LIMITS.callTimeoutMs },
        );
        const { raw, items } = rawText(result);
        return { code: result.isError ? "error" : "ok", raw, items };
      } catch (error) {
        return {
          code: failureCode(error, signal),
          raw: error instanceof Error ? error.message : "",
          items: 0,
        };
      }
    },
    async close() {
      closing = true;
      clearTimer(timer);
      const current = client;
      client = undefined;
      state = "off";
      await current?.close().catch(() => {});
    },
  };
}
