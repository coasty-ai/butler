import { describe, expect, it } from "vitest";
import { toolServerSchema, type ToolServer } from "../src/core/schema";
import { importServers, serverId } from "../src/tools/import";

const claudeDesktop = {
  mcpServers: {
    filesystem: {
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/nk/scratch",
      ],
    },
    GitHub: {
      command: "/opt/homebrew/bin/github-mcp",
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN:
          "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        GITHUB_HOST: "github.com",
        LOOKS_PLAIN: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      },
    },
    remote: { url: "https://mcp.example/mcp" },
    legacy: { type: "sse", url: "https://mcp.example/sse" },
    expanded: { command: "npx", args: ["${HOME}/server"] },
    relative: { command: "./bin/server" },
    broken: "not an object",
    lowercase: { command: "tool", env: { lower_case: "x" } },
  },
};

describe("importing servers from Claude Desktop", () => {
  it("turns each stdio entry into a disabled, unconsented row and moves secrets to the vault", () => {
    const result = importServers(
      JSON.stringify(claudeDesktop),
      [],
      1700000000000,
    );
    expect(result.counts).toEqual({
      added: 2,
      skippedRemote: 2,
      refused: 4,
      secretsMoved: 2,
    });
    expect(result.rows.map((r) => r.id)).toEqual(["filesystem", "github"]);
    for (const row of result.rows) {
      expect(toolServerSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        transport: "stdio",
        enabled: false,
        consented: false,
        trust: "ask",
        network: "internet",
        approvedCommand: "",
        recipe: "",
        tools: {},
        addedAt: 1700000000000,
      });
    }
    const github = result.rows[1];
    expect(github.name).toBe("GitHub");
    expect(github.env).toEqual({ GITHUB_HOST: "github.com" });
    expect(github.secretEnv.sort()).toEqual([
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "LOOKS_PLAIN",
    ]);
    expect(result.secrets).toEqual([
      {
        id: "github",
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
      {
        id: "github",
        name: "LOOKS_PLAIN",
        value: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ]);
    expect(JSON.stringify(result.rows)).not.toContain("ghp_");
    expect(JSON.stringify(result.rows)).not.toContain("sk-");
  });

  it("accepts the inner block alone and keeps ids unique and unreserved", () => {
    const existing: ToolServer[] = [
      toolServerSchema.parse({
        id: "memo",
        name: "Memo",
        transport: "stdio",
        command: "x",
        addedAt: 0,
      }),
    ];
    const result = importServers(
      JSON.stringify({
        memo: { command: "memo-server" },
        apple: { command: "apple-thing" },
        "My Cool Server!!": { command: "cool" },
        "---": { command: "dashes" },
      }),
      existing,
      0,
    );
    expect(result.rows.map((r) => r.id)).toEqual([
      "memo-2",
      "apple-server",
      "my-cool-server",
      "s",
    ]);
    expect(serverId("apple", new Set(["apple-server"]))).toBe("apple-server-2");
    expect(serverId("x".repeat(80), new Set())).toHaveLength(34);
  });

  it("never echoes the pasted text in an error, and refuses more than 64 KB", () => {
    const marker = "ZEPHYR-SECRET-MARKER";
    for (const text of [
      `{"mcpServers": ${marker}`,
      `["${marker}"]`,
      `"${marker}"`,
      `{"mcpServers": {"a": {"command": "${"x".repeat(70000)}"}}}`,
    ]) {
      let message = "";
      try {
        importServers(text, [], 0);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/Could not import/);
      expect(message).not.toContain(marker);
      expect(message.length).toBeLessThan(200);
    }
    // A block of entries that are not servers is refused entry by entry.
    expect(
      importServers(`{"nested": {"deeper": "${marker}"}}`, [], 0).counts,
    ).toEqual({ added: 0, skippedRemote: 0, refused: 1, secretsMoved: 0 });
  });

  it("stops at the server limit", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`s${i}`, { command: "tool" }]),
    );
    const result = importServers(JSON.stringify({ mcpServers: many }), [], 0);
    expect(result.counts.added).toBe(16);
    expect(result.counts.refused).toBe(4);
  });
});
