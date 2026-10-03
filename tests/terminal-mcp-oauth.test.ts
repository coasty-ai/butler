import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TerminalStore } from "../src/terminal/store";
import { toolServerSchema } from "../src/core/schema";
import { McpOAuth } from "../src/terminal/mcp-oauth";

const sdk = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@modelcontextprotocol/client", () => ({ auth: sdk.auth }));
const roots: string[] = [];
afterEach(() => {
  sdk.auth.mockReset();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "butler-mcp-oauth-test-"));
  roots.push(root);
  const key = randomBytes(32);
  const store = new TerminalStore(root, key);
  const row = toolServerSchema.parse({
    id: "fixture",
    name: "Fixture",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    secretHeaders: ["Authorization"],
    addedAt: 1,
  });
  return { root, key, store, row, oauth: new McpOAuth(store) };
}
test("remote MCP sign-in rejects wrong state, preserves PKCE and issuer, and encrypts credentials", async () => {
  const f = fixture();
  let authorizationUrl: URL;
  sdk.auth.mockImplementation(async (provider: any, options: any) => {
    if (!options.authorizationCode) {
      provider.saveCodeVerifier("synthetic-pkce-verifier");
      await provider.saveClientInformation(
        { client_id: "synthetic-client" },
        { issuer: "https://issuer.example.test" },
      );
      authorizationUrl = new URL("https://issuer.example.test/authorize");
      authorizationUrl.searchParams.set("state", provider.state());
      await provider.redirectToAuthorization(authorizationUrl);
      return "REDIRECT";
    }
    expect(options.authorizationCode).toBe("synthetic-code");
    expect(options.iss).toBe("https://issuer.example.test");
    expect(provider.codeVerifier()).toBe("synthetic-pkce-verifier");
    expect(
      provider.clientInformation({ issuer: "https://other.example.test" }),
    ).toBeUndefined();
    await provider.saveTokens(
      {
        access_token: "synthetic-access-fixture",
        refresh_token: "synthetic-refresh-fixture",
        token_type: "Bearer",
        expires_in: 3600,
      },
      { issuer: options.iss },
    );
    return "AUTHORIZED";
  });
  const show = vi.fn();
  const signIn = f.oauth.signIn(f.row, show, new AbortController().signal);
  await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
  const wrong = await fetch(
    "http://127.0.0.1:53684/callback?state=wrong&code=synthetic-code",
  );
  expect(wrong.status).toBe(400);
  expect(sdk.auth).toHaveBeenCalledOnce();
  const url = new URL("http://127.0.0.1:53684/callback");
  url.searchParams.set("state", authorizationUrl!.searchParams.get("state")!);
  url.searchParams.set("code", "synthetic-code");
  url.searchParams.set("iss", "https://issuer.example.test");
  expect((await fetch(url)).status).toBe(200);
  await signIn;
  expect(f.store.profile.secrets["mcp:fixture:oauth:state"]).toBeUndefined();
  expect(
    new TerminalStore(f.root, f.key).profile.secrets[
      "mcp:fixture:header:Authorization"
    ],
  ).toBe("Bearer synthetic-access-fixture");
  expect(readFileSync(join(f.root, "profile.enc"), "utf8")).not.toContain(
    "synthetic-access-fixture",
  );
});
test("cancelled sign-in releases the callback port and token response bodies stay private", async () => {
  const f = fixture();
  const controller = new AbortController();
  const show = vi.fn();
  sdk.auth.mockImplementation(async (provider: any) => {
    provider.redirectToAuthorization(
      new URL("https://issuer.example.test/authorize"),
    );
    return "REDIRECT";
  });
  const signIn = f.oauth.signIn(f.row, show, controller.signal);
  const cancelled = expect(signIn).rejects.toThrow();
  await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
  controller.abort();
  await cancelled;
  expect(f.store.profile.secrets["mcp:fixture:oauth:state"]).toBeUndefined();
  sdk.auth.mockImplementation(async () => {
    throw new Error("private token endpoint body fixture");
  });
  await expect(
    f.oauth.signIn(f.row, vi.fn(), new AbortController().signal),
  ).rejects.toThrow("MCP OAuth sign-in could not finish");
  await expect(
    f.oauth.signIn(f.row, vi.fn(), new AbortController().signal),
  ).rejects.not.toThrow("private token endpoint body");
});
test("near-expiry refresh uses the stored issuer and never opens an interactive sign-in", async () => {
  const f = fixture();
  f.store.profile.secrets["mcp:fixture:oauth:issuer"] =
    "https://issuer.example.test";
  f.store.profile.secrets["mcp:fixture:oauth:expiresAt"] = String(
    Date.now() + 3600_000,
  );
  await f.oauth.refresh(f.row);
  expect(sdk.auth).not.toHaveBeenCalled();
  f.store.profile.secrets["mcp:fixture:oauth:expiresAt"] = "1";
  sdk.auth.mockImplementation(async (provider: any) => {
    await provider.redirectToAuthorization(
      new URL("https://issuer.example.test/authorize"),
    );
  });
  await expect(f.oauth.refresh(f.row)).rejects.toThrow(
    "/connect oauth fixture",
  );
  expect(sdk.auth).toHaveBeenCalledOnce();
});
