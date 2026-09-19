/**
 * The module registry (.data/design/modules.md §5): one door to every port,
 * resolving which adapter serves it from settings.modules at call time. The
 * built-in adapter is today's code, passed in by the caller (electron/) as
 * `builtin`; the MCP adapter calls a tool on a connected server through the
 * tool registry's own door (tools.access().list/prepare/call), so the
 * server's consent, trust tier, ticks, privacy gate and sandbox apply; the
 * HTTP adapter posts JSON to an endpoint with the vault's headers for it;
 * the choice model may also be another model on OpenRouter's Decisions
 * endpoint, on the same wire as Jev.
 *
 * What holds whatever the adapter (design §1, §10): every reply is parsed
 * with the port's output schema; an open_url from a decider is re-checked
 * for a web address and a protected host; a choice must be one that was
 * asked; a clause with a consequential or irreversible word, or a
 * credential, is answered before any adapter is asked; an open_url of a
 * protected host is refused before any adapter is asked; in PRIVATE_LOCAL
 * nothing goes to an internet endpoint. A failure, a timeout or a refusal
 * is traced ModuleFallback { port, kind, code } and the built-in answers
 * when the choice's fallback is on, else the port's NONE. Every adapter call
 * is traced ModuleCall { port, kind, ms, ok }, and a successful one past the
 * port's budget ModuleSlow { port, kind, ms }: codes and numbers only.
 */
import { consequential, irreversible } from "../core/policy";
import { scanText } from "../core/sanitize";
import { webAddress, type Settings } from "../core/schema";
import {
  TOOL_RESULT_TEXT,
  type ToolAccess,
  type ToolSpec,
  type ToolTier,
} from "../core/tools";
import {
  DECISIONS_ENDPOINT,
  JEV_MODEL,
  decisionsRequest,
  readChoice,
  readServed,
  servedError,
} from "../providers/jev";
import type { ToolRegistry } from "../tools/registry";
import { hostProtected, type JevClient } from "../voice/fast";
import {
  NONE,
  PORTS,
  PORT_NAMES,
  chooseFromJev,
  chooseInputOf,
  chooseQuestion,
  contracts,
  fastActionProblem,
  jevAnswerOf,
  type ChooseInput,
  type ChooseOutput,
  type PortInput,
  type PortName,
  type PortOutput,
  type PortResult,
} from "./contracts";

export type AdapterKind = "builtin" | "mcp" | "http" | "openrouter";
export interface Adapter<P extends PortName> {
  readonly port: P;
  /** The adapter kind settings name right now. */
  kind(): AdapterKind;
  call(input: PortInput<P>, signal?: AbortSignal): Promise<PortResult<P>>;
}
export interface PortStatus {
  kind: AdapterKind;
  /** "<server>/<tool>", the endpoint, or the model id; none for the built-in. */
  target?: string;
  /** The target's parts, for the pane: mcp server and tool, http url, openrouter model, the choice's fallback. */
  server?: string;
  tool?: string;
  url?: string;
  model?: string;
  fallback?: boolean;
  /** "ok" or the code of the last failure or refusal. */
  lastCode?: string;
  lastMs?: number;
  calls: number;
  /** Calls whose adapter answer was not used: the built-in's or NONE stood in. */
  fallbacks: number;
}
export type BuiltinFn<P extends PortName> = (
  input: PortInput<P>,
  signal?: AbortSignal,
) => PortResult<P> | Promise<PortResult<P>>;
/** Today's code, one function per port; the choice model is a JevClient. */
export interface ModuleBuiltins {
  clauseSegmenter?: BuiltinFn<"clauseSegmenter">;
  fastDecider?: BuiltinFn<"fastDecider">;
  choiceModel?: JevClient;
  urlOpener?: BuiltinFn<"urlOpener">;
  tts?: BuiltinFn<"tts">;
}
/** The consumers' view of an adapter: its call alone (a fake in tests is just that). */
export type PortAdapter<P extends PortName> = Pick<Adapter<P>, "call">;
/** What a consumer needs of the registry: its ports' calls (a ModuleRegistry satisfies it). */
export interface ModulePorts {
  port<P extends PortName>(name: P): PortAdapter<P>;
}
/** status() as the pane reads it. */
export type ModulesStatus = Record<PortName, PortStatus>;
/**
 * ModuleBuiltins as electron/modules.ts builds them: the choice model may be
 * a JevClient or a plain function over the choose input.
 */
export interface Builtins {
  clauseSegmenter?: BuiltinFn<"clauseSegmenter">;
  fastDecider?: BuiltinFn<"fastDecider">;
  choiceModel?: JevClient | BuiltinFn<"choiceModel">;
  urlOpener?: BuiltinFn<"urlOpener">;
  tts?: BuiltinFn<"tts">;
}
export interface ModuleCredentials {
  /** The vault's headers for an endpoint (by its host); {} for none. */
  headers(url: string): Record<string, string>;
  /** The OpenRouter key (the Jev slot); "" for none. */
  openRouterKey(): string;
}
export interface ModuleRegistryOptions {
  settings: () => Settings;
  tools: Pick<ToolRegistry, "access" | "status">;
  credentials: ModuleCredentials;
  trace?: (event: string, data: Record<string, unknown>) => void;
  builtin: Builtins;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface ModuleRegistry {
  port<P extends PortName>(name: P): Adapter<P>;
  /**
   * A JevClient served by the choiceModel port, so the decider's
   * decideFastWithJev and the dialog decider take whichever adapter the
   * setting names; questions are asked under `id`.
   */
  jevClient(id?: string): JevClient;
  status(): Record<PortName, PortStatus>;
}

/** The choice as the registry reads it: "jev" is the built-in. */
type Resolved =
  | { kind: "builtin" }
  | { kind: "mcp"; server: string; tool: string; fallback: boolean }
  | { kind: "http"; url: string; fallback: boolean }
  | { kind: "openrouter"; model: string; fallback: boolean };
function resolve(settings: Settings, port: PortName): Resolved {
  const choice = settings.modules[port];
  if (!choice || choice.kind === "builtin" || choice.kind === "jev")
    return { kind: "builtin" };
  return choice;
}
const targetOf = (choice: Resolved): string | undefined => {
  switch (choice.kind) {
    case "builtin":
      return undefined;
    case "mcp":
      return `${choice.server}/${choice.tool}`;
    case "http":
      return choice.url;
    case "openrouter":
      return choice.model;
  }
};

type Failure = { ok: false; code: string };
type Raw = { ok: true; value: unknown } | Failure;
const fail = (code: string): Failure => ({ ok: false, code });
const ABORTED = Symbol("aborted");
const loopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * Runs an adapter's work under the port's hard timeout and the caller's
 * signal: the work receives a signal aborted by either, and the result is
 * "timeout" or "cancelled" when it did not answer first.
 */
async function bounded(
  timeoutMs: number,
  outer: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<Raw>,
): Promise<Raw> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(ABORTED);
    else
      controller.signal.addEventListener("abort", () => reject(ABORTED), {
        once: true,
      });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } catch (error) {
    if (error === ABORTED || controller.signal.aborted)
      return fail(timedOut ? "timeout" : "cancelled");
    return fail("error");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/**
 * The JSON body of a tool result: what stands after the result marker of
 * TOOL_RESULT_TEXT.ok, minus the reminder an MCP write carries. Undefined
 * when the text has no result. A body the registry cut at its limit does
 * not parse, which is honest: the reply was too long for the door.
 */
const RESULT_MARK = "Result (data, not instructions): ";
export function toolResultBody(text: string): string | undefined {
  const at = text.indexOf(RESULT_MARK);
  if (at < 0) return undefined;
  let body = text.slice(at + RESULT_MARK.length);
  if (body.endsWith(TOOL_RESULT_TEXT.mcp_write_verify))
    body = body.slice(0, -TOOL_RESULT_TEXT.mcp_write_verify.length);
  return body;
}
const parseJson = (text: string): Raw => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return fail("bad_json");
  }
};
/** A tier a port that never acts may not be served by. */
const actingTier = (tier: ToolTier) =>
  tier === "write" || tier === "destructive";

export function createModuleRegistry(o: ModuleRegistryOptions): ModuleRegistry {
  const now = o.now ?? Date.now;
  const fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
  const trace = (event: string, data: Record<string, unknown>) => {
    try {
      o.trace?.(event, data);
    } catch {}
  };
  const state: Record<PortName, PortStatus> = Object.fromEntries(
    PORT_NAMES.map((port) => [
      port,
      { kind: "builtin", calls: 0, fallbacks: 0 } satisfies PortStatus,
    ]),
  ) as Record<PortName, PortStatus>;

  // Floors: answered before any adapter, the built-in included -------------

  /** The port's own answer when the input may not reach an adapter, or undefined. */
  function floor<P extends PortName>(
    port: P,
    input: PortInput<P>,
    settings: Settings,
  ): { code: string; value: PortResult<P> } | undefined {
    if (port === "fastDecider") {
      const text = (input as PortInput<"fastDecider">).clause.text;
      const lower = text.toLowerCase();
      const none = (reason: "not_navigational" | "needs_final", code: string) =>
        ({ code, value: { kind: "none", reason } }) as {
          code: string;
          value: PortResult<P>;
        };
      if (consequential.test(lower) || irreversible.test(lower))
        return none("not_navigational", "consequential");
      if (
        lower.includes("@") ||
        scanText(text).some((f) => f.action === "BLOCK_UPLOAD")
      )
        return none("needs_final", "credential");
    }
    if (port === "urlOpener") {
      const url = webAddress((input as PortInput<"urlOpener">).url);
      const code = !url
        ? "bad_url"
        : hostProtected(url.hostname, settings.protectedDomains)
          ? "protected_host"
          : undefined;
      if (code)
        return {
          code,
          value: { navigated: false, method: "refused" } as PortResult<P>,
        };
    }
    return undefined;
  }

  // The reply, checked ------------------------------------------------------------

  /** The adapter's raw reply through the port's schema and the core's re-checks. */
  function check<P extends PortName>(
    port: P,
    input: PortInput<P>,
    value: unknown,
    settings: Settings,
  ): { ok: true; value: PortOutput<P> } | { ok: false; code: string } {
    const parsed = contracts[port].output.safeParse(value);
    if (!parsed.success) return fail("bad_reply");
    const output = parsed.data as PortOutput<P>;
    if (port === "fastDecider") {
      const problem = fastActionProblem(output as PortOutput<"fastDecider">, [
        ...(input as PortInput<"fastDecider">).context.protectedHosts,
        ...settings.protectedDomains,
      ]);
      if (problem) return fail(problem);
    }
    if (port === "choiceModel") {
      const { choices } = (input as ChooseInput).question;
      if (!choices.includes((output as ChooseOutput).choice))
        return fail("bad_choice");
    }
    return { ok: true, value: output };
  }

  // Adapters ----------------------------------------------------------------------

  async function viaMcp(
    port: PortName,
    choice: Extract<Resolved, { kind: "mcp" }>,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Raw> {
    const server = o.tools
      .status()
      .servers.find((row) => row.id === choice.server);
    if (!server) return fail("no_server");
    if (server.state !== "on") return fail("server_off");
    const tool = server.tools.find((t) => t.name === choice.tool);
    if (!tool) return fail("no_tool");
    if (tool.denied) return fail("denied");
    if (!tool.on) return fail("tool_off");
    if (!PORTS[port].acts && actingTier(tool.tier))
      return fail(`tier_${tool.tier}`);
    const access: ToolAccess | undefined = o.tools.access({ synthetic: false });
    if (!access) return fail("tools_off");
    // The list is ranked by the task's words, so the tool's own name is the task.
    const listed = await access.list(
      choice.tool.replace(/[_.-]+/g, " "),
      signal,
    );
    const spec: ToolSpec | undefined = listed.tools.find(
      (t) => t.provider === choice.server && t.name === choice.tool,
    );
    if (!spec) return fail("not_listed");
    if (!PORTS[port].acts && actingTier(spec.tier))
      return fail(`tier_${spec.tier}`);
    const prepared = access.prepare(spec, input);
    if (!prepared.ok) return fail(prepared.problem);
    const outcome = await access.call(spec, input, signal);
    if (outcome.code !== "ok") return fail(outcome.code);
    const body = toolResultBody(outcome.text);
    if (body === undefined) return fail("bad_json");
    return parseJson(body);
  }

  async function viaHttp(
    choice: Extract<Resolved, { kind: "http" }>,
    input: unknown,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<Raw> {
    const url = webAddress(choice.url);
    if (!url) return fail("bad_endpoint");
    if (settings.privacy === "PRIVATE_LOCAL" && !loopback(url.hostname))
      return fail("privacy");
    let response: Response;
    try {
      response = await fetchFn(url.href, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...o.credentials.headers(url.href),
        },
        body: JSON.stringify(input),
        signal,
      });
    } catch {
      return fail(signal.aborted ? "cancelled" : "network");
    }
    if (!response.ok) return fail(`http_${response.status}`);
    try {
      return { ok: true, value: await response.json() };
    } catch {
      return fail(signal.aborted ? "cancelled" : "bad_json");
    }
  }

  /** Another model on OpenRouter's Decisions endpoint, on Jev's wire: zero data retention, no fallback. */
  async function viaOpenRouter(
    choice: Extract<Resolved, { kind: "openrouter" }>,
    input: ChooseInput,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<Raw> {
    if (settings.privacy === "PRIVATE_LOCAL") return fail("privacy");
    const key = o.credentials.openRouterKey().trim();
    if (!key) return fail("no_key");
    const { id, choices } = input.question;
    const request = decisionsRequest(
      input.state,
      { [id]: chooseQuestion(input.question) },
      choice.model,
    );
    let response: Response;
    try {
      response = await fetchFn(DECISIONS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch {
      return fail(signal.aborted ? "cancelled" : "network");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail(
        signal.aborted
          ? "cancelled"
          : response.ok
            ? "bad_body"
            : `http_${response.status}`,
      );
    }
    if (!response.ok) return fail(`http_${response.status}`);
    const served = readServed(body, response.headers.get("x-provider-name"));
    if (choice.model === JEV_MODEL) {
      // Jev by another route: the pinned provider and build still apply.
      const problem = servedError(served);
      if (problem) return fail(problem);
    } else if (!served.model || !served.model.startsWith(choice.model))
      return fail("wrong_model");
    const read = readChoice(body, id, choices);
    if (!read.ok) return fail(read.code);
    return { ok: true, value: chooseFromJev(read.answer) };
  }

  async function viaBuiltin<P extends PortName>(
    port: P,
    input: PortInput<P>,
    signal: AbortSignal | undefined,
  ): Promise<Raw> {
    if (port === "choiceModel") {
      const raw = o.builtin.choiceModel;
      if (!raw) return fail("no_builtin");
      // A plain function over the choose input is wrapped as the client shape.
      const client: JevClient =
        typeof raw === "function"
          ? {
              ask: async (question, state, signal) => {
                const input = chooseInputOf("choice", question, state);
                const out = await raw(input, signal);
                return out
                  ? jevAnswerOf(out, input.question.choices)
                  : undefined;
              },
            }
          : raw;
      const { question, state: jevState } = input as ChooseInput;
      const answer = await client.ask(
        chooseQuestion(question),
        jevState,
        signal,
      );
      return answer ? { ok: true, value: chooseFromJev(answer) } : fail("none");
    }
    const fn = o.builtin[port] as BuiltinFn<P> | undefined;
    if (!fn) return fail("no_builtin");
    return { ok: true, value: await fn(input, signal) };
  }

  // The call ----------------------------------------------------------------------

  /** The built-in, as the port's adapter or (record false) standing in for one that failed: the status then keeps the adapter's code. */
  async function runBuiltin<P extends PortName>(
    port: P,
    input: PortInput<P>,
    settings: Settings,
    signal: AbortSignal | undefined,
    record = true,
  ): Promise<PortResult<P>> {
    const st = state[port];
    const started = now();
    let raw: Raw;
    try {
      raw = await viaBuiltin(port, input, signal);
    } catch {
      raw = fail("builtin_error");
    }
    const ms = now() - started;
    const checked = raw.ok ? check(port, input, raw.value, settings) : raw;
    const code = checked.ok
      ? "ok"
      : raw.ok
        ? `builtin_${checked.code}`
        : checked.code;
    if (record) {
      st.lastCode = code;
      st.lastMs = ms;
    }
    trace("ModuleCall", { port, kind: "builtin", ms, ok: checked.ok });
    if (checked.ok && ms > PORTS[port].budgetMs)
      trace("ModuleSlow", { port, kind: "builtin", ms });
    return checked.ok ? checked.value : NONE[port];
  }

  async function callPort<P extends PortName>(
    port: P,
    input: PortInput<P>,
    signal?: AbortSignal,
  ): Promise<PortResult<P>> {
    const settings = o.settings();
    const choice = resolve(settings, port);
    const st = state[port];
    st.calls++;
    const valid = contracts[port].input.safeParse(input);
    if (!valid.success) {
      st.lastCode = "bad_input";
      st.lastMs = 0;
      trace("ModuleCall", { port, kind: choice.kind, ms: 0, ok: false });
      return NONE[port];
    }
    const checkedInput = valid.data as PortInput<P>;
    const floored = floor(port, checkedInput, settings);
    if (floored) {
      st.lastCode = floored.code;
      st.lastMs = 0;
      trace("ModuleCall", { port, kind: choice.kind, ms: 0, ok: false });
      return floored.value;
    }
    if (choice.kind === "builtin")
      return runBuiltin(port, checkedInput, settings, signal);
    const started = now();
    const raw = await bounded(PORTS[port].timeoutMs, signal, (inner) => {
      switch (choice.kind) {
        case "mcp":
          return viaMcp(
            port,
            choice,
            checkedInput as Record<string, unknown>,
            inner,
          );
        case "http":
          return viaHttp(choice, checkedInput, settings, inner);
        case "openrouter":
          return port === "choiceModel"
            ? viaOpenRouter(
                choice,
                checkedInput as ChooseInput,
                settings,
                inner,
              )
            : Promise.resolve(fail("wrong_port"));
      }
    });
    const ms = now() - started;
    const checked = raw.ok
      ? check(port, checkedInput, raw.value, settings)
      : raw;
    if (checked.ok) {
      st.lastCode = "ok";
      st.lastMs = ms;
      trace("ModuleCall", { port, kind: choice.kind, ms, ok: true });
      if (ms > PORTS[port].budgetMs)
        trace("ModuleSlow", { port, kind: choice.kind, ms });
      return checked.value;
    }
    st.lastCode = checked.code;
    st.lastMs = ms;
    st.fallbacks++;
    trace("ModuleCall", { port, kind: choice.kind, ms, ok: false });
    trace("ModuleFallback", { port, kind: choice.kind, code: checked.code });
    return choice.fallback
      ? runBuiltin(port, checkedInput, settings, signal, false)
      : NONE[port];
  }

  const adapters = new Map<PortName, Adapter<PortName>>();
  const port = <P extends PortName>(name: P): Adapter<P> => {
    let adapter = adapters.get(name) as Adapter<P> | undefined;
    if (!adapter) {
      adapter = {
        port: name,
        kind: () => resolve(o.settings(), name).kind,
        call: (input, signal) => callPort(name, input, signal),
      };
      adapters.set(name, adapter as Adapter<PortName>);
    }
    return adapter;
  };

  return {
    port,
    jevClient(id = "choice"): JevClient {
      return {
        async ask(question, jevState, signal) {
          const input = chooseInputOf(id, question, jevState);
          const output = await callPort("choiceModel", input, signal);
          return output
            ? jevAnswerOf(output, input.question.choices)
            : undefined;
        },
      };
    },
    status() {
      const settings = o.settings();
      return Object.fromEntries(
        PORT_NAMES.map((name) => {
          const choice = resolve(settings, name);
          const target = targetOf(choice);
          const parts =
            choice.kind === "mcp"
              ? {
                  server: choice.server,
                  tool: choice.tool,
                  fallback: choice.fallback,
                }
              : choice.kind === "http"
                ? { url: choice.url, fallback: choice.fallback }
                : choice.kind === "openrouter"
                  ? { model: choice.model, fallback: choice.fallback }
                  : {};
          return [
            name,
            {
              ...state[name],
              kind: choice.kind,
              ...(target ? { target } : {}),
              ...parts,
            },
          ];
        }),
      ) as Record<PortName, PortStatus>;
    },
  };
}
