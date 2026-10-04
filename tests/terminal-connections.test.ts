import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
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
import { freshOnboarding } from "../src/terminal/onboarding";
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
test("verified desktop access remains visible without claiming or duplicating an MCP connection", () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.onboarding = {
    ...freshOnboarding(),
    desktopReady: ["gmail", "slack", "github"],
  };
  const connections = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(connections.registry, "status").mockReturnValue({
    ...connections.registry.status(),
    servers: [
      {
        id: "github",
        name: "GitHub",
        state: "off",
        code: "ON_DEMAND",
        tools: [],
      },
    ],
  } as any);
  expect(connections.labels()).toContain("Gmail: computer use");
  expect(connections.labels()).toContain("Slack: computer use");
  expect(connections.labels()).not.toContain("GitHub: computer use");
  expect(connections.labels()).toContain("GitHub: ready on demand");
  expect(store.profile.settings.tools.servers).toEqual([]);
});
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
test("fresh instances reuse encrypted Gmail credentials without repeating prompts", async () => {
  const root = temp(),
    key = randomBytes(32);
  const first = new TerminalStore(root, key);
  first.profile.settings.privacy = "PRIVATE_BYOM";
  Object.assign(first.profile.secrets, {
    "gmail:clientId": "fixture.apps.googleusercontent.com",
    "gmail:clientSecret": "fixture-secret",
    "gmail:refreshToken": "fixture-refresh",
  });
  first.save();
  for (let i = 0; i < 2; i++) {
    const restored = new TerminalStore(root, key);
    const c = new TerminalConnections(restored, "/fixture", "/fixture");
    vi.spyOn(c.registry, "configure").mockResolvedValue();
    const connect = vi.spyOn(c, "connect").mockImplementation(async (id) => {
      expect(id).toBe("gmail");
      expect(restored.profile.secrets["gmail:refreshToken"]).toBe(
        "fixture-refresh",
      );
    });
    const ask = vi.fn(async () => {
      throw new Error("unexpected prompt");
    });
    const result = await c.setup(
      ["gmail"],
      "Safari",
      vi.fn(),
      new AbortController().signal,
      [],
      ask,
    );
    expect(result).toEqual({ connected: ["gmail"], pending: [] });
    expect(connect).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  }
});
test("ready pinned connections skip setup while missing or incomplete Gmail credentials require owner setup", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.privacy = "PRIVATE_BYOM";
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  const row = toolServerSchema.parse({
    id: "codex",
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
    cwd: "/fixture",
    addedAt: 0,
    enabled: true,
    consented: true,
  });
  row.approvedCommand = c.registry.approval(row);
  store.profile.settings.tools.servers.push(row);
  vi.spyOn(c.registry, "status").mockReturnValue({
    ...c.registry.status(),
    servers: [{ id: "codex", state: "on", tools: [] }],
  } as any);
  const connect = vi.spyOn(c, "connect").mockResolvedValue();
  store.profile.secrets["gmail:refreshToken"] = "fixture-incomplete";
  const result = await c.setup(
    ["codex", "gmail", "slack"],
    "Safari",
    vi.fn(),
    new AbortController().signal,
    [],
  );
  expect(result.connected).toEqual(["codex"]);
  expect(result.pending).toEqual(["gmail", "slack"]);
  expect(result.browserTask).toContain("console.cloud.google.com");
  expect(connect).not.toHaveBeenCalled();
});
test("chat setup imports one downloaded Gmail client locally and encrypts it without exposing it in chat", async () => {
  const root = temp(),
    downloads = temp(),
    key = randomBytes(32);
  writeFileSync(
    join(downloads, "client_secret_fixture.json"),
    JSON.stringify({
      installed: {
        client_id: "fixture.apps.googleusercontent.com",
        client_secret: "fixture-client-secret",
      },
    }),
  );
  const store = new TerminalStore(root, key);
  store.profile.settings.privacy = "PRIVATE_BYOM";
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  vi.spyOn(c, "connect").mockImplementation(async (id) => {
    expect(id).toBe("gmail");
    expect(store.profile.secrets["gmail:clientSecret"]).toBe(
      "fixture-client-secret",
    );
  });
  const show = vi.fn();
  const result = await c.setup(
    ["gmail"],
    "Safari",
    show,
    new AbortController().signal,
    [downloads],
  );
  expect(result).toEqual({ connected: ["gmail"], pending: [] });
  expect(
    new TerminalStore(root, key).profile.secrets["gmail:clientSecret"],
  ).toBe("fixture-client-secret");
  expect(
    readFileSync(join(root, "profile.enc")).includes(
      Buffer.from("fixture-client-secret"),
    ),
  ).toBe(false);
  expect(JSON.stringify(show.mock.calls)).not.toContain(
    "fixture-client-secret",
  );
});
test("choosing a different Google client never carries the old refresh grant into that client", async () => {
  const store = new TerminalStore(temp(), randomBytes(32)),
    downloads = temp();
  store.profile.settings.privacy = "PRIVATE_BYOM";
  store.profile.secrets["gmail:clientId"] = "old.apps.googleusercontent.com";
  store.profile.secrets["gmail:refreshToken"] = "old-synthetic-refresh";
  writeFileSync(
    join(downloads, "client_secret_fixture.json"),
    JSON.stringify({
      installed: {
        client_id: "new.apps.googleusercontent.com",
        client_secret: "new-synthetic-secret",
      },
    }),
  );
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  vi.spyOn(c, "connect").mockImplementation(async () => {
    expect(store.profile.secrets["gmail:clientId"]).toBe(
      "new.apps.googleusercontent.com",
    );
    expect(store.profile.secrets["gmail:refreshToken"]).toBeUndefined();
    throw new Error("owner sign-in still needed");
  });
  expect(
    (
      await c.setup(
        ["gmail"],
        "Safari",
        vi.fn(),
        new AbortController().signal,
        [downloads],
      )
    ).pending,
  ).toEqual(["gmail"]);
});
test("an existing Slack bot token is reused and connection failures are never reported ready", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.privacy = "PRIVATE_BYOM";
  store.profile.secrets["slack:botToken"] = "xoxb-synthetic-token";
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  vi.spyOn(c, "connect").mockImplementation(async (id, ask) => {
    expect(id).toBe("slack-bot");
    expect(await ask("leave empty to reuse the saved token", true)).toBe("");
    throw new Error("fixture access declined");
  });
  expect(
    await c.setup(
      ["slack"],
      "Safari",
      vi.fn(),
      new AbortController().signal,
      [],
    ),
  ).toEqual({ connected: [], pending: ["slack"] });
});
test("unfinished setup survives restart without repeating browser preparation when an approved token is supplied", async () => {
  const root = temp(),
    key = randomBytes(32);
  const first = new TerminalStore(root, key);
  first.profile.settings.privacy = "PRIVATE_BYOM";
  const a = new TerminalConnections(first, "/fixture", "/fixture");
  vi.spyOn(a.registry, "configure").mockResolvedValue();
  expect(
    (
      await a.setup(
        ["slack"],
        "Safari",
        vi.fn(),
        new AbortController().signal,
        [],
      )
    ).browserTask,
  ).toBeDefined();
  const next = new TerminalStore(root, key);
  expect(next.profile.settings.tools.servers[0]).toMatchObject({
    enabled: false,
    consented: false,
    approvedCommand: "",
  });
  const b = new TerminalConnections(next, "/fixture", "/fixture");
  vi.spyOn(b.registry, "configure").mockResolvedValue();
  vi.spyOn(b, "connect").mockImplementation(async (id) =>
    expect(id).toBe("slack-bot"),
  );
  const ask = vi.fn(async (_label: string, hidden?: boolean) => {
    expect(hidden).toBe(true);
    return "xoxb-synthetic-fixture-token";
  });
  expect(
    await b.setup(
      ["slack"],
      "Safari",
      vi.fn(),
      new AbortController().signal,
      [],
      ask,
    ),
  ).toEqual({ connected: ["slack"], pending: [] });
  expect(ask).toHaveBeenCalledOnce();
  expect(new TerminalStore(root, key).profile.secrets["slack:botToken"]).toBe(
    "xoxb-synthetic-fixture-token",
  );
});
test("private-local setup does not collect credentials or launch a browser, even after an earlier setup attempt", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.privacy = "PRIVATE_BYOM";
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  await c.setup(["slack"], "Safari", vi.fn(), new AbortController().signal, []);
  store.profile.settings.privacy = "PRIVATE_LOCAL";
  const ask = vi.fn(async () => "");
  const connect = vi.spyOn(c, "connect").mockResolvedValue();
  const result = await c.setup(
    ["slack"],
    "Safari",
    vi.fn(),
    new AbortController().signal,
    [],
    ask,
  );
  expect(result).toEqual({ connected: [], pending: ["slack"] });
  expect(ask).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
test("denied Apple access remains pending; setup requests undetermined access once", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  vi.spyOn(c.registry, "appleAccess").mockResolvedValue({
    calendar: "denied",
    reminders: "notDetermined",
    notes: "granted",
    mail: "granted",
  } as any);
  const request = vi
    .spyOn(c.registry, "requestApple")
    .mockResolvedValue({ reminders: "granted" } as any);
  const result = await c.setup(
    ["calendar", "reminders", "notes"],
    "Safari",
    vi.fn(),
    new AbortController().signal,
    [],
  );
  expect(result).toEqual({
    connected: ["reminders", "notes"],
    pending: ["calendar"],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("reminders");
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
test("guided app setup prepares normal browser access without demanding developer credentials", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.privacy = "PRIVATE_BYOM";
  const c = new TerminalConnections(store, "/fixture", "/fixture");
  vi.spyOn(c.registry, "configure").mockResolvedValue();
  const ask = vi.fn(async () => {
    throw new Error("SYNTHETIC unexpected credential prompt");
  });
  const result = await c.setup(
    ["gmail", "slack"],
    "Safari",
    vi.fn(),
    new AbortController().signal,
    [],
    ask,
    { desktopFirst: true },
  );
  expect(result.browserTask).toContain("https://mail.google.com/");
  expect(result.browserApp).toBe("gmail");
  expect(result.connected).toEqual([]);
  expect(result.pending).toEqual(["gmail", "slack"]);
  const next = await c.setup(
    ["gmail", "slack"],
    "Safari",
    vi.fn(),
    new AbortController().signal,
    [],
    ask,
    { desktopFirst: true, desktopReady: ["gmail"], slackInstalled: true },
  );
  expect(next.browserTask).toContain("In Slack,");
  expect(next.browserApp).toBe("slack");
  expect(ask).not.toHaveBeenCalled();
  expect(
    store.profile.settings.tools.servers.every(
      (row) =>
        !row.enabled &&
        !row.consented &&
        !row.approvedCommand &&
        !row.tools.length,
    ),
  ).toBe(true);
});
test("Slack explains only the missing read scope and never echoes arbitrary scope data", async () => {
  const request = vi.fn(async () =>
    Response.json({
      ok: false,
      error: "missing_scope",
      needed: "channels:read",
      detail: "SYNTHETIC-private-body",
    }),
  );
  const read = createSlackReader({ SLACK_BOT_TOKEN: "xoxb-fixture" }, request);
  await expect(read("slack_activity", {})).rejects.toThrow(
    "Slack needs permission to list public channels. Enable channels:read in the app's Bot Token Scopes, then reinstall it to the workspace.",
  );
  request.mockImplementation(async () =>
    Response.json({
      ok: false,
      error: "missing_scope",
      needed:
        "channels:history, channels:history, im:history, SYNTHETIC-private-scope",
    }),
  );
  await expect(read("slack_channels", {})).rejects.toThrow(
    "Slack needs permission to read public channel messages, read direct messages. Enable channels:history, im:history in the app's Bot Token Scopes, then reinstall it to the workspace.",
  );
  request.mockImplementation(async () =>
    Response.json({
      ok: false,
      error: "missing_scope",
      needed: "SYNTHETIC-private-scope",
    }),
  );
  await expect(read("slack_channels", {})).rejects.toThrow(
    "Slack needs an additional read permission. Check the app's Bot Token Scopes, then reinstall it to the workspace.",
  );
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
test("a dormant Playwright connection keeps its approved read available and reconnects before using it", async () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  store.profile.settings.privacy = "PRIVATE_BYOM";
  store.profile.settings.tools.apple = {
    calendar: false,
    reminders: false,
    notes: false,
    mail: false,
  };
  const row = toolServerSchema.parse({
    id: "playwright",
    name: "Synthetic browser bridge",
    transport: "stdio",
    command: process.execPath,
    args: [join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs")],
    cwd: process.cwd(),
    network: "none",
    addedAt: 0,
    enabled: true,
    consented: true,
    trust: "reads_unattended",
  });
  store.profile.settings.tools.servers = [row];
  const c = new TerminalConnections(store, "/fixture", process.cwd());
  row.approvedCommand = c.registry.approval(row);
  try {
    await c.start();
    expect(c.registry.status().servers[0]).toMatchObject({
      state: "on",
      code: "ON_DEMAND",
    });
    row.tools = c.registry.tick(row.id, "read_note", true);
    await c.registry.configure();
    const access = c.registry.access({ synthetic: false })!;
    const signal = AbortSignal.timeout(3000);
    const list = await access.list("Read the synthetic note", signal);
    const read = list.tools.find((t) => t.name === "read_note")!;
    expect(read.trusted).toBe(true);
    expect(access.prepare(read, { name: "synthetic" }).ok).toBe(true);
    expect((await access.call(read, { name: "synthetic" }, signal)).code).toBe(
      "ok",
    );
    expect(c.registry.status().servers[0]).toMatchObject({
      state: "on",
      code: undefined,
    });
  } finally {
    await c.registry.closeAll();
  }
});
test("saved Gmail access and command pins work across fresh instances without reopening setup", async () => {
  const root = temp(),
    key = randomBytes(32);
  const first = new TerminalStore(root, key);
  first.profile.settings.privacy = "PRIVATE_BYOM";
  first.profile.settings.tools.apple = {
    calendar: false,
    reminders: false,
    notes: false,
    mail: false,
  };
  Object.assign(first.profile.secrets, {
    "gmail:clientId": "synthetic.apps.googleusercontent.com",
    "gmail:clientSecret": "synthetic-client-secret",
    "gmail:refreshToken": "synthetic-refresh",
  });
  const row = toolServerSchema.parse({
    id: "gmail",
    name: "Synthetic Gmail bridge",
    transport: "stdio",
    command: process.execPath,
    args: [join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs")],
    cwd: process.cwd(),
    network: "none",
    addedAt: 0,
    enabled: true,
    consented: true,
    trust: "reads_unattended",
  });
  first.profile.settings.tools.servers = [row];
  row.approvedCommand = new TerminalConnections(
    first,
    "/fixture",
    process.cwd(),
  ).registry.approval(row);
  first.save();
  for (let instance = 0; instance < 2; instance++) {
    const restored = new TerminalStore(root, key),
      c = new TerminalConnections(restored, "/fixture", process.cwd());
    const connect = vi.spyOn(c, "connect");
    const ask = vi.fn(async () => "");
    try {
      await c.start();
      const result = await c.setup(
        ["gmail"],
        "Safari",
        vi.fn(),
        AbortSignal.timeout(3000),
        [],
        ask,
      );
      expect(result).toEqual({ connected: ["gmail"], pending: [] });
      expect(connect).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
      const access = c.registry.access({ synthetic: false })!;
      const signal = AbortSignal.timeout(3000);
      const read = (
        await access.list("Read the synthetic note", signal)
      ).tools.find((t) => t.name === "read_note")!;
      row.tools = c.registry.tick(row.id, "read_note", true);
      restored.profile.settings.tools.servers[0].tools = row.tools;
      restored.save();
      await c.registry.configure();
      const trusted = (
        await access.list("Read the synthetic note", signal)
      ).tools.find((t) => t.name === "read_note")!;
      expect(
        (await access.call(trusted, { name: "synthetic" }, signal)).code,
      ).toBe("ok");
    } finally {
      await c.registry.closeAll();
    }
  }
});
test("a new CLI connection restores encrypted discovery but still performs the read through a fresh server", async () => {
  const root = temp(),
    key = randomBytes(32),
    store = new TerminalStore(root, key);
  store.profile.settings.privacy = "PRIVATE_BYOM";
  for (const name of Object.keys(
    store.profile.settings.tools.apple,
  ) as (keyof typeof store.profile.settings.tools.apple)[])
    store.profile.settings.tools.apple[name] = false;
  const row = toolServerSchema.parse({
    id: "playwright",
    name: "Synthetic bridge",
    transport: "stdio",
    command: process.execPath,
    args: [join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs")],
    cwd: process.cwd(),
    network: "none",
    addedAt: 0,
    enabled: true,
    consented: true,
    trust: "reads_unattended",
  });
  store.profile.settings.tools.servers = [row];
  const first = new TerminalConnections(store, "/fixture", process.cwd());
  row.approvedCommand = first.registry.approval(row);
  try {
    await first.start();
    row.tools = first.registry.tick(row.id, "read_note", true);
    store.save();
  } finally {
    await first.registry.closeAll();
  }
  const restored = new TerminalStore(root, key),
    readCache = vi.spyOn(restored.catalogues, "read"),
    second = new TerminalConnections(restored, "/fixture", process.cwd());
  try {
    await second.start();
    expect(readCache).toHaveBeenCalledWith("playwright", expect.any(String));
    expect(readCache.mock.results[0].value).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "read_note" })]),
    );
    expect(second.registry.status().servers[0]).toMatchObject({
      state: "on",
      code: "ON_DEMAND",
    });
    const access = second.registry.access({ synthetic: false })!,
      signal = AbortSignal.timeout(3000),
      read = (await access.list("Read the synthetic note", signal)).tools.find(
        (t) => t.name === "read_note",
      )!;
    expect(read.trusted).toBe(true);
    expect((await access.call(read, { name: "synthetic" }, signal)).code).toBe(
      "ok",
    );
    expect(second.registry.status().servers[0].code).toBeUndefined();
  } finally {
    await second.registry.closeAll();
  }
  const changed = new TerminalStore(root, key);
  changed.profile.settings.tools.servers[0].args.push("--changed");
  const deniedCache = vi.spyOn(changed.catalogues, "read"),
    third = new TerminalConnections(changed, "/fixture", process.cwd());
  try {
    await third.start();
    expect(deniedCache).not.toHaveBeenCalled();
    expect(third.registry.status().servers[0].state).not.toBe("on");
  } finally {
    await third.registry.closeAll();
  }
});
