import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createToolRegistry, type ToolRegistry } from "../tools/registry";
import {
  RECIPES,
  serverFromRecipe,
  consentText,
} from "../tools/providers/recipes";
import {
  importConnections,
  type ImportedConnection,
} from "./connection-config";
import { createSlackReader, SlackConnectionError } from "./slack";
import { McpOAuth } from "./mcp-oauth";
import type { AppleConsent } from "../core/tools";
import { TOOL_LIMITS } from "../core/tools";
import {
  toolServerSchema,
  type ToolServer,
  type Settings,
} from "../core/schema";
import type { ServerRecipe } from "../core/tools";
import { authorize, SLACK_READ_SCOPES, type OAuthClient } from "./oauth";
import type { TerminalStore } from "./store";
import {
  browserSetupTask,
  findGoogleClient,
  googleClientFile,
  type SetupApp,
} from "./concierge";
import { desktopSetupTask, appNames } from "./onboarding";

export const CONNECTIONS = [
  "github",
  "slack",
  "claude-code",
  "codex",
  "gmail",
  "filesystem",
  "playwright",
  "slack-bot",
] as const;
export type ConnectionId = (typeof CONNECTIONS)[number];
export type Ask = (label: string, secret?: boolean) => Promise<string>;
export interface ConnectionSetup {
  connected: string[];
  pending: string[];
  browserTask?: string;
  browserApp?: "gmail" | "slack" | "github";
}
/** Scope a direct Apple read or a passive check without editing saved consent. */
export function connectionSettings(
  settings: Settings,
  briefingsOnly: boolean,
  firstPartyOnly = false,
  onlyServers?: readonly string[],
): Settings {
  if (!briefingsOnly && !firstPartyOnly && !onlyServers) return settings;
  return {
    ...settings,
    tools: {
      ...settings.tools,
      servers: settings.tools.servers.map((server) => ({
        ...server,
        enabled:
          server.enabled &&
          !firstPartyOnly &&
          (!onlyServers || onlyServers.includes(server.id)) &&
          (!briefingsOnly ||
            settings.briefings.reads.some((read) =>
              read.tool.startsWith(`${server.id}__`),
            )),
      })),
    },
  };
}
export class TerminalConnections {
  readonly registry: ToolRegistry;
  readonly recipes: readonly ServerRecipe[];
  private githubToken = "";
  private warnings: string[] = [];
  private briefingsOnly = false;
  private firstPartyOnly = false;
  private onlyServers?: readonly string[];
  private browserAttempted = new Set<SetupApp>();
  private slackIssue?: SlackConnectionError;
  private async verifySlackBot(
    token: string,
    signal: AbortSignal,
    authenticated?: () => void | Promise<void>,
  ) {
    try {
      const read = createSlackReader({ SLACK_BOT_TOKEN: token });
      await read("auth_test", {}, signal);
      signal.throwIfAborted();
      await authenticated?.();
      await read("readiness_test", {}, signal);
      signal.throwIfAborted();
      this.slackIssue = undefined;
    } catch (error) {
      signal.throwIfAborted();
      this.slackIssue =
        error instanceof SlackConnectionError
          ? error
          : new SlackConnectionError(
              "VERIFY_FAILED",
              "Slack could not be verified right now. Your saved setup is kept; say ‘Connect Slack’ to retry.",
            );
      throw this.slackIssue;
    }
  }
  private scopedSettings() {
    return connectionSettings(
      this.store.profile.settings,
      this.briefingsOnly,
      this.firstPartyOnly,
      this.onlyServers,
    );
  }
  constructor(
    private store: TerminalStore,
    readonly project: string,
    readonly root: string,
    private openPage?: (url: string) => Promise<boolean>,
  ) {
    this.recipes = [
      ...RECIPES,
      ...["codex", "gmail", "slack-bot"].map((id): ServerRecipe => ({
        id,
        name: id === "codex" ? "Codex" : id === "gmail" ? "Gmail" : "Slack bot",
        transport: "stdio",
        command: process.execPath,
        args: [
          join(root, "dist-terminal/mcp-server.cjs"),
          id === "slack-bot" ? "slack" : id,
        ],
        network: "internet",
        needsFolder: true,
        cwdFromFolder: true,
        secretEnv:
          id === "gmail"
            ? ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]
            : id === "slack-bot"
              ? ["SLACK_BOT_TOKEN"]
              : [],
        installNote: "Uses the locally installed Butler bridge.",
        defaultTools:
          id === "codex"
            ? ["codex_task"]
            : id === "gmail"
              ? ["gmail_search", "gmail_read"]
              : [
                  "slack_channels",
                  "slack_history",
                  "slack_thread",
                  "slack_activity",
                ],
        allowTools:
          id === "codex"
            ? ["codex_task"]
            : id === "gmail"
              ? ["gmail_search", "gmail_read"]
              : [
                  "slack_channels",
                  "slack_history",
                  "slack_thread",
                  "slack_activity",
                ],
        longRunning: id === "codex" ? ["codex_task"] : [],
        privateLocal: false,
        consent:
          id === "codex"
            ? "Runs the signed-in Codex CLI in {folder}; asks before each coding task."
            : id === "gmail"
              ? "Reads Gmail with the owner’s OAuth grant; cannot send or change messages."
              : "Reads conversations the Slack bot has joined. Cannot send messages or read the owner's other DMs.",
      })),
    ];
    this.registry = createToolRegistry({
      recipes: this.recipes,
      onDemand: ["claude-code", "codex", "playwright"],
      settings: () => this.scopedSettings(),
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
              : id === "slack-bot"
                ? { SLACK_BOT_TOKEN: secrets["slack:botToken"] || "" }
                : Object.fromEntries(
                    store.profile.settings.tools.servers
                      .find((r) => r.id === id)
                      ?.secretEnv.map((name) => [
                        name,
                        secrets[`mcp:${id}:env:${name}`] || "",
                      ]) || [],
                  ),
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
                : Object.fromEntries(
                    store.profile.settings.tools.servers
                      .find((r) => r.id === id)
                      ?.secretHeaders.map((name) => [
                        name,
                        secrets[`mcp:${id}:header:${name}`] || "",
                      ]) || [],
                  ),
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
      catalogues: store.catalogues,
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
  async start(
    options: {
      briefingsOnly?: boolean;
      firstPartyOnly?: boolean;
      onlyServers?: readonly string[];
    } = {},
  ) {
    this.briefingsOnly = !!options.briefingsOnly;
    this.firstPartyOnly = !!options.firstPartyOnly;
    this.onlyServers = options.onlyServers;
    this.githubToken = this.store.profile.secrets["github:token"] || "";
    if (
      !this.githubToken &&
      this.scopedSettings().tools.servers.some(
        (row) => row.id === "github" && row.enabled,
      )
    )
      this.readGithubToken();
    await this.refreshCredentials();
    await this.registry.configure();
    await this.ready();
  }
  private async ready(id?: string) {
    const deadline = Date.now() + 15_000;
    const starting = () => {
      const status = this.registry.status();
      return (
        (!id && status.apple.state === "starting") ||
        status.servers.some(
          (server) => (!id || server.id === id) && server.state === "starting",
        )
      );
    };
    while (Date.now() < deadline && starting())
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  labels() {
    const servers = this.registry.status().servers;
    const ids = [
      ...new Set([
        ...CONNECTIONS,
        ...this.store.profile.settings.tools.servers.map((r) => r.id),
      ]),
    ];
    const labels = ids.map((id) => {
      const s = servers.find((r) => r.id === id);
      if (id === "slack-bot" && this.slackIssue)
        return "Slack bot: needs attention";
      if (s?.code === "ON_DEMAND") return `${s.name}: ready on demand`;
      return s
        ? `${s.name}: ${s.state}${s.code ? ` (${s.code})` : ""}`
        : `${id}: not connected`;
    });
    const apple = this.registry.status().apple;
    labels.push(
      `Apple apps: ${apple.state}${apple.code ? ` (${apple.code})` : ""}`,
    );
    for (const app of this.store.profile.onboarding?.desktopReady || []) {
      const id = app === "slack" ? "slack-bot" : app;
      if (
        !servers.some(
          (server) =>
            (server.id === app || server.id === id) &&
            !(server.id === "slack-bot" && this.slackIssue) &&
            (server.state === "on" || server.code === "ON_DEMAND"),
        )
      )
        labels.push(`${appNames([app])}: computer use`);
    }
    return labels;
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
  /** An explicit chat request reuses local grants and leaves account decisions to the owner. */
  async setup(
    apps: SetupApp[],
    browser: string,
    show: (text: string) => void,
    signal: AbortSignal,
    clientFolders = [join(homedir(), "Downloads"), this.project],
    ask?: Ask,
    options: {
      desktopFirst?: boolean;
      desktopReady?: readonly SetupApp[];
      slackInstalled?: boolean;
    } = {},
  ): Promise<ConnectionSetup> {
    const result: ConnectionSetup = { connected: [], pending: [] };
    const secrets = this.store.profile.secrets;
    const slackPending = (error: SlackConnectionError) => {
      show(error.message);
      result.pending.push("slack");
      if (
        options.desktopFirst &&
        !result.browserTask &&
        !options.desktopReady?.includes("slack")
      ) {
        result.browserTask = desktopSetupTask(
          "slack",
          browser,
          !!options.slackInstalled,
        );
        result.browserApp = "slack";
        show(
          "I'll get your signed-in Slack app ready for computer use while its bot connection needs repair.",
        );
      }
    };
    const missing = () => {
      throw new Error("SETUP_INPUT_REQUIRED");
    };
    for (const app of [...new Set(apps)]) {
      signal.throwIfAborted();
      if (["calendar", "reminders", "notes", "mail"].includes(app)) {
        const consent = app as AppleConsent;
        this.store.profile.settings.tools.apple[consent] = true;
        this.store.save();
        try {
          let access = await this.registry.appleAccess();
          if (access[consent] === "notDetermined") {
            show(`Please approve macOS access to ${app} when it asks.`);
            access = await this.registry.requestApple(consent);
          }
          (access[consent] === "granted"
            ? result.connected
            : result.pending
          ).push(app);
        } catch {
          signal.throwIfAborted();
          result.pending.push(app);
        }
        continue;
      }
      if (this.store.profile.settings.privacy === "PRIVATE_LOCAL") {
        result.pending.push(app);
        if (
          options.desktopFirst &&
          !result.browserTask &&
          !options.desktopReady?.includes(app) &&
          (app === "gmail" || app === "slack" || app === "github")
        ) {
          result.browserTask = desktopSetupTask(
            app,
            browser,
            !!options.slackInstalled,
          );
          result.browserApp = app;
        }
        continue;
      }
      if (
        (this.browserAttempted.has(app) ||
          this.store.profile.settings.tools.servers.some(
            (row) =>
              !row.enabled &&
              (row.id === app || (app === "slack" && row.id === "slack-bot")),
          )) &&
        ask &&
        !options.desktopFirst &&
        (app === "github" || app === "slack") &&
        !(app === "github"
          ? secrets["github:token"]
          : secrets["slack:botToken"] ||
            secrets["slack:accessToken"] ||
            secrets["slack:clientId"])
      ) {
        const token = await ask(
          app === "github"
            ? "Paste the GitHub token from the access you approved (hidden), or leave blank to continue browser setup"
            : "Paste your approved Slack bot token (hidden), or leave blank to continue browser setup",
          true,
        );
        signal.throwIfAborted();
        if (token) {
          if (app === "slack" && !/^xoxb-[A-Za-z0-9-]{10,}$/.test(token))
            throw new Error(
              "That isn't a Slack bot token. It should start with xoxb-.",
            );
          secrets[app === "github" ? "github:token" : "slack:botToken"] = token;
          this.store.save();
        }
      }
      const id =
        app === "slack" &&
        secrets["slack:botToken"] &&
        !secrets["slack:accessToken"]
          ? "slack-bot"
          : (app as ConnectionId);
      const row = this.store.profile.settings.tools.servers.find(
        (row) => row.id === id,
      );
      const live = this.registry
        .status()
        .servers.find((server) => server.id === id);
      if (
        row?.enabled &&
        row.consented &&
        row.approvedCommand === this.registry.approval(row) &&
        live?.state === "on" &&
        (app !== "gmail" ||
          (secrets["gmail:clientId"] &&
            secrets["gmail:clientSecret"] &&
            secrets["gmail:refreshToken"])) &&
        (!(id === "codex" || id === "claude-code") || row.cwd === this.project)
      ) {
        if (id === "slack-bot") {
          try {
            await this.verifySlackBot(secrets["slack:botToken"], signal);
            result.connected.push(app);
          } catch (error) {
            signal.throwIfAborted();
            slackPending(error as SlackConnectionError);
          }
        } else result.connected.push(app);
        continue;
      }
      if (
        app === "gmail" &&
        !(secrets["gmail:clientId"] && secrets["gmail:clientSecret"])
      ) {
        let client = findGoogleClient(clientFolders);
        if (
          !client &&
          ask &&
          !options.desktopFirst &&
          (this.browserAttempted.has(app) || row)
        ) {
          const path = await ask(
            "Choose your downloaded Google Desktop client JSON (file path), or leave blank for browser setup",
            true,
          );
          signal.throwIfAborted();
          if (path)
            client = googleClientFile(
              resolve(path.replace(/^~(?=\/)/, homedir())),
            );
        }
        if (client) {
          if (secrets["gmail:clientId"] !== client.clientId) {
            // A refresh grant belongs to its client, never another project.
            delete secrets["gmail:refreshToken"];
            delete secrets["gmail:accessToken"];
            delete secrets["gmail:expiresAt"];
          }
          secrets["gmail:clientId"] = client.clientId;
          secrets["gmail:clientSecret"] = client.clientSecret!;
          this.store.save();
        }
      }
      if (app === "github") this.readGithubToken();
      const needsBrowser =
        app === "gmail"
          ? !(secrets["gmail:clientId"] && secrets["gmail:clientSecret"])
          : app === "slack"
            ? id === "slack" &&
              !secrets["slack:accessToken"] &&
              !secrets["slack:clientId"]
            : app === "github" && !this.githubToken;
      if (needsBrowser && ["gmail", "slack", "github"].includes(app)) {
        // A disabled built-in row records unfinished setup across restarts. It
        // carries no access grant, selected tools or command approval.
        if (
          !row &&
          this.store.profile.settings.tools.servers.length < TOOL_LIMITS.servers
        ) {
          this.store.profile.settings.tools.servers.push(this.makeRow(id));
          this.store.save();
        }
        result.pending.push(app);
        if (!result.browserTask && !options.desktopReady?.includes(app)) {
          const webApp = app as "gmail" | "slack" | "github";
          result.browserTask = options.desktopFirst
            ? desktopSetupTask(webApp, browser, !!options.slackInstalled)
            : browserSetupTask(webApp, browser);
          result.browserApp = webApp;
          this.browserAttempted.add(app);
        }
        continue;
      }
      try {
        // A saved bot token needs no repeated token question; all other missing
        // input stops this connection instead of opening another terminal wizard.
        await this.connect(
          id,
          (label) =>
            id === "slack-bot" && label.includes("reuse")
              ? Promise.resolve("")
              : missing(),
          (message) => {
            if (
              message.startsWith("Finish signing in") ||
              message.startsWith("Open this sign-in")
            )
              show(message);
          },
          signal,
        );
        result.connected.push(app);
      } catch (error) {
        signal.throwIfAborted();
        if (app === "slack" && error instanceof SlackConnectionError) {
          slackPending(error);
        } else result.pending.push(app);
      }
    }
    signal.throwIfAborted();
    await this.registry.configure();
    signal.throwIfAborted();
    show(
      result.connected.length
        ? `Ready: ${result.connected.join(", ")}.`
        : "No new connections are ready yet.",
    );
    if (result.pending.length)
      show(`Still needs attention: ${result.pending.join(", ")}.`);
    return result;
  }
  async connect(
    id: ConnectionId,
    ask: Ask,
    show: (text: string) => void,
    signal: AbortSignal,
    options: { slackClientId?: string } = {},
  ) {
    if (!CONNECTIONS.includes(id))
      throw new Error("Choose a connection from /connect list.");
    const s = this.store.profile.settings;
    if (
      s.privacy === "PRIVATE_LOCAL" &&
      !this.recipes.find((r) => r.id === id)?.privateLocal
    )
      throw new Error(
        "These integrations require the BYOM setting. Choose a provider with /model first.",
      );
    let row = s.tools.servers.find((r) => r.id === id);
    if (!row) {
      if (s.tools.servers.length >= TOOL_LIMITS.servers)
        throw new Error(
          `Butler supports up to ${TOOL_LIMITS.servers} configured servers.`,
        );
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
    if (id === "slack-bot") {
      show(
        "Slack bot connection: reads only conversations your bot has joined. Add the needed conversation read/history scopes and invite the bot to channels. An xapp app token is not needed for periodic reads.",
      );
      const secrets = this.store.profile.secrets;
      const token =
        (await ask(
          secrets["slack:botToken"]
            ? "Slack bot token (leave empty to reuse the saved token)"
            : "Slack bot token (xoxb-…)",
          true,
        )) ||
        secrets["slack:botToken"] ||
        "";
      if (!/^xoxb-[A-Za-z0-9-]{10,}$/.test(token))
        throw new Error("Enter a Slack bot token beginning xoxb-.");
      await this.verifySlackBot(token, signal, async () => {
        // Keep an authenticated token even if scopes or membership need repair.
        const changed = secrets["slack:botToken"] !== token;
        secrets["slack:botToken"] = token;
        this.store.save();
        // Rotate an existing bridge too; it must not keep the previous account.
        if (changed) await this.registry.configure();
      });
    }
    if (id === "gmail" || id === "slack") {
      const secrets = this.store.profile.secrets;
      let ready =
        id === "gmail"
          ? !!secrets["gmail:refreshToken"]
          : !!secrets["slack:accessToken"];
      if (
        id === "slack" &&
        ready &&
        secrets["slack:readScopeRequest"] !== SLACK_READ_SCOPES.join(",")
      ) {
        // Only a connection request upgrades an older grant; startup keeps
        // existing access. Remember the requested set, not a claim of coverage.
        show(
          "Slack needs one account approval to add your DMs, group messages and other read access. Your existing connection is kept if you cancel.",
        );
        ready = false;
      }
      if (
        id === "slack" &&
        ready &&
        Number(secrets["slack:expiresAt"]) <= Date.now() + 120_000
      ) {
        try {
          await this.refreshSlack();
        } catch {
          ready = false;
        }
      }
      if (!ready) {
        const client =
          id === "slack" && options.slackClientId
            ? { clientId: options.slackClientId }
            : await this.client(id, ask, show);
        const tokens = await authorize(
          id,
          client,
          show,
          signal,
          fetch,
          this.openPage,
        );
        if (id === "gmail" && !tokens.refresh_token)
          throw new Error(
            "Google did not provide offline access. Revoke the old Butler grant and run /connect gmail again.",
          );
        if (id === "slack") {
          // A new grant must not reuse refresh/expiry data from the old token.
          delete secrets["slack:refreshToken"];
          delete secrets["slack:expiresAt"];
          secrets["slack:clientId"] = client.clientId;
          secrets["slack:readScopeRequest"] = SLACK_READ_SCOPES.join(",");
        }
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
    if (["filesystem", "playwright"].includes(id)) {
      const recipe = this.recipes.find((r) => r.id === id)!;
      show(consentText(recipe, this.project) + "\n" + recipe.installNote);
      if (
        (await ask("Connect this server? yes/no")).trim().toLowerCase() !==
        "yes"
      )
        return;
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
              : id === "filesystem" || id === "playwright"
                ? !!this.recipes
                    .find((r) => r.id === id)
                    ?.defaultTools.includes(tool.name)
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
    if (
      id === "slack-bot" &&
      !s.briefings.reads.some((r) => r.tool === "slack-bot__slack_activity")
    )
      s.briefings.reads.push({
        tool: "slack-bot__slack_activity",
        args: { hours: 24, channels: 5 },
      });
    this.store.save();
    show(
      id === "slack-bot"
        ? "Slack is connected. I can read conversations the bot has joined."
        : id === "slack"
          ? "Slack is connected as your account. Available read tools are enabled; access follows your Slack membership and workspace policies."
          : `${row.name} connected. ${probe.toolCount} tools listed.${id === "codex" || id === "claude-code" ? ` Coding tools are scoped to ${this.project}.` : ""}`,
    );
  }
  catalog() {
    return "Say ‘Connect my apps’ to reuse existing account access and prepare missing browser setup. ‘Set up Gmail and Slack’ connects just those apps.\nConnections: github, slack (bot or OAuth), claude-code, codex, gmail, filesystem, playwright, apple, calendar, reminders, notes, mail.\n/connect auto performs the same automatic setup; /connect all keeps the detailed wizard.\n/connect mcp adds any local stdio or remote Streamable HTTP MCP server with OAuth, bearer tokens, custom headers or no authentication.\n/connect oauth <server> signs in to an existing remote MCP.\n/connect import <path> imports Claude/Cursor/VS Code MCP JSON.\n/tools lists available tools; /tool <server__tool> on|off selects one.\nApps without an API or MCP can use /cua <task in App>. Accounts and permissions are still required.";
  }
  async connectCommand(
    input: string,
    ask: Ask,
    show: (text: string) => void,
    signal: AbortSignal,
  ) {
    const [id, mode] = input.split(/\s+/);
    if (!id || id === "list") {
      show(this.catalog());
      return;
    }
    if (id === "oauth") {
      const row = this.store.profile.settings.tools.servers.find(
        (r) => r.id === mode,
      );
      if (!row || row.recipe)
        throw new Error(
          "Use /connect oauth <custom HTTP server>. Built-in services use their own connection wizard.",
        );
      if (!row.secretHeaders.includes("Authorization"))
        row.secretHeaders.push("Authorization");
      await new McpOAuth(this.store).signIn(row, show, signal);
      // An unsuccessful first OAuth setup can be completed here later.
      row.enabled = true;
      row.consented = true;
      row.approvedCommand = this.registry.approval(row);
      this.store.save();
      await this.registry.configure();
      await this.ready(row.id);
      const listed = this.registry
        .status()
        .servers.find((r) => r.id === row.id);
      if (listed?.state !== "on")
        throw new Error(`${row.name} is not ready. Check /connections.`);
      for (const tool of listed.tools)
        if (!tool.denied && tool.tier === "read")
          row.tools = this.registry.tick(row.id, tool.name, true);
      this.store.save();
      show(`${row.name} signed in.`);
      return;
    }
    if (id === "all") {
      for (const name of [
        "github",
        "slack",
        "claude-code",
        "codex",
        "gmail",
        "apple",
        "filesystem",
        "playwright",
      ]) {
        signal.throwIfAborted();
        if (
          (await ask(`Connect ${name}? yes/skip`)).trim().toLowerCase() !==
          "yes"
        )
          continue;
        try {
          await this.connectCommand(name, ask, show, signal);
        } catch (error) {
          signal.throwIfAborted();
          show(error instanceof Error ? error.message : "Connection failed.");
        }
      }
      return;
    }
    if (id === "import") {
      const path = input.slice(id.length).trim();
      let config: unknown;
      try {
        config = JSON.parse(
          readFileSync(resolve(path.replace(/^~(?=\/)/, homedir())), "utf8"),
        );
      } catch {
        throw new Error(
          "Could not read the MCP JSON file. Check its path and format.",
        );
      }
      const imported = importConnections(config);
      if (
        this.store.profile.settings.tools.servers.length + imported.length >
        TOOL_LIMITS.servers
      )
        throw new Error(
          `Butler supports up to ${TOOL_LIMITS.servers} configured servers.`,
        );
      for (const item of imported) {
        signal.throwIfAborted();
        await this.addCustom(item, ask, show, signal);
      }
      return;
    }
    if (id === "mcp") {
      const name = await ask(
        "Server name (e.g. notion, linear, drive, outlook, discord)",
      );
      const transport = (await ask("Transport: http or stdio")).trim();
      let config: Record<string, unknown>;
      let oauthClientId = "",
        oauthClientSecret = "";
      if (transport === "http") {
        const url = await ask("Streamable HTTP MCP endpoint (https://…)");
        const authentication = (
          await ask("Authentication: oauth, bearer, headers or none")
        ).trim();
        const headers: Record<string, string> = {};
        if (authentication === "bearer")
          headers.Authorization = "Bearer " + (await ask("Bearer token", true));
        else if (authentication === "headers") {
          const names = (await ask("Header names, comma-separated"))
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean);
          for (const key of names) headers[key] = await ask(key, true);
        } else if (authentication === "oauth") {
          headers.Authorization = "";
          oauthClientId = await ask(
            "OAuth client ID (leave empty for automatic registration)",
          );
          if (oauthClientId)
            oauthClientSecret = await ask(
              "OAuth client secret (leave empty for public clients)",
              true,
            );
        } else if (authentication !== "none")
          throw new Error("Choose oauth, bearer, headers or none.");
        config = {
          url,
          headers,
          ...(authentication === "oauth" ? { butlerOAuth: true } : {}),
        };
      } else if (transport === "stdio") {
        const command = await ask("Executable path or command (no shell)");
        let args: unknown;
        try {
          args = JSON.parse(
            await ask('Argument array as JSON, e.g. ["/path/server.js"]'),
          );
        } catch {
          throw new Error("Use a JSON array for MCP arguments.");
        }
        const env: Record<string, string> = {};
        const names = (
          await ask(
            "Secret environment variable names, comma-separated (or empty)",
          )
        )
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        for (const key of names) env[key] = await ask(key, true);
        const network = (await ask("Network: internet or none")).trim();
        config = { command, args, env, network, cwd: this.project };
      } else throw new Error("Choose http or stdio.");
      const item = importConnections({ mcpServers: { [name]: config } })[0];
      if (config.butlerOAuth)
        item.secrets[`mcp:${item.row.id}:oauth:pending`] = "true";
      if (oauthClientId)
        item.secrets[`mcp:${item.row.id}:oauth:clientId`] = oauthClientId;
      if (oauthClientSecret)
        item.secrets[`mcp:${item.row.id}:oauth:clientSecret`] =
          oauthClientSecret;
      await this.addCustom(item, ask, show, signal);
      return;
    }
    if (["apple", "calendar", "reminders", "notes", "mail"].includes(id)) {
      const chosen =
        id === "apple"
          ? (
              await ask(
                "Apple apps: calendar, reminders, notes, mail; enter names or all",
              )
            ).trim()
          : id;
      const consents: AppleConsent[] = [
        "calendar",
        "reminders",
        "notes",
        "mail",
      ];
      const selected =
        chosen === "all" ? consents : chosen.split(/[\s,]+/).filter(Boolean);
      if (
        !selected.length ||
        selected.some((c) => !consents.includes(c as AppleConsent))
      )
        throw new Error("Choose calendar, reminders, notes or mail.");
      for (const consent of selected as AppleConsent[]) {
        signal.throwIfAborted();
        this.store.profile.settings.tools.apple[consent] = true;
        this.store.save();
        show(
          `Requesting macOS access to ${consent} for Butler's Apple bridge.`,
        );
        const access = await this.registry.requestApple(consent);
        show(`${consent}: ${access[consent]}.`);
      }
      await this.registry.configure();
      return;
    }
    if (id === "slack") {
      const choice =
        mode ||
        (await ask("Slack connection: bot or oauth")).trim().toLowerCase();
      if (!["bot", "oauth"].includes(choice))
        throw new Error("Use /connect slack bot or /connect slack oauth.");
      const secrets = this.store.profile.secrets;
      let slackClientId: string | undefined;
      if (
        choice === "oauth" &&
        secrets["slack:clientId"] &&
        (!secrets["slack:accessToken"] ||
          secrets["slack:readScopeRequest"] !== SLACK_READ_SCOPES.join(","))
      ) {
        show(
          "Use the Client ID of the Butler app configured with https://github.com/coasty-ai/butler/blob/main/docs/slack-app-manifest.json. Leave it empty if you updated the same app. Your saved grant changes only after account approval.",
        );
        slackClientId =
          (
            (await ask(
              "Slack app client ID (leave empty to reuse the saved app)",
            )) || ""
          ).trim() || undefined;
      }
      return this.connect(
        choice === "bot" ? "slack-bot" : "slack",
        ask,
        show,
        signal,
        { slackClientId },
      );
    }
    if (!CONNECTIONS.includes(id as ConnectionId))
      throw new Error(
        "Use /connect to see all connection options, or /connect mcp for another app.",
      );
    await this.connect(id as ConnectionId, ask, show, signal);
  }
  private async addCustom(
    item: ImportedConnection,
    ask: Ask,
    show: (text: string) => void,
    signal: AbortSignal,
  ) {
    const { row, secrets } = item;
    const s = this.store.profile.settings;
    if (s.tools.servers.some((r) => r.id === row.id))
      throw new Error(
        `A server named ${row.id} is already configured. Use /disconnect ${row.id} first.`,
      );
    if (s.tools.servers.length >= TOOL_LIMITS.servers)
      throw new Error("The MCP server limit has been reached.");
    if (s.privacy === "PRIVATE_LOCAL" && row.network !== "none")
      throw new Error("Choose /model before connecting an internet server.");
    show(
      `${row.name}: ${row.transport === "http" ? row.url : JSON.stringify([row.command, ...row.args])}\nWorking folder: ${row.cwd || "default"}. Network: ${row.network}. Credential names: ${[...row.secretEnv, ...row.secretHeaders].join(", ") || "none"}. Local servers run as you; tool results reach your model.`,
    );
    if (
      (await ask("Connect this exact server? yes/no")).trim().toLowerCase() !==
      "yes"
    )
      return;
    signal.throwIfAborted();
    s.tools.servers.push(row);
    Object.assign(this.store.profile.secrets, secrets);
    this.store.save();
    const oauth = `mcp:${row.id}:oauth:pending`;
    if (this.store.profile.secrets[oauth]) {
      delete this.store.profile.secrets[oauth];
      await new McpOAuth(this.store).signIn(row, show, signal);
    }
    const probe = await this.registry.test(row.id);
    signal.throwIfAborted();
    if (!probe.ok)
      throw new Error(
        `${row.name} could not connect: ${probe.code || probe.state}. Check its installation or authentication.`,
      );
    row.enabled = true;
    row.consented = true;
    row.approvedCommand = this.registry.approval(row);
    row.trust = "ask";
    this.store.save();
    await this.registry.configure();
    await this.ready(row.id);
    if (
      this.registry.status().servers.find((r) => r.id === row.id)?.state !==
      "on"
    )
      throw new Error(
        `${row.name} is configured but not ready. Check /connections.`,
      );
    for (const tool of probe.tools)
      if (!tool.denied && tool.tier === "read")
        row.tools = this.registry.tick(row.id, tool.name, true);
    this.store.save();
    show(
      `${row.name} connected with read tools enabled. /tools lists tools; /tool selects others. /trust ${row.id} reads enables unattended reads after you review the server.`,
    );
  }
  async disconnect(id: string) {
    if (
      id === "apple" ||
      ["calendar", "reminders", "notes", "mail"].includes(id)
    ) {
      const apple = this.store.profile.settings.tools.apple;
      for (const consent of Object.keys(apple) as AppleConsent[])
        if (id === "apple" || id === consent) apple[consent] = false;
    } else {
      await this.registry.forget(id);
      this.store.profile.settings.tools.servers =
        this.store.profile.settings.tools.servers.filter((r) => r.id !== id);
      for (const key of Object.keys(this.store.profile.secrets))
        if (key.startsWith(`mcp:${id}:`))
          delete this.store.profile.secrets[key];
      this.store.profile.settings.briefings.reads =
        this.store.profile.settings.briefings.reads.filter(
          (r) => !r.tool.startsWith(id + "__"),
        );
    }
    this.store.save();
    await this.registry.configure();
  }
  connectionWarnings() {
    return this.warnings;
  }
  async refreshCredentials() {
    const headers = () =>
      JSON.stringify(
        Object.entries(this.store.profile.secrets).filter(
          ([key]) =>
            key === "slack:accessToken" ||
            key.endsWith(":header:Authorization"),
        ),
      );
    const before = headers();
    this.warnings = [];
    try {
      if (
        this.scopedSettings().tools.servers.some(
          (row) => row.id === "slack" && row.enabled,
        )
      )
        await this.refreshSlack();
    } catch {
      this.warnings.push(
        "Slack account sign-in needs attention. Use /connect slack oauth.",
      );
    }
    const oauth = new McpOAuth(this.store);
    for (const row of this.scopedSettings().tools.servers.filter(
      (r) => r.enabled && r.transport === "http" && !r.recipe,
    )) {
      try {
        await oauth.refresh(row);
      } catch {
        this.warnings.push(
          `${row.name} needs sign-in. Use /connect oauth ${row.id}.`,
        );
      }
    }
    if (before !== headers()) {
      // Connected transports snapshot their headers; a rotated token must
      // reach a new transport before the next briefing read.
      await this.registry.configure();
      await this.ready();
    }
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
        "Create a dedicated internal Butler app at https://api.slack.com/apps using ‘From an app manifest’. Paste the configuration from https://github.com/coasty-ai/butler/blob/main/docs/slack-app-manifest.json and select your workspace. It sets the read permissions, localhost callback and PKCE (a one-way public-client setting). Install/approve the app, including MCP access if your workspace requires it. Copy Basic Information → App Credentials → Client ID. No Client Secret is required. Access requested: channels you can see, your DMs/group DMs, shared files, profiles, canvases, lists and reactions.",
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
