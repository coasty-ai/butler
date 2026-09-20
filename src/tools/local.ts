import type { Settings } from "../core/schema";
import type { McpProvider } from "./mcp";

/**
 * A first-party tool source that runs inside the app's own process: no
 * helper binary, no MCP framing, no network. The registry composes one after
 * the Apple bridge (BUILTIN_SERVERS) and gates it by its own switch in
 * settings.tools; its tools are builtin to the model (transport "builtin",
 * trusted, local, closed-world) and go through the same prepare, policy,
 * call, bounding and undo as every other. The one shipped is the files tool
 * (src/tools/providers/files.ts).
 */
export interface LocalProviderOptions {
  /** The user's home folder: the only tree a local provider may touch. */
  home: string;
  now?: () => number;
  trace?: (event: string, data: Record<string, unknown>) => void;
}
export interface LocalServer {
  /** A RESERVED_PROVIDERS member ("files"): a user's server can never take the id. */
  id: string;
  title: string;
  /** Whether settings let it list at all, beside settings.tools.enabled. */
  enabled(settings: Settings): boolean;
  create(o: LocalProviderOptions): McpProvider;
}
