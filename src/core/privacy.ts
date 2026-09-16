import { z } from "zod";
import type { Settings } from "./schema";
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
