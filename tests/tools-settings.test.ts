import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  settingsSchema,
  toolServerSchema,
  type Settings,
  type ToolServer,
} from "../src/core/schema";
import { localToolSettings, validateToolSettings } from "../src/core/privacy";
import { RESERVED_PROVIDERS, toolsAllowed } from "../src/core/tools";

const row = (over: Partial<ToolServer> = {}): ToolServer =>
  toolServerSchema.parse({
    id: "memo",
    name: "Memo",
    transport: "stdio",
    command: "memo-server",
    enabled: true,
    network: "none",
    addedAt: 0,
    ...over,
  });
const withServers = (
  privacy: Settings["privacy"],
  servers: ToolServer[],
): Settings => ({
  ...defaultSettings,
  privacy,
  tools: { ...defaultSettings.tools, servers },
});

describe("tool settings", () => {
  it("parses a stored config without a tools block and refuses a reserved id", () => {
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    delete legacy.tools;
    expect(settingsSchema.parse(legacy).tools).toEqual(defaultSettings.tools);
    expect(
      settingsSchema.parse({ ...defaultSettings, tools: { enabled: false } })
        .tools,
    ).toEqual({ ...defaultSettings.tools, enabled: false });
    for (const id of RESERVED_PROVIDERS)
      expect(() => row({ id }), id).toThrow();
    expect(() => row({ id: "Notes" })).toThrow();
    expect(() => row({ id: "a".repeat(41) })).toThrow();
  });

  it("accepts sound rows in both modes", () => {
    validateToolSettings(
      withServers("PRIVATE_BYOM", [
        row(),
        row({
          id: "web",
          transport: "http",
          url: "https://mcp.example/mcp",
          network: "internet",
        }),
      ]),
    );
    validateToolSettings(
      withServers("PRIVATE_LOCAL", [
        row(),
        row({ id: "off", network: "internet", enabled: false }),
      ]),
    );
  });

  it("requires unique ids, a command for stdio and no name both plain and secret", () => {
    expect(() =>
      validateToolSettings(withServers("PRIVATE_BYOM", [row(), row()])),
    ).toThrow("own id");
    expect(() =>
      validateToolSettings(
        withServers("PRIVATE_BYOM", [row({ command: "  " })]),
      ),
    ).toThrow("needs a command");
    expect(() =>
      validateToolSettings(
        withServers("PRIVATE_BYOM", [
          row({ env: { TOKEN_URL: "x" }, secretEnv: ["TOKEN_URL"] }),
        ]),
      ),
    ).toThrow("both plainly and as a secret");
    expect(() =>
      validateToolSettings(
        withServers(
          "PRIVATE_BYOM",
          Array.from({ length: 17 }, (_, i) => row({ id: `s${i}` })),
        ),
      ),
    ).toThrow("At most 16");
  });

  it("refuses HTTP in Private local and requires a bare https address elsewhere", () => {
    const web = (url: string, over: Partial<ToolServer> = {}) =>
      row({ id: "web", transport: "http", url, network: "internet", ...over });
    expect(() =>
      validateToolSettings(
        withServers("PRIVATE_LOCAL", [web("https://mcp.example/mcp")]),
      ),
    ).toThrow("not available in Private local");
    validateToolSettings(
      withServers("PRIVATE_LOCAL", [
        web("https://mcp.example/mcp", { enabled: false }),
      ]),
    );
    for (const bad of [
      "http://mcp.example/mcp",
      "https://user:pw@mcp.example/mcp",
      "https://mcp.example/mcp?key=1",
      "https://mcp.example/mcp#frag",
      "not a url",
      "",
    ])
      expect(
        () => validateToolSettings(withServers("PRIVATE_BYOM", [web(bad)])),
        bad,
      ).toThrow(/https/);
    expect(() =>
      validateToolSettings(
        withServers("PRIVATE_LOCAL", [row({ network: "internet" })]),
      ),
    ).toThrow("reaches the internet");
  });

  it("switching to Private local turns off the rows that reach the internet and says which", () => {
    const settings = withServers("PRIVATE_LOCAL", [
      row({ id: "files", name: "Files" }),
      row({
        id: "web",
        name: "Web",
        transport: "http",
        url: "https://mcp.example/mcp",
        network: "internet",
      }),
      row({ id: "net", name: "Net", network: "internet" }),
      row({ id: "quiet", name: "Quiet", network: "internet", enabled: false }),
    ]);
    const flipped = localToolSettings(settings);
    expect(flipped.disabled).toEqual(["Web", "Net"]);
    expect(
      flipped.settings.tools.servers.map((r) => [r.id, r.enabled]),
    ).toEqual([
      ["files", true],
      ["web", false],
      ["net", false],
      ["quiet", false],
    ]);
    expect(() => validateToolSettings(flipped.settings)).not.toThrow();
    const open = { ...settings, privacy: "PRIVATE_BYOM" as const };
    const byom = localToolSettings(open);
    expect(byom.disabled).toEqual([]);
    expect(byom.settings).toBe(open);
  });

  it("gates a tool by privacy at use time as well", () => {
    const local = withServers("PRIVATE_LOCAL", []);
    const byom = withServers("PRIVATE_BYOM", []);
    expect(toolsAllowed(local, { transport: "builtin", local: true })).toBe(
      true,
    );
    expect(toolsAllowed(local, { transport: "stdio", local: true })).toBe(true);
    expect(toolsAllowed(local, { transport: "stdio", local: false })).toBe(
      false,
    );
    expect(toolsAllowed(local, { transport: "http", local: false })).toBe(
      false,
    );
    expect(toolsAllowed(byom, { transport: "http", local: false })).toBe(true);
    expect(
      toolsAllowed(
        { ...byom, tools: { ...byom.tools, enabled: false } },
        { transport: "builtin", local: true },
      ),
    ).toBe(false);
  });
});
