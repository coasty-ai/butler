import type { Settings } from "../../core/schema";
import { defaultSettings } from "../../core/schema";
import type { ToolAccess } from "../../core/tools";
import { createToolRegistry, type ToolRegistry } from "../../tools/registry";
import { FIXTURE_HOST, FIXTURE_PORT } from "./graders";

/**
 * The tool layer a benchmark run is given (AttemptDeps.tools): the built-in
 * files tool, the built-in web tool and nothing else. No Apple consent is
 * on, so the bridge is never started or asked for access; no server row
 * exists, so nothing is resolved, installed or spawned; the files tool runs
 * in this process over the home folder the harness names, under the same
 * path rules as in the product, and the web tool fetches pages under the
 * same rules as in the product plus one allowance: the fixture server's
 * origin (FIXTURE_ORIGIN, loopback, refused in the product) may be read, so
 * a research task's pages reach the model by the tool as they would from a
 * public site. A run's own settings (the cell's) decide whether policy lets
 * a call run; these settings only decide what the registry lists.
 */
export const BENCH_TOOL_SETTINGS: Settings = {
  ...defaultSettings,
  privacy: "PRIVATE_BYOM",
  tools: {
    enabled: true,
    apple: { calendar: false, reminders: false, notes: false, mail: false },
    files: true,
    web: true,
    servers: [],
  },
};
/** The one loopback origin a bench run's web tool may read: the fixture server. */
export const FIXTURE_ORIGIN = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;
export interface BenchTools {
  access: ToolAccess;
  registry: ToolRegistry;
  close(): Promise<void>;
}
export async function createBenchTools(o: {
  home: string;
  /** Where a first-party helper binary would be; never read, since no consent is on. */
  helper?: (name: string) => string;
  version?: string;
  trace?: (event: string, data: Record<string, unknown>) => void;
  /** Loopback origins the web tool may read; the fixture server's unless a test names another. */
  loopbackOrigins?: readonly string[];
}): Promise<BenchTools> {
  const registry = createToolRegistry({
    settings: () => BENCH_TOOL_SETTINGS,
    credentials: () => ({ env: {}, headers: {} }),
    helper: o.helper ?? ((name) => `/nonexistent/${name}`),
    launch: () => undefined,
    home: o.home,
    version: o.version ?? "bench",
    trace: o.trace,
    loopbackOrigins: o.loopbackOrigins ?? [FIXTURE_ORIGIN],
  });
  await registry.configure();
  const access = registry.access({ synthetic: false });
  if (!access) throw new Error("The bench tool layer did not open.");
  return { access, registry, close: () => registry.closeAll() };
}
