import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolServer } from "../core/schema";
import { NPX_COMMAND, type NodeInstall } from "../core/tools";
import { childPath, type ResolveFs } from "./resolve";

/**
 * The app owns the install of a recipe's Node package. `npx -y <package>`
 * inside the network sandbox never answers: even with the package cached, npx
 * asks the registry for the "latest" dist-tag and the blocked request hangs
 * until the connect timeout (0 bytes on stdout for 25 s, measured 2026-09-19),
 * and `npm cache add` caches the tarball alone, so `npx --offline` fails on a
 * fresh Mac with ENOTCACHED on the dependency tree. So the registry installs
 * the pinned package once, attended and with network, into a folder of its
 * own under the app's data directory (installPrefix), and the server runs as
 * `node <prefix>/node_modules/.bin/<bin> <args>` through the shim with
 * `--no-network` when the row declares none. npx is never on that path.
 *
 * Everything here is pure except defaultInstaller, which spawns npm with its
 * output ignored: nothing npm prints is ever read, kept or traced.
 */
export const INSTALL_TIMEOUT_MS = 180_000;
/** npx's own flags a row from before the install step may carry ahead of the package. */
const NPX_FLAGS = /^(?:-y|--yes|--offline|--prefer-offline|--no-install)$/;

/** Where one row's package lives: <root>/<rowId>, root being <userData>/mcp. */
export function installPrefix(root: string, rowId: string): string {
  return join(root, rowId);
}
/** The installed bin the server runs as: <prefix>/node_modules/.bin/<bin>. */
export function installedBin(prefix: string, install: NodeInstall): string {
  return join(prefix, "node_modules", ".bin", install.bin);
}
/** The version installed under the prefix, from the package's own package.json; undefined when absent or unreadable. */
export function installedVersion(
  prefix: string,
  install: NodeInstall,
  fs: ResolveFs,
): string | undefined {
  if (!fs.read) return undefined;
  const text = fs.read(
    join(prefix, "node_modules", install.package, "package.json"),
  );
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Installed means the bin is executable and, where the file system can be
 * read, the package's version is the pinned one, so a bumped pin installs
 * again in place; a table without read (tests) is trusted on the bin alone.
 */
export function isInstalled(
  prefix: string,
  install: NodeInstall,
  fs: ResolveFs,
): boolean {
  if (!fs.isExecutable(installedBin(prefix, install))) return false;
  return !fs.read || installedVersion(prefix, install, fs) === install.version;
}
/**
 * npm's arguments for the install: into the prefix, quiet, no audit or
 * funding chatter, no lifecycle scripts (a pinned server ships built; nothing
 * fetched from the registry runs at install time), the package at its pin.
 */
export function npmInstallArgs(prefix: string, install: NodeInstall): string[] {
  return [
    "install",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--loglevel=error",
    `${install.package}@${install.version}`,
  ];
}
/** The environment npm runs in: the fixed child environment, nothing of the app's. */
export function installEnv(
  npm: string,
  home: string,
  fs?: ResolveFs,
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    PATH: childPath(npm, home, fs),
  };
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
/**
 * A recipe row's own arguments, without npx's: a row from before the install
 * step (`npx -y <package> <folder>`) keeps only what followed the package,
 * so the folder the user picked survives the change of route.
 */
export function recipeArgs(row: ToolServer, install: NodeInstall): string[] {
  if (!NPX_COMMAND.test(row.command)) return row.args;
  const args = [...row.args];
  while (args.length && NPX_FLAGS.test(args[0])) args.shift();
  if (
    args.length &&
    (args[0] === install.package || args[0].startsWith(`${install.package}@`))
  )
    args.shift();
  return args;
}
/**
 * The arguments the server is run with, after its command: an installed
 * recipe's bin then its own arguments; a pasted npx row that may not reach the
 * network run offline, so a package missing from npx's cache fails at once
 * (ENOTCACHED) instead of hanging on the registry; anything else as given.
 */
export function liveArgs(
  row: ToolServer,
  install: NodeInstall | undefined,
  prefix: string,
): string[] {
  if (install)
    return [installedBin(prefix, install), ...recipeArgs(row, install)];
  if (
    NPX_COMMAND.test(row.command) &&
    row.network === "none" &&
    !row.args.includes("--offline")
  )
    return ["--offline", ...row.args];
  return row.args;
}
export interface InstallRequest {
  /** The resolved npm. */
  npm: string;
  prefix: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}
export interface InstallOutcome {
  /** npm's exit status; null when it was killed or never ran. */
  exitCode: number | null;
  timedOut: boolean;
}
export type Installer = (request: InstallRequest) => Promise<InstallOutcome>;
/** Runs npm with its output ignored; makes the prefix first. Never throws. */
export const defaultInstaller: Installer = (request) =>
  new Promise((resolve) => {
    try {
      mkdirSync(request.prefix, { recursive: true });
    } catch {
      /* npm reports the folder it cannot use. */
    }
    let done = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: InstallOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.npm, request.args, {
        cwd: request.prefix,
        env: request.env,
        stdio: "ignore",
      });
    } catch {
      finish({ exitCode: null, timedOut: false });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    child.on("error", () => finish({ exitCode: null, timedOut }));
    child.on("exit", (code) => finish({ exitCode: code, timedOut }));
  });
