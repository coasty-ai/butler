import { describe, expect, it } from "vitest";
import {
  childPath,
  REFUSED_COMMANDS,
  resolveCommand,
  searchPath,
  type ResolveFs,
} from "../src/tools/resolve";

const home = "/Users/nk";
const executables = new Set([
  "/opt/homebrew/bin/uvx",
  "/usr/local/bin/uvx",
  `${home}/.nvm/versions/node/v22.23.2/bin/npx`,
  `${home}/.nvm/versions/node/v20.19.0/bin/npx`,
  `${home}/.nvm/versions/node/v20.19.0/bin/old-only`,
  `${home}/.volta/bin/claude`,
  `${home}/Library/Python/3.12/bin/mcp-server-fetch`,
  "/usr/bin/python3",
  "/bin/sh",
  "/Applications/Tool.app/Contents/MacOS/tool",
]);
const fs: ResolveFs = {
  isExecutable: (path) => executables.has(path),
  list: (dir) =>
    dir === `${home}/.nvm/versions/node`
      ? ["v20.19.0", "v22.23.2", "v9.1.0", "junk"]
      : dir === `${home}/Library/Python`
        ? ["3.9", "3.12"]
        : [],
};

describe("command resolution", () => {
  it("searches the fixed directories in order, with the highest Node and Python versions", () => {
    expect(searchPath(home, fs)).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      `${home}/.nvm/versions/node/v22.23.2/bin`,
      `${home}/.volta/bin`,
      `${home}/.local/bin`,
      `${home}/.cargo/bin`,
      `${home}/Library/Python/3.12/bin`,
      `${home}/Library/Python/3.9/bin`,
      "/usr/bin",
      "/bin",
    ]);
    expect(resolveCommand("uvx", home, fs)).toEqual({
      path: "/opt/homebrew/bin/uvx",
    });
    expect(resolveCommand("npx", home, fs)).toEqual({
      path: `${home}/.nvm/versions/node/v22.23.2/bin/npx`,
    });
    // Only the highest Node is on the path: a tool installed for an older
    // one is not found.
    expect(resolveCommand("old-only", home, fs)).toEqual({ code: "NOT_FOUND" });
    expect(resolveCommand("claude", home, fs)).toEqual({
      path: `${home}/.volta/bin/claude`,
    });
    expect(resolveCommand("mcp-server-fetch", home, fs)).toEqual({
      path: `${home}/Library/Python/3.12/bin/mcp-server-fetch`,
    });
    expect(resolveCommand("python3", home, fs)).toEqual({
      path: "/usr/bin/python3",
    });
    expect(resolveCommand("nothing-here", home, fs)).toEqual({
      code: "NOT_FOUND",
    });
    expect(resolveCommand("", home, fs)).toEqual({ code: "NOT_FOUND" });
  });

  it("uses an absolute path as given when it is executable", () => {
    expect(
      resolveCommand("/Applications/Tool.app/Contents/MacOS/tool", home, fs),
    ).toEqual({
      path: "/Applications/Tool.app/Contents/MacOS/tool",
    });
    expect(resolveCommand("/opt/missing/tool", home, fs)).toEqual({
      code: "NOT_FOUND",
    });
  });

  it("refuses shells and launchers by basename, and relative commands", () => {
    for (const name of REFUSED_COMMANDS) {
      expect(resolveCommand(name, home, fs)).toEqual({ code: "REFUSED" });
      expect(resolveCommand(`/bin/${name}`, home, fs)).toEqual({
        code: "REFUSED",
      });
    }
    expect(resolveCommand("./server.js", home, fs)).toEqual({
      code: "RELATIVE",
    });
    expect(resolveCommand("node_modules/.bin/server", home, fs)).toEqual({
      code: "RELATIVE",
    });
    expect(resolveCommand("../up/sh", home, fs)).toEqual({ code: "REFUSED" });
  });

  it("builds the child's PATH from the command's own directory and the fixed list, never the app's", () => {
    const path = childPath(
      `${home}/.nvm/versions/node/v22.23.2/bin/npx`,
      home,
      fs,
    );
    expect(path.split(":")[0]).toBe(`${home}/.nvm/versions/node/v22.23.2/bin`);
    expect(
      path.split(":").filter((d) => d.endsWith("v22.23.2/bin")),
    ).toHaveLength(1);
    expect(path.endsWith("/usr/bin:/bin")).toBe(true);
    expect(path.split(":")).toHaveLength(searchPath(home, fs).length);
  });
});
