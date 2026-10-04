import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  terminalText,
  wrapText,
  screenLines,
  TerminalScreen,
  type ScreenState,
} from "../src/terminal/screen";
import { TerminalStore, initialSettings } from "../src/terminal/store";
import {
  createGmailReader,
  messageText,
  codexTask,
  codexTools,
  gmailTools,
} from "../src/terminal/mcp-server";
import {
  authorizationUrl,
  exchangeCode,
  authorize,
} from "../src/terminal/oauth";
import { TerminalConnections } from "../src/terminal/connections";

const roots: string[] = [];
test("summaries wrap at word boundaries, preserve paragraphs and split only oversized tokens", () => {
  expect(
    wrapText("A short recruiting follow-up.\n\nNext step: reply.", 20),
  ).toEqual(["A short recruiting", "follow-up.", "", "Next step: reply."]);
  expect(wrapText("abcdefghij rest", 4)).toEqual([
    "abcd",
    "efgh",
    "ij",
    "rest",
  ]);
  expect(wrapText("🙂🙂🙂 words", 4)).toEqual(["🙂🙂🙂", "word", "s"]);
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "butler-terminal-test-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("untrusted app text cannot control the terminal or set its title", () => {
  expect(terminalText("hello\x1b]0;spoof\x07\x1b[2Jworld\r\x00")).toBe(
    "helloworld",
  );
});
test("narrow layouts keep input visible and mask secrets", () => {
  const state: ScreenState = {
    phase: "thinking",
    model: "a".repeat(100),
    connections: ["b".repeat(100)],
    nextBriefing: "off",
    status: "c".repeat(100),
    messages: [{ who: "Butler", text: "d".repeat(200) }],
  };
  const lines = screenLines(state, 40, 15, 3, "secret-value", "key", true);
  expect(lines.length).toBeLessThanOrEqual(15);
  expect(lines.every((line) => line.length < 40)).toBe(true);
  expect(lines.join("\n")).not.toContain("secret-value");
  expect(lines.join("\n")).toContain("key>");
});
test("saved on-demand connections count as connected without exposing command lists in everyday chrome", () => {
  const state: ScreenState = {
    phase: "idle",
    model: "synthetic",
    nextBriefing: "off",
    status: "Ready",
    connections: ["Gmail: ready on demand", "GitHub: on", "Codex: off"],
    messages: [],
  };
  const view = screenLines(state, 100, 30, 0, "").join("\n");
  expect(view).toContain("2 connected");
  expect(view).toContain("Connect my apps");
  expect(view).not.toContain("/connect");
  expect(view).not.toContain("/cua");
});
test("history paging preserves the input and returns to new conversation messages", () => {
  const source = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const output = { isTTY: true, columns: 80, rows: 24, write: vi.fn() };
  const screen = new TerminalScreen(
    () => {},
    () => {},
    () => {},
    output as any,
    source as any,
  );
  try {
    screen.start();
    for (let i = 0; i < 20; i++)
      screen.message("Butler", `Fixture conversation ${i}`);
    source.emit("keypress", "", { name: "pageup" });
    expect(output.write.mock.calls.at(-1)![0]).toContain(
      "Fixture conversation 12",
    );
    for (let i = 0; i < 50; i++)
      source.emit("keypress", "", { name: "pageup" });
    for (let i = 0; i < 5; i++)
      source.emit("keypress", "", { name: "pagedown" });
    expect(
      output.write.mock.calls.filter(([text]) => text).at(-1)![0],
    ).toContain("Fixture conversation 19");
    screen.clearMessages();
    screen.message("You", "New fixture conversation");
    expect(output.write.mock.calls.at(-1)![0]).toContain(
      "New fixture conversation",
    );
  } finally {
    screen.close();
  }
});
test("streamed message identifiers survive transcript trimming without replacing another message", () => {
  const output = { isTTY: false, write: vi.fn() };
  const screen = new TerminalScreen(
    () => {},
    () => {},
    () => {},
    output as any,
  );
  const old = screen.message("Butler", "Old fixture");
  for (let i = 0; i < 100; i++) screen.message("You", `Fixture ${i}`);
  screen.updateMessage(old, "Must not replace another message");
  expect(screen.state.messages[0].text).toBe("Fixture 0");
  const current = screen.message("Butler", "Stream start.");
  screen.updateMessage(current, "Stream start. Stream end.");
  expect(screen.state.messages.at(-1)?.text).toBe("Stream start. Stream end.");
});
test("closing the animated screen restores the terminal and rejects a credential prompt", async () => {
  const source = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const output = { isTTY: true, columns: 80, rows: 24, write: vi.fn() };
  const screen = new TerminalScreen(
    () => {},
    () => {},
    () => {},
    output as any,
    source as any,
  );
  screen.start();
  const question = screen.ask("Token", true);
  const rejection = expect(question).rejects.toThrow("closed");
  screen.close();
  screen.close();
  await rejection;
  expect(source.setRawMode).toHaveBeenLastCalledWith(false);
  expect(output.write).toHaveBeenLastCalledWith(
    expect.stringContaining("\x1b[?25h"),
  );
  expect(source.listenerCount("keypress")).toBe(0);
});
test("profiles and briefing copies are encrypted, private, and reject the wrong key", () => {
  const root = temp();
  const key = randomBytes(32);
  const store = new TerminalStore(root, key);
  store.profile.secrets["gmail:refreshToken"] = "private-fixture-token";
  store.save();
  store.saveBriefing("private-fixture-briefing");
  expect(readFileSync(join(root, "profile.enc"), "utf8")).not.toContain(
    "private-fixture-token",
  );
  expect(readFileSync(join(root, "latest-briefing.enc"), "utf8")).not.toContain(
    "private-fixture-briefing",
  );
  expect(statSync(join(root, "profile.enc")).mode & 0o777).toBe(0o600);
  expect(new TerminalStore(root, key).latestBriefing()).toBe(
    "private-fixture-briefing",
  );
  expect(() => new TerminalStore(root, randomBytes(32))).toThrow();
});
test("terminal defaults use the existing provider and a British persona", () => {
  expect(initialSettings({ OPENAI_API_KEY: "fixture" })).toMatchObject({
    provider: "openai",
    privacy: "PRIVATE_BYOM",
    persona: "jarvis",
    decisions: "off",
  });
  expect(initialSettings({})).toMatchObject({
    provider: "ollama",
    privacy: "PRIVATE_LOCAL",
  });
});
test("Gmail uses only message reads and bounds its valid JSON", async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token"))
      return Response.json({
        access_token: "access-fixture",
        expires_in: 3600,
      });
    expect(init?.method ?? "GET").toBe("GET");
    if (url.includes("messages?"))
      return Response.json({
        messages: Array.from({ length: 20 }, (_, i) => ({
          id: (i + 1).toString(16),
        })),
        nextPageToken: "more",
      });
    return Response.json({
      id: "a",
      snippet: "x".repeat(5000),
      payload: {
        headers: [
          { name: "From", value: "x".repeat(5000) },
          { name: "Subject", value: "x".repeat(5000) },
          { name: "Date", value: "x".repeat(5000) },
        ],
      },
    });
  });
  const reader = createGmailReader(
    {
      GMAIL_CLIENT_ID: "fixture",
      GMAIL_CLIENT_SECRET: "fixture",
      GMAIL_REFRESH_TOKEN: "fixture",
    },
    request as any,
  );
  const text = await reader("gmail_search", { query: "is:unread", limit: 20 });
  expect(text.length).toBeLessThanOrEqual(18_000);
  expect(JSON.parse(text).more).toBe(true);
  await expect(reader("gmail_read", { id: "../../settings" })).rejects.toThrow(
    "identifier",
  );
  await expect(
    reader("gmail_search", { query: "in:inbox", send: true }),
  ).rejects.toThrow("Unexpected");
  await expect(reader("gmail_send", { query: "in:inbox" })).rejects.toThrow();
  expect(
    request.mock.calls.filter(([url]) => url.endsWith("/token")),
  ).toHaveLength(1);
  expect(gmailTools.every((t) => t.annotations.readOnlyHint)).toBe(true);
});
test("Gmail search preserves all selected message identifiers ahead of a truncated metadata result", async () => {
  const ids = ["a1", "a2", "a3", "a4", "a5"];
  const request = vi.fn(async (address: string) => {
    if (address.endsWith("/token"))
      return Response.json({
        access_token: "synthetic-token",
        expires_in: 3600,
      });
    if (address.includes("messages?"))
      return Response.json({
        messages: ids.map((id) => ({ id })),
        nextPageToken: "synthetic-more",
      });
    return Response.json({
      id: address.match(/messages\/([a-f0-9]+)\?/)?.[1],
      snippet: "x".repeat(500),
      payload: { headers: [{ name: "Subject", value: "Synthetic message" }] },
    });
  });
  const read = createGmailReader(
    {
      GMAIL_CLIENT_ID: "synthetic-client",
      GMAIL_CLIENT_SECRET: "synthetic-secret",
      GMAIL_REFRESH_TOKEN: "synthetic-refresh",
    },
    request as any,
  );
  const text = await read("gmail_search", { query: "is:unread", limit: 5 });
  expect(JSON.parse(text).ids).toEqual(ids);
  expect(text.indexOf('"ids"')).toBeLessThan(text.indexOf('"messages"'));
  expect(text.slice(0, 640)).toContain('"a5"');
  expect(text.length).toBeGreaterThan(1500);
});
test("large message bodies cannot expand unbounded output", () => {
  const text = messageText({
    id: "a",
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from("x".repeat(100_000)).toString("base64url") },
    },
  });
  expect(JSON.parse(text).body.length).toBeLessThanOrEqual(12_000);
});
test("OAuth requests only read access and never includes client secrets in the URL", () => {
  const client = { clientId: "fixture", clientSecret: "secret-fixture" };
  const gmail = new URL(
    authorizationUrl(
      "gmail",
      client,
      "http://127.0.0.1:53683/callback",
      "state-fixture",
    ),
  );
  expect(gmail.searchParams.get("scope")).toBe(
    "https://www.googleapis.com/auth/gmail.readonly",
  );
  expect(gmail.toString()).not.toContain("secret-fixture");
  const slack = new URL(
    authorizationUrl(
      "slack",
      client,
      "http://localhost:53682/callback",
      "state-fixture",
    ),
  );
  expect(slack.searchParams.get("scope")).not.toContain("write");
});
test("token exchange uses the Slack MCP user endpoint and hides provider error bodies", async () => {
  const token = await exchangeCode(
    "slack",
    { clientId: "id" },
    "code",
    "http://localhost/callback",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://slack.com/api/oauth.v2.user.access");
      expect((init.body as URLSearchParams).has("client_secret")).toBe(false);
      return Response.json({
        ok: true,
        access_token: "user-token",
        token_type: "user",
        authed_user: { id: "fixture-id" },
      });
    }) as any,
  );
  expect(token.access_token).toBe("user-token");
  await expect(
    exchangeCode(
      "gmail",
      { clientId: "id", clientSecret: "secret" },
      "code",
      "http://localhost/callback",
      vi.fn(
        async () => new Response("secret provider body", { status: 400 }),
      ) as any,
    ),
  ).rejects.toThrow("could not exchange");
});
test("aborting OAuth closes its loopback listener", async () => {
  const controller = new AbortController();
  const pending = authorize(
    "gmail",
    { clientId: "id", clientSecret: "secret" },
    () => controller.abort(),
    controller.signal,
  );
  await expect(pending).rejects.toThrow("cancelled");
});

test("OAuth rejects an unrelated callback and exchanges the matching Google code with PKCE", async () => {
  const controller = new AbortController();
  let opened: (url: string) => void;
  const link = new Promise<string>((resolve) => {
    opened = resolve;
  });
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    expect(body.get("code")).toBe("fixture-code");
    expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
    return Response.json({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
    });
  });
  const pending = authorize(
    "gmail",
    { clientId: "fixture-id", clientSecret: "fixture-secret" },
    (text) => opened(text.split("\n").at(-1)!),
    controller.signal,
    request as any,
  );
  try {
    const auth = new URL(await link);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.toString()).not.toContain("fixture-secret");
    const redirect = auth.searchParams.get("redirect_uri")!;
    const unrelated = await fetch(redirect + "?state=wrong&code=fixture-code");
    expect(unrelated.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
    const valid = await fetch(
      redirect + `?state=${auth.searchParams.get("state")}&code=fixture-code`,
    );
    expect(valid.status).toBe(200);
    await expect(pending).resolves.toMatchObject({
      access_token: "fixture-access",
    });
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});
test.each([true, false])(
  "OAuth opens the sign-in page after binding its callback, with fallback when launch is %s",
  async (opened) => {
    const controller = new AbortController();
    const shown: string[] = [];
    let authUrl: string | undefined;
    const openPage = vi.fn(async (url: string) => {
      authUrl = url;
      return opened;
    });
    const request = vi.fn(async () =>
      Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
      }),
    );
    const pending = authorize(
      "gmail",
      { clientId: "synthetic-id", clientSecret: "synthetic-secret" },
      (text) => shown.push(text),
      controller.signal,
      request as any,
      openPage,
    );
    try {
      await vi.waitFor(() => expect(authUrl).toBeDefined());
      const auth = new URL(authUrl!);
      const bad = await fetch(
        auth.searchParams.get("redirect_uri")! +
          "?state=wrong&code=synthetic-code",
      );
      expect(bad.status).toBe(400);
      expect(request).not.toHaveBeenCalled();
      const response = await fetch(
        auth.searchParams.get("redirect_uri")! +
          `?state=${auth.searchParams.get("state")}&code=synthetic-code`,
      );
      expect(response.status).toBe(200);
      await expect(pending).resolves.toMatchObject({
        refresh_token: "synthetic-refresh",
      });
      expect(openPage).toHaveBeenCalledOnce();
      expect(shown.join(" ")).not.toContain("synthetic-secret");
      expect(shown.join(" ")).not.toContain("synthetic-refresh");
      if (opened) expect(shown.join(" ")).not.toContain("https://");
      else expect(shown.join(" ")).toContain("Open this sign-in link");
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  },
);
test("interrupting a coding task terminates its owned process", async () => {
  const binary = join(temp(), "fake-codex.cjs");
  writeFileSync(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, {
    mode: 0o700,
  });
  const controller = new AbortController();
  const task = codexTask("fixture coding task", controller.signal, binary);
  controller.abort();
  await expect(task).rejects.toThrow("interrupted");
  expect(codexTools[0].annotations.destructiveHint).toBe(true);
});
test("coding bridge recipe is scoped and long running without automatic edits", () => {
  const store = new TerminalStore(temp(), randomBytes(32));
  const connections = new TerminalConnections(
    store,
    "/fixture/project",
    "/fixture/butler",
  );
  expect(connections.recipes.find((r) => r.id === "codex")).toMatchObject({
    cwdFromFolder: true,
    longRunning: ["codex_task"],
    allowTools: ["codex_task"],
  });
  expect(store.profile.settings.tools.servers).toHaveLength(0);
});
