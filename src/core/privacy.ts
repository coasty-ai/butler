import { z } from "zod";
import type { Settings } from "./schema";
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
