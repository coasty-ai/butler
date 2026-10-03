import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/client";
import { moduleEndpoint, type ToolServer } from "../core/schema";
import type { TerminalStore } from "./store";

const REDIRECT = "http://127.0.0.1:53684/callback";
/** SDK discovery, issuer binding and PKCE; credentials stay in the encrypted profile. */
export class McpOAuth {
  constructor(
    private store: TerminalStore,
    private request: typeof fetch = fetch,
  ) {}
  private provider(
    row: ToolServer,
    redirect: (url: URL) => void,
  ): OAuthClientProvider {
    const secrets = this.store.profile.secrets;
    const prefix = `mcp:${row.id}:oauth:`;
    const key = (kind: string, issuer?: string) =>
      prefix +
      kind +
      ":" +
      createHash("sha256")
        .update(issuer || "unbound")
        .digest("hex");
    const read = (name: string) =>
      secrets[name] ? JSON.parse(secrets[name]) : undefined;
    const save = (name: string, value: unknown) => {
      secrets[name] = JSON.stringify(value);
      this.store.save();
    };
    let verifier = "";
    const state = secrets[prefix + "state"] || "";
    return {
      redirectUrl: REDIRECT,
      clientMetadata: {
        client_name: "Butler terminal",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: secrets[prefix + "clientSecret"]
          ? "client_secret_post"
          : "none",
      },
      state: () => state,
      clientInformation: (ctx) =>
        read(key("client", ctx?.issuer)) ||
        (secrets[prefix + "clientId"]
          ? {
              client_id: secrets[prefix + "clientId"],
              ...(secrets[prefix + "clientSecret"]
                ? { client_secret: secrets[prefix + "clientSecret"] }
                : {}),
            }
          : undefined),
      saveClientInformation: (value, ctx) =>
        save(key("client", ctx?.issuer), value),
      tokens: (ctx) =>
        read(key("tokens", ctx?.issuer || secrets[prefix + "issuer"])),
      saveTokens: (value, ctx) => {
        const issuer =
          ctx?.issuer || (value as { issuer?: string }).issuer || "";
        secrets[prefix + "issuer"] = issuer;
        secrets[prefix + "expiresAt"] = String(
          Date.now() + (value.expires_in ?? 3600) * 1000,
        );
        secrets[`mcp:${row.id}:header:Authorization`] =
          "Bearer " + value.access_token;
        save(key("tokens", issuer), value);
      },
      redirectToAuthorization: redirect,
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      discoveryState: () => read(prefix + "discovery"),
      saveDiscoveryState: (value) => save(prefix + "discovery", value),
      invalidateCredentials: (scope) => {
        if (scope === "verifier") {
          verifier = "";
          return;
        }
        for (const name of Object.keys(secrets))
          if (
            name.startsWith(prefix) &&
            (scope === "all" ||
              name.includes(":" + scope.replace(/s$/, "") + ":") ||
              (scope === "discovery" && name === prefix + "discovery"))
          )
            delete secrets[name];
        if (scope === "all" || scope === "tokens")
          delete secrets[`mcp:${row.id}:header:Authorization`];
        this.store.save();
      },
    };
  }
  private fetch(signal: AbortSignal): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!moduleEndpoint(url))
        throw new Error("Unsupported MCP authorization endpoint.");
      return this.request(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(15_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    }) as typeof fetch;
  }
  async signIn(
    row: ToolServer,
    show: (text: string) => void,
    signal: AbortSignal,
  ) {
    if (row.transport !== "http" || !moduleEndpoint(row.url))
      throw new Error("OAuth needs a valid HTTP MCP endpoint.");
    const state = randomBytes(32).toString("hex");
    const stateKey = `mcp:${row.id}:oauth:state`;
    this.store.profile.secrets[stateKey] = state;
    let resolveCode: (value: { code: string; iss?: string }) => void;
    let rejectCode: (error: Error) => void;
    const code = new Promise<{ code: string; iss?: string }>(
      (resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      },
    );
    // Attach before discovery, which can fail before the callback is awaited.
    void code.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", REDIRECT);
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      if (
        req.method !== "GET" ||
        url.pathname !== "/callback" ||
        url.searchParams.get("state") !== state
      ) {
        res.writeHead(400);
        res.end("Invalid sign-in callback.");
        return;
      }
      if (url.searchParams.has("error")) {
        res.end("Access declined. Return to Butler.");
        rejectCode(new Error("MCP access was declined."));
        return;
      }
      const value = url.searchParams.get("code");
      if (!value || value.length > 8192) {
        res.writeHead(400);
        res.end("Missing sign-in code.");
        return;
      }
      res.end("Sign-in received. Return to Butler.");
      resolveCode({
        code: value,
        ...(url.searchParams.get("iss")
          ? { iss: url.searchParams.get("iss")! }
          : {}),
      });
    });
    const cancel = () => rejectCode(new Error("MCP sign-in cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => rejectCode(new Error("MCP sign-in timed out.")),
      10 * 60_000,
    );
    const provider = this.provider(row, (url) => {
      if (!moduleEndpoint(url.toString()))
        throw new Error("Unsupported MCP authorization URL.");
      show(
        `Open this URL and approve the account and scopes you want Butler to use:\n${url}`,
      );
    });
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        server.once("error", () =>
          reject(new Error("MCP callback port 53684 is unavailable.")),
        );
        server.listen(53684, "127.0.0.1", resolve);
      });
      const fetchFn = this.fetch(signal);
      const result = await auth(provider, { serverUrl: row.url, fetchFn });
      if (result === "REDIRECT") {
        const received = await code;
        await auth(provider, {
          serverUrl: row.url,
          authorizationCode: received.code,
          iss: received.iss,
          fetchFn,
        });
      }
      if (!this.store.profile.secrets[`mcp:${row.id}:header:Authorization`])
        throw new Error("MCP sign-in did not grant a token.");
    } catch {
      signal.throwIfAborted();
      // SDK exceptions may include a token endpoint's response body.
      throw new Error(
        "MCP OAuth sign-in could not finish. This server needs PKCE and either public-client registration or a registered client ID. Check its client settings, or import its authenticated local proxy or supported token/header.",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      server.closeAllConnections();
      server.close();
      delete this.store.profile.secrets[stateKey];
      this.store.save();
    }
  }
  async refresh(row: ToolServer) {
    const prefix = `mcp:${row.id}:oauth:`;
    const secrets = this.store.profile.secrets;
    if (
      !secrets[prefix + "issuer"] ||
      Number(secrets[prefix + "expiresAt"]) > Date.now() + 120_000
    )
      return;
    try {
      await auth(
        this.provider(row, () => {
          throw new Error("Interactive sign-in required.");
        }),
        {
          serverUrl: row.url,
          fetchFn: this.fetch(AbortSignal.timeout(20_000)),
        },
      );
    } catch {
      throw new Error(
        `${row.name} needs sign-in. Use /connect oauth ${row.id}.`,
      );
    }
  }
}
