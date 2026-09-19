#!/usr/bin/env node
// The reference adapter server (.data/design/modules.md §8): one MCP stdio
// server exposing the four tool ports the app can put an adapter behind:
// segment_clauses (clauseSegmenter), decide_clause (fastDecider), choose
// (choiceModel) and open_url (urlOpener). It is what scripts/modules-check.mjs
// is tested against and what an adapter author copies from.
//
//   node examples/modules/mcp-modules/server.mjs [--allow-open]
//
// segment_clauses and decide_clause call the app's own built-ins
// (src/voice/stream.ts, src/voice/fast.ts) through the repository, so the
// example proves the wiring, not a new decider; tsx is registered here so
// plain `node` runs it. One visible difference a test can see: the label of
// every open_url decide_clause returns ends in " · example". choose is a
// stand-in that returns the first choice at p 0.5, below the decider's 0.85
// bar, so nothing is ever taken on its word. open_url validates the address
// (http or https, a host, no credentials: src/core/schema.ts webAddress) and
// runs `open <url>` (or `open -a <browser> <url>`) only when the server was
// started with --allow-open; otherwise it answers { navigated: false,
// method: "dry-run" }, so a check can call it without a window opening.
//
// The framing is newline-delimited JSON-RPC 2.0 with the MCP handshake, as
// tests/fixtures/mcp-fixture-server.mjs and the Apple bridge speak it: the
// repository ships the MCP client packages (@modelcontextprotocol/client,
// /core) and no server package, and forty lines of framing keep the example
// runnable with node alone. The tool schemas are the contracts' own
// (src/modules/contracts.ts): the input lenient, the output strict, which is
// what the app's client validates a structured result against.
//
// Nothing here reads the screen, keeps audio or text, or writes to disk;
// stderr carries one line at start and nothing the clause said.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(
    "Usage: node examples/modules/mcp-modules/server.mjs [--allow-open]\n\n" +
      "An MCP stdio server with segment_clauses, decide_clause, choose and open_url.\n" +
      "open_url runs `open <url>` only with --allow-open; otherwise it answers a dry run.\n",
  );
  process.exit(0);
}
const allowOpen = argv.includes("--allow-open");

const { register } = await import("tsx/esm/api");
register();
const { createClauseStream } = await import("../../../src/voice/stream.ts");
const { decideFast } = await import("../../../src/voice/fast.ts");
const { webAddress } = await import("../../../src/core/schema.ts");
const { contracts } = await import("../../../src/modules/contracts.ts");

const SERVER = { name: "mcp-modules-example", version: "0.1.0" };
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const TOOLS = [
  { name: "segment_clauses", title: "Segment clauses", annotations: READ_ONLY },
  { name: "decide_clause", title: "Decide a clause", annotations: READ_ONLY },
  { name: "choose", title: "Choose", annotations: READ_ONLY },
  {
    name: "open_url",
    title: "Open a URL",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
].map((tool) => ({
  ...tool,
  description: contracts[tool.name].description,
  inputSchema: contracts[tool.name].inputSchema,
  outputSchema: contracts[tool.name].outputSchema,
}));

// segment_clauses is stateless on the wire: the caller sends back the clauses
// it was given last time. The built-in stream keeps the time each clause's
// words last changed, which a Clause does not carry, so this server continues
// the live stream when `previous` is exactly what it returned last, and starts
// a fresh one otherwise (a new utterance, another caller, a restart). An
// adapter with no memory at all would commit by boundary only.
let live;
let lastReturned = "[]";
const sameClauses = (previous) => JSON.stringify(previous) === lastReturned;
function segment({ text, atMs, previous, final }) {
  if (!live || !sameClauses(previous)) live = createClauseStream();
  const events = final ? live.final(text, atMs) : live.push({ text, atMs });
  const clauses = live.clauses();
  if (final) live = undefined;
  lastReturned = final ? "[]" : JSON.stringify(clauses);
  return { clauses, events };
}

function decide({ clause, context }) {
  const action = decideFast(clause, context);
  return action.kind === "open_url"
    ? { ...action, label: `${action.label} · example` }
    : action;
}

const choose = ({ question }) => ({ choice: question.choices[0], p: 0.5 });

function openUrl({ url, browser }) {
  const parsed = webAddress(url);
  if (!parsed) return Promise.resolve({ error: "INVALID_URL" });
  if (!allowOpen)
    return Promise.resolve({ navigated: false, method: "dry-run" });
  const args = browser ? ["-a", browser, parsed.href] : [parsed.href];
  return new Promise((resolve) => {
    execFile("open", args, { timeout: 3000 }, (error) => {
      resolve(
        error
          ? { error: "OPEN_FAILED", method: browser ? "open -a" : "open" }
          : { navigated: true, method: browser ? "open -a" : "open" },
      );
    });
  });
}

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const structured = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
/** A tool-level failure: a code the caller can read, never the argument. */
const toolError = (code, value) => ({
  content: [{ type: "text", text: code }],
  structuredContent: value,
  isError: true,
});

async function call(id, params) {
  const name = params?.name;
  const contract = contracts[name];
  if (
    typeof name !== "string" ||
    !contract ||
    !TOOLS.some((t) => t.name === name)
  )
    return fail(id, -32602, "Unknown tool");
  const parsed = contract.input.safeParse(params.arguments ?? {});
  if (!parsed.success) {
    // The paths of what failed, never the values.
    const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
    return fail(id, -32602, `INVALID_ARGS: ${[...new Set(paths)].join(", ")}`);
  }
  const args = parsed.data;
  switch (name) {
    case "segment_clauses":
      return reply(id, structured(segment(args)));
    case "decide_clause":
      return reply(id, structured(decide(args)));
    case "choose":
      return reply(id, structured(choose(args)));
    case "open_url": {
      const out = await openUrl(args);
      if (out.error === "INVALID_URL")
        return fail(id, -32602, "INVALID_ARGS: url");
      if (out.error)
        return reply(
          id,
          toolError(out.error, { navigated: false, method: out.method }),
        );
      return reply(id, structured(out));
    }
  }
}

process.stderr.write(
  `${SERVER.name} ready${allowOpen ? " (open allowed)" : ""}\n`,
);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  if (!message || typeof message !== "object" || Array.isArray(message))
    return fail(null, -32600, "Invalid Request");
  const { id, method, params = {} } = message;
  if (typeof method !== "string") return;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call":
      void call(id, params).catch(() => fail(id, -32603, "Internal error"));
      return;
    default:
      if (id !== undefined) fail(id, -32601, "Method not found");
  }
});
process.stdin.on("end", () => process.exit(0));
