import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { importConnections } from "../src/terminal/connection-config";
import { createSlackReader, slackTools } from "../src/terminal/slack";
import { installedApps } from "../src/terminal/apps";
import {
  TerminalConnections,
  connectionSettings,
} from "../src/terminal/connections";
import { TerminalStore } from "../src/terminal/store";
import { McpOAuth } from "../src/terminal/mcp-oauth";
import {
  settingsSchema,
  toolServerSchema,
  defaultSettings,
} from "../src/core/schema";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "butler-connect-test-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("startup waits for the Apple bridge even when no external servers are enabled", async () => {
  vi.useFakeTimers();
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.secrets["github:token"] = "synthetic-token";
  const connections = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(connections.registry, "configure").mockResolvedValue();
  const status = connections.registry.status();
  status.apple.state = "starting";
  vi.spyOn(connections.registry, "status").mockImplementation(() => status);
  let settled = false;
  const startup = connections.start().then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(300);
  expect(settled).toBe(false);
  status.apple.state = "on";
  await vi.advanceTimersByTimeAsync(100);
  await startup;
  expect(settled).toBe(true);
});
test("passive briefings leave unused agent servers dormant without changing saved connections or consent", () => {
  const settings = settingsSchema.parse({
    ...defaultSettings,
    tools: {
      servers: ["gmail", "claude-code", "codex", "slack-bot"].map((id) =>
        toolServerSchema.parse({
          id,
          name: id,
          transport: "stdio",
          addedAt: 0,
          enabled: id !== "slack-bot",
          consented: true,
          approvedCommand: "synthetic-command-pin",
        }),
      ),
    },
    briefings: {
      reads: [
        { tool: "gmail__gmail_search", args: { query: "is:unread" } },
        { tool: "slack-bot__slack_activity", args: {} },
      ],
    },
  });
  const scoped = connectionSettings(settings, true);
  expect(
    scoped.tools.servers.filter((row) => row.enabled).map((row) => row.id),
  ).toEqual(["gmail"]);
  expect(settings.tools.servers.filter((row) => row.enabled)).toHaveLength(3);
  expect(scoped.tools.servers[1]).toMatchObject({
    consented: true,
    approvedCommand: "synthetic-command-pin",
  });
  expect(connectionSettings(settings, false)).toBe(settings);
  const firstParty = connectionSettings(settings, false, true);
  expect(firstParty.tools.servers.every((row) => !row.enabled)).toBe(true);
  expect(firstParty.tools.apple).toBe(settings.tools.apple);
  expect(settings.tools.servers.filter((row) => row.enabled)).toHaveLength(3);
  const inbox = connectionSettings(settings, false, false, ["gmail"]);
  expect(
    inbox.tools.servers.filter((row) => row.enabled).map((row) => row.id),
  ).toEqual(["gmail"]);
  expect(settings.tools.servers.filter((row) => row.enabled)).toHaveLength(3);
  expect(inbox.tools.servers[1]).toMatchObject({
    consented: true,
    approvedCommand: "synthetic-command-pin",
  });
});
test("imports local commands and HTTP headers with credentials separated from visible server rows", () => {
  const rows = importConnections(
    {
      mcpServers: {
        "My Drive": {
          command: "/fixture/server",
          args: ["--stdio"],
          env: { API_TOKEN: "${FIXTURE_TOKEN}" },
        },
        notion: {
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer fixture-private-value" },
        },
      },
    },
    { FIXTURE_TOKEN: "fixture-secret" },
  );
  expect(rows[0].row).toMatchObject({
    id: "my-drive",
    enabled: false,
    consented: false,
    secretEnv: ["API_TOKEN"],
    env: {},
  });
  expect(rows[0].secrets).toEqual({
    "mcp:my-drive:env:API_TOKEN": "fixture-secret",
  });
  expect(JSON.stringify(rows.map((r) => r.row))).not.toContain(
    "fixture-private-value",
  );
  expect(rows[1].row.secretHeaders).toEqual(["Authorization"]);
});
test("supports VS Code server maps and avoids native provider identity collisions", () => {
  expect(
    importConnections({ servers: { notes: { command: "fixture" } } })[0].row.id,
  ).toBe("mcp-notes");
  expect(
    importConnections({
      mcp: { servers: { linear: { url: "https://fixture.test/mcp" } } },
    })[0].row.transport,
  ).toBe("http");
});
test.each([
  { url: "http://remote.example.test/mcp" },
  { url: "https://private:secret@example.test/mcp" },
  { url: "https://example.test/mcp?access_token=private-value" },
  { url: "https://example.test/mcp", type: "sse" },
  { command: "fixture", args: ["--token", "private-value"] },
  { command: "fixture", env: { BAD_NAME: "${MISSING_FIXTURE}" } },
  { command: "fixture", args: "private-value" },
])(
  "rejects unsupported or unsafe configurations without exposing supplied values",
  (config) => {
    try {
      importConnections({ mcpServers: { fixture: config } }, {});
      throw new Error("not rejected");
    } catch (error) {
      expect((error as Error).message).not.toBe("not rejected");
      expect((error as Error).message).not.toContain("private-value");
    }
  },
);
test("localhost HTTP works and conflicting normalized server names are rejected", () => {
  expect(
    importConnections({
      mcpServers: { local: { url: "http://127.0.0.1:1234/mcp" } },
    })[0].row.url,
  ).toContain("127.0.0.1");
  expect(() =>
    importConnections({
      mcpServers: {
        "My App": { command: "fixture" },
        "my-app": { command: "fixture" },
      },
    }),
  ).toThrow("unique");
});
test("installed-app inventory explains both a connector and desktop path without launching apps", () => {
  const root = temp();
  ["Slack.app", "Notes.app", "Some App.app"].forEach((name) =>
    mkdirSync(join(root, name)),
  );
  writeFileSync(join(root, "not-an-app.txt"), "fixture");
  expect(installedApps([root])).toEqual([
    {
      name: "Notes",
      connection: "/connect notes",
      desktop: "/cua <task in Notes>",
    },
    {
      name: "Slack",
      connection: "/connect slack bot or /connect slack oauth",
      desktop: "/cua <task in Slack>",
    },
    {
      name: "Some App",
      connection: "/connect mcp or /connect import <config.json>",
      desktop: "/cua <task in Some App>",
    },
  ]);
});
test("Slack bot bridge uses read methods, limits output, and reports incomplete coverage", async () => {
  const token = "xoxb-fixture-private-value";
  const request = vi.fn(async (address: string, init: RequestInit) => {
    expect(init.method || "GET").toBe("GET");
    expect(address).not.toContain(token);
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer " + token });
    const url = new URL(address);
    if (url.pathname.endsWith("users.conversations"))
      return Response.json({
        ok: true,
        channels: Array.from({ length: 60 }, (_, i) => ({
          id: "C" + String(i).padStart(9, "0"),
          name: "n".repeat(1000),
        })),
        response_metadata: { next_cursor: "more" },
      });
    return Response.json({
      ok: true,
      has_more: true,
      messages: Array.from({ length: 40 }, () => ({
        ts: "1234567890.123456",
        user: "U".repeat(1000),
        text: "x".repeat(10000),
      })),
    });
  });
  const read = createSlackReader({ SLACK_BOT_TOKEN: token }, request as any);
  for (const [name, args] of [
    ["slack_channels", {}],
    ["slack_history", { channel: "C000000001" }],
    ["slack_activity", { channels: 8 }],
  ] as const) {
    const result = await read(name, args);
    expect(result.length).toBeLessThanOrEqual(18000);
    const parsed = JSON.parse(result);
    if (name === "slack_history") expect(parsed.more).toBe(true);
    if (name === "slack_activity") {
      expect(parsed.more).toBe(true);
      expect(parsed.conversationsChecked).toHaveLength(8);
    }
  }
  expect(slackTools.every((t) => t.annotations.readOnlyHint)).toBe(true);
});
test("Slack API errors cannot leak server bodies, and bot thread restrictions are explained", async () => {
  const request = vi.fn(async () =>
    Response.json({
      ok: false,
      error: "not_allowed_token_type",
      detail: "private-fixture-body",
    }),
  );
  const read = createSlackReader({ SLACK_BOT_TOKEN: "xoxb-fixture" }, request);
  await expect(
    read("slack_thread", { channel: "C000000001", ts: "1234567890.123456" }),
  ).rejects.toThrow("user token");
  await expect(
    read("slack_history", { channel: "../../settings" }),
  ).rejects.toThrow("valid Slack");
  await expect(read("chat.postMessage", {})).rejects.toThrow("Unexpected");
  expect(request).toHaveBeenCalledTimes(1);
});
test("generic setup does not execute a server before exact command consent", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.privacy = "PRIVATE_BYOM";
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  const path = join(temp(), "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: "/fixture/server",
          args: ["--stdio"],
          env: { TOKEN: "fixture-private-value" },
        },
      },
    }),
  );
  const probe = vi.spyOn(c.registry, "test");
  const show = vi.fn();
  await c.connectCommand(
    "import " + path,
    async () => "no",
    show,
    new AbortController().signal,
  );
  expect(probe).not.toHaveBeenCalled();
  expect(store.profile.settings.tools.servers).toHaveLength(0);
  expect(JSON.stringify(show.mock.calls)).not.toContain(
    "fixture-private-value",
  );
});
test("catalog exposes every built-in path and generic authentication options", () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  for (const option of [
    "apple",
    "filesystem",
    "playwright",
    "OAuth",
    "bearer",
    "custom headers",
    "stdio",
    "import",
    "all",
  ])
    expect(c.catalog()).toContain(option);
});
test("rotating an OAuth token reconnects transports before the next read", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  const row = importConnections({
    mcpServers: {
      fixture: {
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer synthetic-old-token" },
      },
    },
  })[0];
  row.row.enabled = true;
  store.profile.settings.tools.servers = [row.row];
  Object.assign(store.profile.secrets, row.secrets);
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  const configure = vi.spyOn(c.registry, "configure").mockResolvedValue();
  vi.spyOn(McpOAuth.prototype, "refresh").mockImplementation(async () => {
    store.profile.secrets["mcp:fixture:header:Authorization"] =
      "Bearer synthetic-rotated-token";
  });
  await c.refreshCredentials();
  expect(configure).toHaveBeenCalledOnce();
  await c.refreshCredentials();
  expect(configure).toHaveBeenCalledOnce();
});
test("an inbox-only session does not refresh unrelated OAuth accounts or change their approvals", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.tools.servers = ["gmail", "slack", "fixture"].map(
    (id) =>
      toolServerSchema.parse({
        id,
        name: id,
        transport: id === "fixture" ? "http" : "stdio",
        url: "https://mcp.example.test/mcp",
        addedAt: 0,
        enabled: true,
        consented: true,
        approvedCommand: "synthetic-command-pin",
      }),
  );
  const saved = structuredClone(store.profile.settings.tools.servers);
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  const slack = vi.spyOn(c, "refreshSlack").mockResolvedValue();
  const oauth = vi.spyOn(McpOAuth.prototype, "refresh").mockResolvedValue();
  await c.start({ onlyServers: ["gmail"] });
  await c.refreshCredentials();
  expect(slack).not.toHaveBeenCalled();
  expect(oauth).not.toHaveBeenCalled();
  expect(store.profile.settings.tools.servers).toEqual(saved);
});
