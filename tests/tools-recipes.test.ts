import { describe, expect, it } from "vitest";
import {
  FOLDER,
  RECIPES,
  consentText,
  serverFromRecipe,
} from "../src/tools/providers/recipes";
import { RECIPES as EXPORTED, BUILTIN_SERVERS } from "../src/tools/providers";
import { toolServerSchema } from "../src/core/schema";
import { RESERVED_PROVIDERS, TOOL_DENYLIST } from "../src/core/tools";

const folder = "/Users/u/oa-scratch";
const recipe = (id: string) => RECIPES.find((r) => r.id === id)!;

describe("server recipes", () => {
  it("offers the five connections, from the providers index", () => {
    expect(RECIPES.map((r) => r.id)).toEqual([
      "filesystem",
      "playwright",
      "github",
      "slack",
      "claude-code",
    ]);
    expect(EXPORTED).toBe(RECIPES);
    expect(BUILTIN_SERVERS.map((s) => s.id)).toEqual(["apple"]);
  });

  it("shapes every recipe into a settings row that validates, off and unconsented", () => {
    for (const r of RECIPES) {
      const row = serverFromRecipe(r, { folder, addedAt: 1_700_000_000_000 });
      expect(toolServerSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        id: r.id,
        name: r.name,
        transport: r.transport,
        network: r.network,
        recipe: r.id,
        enabled: false,
        consented: false,
        trust: "ask",
        approvedCommand: "",
        tools: {},
        env: {},
      });
      expect(JSON.stringify(row)).not.toContain(FOLDER);
      expect(RESERVED_PROVIDERS.has(r.id)).toBe(false);
    }
    const twice = serverFromRecipe(recipe("filesystem"), {
      folder,
      addedAt: 1,
      id: "filesystem-2",
    });
    expect(twice.id).toBe("filesystem-2");
    expect(twice.recipe).toBe("filesystem");
  });

  it("puts the folder where the recipe says, and needs one where it says so", () => {
    const files = serverFromRecipe(recipe("filesystem"), {
      folder,
      addedAt: 1,
    });
    // The installed bin is the registry's to put in front (src/tools/install.ts
    // liveArgs); the row carries the recipe's own arguments alone.
    expect(files.command).toBe("node");
    expect(files.args).toEqual([folder]);
    expect(files.cwd).toBe("");
    const agent = serverFromRecipe(recipe("claude-code"), {
      folder,
      addedAt: 1,
    });
    expect(agent.command).toBe("claude");
    expect(agent.args).toEqual(["mcp", "serve"]);
    expect(agent.cwd).toBe(folder);
    for (const id of ["filesystem", "claude-code"])
      expect(() => serverFromRecipe(recipe(id), { addedAt: 1 })).toThrow(
        "FOLDER_REQUIRED",
      );
    expect(serverFromRecipe(recipe("playwright"), { addedAt: 1 }).cwd).toBe("");
    expect(consentText(recipe("filesystem"), folder)).toContain(
      `inside ${folder} only`,
    );
    expect(consentText(recipe("claude-code"))).toContain(
      "in the folder you pick",
    );
    expect(consentText(recipe("playwright"))).toBe(
      recipe("playwright").consent,
    );
  });

  it("runs in Private local only when stdio and offline", () => {
    for (const r of RECIPES)
      expect(r.privateLocal, r.id).toBe(
        r.transport === "stdio" && r.network === "none",
      );
    expect(recipe("filesystem").privateLocal).toBe(true);
    expect(RECIPES.filter((r) => r.privateLocal)).toHaveLength(1);
  });

  it("never offers a shell, an editor or the web from the coding agent", () => {
    const agent = recipe("claude-code");
    expect(agent.allowTools).toEqual(["Agent", "Read", "Glob", "Grep", "LS"]);
    for (const name of agent.allowTools!)
      expect(TOOL_DENYLIST.test(name), name).toBe(false);
    for (const hidden of [
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Workflow",
      "CronCreate",
      "SendMessage",
      "EnterWorktree",
      "Skill",
      "TodoWrite",
    ])
      expect(agent.allowTools).not.toContain(hidden);
    expect(agent.defaultTools).toEqual(["Agent"]);
    for (const r of RECIPES)
      if (r.allowTools)
        for (const name of r.defaultTools) expect(r.allowTools).toContain(name);
  });

  it("tiers the coding agent's Agent as destructive and long-running, its reads as reads", () => {
    const agent = recipe("claude-code");
    expect(agent.tierOverrides?.Agent).toBe("destructive");
    expect(agent.longRunning).toContain("Agent");
    for (const name of ["Read", "Glob", "Grep", "LS"])
      expect(agent.tierOverrides?.[name]).toBe("read");
    expect(recipe("playwright").tierOverrides).toEqual({
      browser_navigate: "write",
    });
    for (const r of RECIPES)
      for (const name of Object.keys(r.tierOverrides ?? {}))
        if (r.allowTools) expect(r.allowTools).toContain(name);
  });

  it("says in every consent what leaves the Mac and that it runs as you", () => {
    for (const r of RECIPES) {
      expect(r.consent, r.id).toMatch(/runs as you/i);
      expect(r.consent, r.id).toMatch(
        /leaves this Mac|reaches the model|over the internet|your Claude account/,
      );
      expect(r.consent.length).toBeLessThanOrEqual(400);
      expect(r.consent).not.toMatch(/[\n\r]/);
      expect(r.installNote.length).toBeGreaterThan(10);
    }
    expect(recipe("filesystem").consent).toContain(
      "Butler installs its package from npm when you test or approve it, and never again while it runs",
    );
    expect(recipe("playwright").consent).toContain(
      "Protected websites are still refused",
    );
    expect(recipe("claude-code").consent).toContain(
      "Butler asks before each run",
    );
    expect(recipe("github").installNote).toContain(
      "OAuth sign-in arrives in a later increment",
    );
    expect(recipe("slack").installNote).toMatch(
      /OAuth sign-in.*later increment/,
    );
    expect(recipe("slack").installNote).toContain("(verify)");
  });

  it("pins the Node packages the app installs, by version and bin, and keeps npx off every recipe", () => {
    // npx inside the network sandbox asks the registry for the latest tag and
    // hangs (measured 2026-09-19); the app installs the pinned package itself.
    expect(recipe("filesystem").install).toEqual({
      package: "@modelcontextprotocol/server-filesystem",
      version: "2026.8.31",
      bin: "mcp-server-filesystem",
    });
    // The bin name is part of the pin: it changed between 0.0.50 and 0.0.70.
    expect(recipe("playwright").install).toEqual({
      package: "@playwright/mcp",
      version: "0.0.82",
      bin: "playwright-mcp",
    });
    expect(recipe("playwright").args).toEqual(["--extension"]);
    for (const r of RECIPES) {
      expect(r.command ?? "", r.id).not.toMatch(/npx|uvx|bunx/);
      for (const arg of r.args ?? []) {
        expect(arg, r.id).not.toMatch(/@latest|^-y$/);
        // The bin comes from install; no argument names a package or a path.
        if (r.install) expect(arg, r.id).not.toMatch(/^@|\//);
      }
      if (!r.install) continue;
      expect(r.command, r.id).toBe("node");
      expect(r.install.version, r.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.install.bin, r.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(r.install.package, r.id).toMatch(
        /^(?:@[a-z0-9-]+\/)?[a-z0-9._-]+$/,
      );
      expect(r.installNote, r.id).toContain(
        `${r.install.package} ${r.install.version}`,
      );
      expect(r.installNote, r.id).toMatch(/network/);
    }
    expect(RECIPES.filter((r) => r.install).map((r) => r.id)).toEqual([
      "filesystem",
      "playwright",
    ]);
  });

  it("never runs through a shell or a script interpreter, node only on a bin the app installed", () => {
    const refused = new Set([
      "sh",
      "bash",
      "zsh",
      "fish",
      "osascript",
      "env",
      "sudo",
      "open",
      "python",
    ]);
    for (const r of RECIPES) {
      if (r.transport === "stdio") {
        expect(r.command, r.id).toBeDefined();
        expect(refused.has(r.command!.split("/").pop()!), r.id).toBe(false);
        // node runs only what install names; a recipe without one never
        // points node at a script.
        expect(r.command === "node", r.id).toBe(!!r.install);
        expect(r.command).not.toContain("/");
        expect(r.url).toBeUndefined();
        for (const arg of r.args ?? []) expect(arg).not.toMatch(/[;&|`$]/);
      } else {
        expect(r.url, r.id).toMatch(/^https:\/\//);
        expect(r.command).toBeUndefined();
        expect(r.args).toBeUndefined();
      }
    }
  });

  it("keeps remote servers to BYOM with a bearer header from the vault", () => {
    for (const id of ["github", "slack"]) {
      const r = recipe(id);
      expect(r.transport).toBe("http");
      expect(r.network).toBe("internet");
      expect(r.privateLocal).toBe(false);
      expect(r.secretHeaders).toEqual(["Authorization"]);
      expect(r.secretEnv).toBeUndefined();
    }
    expect(recipe("github").url).toBe("https://api.githubcopilot.com/mcp/");
    expect(recipe("slack").url).toBe("https://mcp.slack.com/mcp");
    expect(recipe("slack").defaultTools).toEqual([]);
    expect(recipe("github").defaultTools).toEqual([
      "search_repositories",
      "get_me",
      "list_pull_requests",
    ]);
  });
});
