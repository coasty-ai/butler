import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolFastPath } from "../src/assistant/tool-answers";
import type { Settings, ToolServer } from "../src/core/schema";
import type { DiagnosticSink } from "../src/core/diagnostics";
import type { ToolOutcome } from "../src/core/tools";
import { createToolRegistry, type ToolRegistry } from "../src/tools/registry";
import { toolSecrets, type Credentials } from "./credentials";

/**
 * The tool layer as main.ts holds it: the registry (src/tools) with the
 * app's helper paths, the vault's secrets and the idle start. Servers the
 * user added start a few seconds after the app is up, or right after an
 * approval, so the list frozen at the start of a run already has them;
 * they are closed on disable, forget and before-quit.
 */
export const IDLE_START_MS = 5000;
export interface ToolPaths {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}
/** A first-party helper binary, located as the other helpers are (main.ts getAgenda). */
export function helperBinary(name: string, paths: ToolPaths): string {
  return paths.packaged
    ? join(paths.resourcesPath, name)
    : join(paths.appPath, "native/bin", name);
}
/**
 * coarena-launch when the build has it: user servers then run with TCC
 * responsibility disclaimed and, when declared local, inside the network
 * sandbox. Without it they are spawned directly, which the pane says.
 */
export function launchShim(paths: ToolPaths): string | undefined {
  const shim = helperBinary("coarena-launch", paths);
  return existsSync(shim) ? shim : undefined;
}
export interface ToolLayer extends ToolRegistry {
  /** Starts what settings allow, a few seconds from now (the idle start). */
  startSoon(delayMs?: number): void;
}
export function createToolLayer(o: {
  settings: () => Settings;
  credentials: () => Credentials;
  paths: ToolPaths;
  home: string;
  /** app.getPath("userData"): a recipe's installed package lives under <dataDir>/mcp/<rowId>. */
  dataDir: string;
  version: string;
  trace?: DiagnosticSink;
  onTicks?: (id: string, tools: ToolServer["tools"]) => void;
}): ToolLayer {
  const registry = createToolRegistry({
    settings: o.settings,
    credentials: (id) => toolSecrets(o.credentials(), id),
    helper: (name) => helperBinary(name, o.paths),
    launch: () => launchShim(o.paths),
    home: o.home,
    installRoot: join(o.dataDir, "mcp"),
    version: o.version,
    trace: o.trace,
    onTicks: o.onTicks,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    ...registry,
    startSoon(delayMs = IDLE_START_MS) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void registry.configure().catch((error) => {
          o.trace?.("ToolServerFailed", {
            code:
              error instanceof Error && error.name ? error.name : "configure",
          });
        });
      }, delayMs);
      timer.unref?.();
    },
    closeAll() {
      clearTimeout(timer);
      return registry.closeAll();
    },
  };
}
/**
 * A request one builtin read answers outright (toolFastPath "answer"): the
 * tool must be in the list for these words, a read, and trusted; then it is
 * called and its spoken line built. Anything else, including a failed read,
 * returns undefined and the turn takes today's path.
 */
export async function answerByTool(
  registry: ToolRegistry,
  fast: Extract<ToolFastPath, { kind: "answer" }>,
  text: string,
  signal: AbortSignal,
): Promise<{ said: string; outcome: ToolOutcome } | undefined> {
  const access = registry.access({ synthetic: false });
  if (!access) return undefined;
  const { tools } = await access.list(text, signal);
  const spec = tools.find((tool) => tool.id === fast.tool);
  if (!spec || spec.tier !== "read" || !spec.trusted) return undefined;
  if (!access.prepare(spec, fast.args).ok) return undefined;
  const outcome = await access.call(spec, fast.args, signal);
  if (outcome.code !== "ok") return undefined;
  return { said: fast.say(outcome, registry.clock()), outcome };
}
