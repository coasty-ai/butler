import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  settingsSchema,
  toolServerSchema,
  type Settings,
  type ToolServer,
} from "../src/core/schema";
import { localToolSettings, validateToolSettings } from "../src/core/privacy";
import {
  RESERVED_PROVIDERS,
  TOOL_INSTALL_REMEDY,
  toolsAllowed,
} from "../src/core/tools";
import { argvNote, installRemedy, stateNote } from "../src/ui/settings-tools";

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

  it("turns the web tool on by default, keeps a stored config's choice, and refuses a non-boolean", () => {
    expect(defaultSettings.tools.web).toBe(true);
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    delete (legacy.tools as Record<string, unknown>).web;
    expect(settingsSchema.parse(legacy).tools.web).toBe(true);
    expect(
      settingsSchema.parse({
        ...defaultSettings,
        tools: { ...defaultSettings.tools, web: false },
      }).tools.web,
    ).toBe(false);
    expect(() =>
      settingsSchema.parse({
        ...defaultSettings,
        tools: { ...defaultSettings.tools, web: "yes" },
      }),
    ).toThrow();
  });
  it("turns the files tool on by default, keeps a stored config's choice, and lets the master switch gate it", () => {
    expect(defaultSettings.tools.files).toBe(true);
    const legacy: Record<string, unknown> = structuredClone(defaultSettings);
    delete (legacy.tools as Record<string, unknown>).files;
    expect(settingsSchema.parse(legacy).tools.files).toBe(true);
    expect(
      settingsSchema.parse({
        ...defaultSettings,
        tools: { ...defaultSettings.tools, files: false },
      }).tools.files,
    ).toBe(false);
    expect(() =>
      settingsSchema.parse({
        ...defaultSettings,
        tools: { ...defaultSettings.tools, files: "yes" },
      }),
    ).toThrow();
    // The gate a files spec passes: builtin and local, in both privacy modes.
    const local = withServers("PRIVATE_LOCAL", []);
    expect(toolsAllowed(local, { transport: "builtin", local: true })).toBe(
      true,
    );
    expect(
      toolsAllowed(
        { ...local, tools: { ...local.tools, enabled: false } },
        { transport: "builtin", local: true },
      ),
    ).toBe(false);
  });

  it("accepts sound rows in both modes", () => {
    validateToolSettings(
      withServers("PRIVATE_BYOM", [
        row(),
        row({
          id: "remote",
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
      row({
        id: "remote",
        transport: "http",
        url,
        network: "internet",
        ...over,
      });
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
      // "files" is the built-in files tool's reserved id; a user's server takes another.
      row({ id: "docs", name: "Docs" }),
      row({
        id: "remote",
        name: "Remote",
        transport: "http",
        url: "https://mcp.example/mcp",
        network: "internet",
      }),
      row({ id: "net", name: "Net", network: "internet" }),
      row({ id: "quiet", name: "Quiet", network: "internet", enabled: false }),
    ]);
    const flipped = localToolSettings(settings);
    expect(flipped.disabled).toEqual(["Remote", "Net"]);
    expect(
      flipped.settings.tools.servers.map((r) => [r.id, r.enabled]),
    ).toEqual([
      ["docs", true],
      ["remote", false],
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

describe("the Tools pane's notes", () => {
  it("names a missing or failed install with the one remedy, and a missing command as before", () => {
    expect(TOOL_INSTALL_REMEDY).toBe(
      "Approve the server again to install it; needs Node 22 and network for that step.",
    );
    expect(stateNote("needs_install", "INSTALL_FAILED")).toBe(
      `Could not install the server's package. ${TOOL_INSTALL_REMEDY}`,
    );
    expect(stateNote("needs_install", "NOT_INSTALLED")).toBe(
      `Not installed. ${TOOL_INSTALL_REMEDY}`,
    );
    for (const code of ["NOT_FOUND", "REFUSED", "RELATIVE", undefined])
      expect(stateNote("needs_install", code)).toBe(
        "Not found: install Node 22+ or give the full path",
      );
    // npm's exit status is a number in the trace, and its output is never
    // read: the pane's sentence is fixed, whatever npm said.
    expect(stateNote("needs_install", "INSTALL_FAILED")).not.toMatch(
      /npm|exit|ENOTCACHED|ERR/,
    );
    // The remedy states are where the pane offers Approve again.
    expect(installRemedy("needs_install", "INSTALL_FAILED")).toBe(true);
    expect(installRemedy("needs_install", "NOT_INSTALLED")).toBe(true);
    expect(installRemedy("needs_install", "NOT_FOUND")).toBe(false);
    expect(installRemedy("needs_approval", "INSTALL_FAILED")).toBe(false);
    expect(stateNote("needs_approval")).toBe("Needs your approval");
    expect(stateNote("failed", "exhausted")).toContain("repeated exits");
  });

  it("says a pasted npx row runs offline in the sandbox, that a fetching runner may download, and nothing for an installed recipe", () => {
    const launch = "/Applications/Butler.app/Contents/Resources/coarena-launch";
    const npx = "/Users/u/.nvm/versions/node/v22.23.2/bin/npx";
    const offline = argvNote([
      launch,
      "--no-network",
      "--",
      npx,
      "--offline",
      "-y",
      "srv",
    ]);
    expect(offline).toContain("Runs npx offline inside the network sandbox");
    expect(offline).toContain("ENOTCACHED");
    expect(argvNote([launch, "--", npx, "-y", "srv"])).toBe(
      " May download the package the first time it starts; not available in Private local.",
    );
    // "--offline" belongs to npx; a server's own --offline argument is not it.
    expect(argvNote([launch, "--", "/usr/local/bin/srv", "--offline"])).toBe(
      "",
    );
    expect(
      argvNote([
        launch,
        "--no-network",
        "--",
        "/Users/u/.nvm/versions/node/v22.23.2/bin/node",
        "/Users/u/Library/Application Support/coarena-open-assist/mcp/filesystem/node_modules/.bin/mcp-server-filesystem",
        "/Users/u/Documents",
      ]),
    ).toBe("");
  });
});
