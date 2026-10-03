import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}
export interface OAuthToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
export function authorizationUrl(
  provider: "gmail" | "slack",
  client: OAuthClient,
  redirect: string,
  state: string,
  challenge?: string,
): string {
  const url = new URL(
    provider === "gmail"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://slack.com/oauth/v2_user/authorize",
  );
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (provider === "gmail") {
    url.searchParams.set(
      "scope",
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else
    url.searchParams.set(
      "scope",
      "search:read.public,search:read.private,channels:history,groups:history",
    );
  return url.toString();
}
export async function exchangeCode(
  provider: "gmail" | "slack",
  client: OAuthClient,
  code: string,
  redirect: string,
  request: typeof fetch = fetch,
  verifier?: string,
  signal?: AbortSignal,
): Promise<OAuthToken> {
  const response = await request(
    provider === "gmail"
      ? "https://oauth2.googleapis.com/token"
      : "https://slack.com/api/oauth.v2.user.access",
    {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        code,
        redirect_uri: redirect,
        grant_type: "authorization_code",
        ...(verifier ? { code_verifier: verifier } : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error("The provider could not exchange the sign-in code.");
  const data = await response.json();
  const token = data;
  if (data.ok === false || typeof token?.access_token !== "string")
    throw new Error("Sign-in did not grant the required account access.");
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_in: token.expires_in,
  };
}
/** Only the owner opens/approves this URL; no browser automation or credential logging. */
export async function authorize(
  provider: "gmail" | "slack",
  client: OAuthClient,
  show: (text: string) => void,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<OAuthToken> {
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = verifier
    ? createHash("sha256").update(verifier).digest("base64url")
    : undefined;
  const port = provider === "slack" ? 53682 : 53683;
  const redirect = `http://${provider === "gmail" ? "127.0.0.1" : "localhost"}:${port}/callback`;
  let server: ReturnType<typeof createServer>;
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      abort = () => fail(new Error("Sign-in cancelled."));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => fail(new Error("Sign-in timed out. Run /connect again.")),
        10 * 60_000,
      );
      server = createServer((req, res) => {
        let url: URL;
        try {
          url = new URL(req.url || "/", redirect);
        } catch {
          res.writeHead(400);
          res.end("Invalid callback.");
          return;
        }
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        if (
          req.method !== "GET" ||
          url.pathname !== "/callback" ||
          url.searchParams.get("state") !== state
        ) {
          res.writeHead(400);
          res.end("Unrecognised sign-in callback.");
          return;
        }
        if (url.searchParams.has("error")) {
          res.end("Access was not granted. Return to Butler.");
          fail(new Error("Account access was declined."));
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("The sign-in code is missing.");
          return;
        }
        res.end(
          "Sign-in received. You may close this tab and return to Butler.",
        );
        resolve(code);
      });
      server.once("error", () =>
        fail(new Error(`The sign-in callback port ${port} is unavailable.`)),
      );
      server.listen(port, "127.0.0.1", () =>
        show(
          `Open this URL and approve the account you want Butler to use:\n${authorizationUrl(provider, client, redirect, state, challenge)}`,
        ),
      );
    });
    return await exchangeCode(
      provider,
      client,
      code,
      redirect,
      request,
      verifier,
      signal,
    );
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abort!);
    server!?.close();
  }
}
