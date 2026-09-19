import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolServerSchema, type ToolServer } from "../src/core/schema";
import {
  TOOL_LIMITS,
  type AppleConsent,
  type BuiltinServer,
  type ToolSpec,
} from "../src/core/tools";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  createMcpProvider,
  failureCode,
  refusalCode,
  type McpProvider,
} from "../src/tools/mcp";

/**
 * The MCP client against tests/fixtures/mcp-fixture-server.mjs, spawned the
 * way a user's server is: through the launcher (tests/fixtures/fake-launch.mjs
 * records what coarena-launch would have been given) with the minimal
 * environment, then listed, ticked, pinned, tiered and called.
 */
const fixture = fileURLToPath(
  new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url),
);
const launcher = fileURLToPath(
  new URL("./fixtures/fake-launch.mjs", import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), "butler-mcp-"));
const home = join(scratch, "home");
const providers: McpProvider[] = [];

beforeAll(() => {
  // The launcher records into $TMPDIR, the one writable place in the child's
  // fixed environment.
  process.env.TMPDIR = scratch;
  process.env.COARENA_TEST_LEAK = "must-not-reach-the-child";
});
afterEach(async () => {
  for (const p of providers.splice(0)) await p.close();
  for (const name of readdirSync(scratch))
    if (name.startsWith("fake-launch-")) rmSync(join(scratch, name));
});

const row = (over: Partial<ToolServer> = {}): ToolServer =>
  toolServerSchema.parse({
    id: "fixture",
    name: "Fixture",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    enabled: true,
    consented: true,
    network: "none",
    addedAt: 0,
    ...over,
  });
const signal = { signal: new AbortController().signal };

/** A started provider whose listed tools are all ticked at their current pins. */
async function started(
  o: {
    row?: Partial<ToolServer>;
    launch?: boolean;
    tick?: (name: string) => boolean;
    trace?: (event: string, data: Record<string, unknown>) => void;
    timers?: { fn: () => void; ms: number }[];
    now?: () => number;
  } = {},
) {
  const ticks: ToolServer["tools"] = {};
  const provider = createMcpProvider(
    {
      kind: "server",
      row: row(o.row),
      command: process.execPath,
      launch: o.launch === false ? undefined : launcher,
      secrets: { env: {}, headers: {} },
    },
    {
      home,
      version: "0.1.0-test",
      ticks: () => ticks,
      trace: o.trace,
      now: o.now,
      ...(o.timers
        ? {
            setTimer: (fn: () => void, ms: number) =>
              o.timers!.push({ fn, ms }) - 1,
            clearTimer: () => {},
          }
        : {}),
    },
  );
  providers.push(provider);
  await provider.start();
  for (const entry of provider.catalog())
    if (!entry.denied && (o.tick?.(entry.name) ?? true))
      ticks[entry.name] = { on: true, pin: provider.pinOf(entry.name)! };
  return { provider, ticks };
}
const records = () =>
  readdirSync(scratch)
    .filter((name) => name.startsWith("fake-launch-"))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(scratch, name), "utf8")) as {
          flags: string[];
          command: string;
          args: string[];
          env: Record<string, string>;
        },
    );
const named = (specs: ToolSpec[], name: string) =>
  specs.find((spec) => spec.name === name)!;

describe("MCP client: listing", () => {
  it("lists ticked tools with tiers from annotations and the vocabulary, never a denylisted name", async () => {
    const { provider } = await started();
    expect(provider.state()).toMatchObject({ state: "on" });
    const specs = await provider.tools(signal.signal);
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("bash");
    expect(named(specs, "read_note")).toMatchObject({
      id: "fixture__read_note",
      provider: "fixture",
      title: "Fixture",
      tier: "read",
      trusted: false,
      local: true,
      openWorld: true,
      undoable: false,
      longRunning: false,
      transport: "stdio",
      timeoutMs: TOOL_LIMITS.callTimeoutMs,
      dateKeys: [],
    });
    expect(named(specs, "read_note").does).toBe(
      "Read a note: Reads one note by name.",
    );
    expect(named(specs, "read_note").params).toBe("name (text)");
    expect(named(specs, "save_note").tier).toBe("write");
    expect(named(specs, "plain_tool").tier).toBe("destructive");
    expect(named(specs, "when").dateKeys).toEqual(["start"]);
    expect(named(specs, "when").params).toBe(
      "start (text, date-time), note? (text)",
    );
    // Content-free trace codes: a hash of the server id and of the tool id.
    expect(named(specs, "read_note").trace).toEqual({
      server: expect.stringMatching(/^s[0-9a-f]{12}$/),
      tool: expect.stringMatching(/^t[0-9a-f]{12}$/),
    });
    const catalog = provider.catalog();
    expect(catalog.find((c) => c.name === "bash")).toMatchObject({
      denied: true,
      on: false,
    });
    expect(catalog.find((c) => c.name === "read_note")).toMatchObject({
      on: true,
      changed: false,
      tier: "read",
      description: "Reads one note by name. Returns its text.",
    });
  });

  it("marks a read trusted only on a server whose reads run unattended", async () => {
    const { provider } = await started({ row: { trust: "reads_unattended" } });
    const specs = await provider.tools(signal.signal);
    expect(named(specs, "read_note").trusted).toBe(true);
    expect(named(specs, "save_note").trusted).toBe(true);
  });

  it("lists only ticked tools", async () => {
    const { provider } = await started({
      tick: (name) => name === "read_note",
    });
    const specs = await provider.tools(signal.signal);
    expect(specs.map((s) => s.name)).toEqual(["read_note"]);
  });

  it("drops a tool whose description drifted since it was ticked, and says the server changed", async () => {
    const marker = join(scratch, "shift-signal");
    rmSync(marker, { force: true });
    const { provider } = await started({
      row: { args: [fixture, "--signal", marker] },
    });
    expect((await provider.tools(signal.signal)).map((s) => s.name)).toContain(
      "shifting",
    );
    const before = provider.pinOf("shifting");
    writeFileSync(marker, "");
    // The server announces the change; the next listing re-reads it.
    for (let i = 0; i < 50 && provider.pinOf("shifting") === before; i++) {
      await provider.tools(signal.signal);
      await new Promise((r) => setTimeout(r, 50));
    }
    const specs = await provider.tools(signal.signal);
    expect(specs.map((s) => s.name)).not.toContain("shifting");
    expect(specs.map((s) => s.name)).toContain("read_note");
    expect(provider.state().state).toBe("changed");
    expect(provider.catalog().find((c) => c.name === "shifting")).toMatchObject(
      { on: true, changed: true },
    );
    rmSync(marker, { force: true });
  });
});

describe("MCP client: the launcher and the environment", () => {
  it("runs the server through the launcher with --no-network for a local server, and no flag otherwise", async () => {
    await started();
    const [local] = records();
    expect(local.flags).toEqual(["--no-network"]);
    expect(local.command).toBe(process.execPath);
    expect(local.args).toEqual([fixture]);
    for (const p of providers.splice(0)) await p.close();
    for (const name of readdirSync(scratch))
      if (name.startsWith("fake-launch-")) rmSync(join(scratch, name));
    await started({ row: { network: "internet" } });
    expect(records()[0].flags).toEqual([]);
  });

  it("gives the child only the fixed environment, the row's variables and its secrets", async () => {
    const provider = createMcpProvider(
      {
        kind: "server",
        row: row({ env: { PLAIN_SETTING: "yes" }, secretEnv: ["API_TOKEN"] }),
        command: process.execPath,
        launch: launcher,
        secrets: { env: { API_TOKEN: "vault-value" }, headers: {} },
      },
      { home, version: "0.1.0-test", ticks: () => ({}) },
    );
    providers.push(provider);
    await provider.start();
    const [record] = records();
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process; nothing
    // else may come from the app's environment.
    const keys = Object.keys(record.env)
      .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
      .sort();
    for (const key of keys)
      expect(
        [
          "HOME",
          "TMPDIR",
          "LANG",
          "LC_ALL",
          "PATH",
          "PLAIN_SETTING",
          "API_TOKEN",
        ],
        `unexpected variable ${key}`,
      ).toContain(key);
    expect(keys.some((k) => k.startsWith("COARENA_"))).toBe(false);
    expect(record.env.HOME).toBe(home);
    expect(record.env.API_TOKEN).toBe("vault-value");
    expect(record.env.PATH.split(":")[0]).toBe(
      process.execPath.replace(/\/[^/]+$/, ""),
    );
    expect(record.env.PATH).toContain("/usr/bin");
  });

  it("only counts what the server writes to stderr", async () => {
    const { provider } = await started();
    expect(provider.stderrBytes()).toBe("fixture started\n".length);
  });

  it("spawns directly when there is no launcher", async () => {
    const { provider } = await started({ launch: false });
    expect(provider.state().state).toBe("on");
    expect(records()).toEqual([]);
    const specs = await provider.tools(signal.signal);
    // Without the sandbox a declared-local server is not local.
    expect(named(specs, "read_note").local).toBe(false);
  });
});

describe("MCP client: calls", () => {
  it("validates arguments before a call and returns the result's text", async () => {
    const { provider } = await started();
    const specs = await provider.tools(signal.signal);
    const read = named(specs, "read_note");
    expect(provider.prepare(read, {})).toEqual({
      ok: false,
      problem: "invalid_args",
    });
    expect(provider.prepare(read, { name: 5 })).toEqual({
      ok: false,
      problem: "invalid_args",
    });
    expect(provider.prepare(read, { name: "todo" })).toEqual({
      ok: true,
      question: { kind: "mcp_read", server: "Fixture", tool: "read_note" },
      groundText: ["todo"],
      argsBytes: 15,
    });
    const when = named(specs, "when");
    expect(
      provider.prepare(when, {
        start: "2026-09-19T18:00:00-07:00",
        note: "dentist",
      }),
    ).toMatchObject({ ok: true, groundText: ["dentist"] });
    expect(
      provider.prepare(named(specs, "save_note"), { name: "x" }),
    ).toMatchObject({
      question: { kind: "mcp_write", server: "Fixture", tool: "save_note" },
    });
    expect(provider.prepare(named(specs, "plain_tool"), {})).toMatchObject({
      question: {
        kind: "mcp_destructive",
        server: "Fixture",
        tool: "plain_tool",
      },
    });
    const result = await provider.call(
      read,
      { name: "todo" },
      { ...signal, timeoutMs: 2000 },
    );
    expect(result).toEqual({ code: "ok", raw: "note todo: hello", items: 1 });
  });

  it("maps an error result, an input request and a crash to their codes", async () => {
    const { provider } = await started();
    const specs = await provider.tools(signal.signal);
    expect(
      await provider.call(
        named(specs, "failing"),
        {},
        { ...signal, timeoutMs: 2000 },
      ),
    ).toEqual({ code: "error", raw: "boom", items: 1 });
    // A 2025-era server cannot ask for input mid-call: the SDK rejects the
    // shape and the model reads an error. A 2026-era server's request
    // surfaces as the SDK's typed refusal, which becomes input_required and
    // never opens any UI here.
    expect(
      (
        await provider.call(
          named(specs, "needs_input"),
          {},
          { ...signal, timeoutMs: 2000 },
        )
      ).code,
    ).toBe("error");
    const inputRequired = new SdkError(
      SdkErrorCode.UnsupportedResultType,
      "Unsupported result type 'input_required' for tools/call",
      { resultType: "input_required", method: "tools/call" },
    );
    expect(failureCode(inputRequired, signal.signal)).toBe("input_required");
    expect(
      failureCode(
        new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
        signal.signal,
      ),
    ).toBe("timeout");
    expect(
      failureCode(
        new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"),
        signal.signal,
      ),
    ).toBe("unavailable");
    expect(failureCode(new Error("anything"), signal.signal)).toBe("error");
    const crashed = await provider.call(
      named(specs, "crash"),
      {},
      {
        ...signal,
        timeoutMs: 2000,
      },
    );
    expect(crashed.code).toBe("unavailable");
  });

  it("validates structured content against the tool's output schema", async () => {
    const { provider } = await started();
    const specs = await provider.tools(signal.signal);
    const save = named(specs, "save_note");
    expect(
      await provider.call(save, { name: "a" }, { ...signal, timeoutMs: 2000 }),
    ).toEqual({ code: "ok", raw: "saved a", items: 1 });
    const bad = await provider.call(
      save,
      { name: "a", bad: true },
      {
        ...signal,
        timeoutMs: 2000,
      },
    );
    expect(bad.code).toBe("error");
    expect(bad.raw).toMatch(/output schema/i);
  });

  it("honours the timeout, resets it on progress and stops at three times the timeout", async () => {
    const { provider } = await started();
    const specs = await provider.tools(signal.signal);
    const slow = named(specs, "slow");
    // 1 s of work with a 400 ms timeout: progress every 100 ms keeps it alive.
    expect(
      await provider.call(slow, { seconds: 1 }, { ...signal, timeoutMs: 400 }),
    ).toEqual({ code: "ok", raw: "slept", items: 1 });
    // 3 s of work with a 300 ms timeout: the 900 ms ceiling ends it.
    const startedAt = Date.now();
    const late = await provider.call(
      slow,
      { seconds: 3 },
      {
        ...signal,
        timeoutMs: 300,
      },
    );
    expect(late.code).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it("reports an aborted call as interrupted", async () => {
    const { provider } = await started();
    const specs = await provider.tools(signal.signal);
    const controller = new AbortController();
    const pending = provider.call(
      named(specs, "slow"),
      { seconds: 5 },
      { signal: controller.signal, timeoutMs: 20000 },
    );
    setTimeout(() => controller.abort(), 100);
    expect((await pending).code).toBe("interrupted");
  });
});

describe("MCP client: lifecycle", () => {
  it("restarts an exited server with the helpers' backoff, then gives up until Retry", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    let now = 1_000_000;
    const events: string[] = [];
    const { provider } = await started({
      timers,
      now: () => now,
      trace: (event) => events.push(event),
    });
    const crash = async () => {
      const specs = await provider.tools(signal.signal);
      await provider.call(
        named(specs, "crash"),
        {},
        { ...signal, timeoutMs: 2000 },
      );
      // The exit reaches the client a moment after the failed request.
      for (let i = 0; i < 50 && provider.state().state !== "failed"; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(provider.state().state).toBe("failed");
    };
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      await crash();
      expect(provider.state().code).toBe("exited");
      const timer = timers.pop()!;
      delays.push(timer.ms);
      now += timer.ms;
      timer.fn();
      for (let i = 0; i < 100 && provider.state().state !== "on"; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(provider.state()).toMatchObject({
        state: "on",
        restarts: attempt + 1,
      });
    }
    expect(delays).toEqual([500, 1000, 2000, 2000, 2000]);
    await crash();
    expect(timers).toEqual([]);
    expect(provider.state()).toMatchObject({
      state: "failed",
      code: "exhausted",
    });
    expect(events).toContain("ToolServerExited");
    expect(events).toContain("ToolServerFailed");
    await provider.retry();
    expect(provider.state()).toMatchObject({ state: "on", restarts: 0 });
  });

  it("reports a command that cannot be spawned as failed without retrying", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const provider = createMcpProvider(
      {
        kind: "server",
        row: row({ command: join(scratch, "missing") }),
        command: join(scratch, "missing"),
        secrets: { env: {}, headers: {} },
      },
      {
        home,
        version: "0.1.0-test",
        ticks: () => ({}),
        setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
        clearTimer: () => {},
        connectTimeoutMs: 3000,
      },
    );
    providers.push(provider);
    await provider.start();
    expect(provider.state().state).toBe("failed");
    expect(timers).toEqual([]);
    expect(await provider.tools(signal.signal)).toEqual([]);
  });

  it("traces starts with content-free fields only", async () => {
    const traced: Record<string, unknown>[] = [];
    await started({ trace: (event, data) => traced.push({ event, ...data }) });
    const startedEvent = traced.find((t) => t.event === "ToolServerStarted")!;
    expect(startedEvent).toMatchObject({
      server: expect.stringMatching(/^s[0-9a-f]{12}$/),
      transport: "stdio",
      sandboxed: true,
      disclaimed: true,
      restarts: 0,
      toolCount: expect.any(Number),
    });
    expect(JSON.stringify(traced)).not.toContain("fixture");
    expect(JSON.stringify(traced)).not.toContain(process.execPath);
  });
});

describe("MCP client: the Apple bridge as a builtin source", () => {
  it("reads the code a refusal leads with, as the bridge writes every refusal", () => {
    // The bridge's own refusal texts (tests/fixtures/apple/*.json): the code,
    // a colon, a sentence. Only the code is read; the sentence is data.
    const directory = fileURLToPath(
      new URL("./fixtures/apple/", import.meta.url),
    );
    const texts = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const fixture = JSON.parse(
          readFileSync(join(directory, name), "utf8"),
        ) as {
          exchange: {
            out: {
              result?: { isError?: boolean; content?: { text: string }[] };
            } | null;
          }[];
        };
        return fixture.exchange.flatMap((step) =>
          step.out?.result?.isError
            ? step.out.result.content!.map((block) => block.text)
            : [],
        );
      });
    expect(texts.length).toBeGreaterThan(30);
    // Every recorded refusal leads with its code; these are all of them.
    const codes = new Set(texts.map((text) => refusalCode({}, text)));
    expect([...codes].sort()).toEqual([
      "BAD_ARGS",
      "DUPLICATE",
      "NOT_CREATED_HERE",
      "NO_ACCESS",
      "NO_CALENDAR",
      "NO_FOLDER",
      "NO_LIST",
      "READBACK_MISMATCH",
    ]);
    expect(
      refusalCode(
        {},
        "DUPLICATE: An event titled Dentist at that time is already in Home.",
      ),
    ).toBe("DUPLICATE");
    expect(
      refusalCode({}, "NO_ACCESS: macOS has not allowed Butler to use Mail."),
    ).toBe("NO_ACCESS");
    // A structured code wins; a sentence without a code, a lowercase word, a
    // code buried in the text or a hostile "code" of another shape is none.
    expect(refusalCode({ structuredContent: { code: "NO_ACCESS" } }, "x")).toBe(
      "NO_ACCESS",
    );
    expect(refusalCode({}, "boom")).toBeUndefined();
    expect(refusalCode({}, "duplicate: no")).toBeUndefined();
    expect(refusalCode({}, "The reply was DUPLICATE: no")).toBeUndefined();
    expect(refusalCode({}, "X: no")).toBeUndefined();
    expect(refusalCode({}, `${"A".repeat(41)}: no`)).toBeUndefined();
  });

  it("enforces a per-app consent at call time, not only at listing", async () => {
    // The fixture server stands in for coarena-apple; its read_note is the
    // table's one Calendar tool.
    const server: BuiltinServer = {
      id: "apple",
      helper: process.execPath,
      args: [fixture],
      tools: {
        read_note: {
          title: "Calendar",
          does: "Reads one note.",
          tier: "read",
          undoable: false,
          consent: "calendar",
          question: () => ({
            kind: "mcp_read",
            server: "Calendar",
            tool: "read_note",
          }),
        },
      },
    };
    const consents = new Set<AppleConsent>(["calendar"]);
    const provider = createMcpProvider(
      { kind: "builtin", server, helper: process.execPath },
      { home, version: "0.1.0-test", consents: () => consents },
    );
    providers.push(provider);
    await provider.start();
    expect(provider.state()).toMatchObject({ state: "on" });
    const specs = await provider.tools(signal.signal);
    expect(specs.map((s) => s.id)).toEqual(["apple__read_note"]);
    const read = named(specs, "read_note");
    expect(read).toMatchObject({
      transport: "builtin",
      trusted: true,
      local: true,
      title: "Calendar",
    });
    expect(
      await provider.call(
        read,
        { name: "todo" },
        { ...signal, timeoutMs: 2000 },
      ),
    ).toEqual({
      code: "ok",
      raw: "note todo: hello",
      items: 1,
      lines: undefined,
      facts: undefined,
      verified: false,
      undoToken: undefined,
    });
    // The user switches Calendar off while a run holds the frozen spec.
    consents.delete("calendar");
    expect(await provider.tools(signal.signal)).toEqual([]);
    expect(
      await provider.call(
        read,
        { name: "todo" },
        { ...signal, timeoutMs: 2000 },
      ),
    ).toEqual({ code: "unavailable", raw: "", items: 0 });
    // A tool the table never named is never called either.
    expect(
      await provider.call(
        { ...read, name: "save_note", id: "apple__save_note" },
        { name: "x" },
        { ...signal, timeoutMs: 2000 },
      ),
    ).toEqual({ code: "unavailable", raw: "", items: 0 });
  });
});
