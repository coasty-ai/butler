import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createToolRegistry, type ToolRegistry } from "../tools/registry";
import { RECIPES, serverFromRecipe } from "../tools/providers/recipes";
import { toolServerSchema, type ToolServer } from "../core/schema";
import type { ServerRecipe } from "../core/tools";
import { authorize, type OAuthClient } from "./oauth";
import type { TerminalStore } from "./store";

export const CONNECTIONS = [
  "github",
  "slack",
  "claude-code",
  "codex",
  "gmail",
] as const;
export type ConnectionId = (typeof CONNECTIONS)[number];
export type Ask = (label: string, secret?: boolean) => Promise<string>;
export class TerminalConnections {
  readonly registry: ToolRegistry;
  readonly recipes: readonly ServerRecipe[];
  private githubToken = "";
  constructor(
    private store: TerminalStore,
    readonly project: string,
    readonly root: string,
  ) {
    this.recipes = [
      ...RECIPES,
      ...["codex", "gmail"].map((id): ServerRecipe => ({
        id,
        name: id === "codex" ? "Codex" : "Gmail",
        transport: "stdio",
        command: process.execPath,
        args: [join(root, "dist-terminal/mcp-server.cjs"), id],
        network: "internet",
        needsFolder: true,
        cwdFromFolder: true,
        secretEnv:
          id === "gmail"
            ? ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]
            : [],
        installNote: "Uses the locally installed Butler bridge.",
        defaultTools:
          id === "codex" ? ["codex_task"] : ["gmail_search", "gmail_read"],
        allowTools:
          id === "codex" ? ["codex_task"] : ["gmail_search", "gmail_read"],
        longRunning: id === "codex" ? ["codex_task"] : [],
        privateLocal: false,
        consent:
          id === "codex"
            ? "Runs the signed-in Codex CLI in {folder}; asks before each coding task."
            : "Reads Gmail with the owner’s OAuth grant; cannot send or change messages.",
      })),
    ];
    this.registry = createToolRegistry({
      recipes: this.recipes,
      settings: () => store.profile.settings,
      credentials: (
        id,
      ): { env: Record<string, string>; headers: Record<string, string> } => {
        const secrets = store.profile.secrets;
        return {
          env:
            id === "gmail"
              ? {
                  GMAIL_CLIENT_ID: secrets["gmail:clientId"] || "",
                  GMAIL_CLIENT_SECRET: secrets["gmail:clientSecret"] || "",
                  GMAIL_REFRESH_TOKEN: secrets["gmail:refreshToken"] || "",
                }
              : {},
          headers:
            id === "github"
              ? {
                  Authorization: this.githubToken
                    ? `Bearer ${this.githubToken}`
                    : "",
                  "X-MCP-Readonly": "true",
                }
              : id === "slack"
                ? {
                    Authorization: secrets["slack:accessToken"]
                      ? `Bearer ${secrets["slack:accessToken"]}`
                      : "",
                  }
                : {},
        };
      },
      helper: (name) => join(root, "native/bin", name),
      launch: () =>
        existsSync(join(root, "native/bin/coarena-launch"))
          ? join(root, "native/bin/coarena-launch")
          : undefined,
      home: homedir(),
      installRoot: join(store.root, "mcp"),
      version: "butler-terminal",
      onTicks: (id, tools) => {
        const row = store.profile.settings.tools.servers.find(
          (r) => r.id === id,
        );
        if (row) {
          row.tools = tools;
          store.save();
        }
      },
    });
  }
  private readGithubToken() {
    try {
      this.githubToken = execFileSync(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
      ).trim();
    } catch {
      this.githubToken = this.store.profile.secrets["github:token"] || "";
    }
  }
  async start() {
    this.githubToken = this.store.profile.secrets["github:token"] || "";
    if (!this.githubToken) this.readGithubToken();
    await this.refreshSlack();
    await this.registry.configure();
    await this.ready();
  }
  private async ready(id?: string) {
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      this.registry
        .status()
        .servers.some((s) => (!id || s.id === id) && s.state === "starting")
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  labels() {
    const servers = this.registry.status().servers;
    return CONNECTIONS.map((id) => {
      const s = servers.find((r) => r.id === id);
      return s
        ? `${s.name}: ${s.state}${s.code ? ` (${s.code})` : ""}`
        : `${id}: not connected`;
    });
  }
  private makeRow(id: ConnectionId): ToolServer {
    const recipe = this.recipes.find((r) => r.id === id);
    if (recipe) {
      const row = serverFromRecipe(recipe, {
        folder: this.project,
        addedAt: Date.now(),
      });
      if (id === "gmail")
        row.secretEnv = [
          "GMAIL_CLIENT_ID",
          "GMAIL_CLIENT_SECRET",
          "GMAIL_REFRESH_TOKEN",
        ];
      return row;
    }
    return toolServerSchema.parse({
      id,
      name: id === "codex" ? "Codex" : "Gmail",
      transport: "stdio",
      command: process.execPath,
      args: [join(this.root, "dist-terminal/mcp-server.cjs"), id],
      cwd: this.project,
      network: "internet",
      secretEnv:
        id === "gmail"
          ? ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]
          : [],
      addedAt: Date.now(),
    });
  }
  async connect(
    id: ConnectionId,
    ask: Ask,
    show: (text: string) => void,
    signal: AbortSignal,
  ) {
    if (!CONNECTIONS.includes(id))
      throw new Error("Choose github, slack, claude-code, codex or gmail.");
    const s = this.store.profile.settings;
    if (s.privacy === "PRIVATE_LOCAL")
      throw new Error(
        "These integrations require the BYOM setting. Choose a provider with /model first.",
      );
    let row = s.tools.servers.find((r) => r.id === id);
    if (!row) {
      row = this.makeRow(id);
      s.tools.servers.push(row);
      this.store.save();
    }
    if ((id === "claude-code" || id === "codex") && row.cwd !== this.project) {
      row.cwd = this.project;
      row.consented = false;
      row.enabled = false;
      row.approvedCommand = "";
      row.tools = {};
      this.store.save();
    }
    if (id === "github") {
      this.readGithubToken();
      if (!this.githubToken) {
        const token = await ask("GitHub access token", true);
        if (!token)
          throw new Error(
            "Run gh auth login or supply a token to connect GitHub.",
          );
        this.store.profile.secrets["github:token"] = token;
        this.githubToken = token;
        this.store.save();
      }
    }
    if (id === "gmail" || id === "slack") {
      const secrets = this.store.profile.secrets;
      const ready =
        id === "gmail"
          ? !!secrets["gmail:refreshToken"]
          : !!secrets["slack:accessToken"];
      if (!ready) {
        const client = await this.client(id, ask, show);
        const tokens = await authorize(id, client, show, signal);
        if (id === "gmail" && !tokens.refresh_token)
          throw new Error(
            "Google did not provide offline access. Revoke the old Butler grant and run /connect gmail again.",
          );
        secrets[`${id}:accessToken`] = tokens.access_token;
        if (tokens.refresh_token)
          secrets[`${id}:refreshToken`] = tokens.refresh_token;
        if (tokens.expires_in)
          secrets[`${id}:expiresAt`] = String(
            Date.now() + tokens.expires_in * 1000,
          );
        this.store.save();
      }
    }
    if (id === "codex") {
      try {
        execFileSync("codex", ["login", "status"], {
          stdio: "pipe",
          timeout: 5000,
        });
      } catch {
        throw new Error(
          "Codex needs sign-in. Run codex login, then /connect codex.",
        );
      }
    }
    if (id === "github" && this.githubToken) {
      this.store.profile.secrets["github:token"] = this.githubToken;
      this.store.save();
    }
    const probe = await this.registry.test(id);
    if (signal.aborted) throw new Error("Connection interrupted.");
    if (!probe.ok)
      throw new Error(
        `${row.name} could not connect: ${probe.code || probe.state}.`,
      );
    row.enabled = true;
    row.consented = true;
    row.approvedCommand = this.registry.approval(row);
    row.trust =
      id === "claude-code" || id === "codex" ? "ask" : "reads_unattended";
    this.store.save();
    await this.registry.configure();
    await this.ready(id);
    if (this.registry.status().servers.find((s) => s.id === id)?.state !== "on")
      throw new Error(
        `${row.name} was configured but its connection is not ready. Check /connections.`,
      );
    // Only owner-requested coding entry points and read tools are enabled.
    const listed =
      this.registry.status().servers.find((x) => x.id === id)?.tools ?? [];
    for (const tool of listed) {
      const selected =
        id === "github"
          ? [
              "get_me",
              "search_repositories",
              "list_pull_requests",
              "search_issues",
              "pull_request_read",
            ].includes(tool.name)
          : id === "claude-code"
            ? ["Agent", "Read"].includes(tool.name)
            : id === "codex"
              ? tool.name === "codex_task"
              : tool.tier === "read" && !tool.denied;
      if (selected && !tool.denied)
        row.tools = this.registry.tick(id, tool.name, true);
    }
    if (
      id === "gmail" &&
      !s.briefings.reads.some((r) => r.tool === "gmail__gmail_search")
    )
      s.briefings.reads.push({
        tool: "gmail__gmail_search",
        args: { query: "is:unread newer_than:1d", limit: 8 },
      });
    this.store.save();
    show(
      `${row.name} connected. ${probe.toolCount} tools listed. Coding tools are scoped to ${this.project}.`,
    );
  }
  private async client(
    id: "gmail" | "slack",
    ask: Ask,
    show: (text: string) => void,
  ): Promise<OAuthClient> {
    const secrets = this.store.profile.secrets;
    if (
      secrets[`${id}:clientId`] &&
      (id === "slack" || secrets[`${id}:clientSecret`])
    )
      return {
        clientId: secrets[`${id}:clientId`],
        clientSecret:
          id === "gmail" ? secrets[`${id}:clientSecret`] : undefined,
      };
    let client: OAuthClient;
    if (id === "gmail") {
      show(
        "Gmail needs a Google OAuth Desktop client. Download its client JSON from your Google Cloud project with Gmail API enabled, then enter the file path. Access requested: Gmail read only. https://console.cloud.google.com/apis/credentials",
      );
      const path = await ask("Google client JSON path");
      let value: any;
      try {
        value = JSON.parse(
          readFileSync(resolve(path.replace(/^~(?=\/)/, homedir())), "utf8"),
        );
      } catch {
        throw new Error(
          "The Google client JSON could not be read. Check its path and download a valid Desktop client file.",
        );
      }
      if (
        typeof value?.installed?.client_id !== "string" ||
        typeof value?.installed?.client_secret !== "string"
      )
        throw new Error("Use the JSON for a Google Desktop OAuth client.");
      client = {
        clientId: value.installed.client_id,
        clientSecret: value.installed.client_secret,
      };
    } else {
      show(
        "Slack needs a dedicated internal app approved for MCP. Enable PKCE in OAuth & Permissions (a one-way public-client setting), then add http://localhost:53682/callback as its redirect URL. Add user scopes search:read.public, search:read.private, channels:history, groups:history. No Client Secret is required for this desktop flow. https://api.slack.com/apps",
      );
      client = {
        clientId: await ask("Slack app client ID"),
      };
      if (!client.clientId)
        throw new Error("Slack's OAuth client details are required.");
    }
    secrets[`${id}:clientId`] = client.clientId;
    if (client.clientSecret)
      secrets[`${id}:clientSecret`] = client.clientSecret;
    this.store.save();
    return client;
  }
  async refreshSlack() {
    const secrets = this.store.profile.secrets;
    if (
      !secrets["slack:refreshToken"] ||
      Number(secrets["slack:expiresAt"]) > Date.now() + 120_000
    )
      return;
    const response = await fetch("https://slack.com/api/oauth.v2.user.access", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: secrets["slack:clientId"],
        grant_type: "refresh_token",
        refresh_token: secrets["slack:refreshToken"],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const token = await response.json();
    if (!response.ok || !token.ok || typeof token.access_token !== "string")
      throw new Error(
        "Slack sign-in expired. Reconnect it with /connect slack.",
      );
    secrets["slack:accessToken"] = token.access_token;
    if (token.refresh_token)
      secrets["slack:refreshToken"] = token.refresh_token;
    secrets["slack:expiresAt"] = String(
      Date.now() + Number(token.expires_in || 3600) * 1000,
    );
    this.store.save();
    await this.registry.configure();
  }
}
