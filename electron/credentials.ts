import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import type { Settings } from "../src/core/schema";
import {
  credentialScope,
  providerDefaults,
  providerKeyEnv,
  selectProvider,
} from "../src/providers/catalog";

export type Credentials = Record<string, string>;
const keySchema = z.string().trim().max(1000);
const cloudProvider = z.enum(["openai", "anthropic", "google"]);

export function readCredentials(raw: unknown): Credentials {
  return z.record(z.string().max(500), keySchema).parse(raw ?? {});
}

export function providerKey(
  keys: Credentials,
  settings: Pick<Settings, "provider" | "endpoint">,
): string {
  return keys[credentialScope(settings.provider, settings.endpoint)] ?? "";
}

export function withProviderKey(
  keys: Credentials,
  settings: Pick<Settings, "provider" | "endpoint">,
  value: unknown,
): Credentials {
  const next = { ...keys };
  const scope = credentialScope(settings.provider, settings.endpoint);
  const key = keySchema.parse(value);
  if (key) next[scope] = key;
  else delete next[scope];
  return next;
}

export function importEnvCredentials(
  file: string,
  keys: Credentials,
): Credentials {
  try {
    // Import only an explicitly named file. Never source it in a shell or load
    // arbitrary environment variables into Electron/Vite/native subprocesses.
    if (!isAbsolute(file)) throw new Error();
    const info = statSync(file);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error();
    const env = parseEnv(readFileSync(file, "utf8"));
    let next = { ...keys };
    let imported = 0;
    for (const [provider, names] of Object.entries(providerKeyEnv) as [
      keyof typeof providerKeyEnv,
      readonly string[],
    ][]) {
      const value = names.map((name) => env[name]?.trim()).find(Boolean);
      if (!value) continue;
      next = withProviderKey(
        next,
        { provider, endpoint: providerDefaults[provider].endpoint },
        value,
      );
      imported++;
    }
    if (!imported) throw new Error();
    return next;
  } catch {
    // Parser/file errors must never echo contents, including malformed secrets.
    throw new Error(
      "Could not import API keys. Use an absolute path to a .env file containing valid provider keys (maximum 64 KB).",
    );
  }
}

export function importLaunchCredentials(
  args: string[],
  settings: Settings,
  keys: Credentials,
) {
  const index = args.indexOf("--import-env");
  if (index < 0) return undefined;
  const nextKeys = importEnvCredentials(args[index + 1] ?? "", keys);
  const selection = args.indexOf("--provider");
  let nextSettings = settings;
  if (selection >= 0) {
    const parsed = cloudProvider.safeParse(args[selection + 1]);
    if (!parsed.success)
      throw new Error("Choose openai, anthropic or google for --provider.");
    nextSettings = selectProvider(settings, parsed.data);
    if (!providerKey(nextKeys, nextSettings))
      throw new Error("The selected provider has no imported API key.");
  }
  return { settings: nextSettings, credentials: nextKeys };
}
