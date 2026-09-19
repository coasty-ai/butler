import type { ToolServer } from "../../core/schema";
import type { ServerRecipe } from "../../core/tools";

/**
 * Connection recipes: the community servers and the coding agent the Settings
 * pane offers by name (docs/TOOLS.md). A recipe is not a server. Adding one
 * makes a settings.tools.servers row (serverFromRecipe) that arrives disabled
 * and unconsented; the pane shows the exact argv, the consent text and the
 * install note before the user can enable it, and only the recipe's
 * defaultTools are ticked when the server first lists its tools.
 *
 * Every recipe names what the server reaches, what leaves the Mac through it,
 * and that it runs as the user. No recipe runs through a shell, and the
 * coding-agent recipe offers only an allow-list: `claude mcp serve` lists 25
 * tools with no annotations, Bash, Edit and Write among them (measured), and
 * none of those are ever offered.
 */

/** Stands for the folder the user picks, in args, cwd and consent text. */
export const FOLDER = "{folder}";

export const RECIPES: readonly ServerRecipe[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", FOLDER],
    network: "none",
    needsFolder: true,
    defaultTools: ["list_directory", "read_text_file", "search_files"],
    privateLocal: true,
    consent:
      "Reads and, if you tick them, changes files inside {folder} only. No network: nothing leaves this Mac through it. Runs as you. Fetches the package with npx the first time.",
    install:
      "Needs Node 22+ (npx fetches @modelcontextprotocol/server-filesystem the first time).",
  },
  {
    id: "playwright",
    name: "Playwright",
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest", "--extension"],
    network: "internet",
    defaultTools: ["browser_snapshot", "browser_navigate"],
    tierOverrides: { browser_navigate: "write" },
    privateLocal: false,
    consent:
      "Drives your signed-in Chrome through the Playwright extension. Page text reaches the model. Protected websites are still refused by Butler's own policy. Runs as you.",
    install:
      "Needs Node 18+ and the Playwright MCP Bridge extension in Chrome (npx fetches @playwright/mcp the first time).",
  },
  {
    id: "github",
    name: "GitHub",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    network: "internet",
    secretHeaders: ["Authorization"],
    defaultTools: ["search_repositories", "get_me", "list_pull_requests"],
    privateLocal: false,
    consent:
      "Talks to GitHub over the internet with your personal access token; what its tools read and change there reaches the model. Runs as you, with the token's permissions.",
    install:
      "Needs a GitHub personal access token, stored as the Authorization header (Bearer <token>); OAuth sign-in arrives in a later increment.",
  },
  {
    id: "slack",
    name: "Slack",
    transport: "http",
    url: "https://mcp.slack.com/mcp",
    network: "internet",
    secretHeaders: ["Authorization"],
    defaultTools: [],
    privateLocal: false,
    consent:
      "Talks to Slack over the internet with your token; the channel and message text its tools read reaches the model. Runs as you, with the token's permissions.",
    install:
      "Slack's server needs OAuth sign-in, which arrives in a later increment; a user token may work in the meantime (verify). Shown as needs sign-in until a token is stored.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    transport: "stdio",
    command: "claude",
    args: ["mcp", "serve"],
    network: "internet",
    needsFolder: true,
    cwdFromFolder: true,
    allowTools: ["Agent", "Read", "Glob", "Grep", "LS"],
    defaultTools: ["Agent"],
    tierOverrides: {
      Agent: "destructive",
      Read: "read",
      Glob: "read",
      Grep: "read",
      LS: "read",
    },
    longRunning: ["Agent"],
    privateLocal: false,
    consent:
      "Runs Claude Code in {folder} with its own permissions and your Claude account; it can read, edit and run code there. Butler asks before each run and reports what it says. Runs as you.",
    install: "Needs the Claude Code CLI (claude) on this Mac.",
  },
];

/**
 * The settings row a recipe becomes when added: off, unconsented, trust "ask",
 * the folder filled into args and cwd. `id` lets a recipe be added twice
 * (two folders) under two ids.
 */
export function serverFromRecipe(
  recipe: ServerRecipe,
  o: { folder?: string; addedAt: number; id?: string },
): ToolServer {
  const folder = o.folder ?? "";
  if (recipe.needsFolder && !folder) throw new Error("FOLDER_REQUIRED");
  return {
    id: o.id ?? recipe.id,
    name: recipe.name,
    transport: recipe.transport,
    command: recipe.command ?? "",
    args: (recipe.args ?? []).map((arg) => arg.replaceAll(FOLDER, folder)),
    env: {},
    secretEnv: recipe.secretEnv ?? [],
    cwd: recipe.cwdFromFolder ? folder : "",
    url: recipe.url ?? "",
    secretHeaders: recipe.secretHeaders ?? [],
    enabled: false,
    consented: false,
    trust: "ask",
    network: recipe.network,
    approvedCommand: "",
    recipe: recipe.id,
    tools: {},
    addedAt: o.addedAt,
  };
}

/** The consent sheet's text with the folder named. */
export function consentText(recipe: ServerRecipe, folder = ""): string {
  return recipe.consent.replaceAll(FOLDER, folder || "the folder you pick");
}
