import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * The conformance check (scripts/modules-check.mjs) against the reference
 * adapter server (examples/modules/mcp-modules/server.mjs), both spawned for
 * real: the check speaks to the server with the SDK client over stdio, runs
 * tests/fixtures/partial-timelines.json through it and prints agreement with
 * the built-in, latency against the port's budget and failed replies, in
 * codes, counts and milliseconds only. The server's own replies are checked
 * with a client of this test's too, including the one visible difference it
 * keeps from the built-in.
 */
const root = resolve(__dirname, "..");
const script = join(root, "scripts", "modules-check.mjs");
const server = join(root, "examples", "modules", "mcp-modules", "server.mjs");
const fixture = JSON.parse(
  readFileSync(join(root, "tests/fixtures/partial-timelines.json"), "utf8"),
) as {
  timelines: {
    id: string;
    samples: { text: string }[];
    final: { text: string };
    expect: {
      actions: { kind: string }[];
      finalActions: { kind: string }[];
    };
  }[];
};
/** Every open_url the fixtures expect the built-in to issue: what --port urlOpener validates. */
const openUrls = fixture.timelines.reduce(
  (n, t) =>
    n +
    [...t.expect.actions, ...t.expect.finalActions].filter(
      (a) => a.kind === "open_url",
    ).length,
  0,
);
/**
 * Words of the fixtures' objects that are never a code the check prints (a
 * site key, a kind, a case id such as "google-weather"), and the marks of a
 * URL: none may appear in any output.
 */
const NEVER_PRINTED = [
  "midwest",
  "safety",
  "austin",
  "pepper",
  "balance",
  "https://",
  "search_query",
  "%20",
];
const sampleTexts = fixture.timelines.flatMap((t) => [
  ...t.samples.map((s) => s.text),
  t.final.text,
]);
function contentFree(output: string) {
  const lower = output.toLowerCase();
  for (const word of NEVER_PRINTED) expect(lower).not.toContain(word);
  for (const text of sampleTexts)
    if (text.split(" ").length > 1)
      expect(lower).not.toContain(text.toLowerCase());
}

const exampleAdapter = `mcp:${process.execPath} ${server}`;
function run(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 110_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        done({ status, stdout, stderr });
      });
    },
  );
}
type Report = {
  port: string;
  tool: string;
  adapter: string;
  server?: {
    tools: number;
    present: boolean;
    annotations: Record<string, boolean | undefined>;
    outputSchema: boolean;
  };
  cases: {
    id: string;
    calls: number;
    agree: number;
    failures: number;
    rows: Record<string, unknown>[];
  }[];
  summary: {
    calls: number;
    agree: number;
    agreementPct?: number;
    failures: number;
    p50Ms?: number;
    p95Ms?: number;
    budget: string;
    taken?: number;
    exit: number;
  };
};
const LONG = 120_000;

describe("scripts/modules-check.mjs against examples/modules/mcp-modules", () => {
  it(
    "fastDecider: every clause decided alike, no failed reply, the budget met, nothing of the words printed",
    async () => {
      const text = await run([
        "--port",
        "fastDecider",
        "--adapter",
        exampleAdapter,
      ]);
      expect(text.stderr).toBe("");
      expect(text.status).toBe(0);
      expect(text.stdout).toContain(
        "port fastDecider (tool decide_clause) · adapter mcp",
      );
      expect(text.stdout).toContain(
        "server: 4 tools listed · decide_clause present · annotations readOnly=true destructive=false openWorld=false · outputSchema declared",
      );
      expect(text.stdout).toContain(
        "clause 0 (boundary): builtin open_url:youtube · adapter open_url:youtube · agree",
      );
      expect(text.stdout).toContain(
        "builtin none:protected · adapter none:protected · agree",
      );
      expect(text.stdout).toMatch(
        /summary: 18 calls · agree 18\/18 \(100%\) · failures 0 · latency p50 \d+ ms, p95 \d+ ms · budget met/,
      );
      contentFree(text.stdout);

      const json = await run([
        "--port",
        "fastDecider",
        "--adapter",
        exampleAdapter,
        "--json",
      ]);
      expect(json.status).toBe(0);
      const report = JSON.parse(json.stdout) as Report;
      expect(report.port).toBe("fastDecider");
      expect(report.tool).toBe("decide_clause");
      expect(report.adapter).toBe("mcp");
      expect(report.server).toEqual({
        tools: 4,
        present: true,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        outputSchema: true,
      });
      expect(report.cases.map((c) => c.id)).toEqual(
        fixture.timelines.map((t) => t.id),
      );
      expect(report.summary).toMatchObject({
        calls: 18,
        agree: 18,
        agreementPct: 100,
        failures: 0,
        budget: "met",
        exit: 0,
      });
      const owner = report.cases.find((c) => c.id === "owner-youtube")!;
      expect(owner.rows).toEqual([
        expect.objectContaining({
          clause: 0,
          by: "boundary",
          expected: "open_url:youtube",
          actual: "open_url:youtube",
          agree: true,
        }),
        expect.objectContaining({ clause: 1, by: "stable", agree: true }),
      ]);
      contentFree(json.stdout);
    },
    LONG,
  );

  it(
    "clauseSegmenter: every partial and the final segmented alike",
    async () => {
      const { status, stdout } = await run([
        "--port",
        "clauseSegmenter",
        "--adapter",
        "mcp",
        "--json",
        "--",
        process.execPath,
        server,
      ]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.tool).toBe("segment_clauses");
      const calls = fixture.timelines.reduce(
        (n, t) => n + t.samples.length + 1,
        0,
      );
      expect(report.summary).toMatchObject({
        calls,
        agree: calls,
        failures: 0,
        budget: "met",
        exit: 0,
      });
      const owner = report.cases.find((c) => c.id === "owner-youtube")!;
      // The boundary commit at sample 4, the stability commit at sample 8, the supersede at 9, the final.
      expect(owner.rows.map((r) => r.events)).toEqual([
        0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1,
      ]);
      expect(owner.rows.at(-1)).toMatchObject({ sample: "final", agree: true });
      contentFree(stdout);
    },
    LONG,
  );

  it(
    "choose: the stand-in's first choice at p 0.5 passes the contract, agrees rarely and is never taken",
    async () => {
      const { status, stdout } = await run([
        "--port",
        "choose",
        "--adapter",
        exampleAdapter,
        "--json",
      ]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.port).toBe("choiceModel");
      expect(report.tool).toBe("choose");
      expect(report.summary.failures).toBe(0);
      expect(report.summary.taken).toBe(0);
      expect(report.summary.agree).toBeLessThan(report.summary.calls);
      for (const row of report.cases.flatMap((c) => c.rows))
        expect(row).toMatchObject({ actual: "open_app", p: 0.5, taken: false });
      // The act the rules decided, for the owner's sentence: the site, then a search on it.
      const owner = report.cases.find((c) => c.id === "owner-youtube")!;
      expect(owner.rows.map((r) => r.expected)).toEqual([
        "open_site",
        "search_on_site",
      ]);
      contentFree(stdout);
      const text = await run(["--port", "choose", "--adapter", exampleAdapter]);
      expect(text.stdout).toContain(
        "adapter open_app p=0.5 (below 0.85, not taken) · differ",
      );
      expect(text.stdout).toContain(`· taken 0/${report.summary.calls}`);
    },
    LONG,
  );

  it(
    "urlOpener: every URL the built-in decided is valid, and --call gets the example's dry run",
    async () => {
      const dry = await run([
        "--port",
        "urlOpener",
        "--adapter",
        exampleAdapter,
        "--json",
      ]);
      expect(dry.status).toBe(0);
      const declared = JSON.parse(dry.stdout) as Report;
      expect(declared.server?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(declared.summary).toMatchObject({
        calls: openUrls,
        agree: openUrls,
        failures: 0,
        budget: "no data",
        exit: 0,
      });
      for (const row of declared.cases.flatMap((c) => c.rows)) {
        expect(row).toMatchObject({ valid: true });
        expect(row).not.toHaveProperty("method");
      }
      const called = await run([
        "--port",
        "urlOpener",
        "--call",
        "--adapter",
        exampleAdapter,
        "--json",
      ]);
      expect(called.status).toBe(0);
      const report = JSON.parse(called.stdout) as Report;
      expect(report.summary).toMatchObject({
        calls: openUrls,
        failures: 0,
        budget: "met",
      });
      for (const row of report.cases.flatMap((c) => c.rows))
        expect(row).toMatchObject({
          valid: true,
          method: "dry-run",
          navigated: false,
        });
      contentFree(called.stdout);
      const text = await run([
        "--port",
        "urlOpener",
        "--adapter",
        exampleAdapter,
      ]);
      expect(text.stdout).toContain(
        "open_url:youtube · valid · not called (no --call)",
      );
    },
    LONG,
  );

  it(
    "builtin: the built-in against itself agrees everywhere and fits its own contract",
    async () => {
      const { status, stdout } = await run([
        "--port",
        "fastDecider",
        "--adapter",
        "builtin",
        "--json",
      ]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Report;
      expect(report.adapter).toBe("builtin");
      expect(report.server).toBeUndefined();
      expect(report.summary).toMatchObject({
        calls: 18,
        agree: 18,
        failures: 0,
        budget: "met",
      });
      const segments = await run([
        "--port",
        "clauseSegmenter",
        "--adapter",
        "builtin",
        "--json",
      ]);
      expect(segments.status).toBe(0);
      expect((JSON.parse(segments.stdout) as Report).summary).toMatchObject({
        failures: 0,
        budget: "met",
      });
    },
    LONG,
  );

  it(
    "usage: --help, an unknown port, the built-in choice model, and an adapter that never starts",
    async () => {
      const help = await run(["--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain(
        "--port      fastDecider | clauseSegmenter | choose (choiceModel) | urlOpener",
      );
      const port = await run(["--port", "tts"]);
      expect(port.status).toBe(2);
      expect(port.stderr).toContain("--port must be one of");
      const choose = await run(["--port", "choose", "--adapter", "builtin"]);
      expect(choose.status).toBe(2);
      expect(choose.stderr).toContain("Jev over the network");
      const dead = await run([
        "--port",
        "fastDecider",
        "--adapter",
        `mcp:${process.execPath} -e process.exit(3)`,
      ]);
      expect(dead.status).toBe(2);
      expect(dead.stderr).toContain("adapter failed to start");
    },
    LONG,
  );
});

describe("the http adapter", () => {
  let http: Server | undefined;
  afterAll(() => http?.close());

  it(
    "counts a reply the contract refuses as a failure and exits 1",
    async () => {
      http = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          // The request is the contract's; the reply is not: an open_url with no url.
          const args = JSON.parse(body) as { clause?: { index: number } };
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ kind: "open_url", index: args.clause?.index }),
          );
        });
      });
      await new Promise<void>((ready) => http!.listen(0, "127.0.0.1", ready));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const { status, stdout } = await run([
        "--port",
        "fastDecider",
        "--adapter",
        `http:http://127.0.0.1:${address.port}/decide_clause`,
        "--json",
      ]);
      expect(status).toBe(1);
      const report = JSON.parse(stdout) as Report;
      expect(report.adapter).toBe("http");
      expect(report.summary).toMatchObject({
        calls: 18,
        agree: 0,
        failures: 18,
        exit: 1,
      });
      for (const row of report.cases.flatMap((c) => c.rows))
        expect(row).toMatchObject({
          agree: false,
          failure: "schema:url",
          actual: "schema:url",
        });
      contentFree(stdout);
    },
    LONG,
  );
});

describe("examples/modules/mcp-modules/server.mjs through the SDK client", () => {
  const client = new Client(
    { name: "modules-check-test", version: "1" },
    { capabilities: {} },
  );
  afterAll(() => client.close());

  it(
    "lists the four tools with the contracts' schemas and honest annotations, decides with the built-in plus its one difference, chooses the first at 0.5, and dry-runs open_url",
    async () => {
      client.onerror = () => {};
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [server],
          stderr: "pipe",
        }),
        { timeout: 20_000 },
      );
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "segment_clauses",
        "decide_clause",
        "choose",
        "open_url",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect((tool.outputSchema as { type?: string } | undefined)?.type).toBe(
          "object",
        );
        expect(tool.description?.length).toBeGreaterThan(20);
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      for (const name of ["segment_clauses", "decide_clause", "choose"])
        expect(byName[name].annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      expect(byName.open_url.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });

      const clause = (text: string, index = 0) => ({
        index,
        text,
        startWord: 0,
        endWord: text.split(" ").length,
        state: "committed",
        committedAtMs: 0,
      });
      const decided = await client.callTool({
        name: "decide_clause",
        arguments: {
          clause: clause("go to youtube"),
          context: { protectedHosts: [] },
        },
      });
      // The built-in's decision, and the example's mark on the label.
      expect(decided.structuredContent).toEqual({
        kind: "open_url",
        url: "https://www.youtube.com/",
        siteKey: "youtube",
        label: "YouTube · example",
      });
      const protectedHost = await client.callTool({
        name: "decide_clause",
        arguments: {
          clause: clause("go to paypal dot com"),
          context: { protectedHosts: ["paypal.com"] },
        },
      });
      expect(protectedHost.structuredContent).toEqual({
        kind: "none",
        reason: "protected",
      });

      const first = await client.callTool({
        name: "segment_clauses",
        arguments: { text: "go to youtube and play", atMs: 640, previous: [] },
      });
      const firstOut = first.structuredContent as {
        clauses: { index: number; state: string }[];
        events: { kind: string; by?: string }[];
      };
      expect(firstOut.events).toEqual([
        expect.objectContaining({ kind: "committed", by: "boundary" }),
      ]);
      expect(firstOut.clauses.map((c) => c.state)).toEqual([
        "committed",
        "growing",
      ]);
      const second = await client.callTool({
        name: "segment_clauses",
        arguments: {
          text: "go to youtube and play a midwest safety video",
          atMs: 2300,
          previous: firstOut.clauses,
          final: true,
        },
      });
      const secondOut = second.structuredContent as {
        clauses: unknown[];
        events: { kind: string; dropped?: unknown[] }[];
      };
      expect(secondOut.events).toEqual([
        expect.objectContaining({ kind: "final", dropped: [] }),
      ]);
      expect(secondOut.clauses).toHaveLength(2);

      const chosen = await client.callTool({
        name: "choose",
        arguments: {
          question: {
            id: "clause",
            choices: ["open_site", "scroll"],
            prompt: "Which?",
          },
          state: { clause: "anything" },
        },
      });
      expect(chosen.structuredContent).toEqual({ choice: "open_site", p: 0.5 });

      const opened = await client.callTool({
        name: "open_url",
        arguments: { url: "https://www.youtube.com/" },
      });
      expect(opened.structuredContent).toEqual({
        navigated: false,
        method: "dry-run",
      });
      // A refused address is a protocol error naming the field, never a launch.
      await expect(
        client.callTool({
          name: "open_url",
          arguments: { url: "ftp://example.com/" },
        }),
      ).rejects.toThrow(/INVALID_ARGS: url/);
      await expect(
        client.callTool({
          name: "open_url",
          arguments: { url: "https://user:pw@example.com/" },
        }),
      ).rejects.toThrow(/INVALID_ARGS: url/);
      await expect(
        client.callTool({ name: "decide_clause", arguments: { clause: {} } }),
      ).rejects.toThrow(/INVALID_ARGS/);
      await expect(
        client.callTool({ name: "speak", arguments: { text: "hi" } }),
      ).rejects.toThrow(/Unknown tool/);
    },
    LONG,
  );
});
