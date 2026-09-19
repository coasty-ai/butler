import { z } from "zod";
import type {
  ChoiceModelChoice,
  ModuleChoice,
  ModulesSettings,
  Settings,
  ToolServer,
} from "./schema";
import { RESERVED_PROVIDERS, TOOL_LIMITS } from "./tools";
/**
 * The rows a Private local switch has to turn off: servers that reach the
 * internet or speak HTTP. Returns the settings with those rows disabled and
 * the labels of what changed, so the save can say so.
 */
export function localToolSettings(s: Settings): {
  settings: Settings;
  disabled: string[];
} {
  if (s.privacy !== "PRIVATE_LOCAL") return { settings: s, disabled: [] };
  const offending = (row: Settings["tools"]["servers"][number]) =>
    row.enabled && (row.transport === "http" || row.network !== "none");
  const disabled = s.tools.servers.filter(offending).map((row) => row.name);
  if (!disabled.length) return { settings: s, disabled };
  return {
    settings: {
      ...s,
      tools: {
        ...s.tools,
        servers: s.tools.servers.map((row) =>
          offending(row) ? { ...row, enabled: false } : row,
        ),
      },
    },
    disabled,
  };
}
/**
 * The tools gate at save time (electron/main.ts saveSettings and every
 * server bridge call); toolsAllowed() is the gate at use time.
 */
export function validateToolSettings(
  s: Pick<Settings, "privacy" | "tools">,
): void {
  const rows = s.tools.servers;
  if (rows.length > TOOL_LIMITS.servers)
    throw new Error(
      `At most ${TOOL_LIMITS.servers} tool servers can be connected.`,
    );
  const ids = new Set<string>();
  for (const row of rows) {
    if (RESERVED_PROVIDERS.has(row.id) || ids.has(row.id))
      throw new Error("Each tool server needs its own id.");
    ids.add(row.id);
    if (row.transport === "stdio" && !row.command.trim())
      throw new Error(`${row.name} needs a command.`);
    if (row.transport === "http") {
      if (s.privacy === "PRIVATE_LOCAL" && row.enabled)
        throw new Error(
          "Remote tool servers are not available in Private local.",
        );
      let url: URL;
      try {
        url = new URL(row.url);
      } catch {
        throw new Error(`${row.name} needs an https address.`);
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          `${row.name} needs an https address without credentials, query parameters or fragments.`,
        );
    }
    if (s.privacy === "PRIVATE_LOCAL" && row.enabled && row.network !== "none")
      throw new Error(
        `${row.name} reaches the internet; Private local runs only local tool servers.`,
      );
    if (row.secretEnv.some((name) => name in row.env))
      throw new Error(
        `${row.name} names a variable both plainly and as a secret.`,
      );
  }
}
// Modules (.data/design/modules.md §10) ---------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
/**
 * Whether one module choice sends anything off this Mac: an http endpoint
 * that is not loopback, a tool on a server reached over http or declared
 * internet, or an OpenRouter model. Jev is gated by its own consent and
 * privacy rule (electron/jev.ts jevEnabled) and is not counted here; the
 * built-in and a command are local by construction.
 */
export function moduleReachesInternet(
  choice: ModuleChoice | ChoiceModelChoice | undefined,
  servers: readonly ToolServer[],
): boolean {
  if (!choice) return false;
  switch (choice.kind) {
    case "http": {
      try {
        return !LOOPBACK.has(new URL(choice.url).hostname);
      } catch {
        return true;
      }
    }
    case "mcp": {
      const row = servers.find((r) => r.id === choice.server);
      return !row || row.transport === "http" || row.network !== "none";
    }
    case "openrouter":
      return true;
    default:
      return false;
  }
}
/**
 * The modules gate at save time (electron/main.ts saveSettings): the same
 * rule the task model has, so in Private local no port's adapter may reach
 * the internet; a tool choice must name a connected server. Throws with the
 * one fixed line the settings window shows.
 */
export function validateModuleSettings(
  s: Pick<Settings, "privacy" | "modules" | "tools">,
): void {
  const ports = [
    "clauseSegmenter",
    "fastDecider",
    "choiceModel",
    "urlOpener",
    "tts",
  ] as const;
  for (const port of ports) {
    const choice = s.modules[port];
    if (!choice) continue;
    if (
      choice.kind === "mcp" &&
      !s.tools.servers.some((row) => row.id === choice.server)
    )
      throw new Error("A module names a tool server that is not connected.");
    if (
      s.privacy === "PRIVATE_LOCAL" &&
      moduleReachesInternet(choice, s.tools.servers)
    )
      throw new Error(
        "In Private local, modules stay on this Mac: choose Built-in, a local tool server or a loopback endpoint.",
      );
  }
}
/** The module choices with every reference to one tool server reset to the built-in (forget). */
export function modulesWithoutServer(
  modules: ModulesSettings,
  serverId: string,
): ModulesSettings {
  const out: ModulesSettings = { ...modules };
  for (const key of Object.keys(out) as (keyof ModulesSettings)[]) {
    const choice = out[key];
    if (choice && choice.kind === "mcp" && choice.server === serverId)
      delete out[key];
  }
  return out;
}
export function validateProviderEndpoint(s: Settings): URL {
  const u = new URL(s.endpoint);
  if (u.username || u.password || u.search || u.hash)
    throw new Error(
      "Endpoint must not contain credentials, query parameters or fragments.",
    );
  const loopback = ["127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    s.privacy === "PRIVATE_LOCAL" &&
    (!loopback || s.provider !== "ollama" || /cloud|\//i.test(s.model))
  )
    throw new Error(
      "Private local requires a local Ollama model and a literal loopback address.",
    );
  if (!loopback && u.protocol !== "https:")
    throw new Error("Remote providers require HTTPS.");
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("Unsupported endpoint protocol.");
  const official: Record<string, string> = {
    openai: "api.openai.com",
    anthropic: "api.anthropic.com",
    google: "generativelanguage.googleapis.com",
  };
  if (official[s.provider] && u.hostname !== official[s.provider])
    throw new Error("Choose Custom compatible for a third-party endpoint.");
  if (/(^|\.)coarena\./i.test(u.hostname))
    throw new Error("Private inference cannot use a CoArena content proxy.");
  return u;
}
// No sender exists. Strict allow-list prevents accidental content-bearing telemetry.
export const telemetrySchema = z
  .object({
    app_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    os: z.enum(["darwin", "win32", "linux"]),
    provider: z.enum([
      "ollama",
      "openai",
      "anthropic",
      "google",
      "compatible",
      "tutorial",
    ]),
    duration_ms: z.number().nonnegative(),
    actions: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    confirmations: z.number().int().nonnegative(),
    success: z.boolean().nullable(),
  })
  .strict();
