import type { Settings } from "../core/schema";
import type { McpProvider } from "./mcp";

/**
 * A first-party tool source that runs inside the app's own process: no
 * helper binary, no MCP framing. The registry composes one after the Apple
 * bridge (BUILTIN_SERVERS) and gates it by its own switch in settings.tools;
 * its tools are builtin to the model (transport "builtin", trusted, local,
 * closed-world) and go through the same prepare, policy, call, bounding and
 * undo as every other. Two are shipped: the files tool
 * (src/tools/providers/files.ts), which touches nothing outside the home
 * folder, and the web tool (src/tools/providers/web.ts), which fetches one
 * public page by GET with no cookies or credentials and hands its text back.
 */
export interface LocalProviderOptions {
  /** The user's home folder: the only tree a local provider may touch. */
  home: string;
  /**
   * The settings, read live: the web tool judges a host against
   * settings.protectedDomains at prepare and again at call. The registry
   * always passes them; a provider built bare (the files tool in a test)
   * reads nothing here, and the web tool falls back to the defaults' list.
   */
  settings?: () => Settings;
  /**
   * Origins on this Mac a read may reach although they are loopback
   * ("http://127.0.0.1:47831", the bench fixture server): the bench's own
   * registry (src/gym/bench/tools.ts) names its fixture origin, the owner's
   * app names none, so nothing of the app fetches loopback by default.
   */
  loopbackOrigins?: readonly string[];
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
