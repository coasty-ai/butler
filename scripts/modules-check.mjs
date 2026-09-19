// Conformance check for a port adapter (.data/design/modules.md §8): runs the
// partial timelines of tests/fixtures/partial-timelines.json through an
// adapter and prints, per case, its agreement with the built-in, its latency
// and every reply the port's contract refuses; then p50/p95 against the
// port's budget (src/modules/contracts.ts PORTS). No registry and no settings:
// an MCP adapter is the command itself, spawned over stdio with the SDK
// client, so a developer can test a server before connecting it in Settings.
//
//   node scripts/modules-check.mjs --port fastDecider --adapter builtin
//   node scripts/modules-check.mjs --port fastDecider --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
//   node scripts/modules-check.mjs --port clauseSegmenter --adapter mcp -- node examples/modules/mcp-modules/server.mjs
//   node scripts/modules-check.mjs --port choose --adapter http:https://host/choose --json
//   node scripts/modules-check.mjs --port urlOpener --call --adapter "mcp:node examples/modules/mcp-modules/server.mjs"
//
// Ports: fastDecider (decide_clause: every clause the built-in stream commits
// while speaking, and the final's, decided by both; agreement is the same
// kind and the same URL, application or direction), clauseSegmenter
// (segment_clauses: every partial and the final, the adapter told the clauses
// it returned last; agreement is the same committed, superseded and final
// events by index and words), choose (the decider's clause question for the
// same clauses; agreement is the act the rules decided, and a reply counts as
// taken only at p >= 0.85), urlOpener (open_url: the URLs the built-in
// decided, validated against the contract; called only with --call, since a
// live opener would load them). The built-in choice model is Jev over the
// network and needs a key, so --port choose takes an adapter.
//
// Content-free: case ids, clause indices, kinds, reasons, site keys, acts,
// counts and milliseconds. Never a clause's words, a URL, a label or a name;
// the fixtures are synthetic, but the rule holds. Exit 0 when every reply
// passed and the budget was met, 1 on any failed reply or a budget miss, 2 on
// a usage error or an adapter that could not be started.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    adapter: { type: "string", default: "builtin" },
    json: { type: "boolean", default: false },
    call: { type: "boolean", default: false },
    fixtures: {
      type: "string",
      default: resolve(root, "tests/fixtures/partial-timelines.json"),
    },
    timeout: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const USAGE = `Usage: node scripts/modules-check.mjs --port <port> [--adapter <adapter>] [--call] [--json] [--fixtures <file>] [--timeout <ms>]

  --port      fastDecider | clauseSegmenter | choose (choiceModel) | urlOpener
  --adapter   builtin (default)
              mcp:<command and arguments>   spawned over stdio; or "mcp" with the
                                            command after "--"
              http:<url>                    one https POST per call, JSON in and out
  --call      urlOpener only: call open_url with each URL (the adapter must be
              a dry-run one, or the pages load)
  --json      the same as data, on stdout
  --timeout   one call's deadline in ms (default: the port's)

Runs tests/fixtures/partial-timelines.json through the adapter and prints, per
case, agreement with the built-in, latency and failed replies; then p50/p95
against the port's budget. Codes, counts and milliseconds only, never words.
Exit 0 clean, 1 on a failed reply or a budget miss, 2 on a usage error.`;

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const usage = (message) => {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
};

const PORT_ALIASES = { choose: "choiceModel" };
const portName = PORT_ALIASES[values.port] ?? values.port;
const CHECKED = ["fastDecider", "clauseSegmenter", "choiceModel", "urlOpener"];
if (!portName || !CHECKED.includes(portName))
  usage(
    `--port must be one of fastDecider, clauseSegmenter, choose, urlOpener`,
  );
if (!existsSync(values.fixtures)) {
  console.error(`No such file: ${values.fixtures}`);
  process.exit(2);
}

// The built-ins and the contracts are TypeScript; tsx is registered here so
// `node scripts/modules-check.mjs` works on its own.
const { register } = await import("tsx/esm/api");
register();
const { createClauseStream } = await import("../src/voice/stream.ts");
const {
  decideFast,
  CLAUSE_ACTS,
  CLAUSE_QUESTION,
  JEV_CLAUSE_MIN_P,
  clauseState,
} = await import("../src/voice/fast.ts");
const { siteByKey, homeUrl } = await import("../src/voice/recipes.ts");
const { webAddress } = await import("../src/core/schema.ts");
const { PORTS, contracts, TOOL_SCHEMAS } =
  await import("../src/modules/contracts.ts");

const port = PORTS[portName];
// contracts is keyed by port ({input, output}); TOOL_SCHEMAS by tool.
const contract = { ...TOOL_SCHEMAS[port.tool], ...contracts[portName] };
const timeoutMs =
  Number(values.timeout) > 0 ? Number(values.timeout) : port.timeoutMs;
const fixture = JSON.parse(readFileSync(values.fixtures, "utf8"));
const timelines = Array.isArray(fixture?.timelines) ? fixture.timelines : [];
if (!timelines.length) {
  console.error("The fixtures file has no timelines.");
  process.exit(2);
}

// Adapters --------------------------------------------------------------------

function parseAdapter(spec) {
  if (spec === "builtin") return { kind: "builtin" };
  if (/^https?:\/\//.test(spec)) return { kind: "http", url: spec };
  if (spec.startsWith("http:")) return { kind: "http", url: spec.slice(5) };
  if (spec === "mcp" || spec.startsWith("mcp:")) {
    const words = spec
      .slice(3)
      .replace(/^:/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const argv = [...words, ...positionals];
    if (!argv.length) usage("An mcp adapter needs a command.");
    return { kind: "mcp", command: argv[0], args: argv.slice(1) };
  }
  return usage("--adapter must be builtin, mcp:<command>, or http:<url>.");
}
const spec = parseAdapter(values.adapter);
if (spec.kind === "http" && !webAddress(spec.url))
  usage("The http adapter needs an http(s) URL.");
if (spec.kind === "builtin" && portName === "choiceModel")
  usage(
    "The built-in choice model is Jev over the network: give --adapter an adapter to check.",
  );

/** A code from an error: the SDK's code or the error's name, code-shaped. */
const errorCode = (error) => {
  const raw = error?.code ?? error?.name ?? "error";
  return (
    String(raw)
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 40) || "error"
  );
};
const code = (value) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)
    ? value
    : undefined;
const timed = async (fn) => {
  const started = performance.now();
  try {
    const raw = await fn();
    return { raw, ms: performance.now() - started };
  } catch (error) {
    return { error: errorCode(error), ms: performance.now() - started };
  }
};

/** The built-in behind each tool, as far as it runs headless and offline. */
function builtinAdapter() {
  let stream;
  return {
    kind: "builtin",
    async start() {},
    reset() {
      stream = undefined;
    },
    call(tool, args) {
      return timed(() => {
        switch (tool) {
          case "segment_clauses": {
            stream ??= createClauseStream();
            const events = args.final
              ? stream.final(args.text, args.atMs)
              : stream.push({ text: args.text, atMs: args.atMs });
            return { clauses: stream.clauses(), events };
          }
          case "decide_clause":
            return decideFast(args.clause, args.context);
          case "open_url":
            // The built-in route (electron/open-url.ts) tells a browser; here a dry run.
            return webAddress(args.url)
              ? { navigated: false, method: "dry-run" }
              : Promise.reject(new Error("INVALID_URL"));
          default:
            throw new Error("unsupported");
        }
      });
    },
    async close() {},
  };
}

/** The command spawned over stdio and spoken to with the SDK client, as the app does. */
async function mcpAdapter({ command, args }) {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/client/stdio");
  const client = new Client(
    { name: "modules-check", version: "1" },
    { capabilities: {} },
  );
  client.onerror = () => {};
  const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  let tools = [];
  return {
    kind: "mcp",
    tools: () => tools,
    async start() {
      await client.connect(transport, { timeout: 10_000 });
      tools = (await client.listTools(undefined, { timeout: 10_000 })).tools;
    },
    reset() {},
    call(tool, args) {
      return timed(async () => {
        const result = await client.callTool(
          { name: tool, arguments: args },
          { timeout: timeoutMs },
        );
        if (result.isError)
          throw Object.assign(new Error("tool"), { code: "TOOL_ERROR" });
        if (result.structuredContent !== undefined)
          return result.structuredContent;
        const text = result.content?.find((c) => c.type === "text")?.text;
        return text === undefined ? undefined : JSON.parse(text);
      });
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

/** One JSON POST per call. */
function httpAdapter({ url }) {
  return {
    kind: "http",
    async start() {},
    reset() {},
    call(_tool, args) {
      return timed(async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
          throw Object.assign(new Error("http"), {
            code: `HTTP_${response.status}`,
          });
        return await response.json();
      });
    },
    async close() {},
  };
}

// The check -------------------------------------------------------------------

/** The reply through the contract: ok with the parsed value, or a failure code. */
function judge(reply) {
  if (reply.error) return { ok: false, code: reply.error };
  const parsed = contract.output.safeParse(reply.raw);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".");
    return { ok: false, code: `schema:${code(path) ?? "root"}` };
  }
  return { ok: true, value: parsed.data };
}
const caseId = (t, i) => code(t.id) ?? `case-${i + 1}`;
/** A fast action as a code: kind, and its reason or site key. */
function actionCode(action) {
  switch (action.kind) {
    case "open_url":
      return `open_url:${code(action.siteKey) ?? "-"}`;
    case "none":
      return `none:${action.reason}`;
    case "scroll":
      return `scroll:${action.direction}`;
    default:
      return action.kind;
  }
}
/** The same kind, and the same URL, application or direction. */
function sameAction(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "open_url":
      return a.url === b.url;
    case "open_app":
      return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
    case "scroll":
      return a.direction === b.direction;
    default:
      return true;
  }
}
/** The clause act the rules' decision amounts to (the choice question's options). */
function actOf(action) {
  switch (action.kind) {
    case "open_app":
      return "open_app";
    case "scroll":
      return "scroll";
    case "open_url": {
      const site = action.siteKey ? siteByKey(action.siteKey) : undefined;
      const parsed = webAddress(action.url);
      const home =
        (site && homeUrl(site) === action.url) ||
        (parsed && parsed.pathname === "/" && !parsed.search && !parsed.hash);
      return home ? "open_site" : "search_on_site";
    }
    default:
      return action.reason === "not_navigational"
        ? "not_navigational"
        : "unclear";
  }
}
/** Committed clauses and superseded events as codes and words, for agreement only (never printed). */
function eventShape(events) {
  return JSON.stringify(
    events.map((e) => {
      switch (e.kind) {
        case "committed":
          return ["c", e.clause.index, e.clause.text.toLowerCase(), e.by];
        case "superseded":
          return ["s", e.clause.index, e.replacement.text.toLowerCase()];
        case "final":
          return [
            "f",
            e.clauses.map((c) => c.text.toLowerCase()),
            e.dropped.map((c) => c.text.toLowerCase()),
          ];
        default:
          return ["?"];
      }
    }),
  );
}
const clauseShape = (clauses) =>
  JSON.stringify(clauses.map((c) => [c.index, c.text.toLowerCase(), c.state]));

/**
 * Drives the built-in stream through one timeline the way the executor does
 * and hands every clause decided (each committed clause, and the final's
 * clauses committed only then; a replacement deciding to the same action is a
 * repeat and is skipped) to `onClause(clause, by, ctx, expected)`.
 */
async function driveClauses(t, onClause) {
  const ctx = { ...t.ctx, protectedHosts: [...(t.ctx?.protectedHosts ?? [])] };
  const stream = createClauseStream();
  const issued = new Map();
  const decide = async (clause, by) => {
    const expected = decideFast(clause, ctx);
    const key = JSON.stringify(expected);
    if (issued.get(clause.index) === key) return;
    issued.set(clause.index, key);
    await onClause(clause, by, { ...ctx }, expected);
    if (expected.kind === "open_url")
      ctx.frontHost = new URL(expected.url).hostname;
  };
  for (const sample of t.samples)
    for (const event of stream.push(sample))
      if (event.kind === "committed") await decide(event.clause, event.by);
  const [final] = stream.final(t.final.text, t.final.atMs);
  for (const clause of final.clauses)
    if (clause.committedAtMs === t.final.atMs) await decide(clause, "final");
}

const adapter =
  spec.kind === "builtin"
    ? builtinAdapter()
    : spec.kind === "mcp"
      ? await mcpAdapter(spec)
      : httpAdapter(spec);
try {
  await adapter.start();
} catch (error) {
  console.error(`adapter failed to start: ${errorCode(error)}`);
  await adapter.close();
  process.exit(2);
}
let listed;
if (adapter.kind === "mcp") {
  const tool = adapter.tools().find((x) => x.name === port.tool);
  listed = {
    tools: adapter.tools().length,
    present: !!tool,
    annotations: {
      readOnlyHint: tool?.annotations?.readOnlyHint,
      destructiveHint: tool?.annotations?.destructiveHint,
      openWorldHint: tool?.annotations?.openWorldHint,
    },
    outputSchema: !!tool?.outputSchema,
  };
  if (!tool) {
    console.error(
      `tool ${port.tool} is not listed by the server (${listed.tools} tools)`,
    );
    await adapter.close();
    process.exit(2);
  }
}

const cases = [];
const record = (bucket, row) => {
  bucket.rows.push(row);
  bucket.calls += 1;
  if (row.agree === true) bucket.agree += 1;
  if (row.failure) bucket.failures += 1;
  if (typeof row.ms === "number") bucket.latencies.push(row.ms);
};
const newCase = (t, i) => ({
  id: caseId(t, i),
  calls: 0,
  agree: 0,
  failures: 0,
  latencies: [],
  rows: [],
});

for (const [i, t] of timelines.entries()) {
  const bucket = newCase(t, i);
  adapter.reset?.();
  switch (portName) {
    case "fastDecider":
      await driveClauses(t, async (clause, by, ctx, expected) => {
        const reply = await adapter.call("decide_clause", {
          clause,
          context: ctx,
        });
        const verdict = judge(reply);
        record(bucket, {
          clause: clause.index,
          by,
          expected: actionCode(expected),
          actual: verdict.ok ? actionCode(verdict.value) : verdict.code,
          agree: verdict.ok ? sameAction(expected, verdict.value) : false,
          ms: Math.round(reply.ms),
          failure: verdict.ok ? undefined : verdict.code,
        });
      });
      break;
    case "clauseSegmenter": {
      const stream = createClauseStream();
      let previous = [];
      const step = async (label, args, expectedEvents) => {
        const reply = await adapter.call("segment_clauses", args);
        const verdict = judge(reply);
        const agree =
          verdict.ok &&
          eventShape(expectedEvents) === eventShape(verdict.value.events) &&
          clauseShape(stream.clauses()) === clauseShape(verdict.value.clauses);
        if (verdict.ok) previous = verdict.value.clauses;
        record(bucket, {
          sample: label,
          events: expectedEvents.length,
          agree,
          ms: Math.round(reply.ms),
          failure: verdict.ok ? undefined : verdict.code,
        });
      };
      for (const [k, sample] of t.samples.entries())
        await step(
          k,
          { text: sample.text, atMs: sample.atMs, previous },
          stream.push(sample),
        );
      await step(
        "final",
        { text: t.final.text, atMs: t.final.atMs, previous, final: true },
        stream.final(t.final.text, t.final.atMs),
      );
      break;
    }
    case "choiceModel":
      await driveClauses(t, async (clause, by, ctx, expected) => {
        const question = {
          id: "clause",
          choices: [...CLAUSE_ACTS],
          prompt: CLAUSE_QUESTION.instructions.question,
        };
        const reply = await adapter.call("choose", {
          question,
          state: clauseState(clause, ctx),
        });
        let verdict = judge(reply);
        if (verdict.ok && !question.choices.includes(verdict.value.choice))
          verdict = { ok: false, code: "choice_not_offered" };
        const act = actOf(expected);
        record(bucket, {
          clause: clause.index,
          by,
          expected: act,
          actual: verdict.ok ? verdict.value.choice : verdict.code,
          p: verdict.ok ? Number(verdict.value.p.toFixed(3)) : undefined,
          taken: verdict.ok ? verdict.value.p >= JEV_CLAUSE_MIN_P : false,
          agree: verdict.ok ? verdict.value.choice === act : false,
          ms: Math.round(reply.ms),
          failure: verdict.ok ? undefined : verdict.code,
        });
      });
      break;
    case "urlOpener":
      await driveClauses(t, async (clause, by, _ctx, expected) => {
        if (expected.kind !== "open_url") return;
        const valid = contract.input.safeParse({ url: expected.url }).success;
        const row = {
          clause: clause.index,
          by,
          site: code(expected.siteKey) ?? "-",
          valid,
          agree: valid,
          failure: valid ? undefined : "input:url",
        };
        if (values.call) {
          const reply = await adapter.call("open_url", { url: expected.url });
          const verdict = judge(reply);
          row.ms = Math.round(reply.ms);
          row.method = verdict.ok
            ? (code(verdict.value.method) ?? "-")
            : undefined;
          row.navigated = verdict.ok ? verdict.value.navigated : undefined;
          if (!verdict.ok) {
            row.failure = verdict.code;
            row.agree = false;
          }
        }
        record(bucket, row);
      });
      break;
  }
  cases.push(bucket);
}
await adapter.close();

// The summary ------------------------------------------------------------------

const percentile = (list, p) => {
  if (!list.length) return undefined;
  const sorted = [...list].sort((a, b) => a - b);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
    ],
  );
};
const all = cases.flatMap((c) => c.latencies);
const calls = cases.reduce((n, c) => n + c.calls, 0);
const agree = cases.reduce((n, c) => n + c.agree, 0);
const failures = cases.reduce((n, c) => n + c.failures, 0);
const p50 = percentile(all, 0.5);
const p95 = percentile(all, 0.95);
const budget =
  p50 === undefined
    ? "no data"
    : p50 <= port.budgetMs && p95 <= port.timeoutMs
      ? "met"
      : "missed";
const taken =
  portName === "choiceModel"
    ? cases.reduce((n, c) => n + c.rows.filter((r) => r.taken).length, 0)
    : undefined;
const exitCode = failures > 0 || budget === "missed" ? 1 : 0;
const summary = {
  calls,
  agree,
  agreementPct: calls ? Math.round((agree / calls) * 1000) / 10 : undefined,
  failures,
  p50Ms: p50,
  p95Ms: p95,
  budget,
  ...(taken !== undefined ? { taken } : {}),
  exit: exitCode,
};
const data = {
  port: portName,
  tool: port.tool,
  adapter: adapter.kind,
  budget: { p50Ms: port.budgetMs, p95Ms: port.timeoutMs },
  timeoutMs,
  ...(listed ? { server: listed } : {}),
  cases: cases.map(({ latencies: _l, ...c }) => ({
    ...c,
    p50Ms: percentile(latencies(c), 0.5),
  })),
  summary,
};
function latencies(c) {
  return c.rows.map((r) => r.ms).filter((ms) => typeof ms === "number");
}

if (values.json) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n", () =>
    process.exit(exitCode),
  );
} else {
  const lines = [];
  lines.push(
    `modules-check: port ${portName} (tool ${port.tool}) · adapter ${adapter.kind} · budget p50 ≤ ${port.budgetMs} ms, p95 ≤ ${port.timeoutMs} ms · timeout ${timeoutMs} ms`,
  );
  if (listed)
    lines.push(
      `server: ${listed.tools} tools listed · ${port.tool} present · annotations readOnly=${listed.annotations.readOnlyHint ?? "-"} destructive=${listed.annotations.destructiveHint ?? "-"} openWorld=${listed.annotations.openWorldHint ?? "-"} · outputSchema ${listed.outputSchema ? "declared" : "absent"}`,
    );
  for (const c of data.cases) {
    const p = c.p50Ms === undefined ? "" : ` · p50 ${c.p50Ms} ms`;
    lines.push(
      `case ${c.id}: ${c.calls} calls · agree ${c.agree}/${c.calls} · failures ${c.failures}${p}`,
    );
    for (const r of c.rows) {
      const ms = typeof r.ms === "number" ? ` · ${r.ms} ms` : "";
      const fail = r.failure ? ` · FAIL ${r.failure}` : "";
      switch (portName) {
        case "fastDecider":
          lines.push(
            `  clause ${r.clause} (${r.by}): builtin ${r.expected} · adapter ${r.actual} · ${r.agree ? "agree" : "differ"}${ms}${fail}`,
          );
          break;
        case "clauseSegmenter":
          lines.push(
            `  sample ${r.sample}: ${r.events} builtin events · ${r.agree ? "agree" : "differ"}${ms}${fail}`,
          );
          break;
        case "choiceModel":
          lines.push(
            `  clause ${r.clause} (${r.by}): rules ${r.expected} · adapter ${r.actual}${r.p === undefined ? "" : ` p=${r.p}`}${r.taken ? " (taken)" : r.p === undefined ? "" : ` (below ${JEV_CLAUSE_MIN_P}, not taken)`} · ${r.agree ? "agree" : "differ"}${ms}${fail}`,
          );
          break;
        case "urlOpener":
          lines.push(
            `  clause ${r.clause} (${r.by}): open_url:${r.site} · ${r.valid ? "valid" : "invalid"}${r.method ? ` · ${r.method}${r.navigated ? " navigated" : ""}` : values.call ? "" : " · not called (no --call)"}${ms}${fail}`,
          );
          break;
      }
    }
  }
  lines.push(
    `summary: ${calls} calls · agree ${agree}/${calls}${summary.agreementPct === undefined ? "" : ` (${summary.agreementPct}%)`} · failures ${failures} · latency ${p50 === undefined ? "no data" : `p50 ${p50} ms, p95 ${p95} ms`} · budget ${budget}${taken !== undefined ? ` · taken ${taken}/${calls}` : ""}`,
  );
  process.stdout.write(lines.join("\n") + "\n", () => process.exit(exitCode));
}
