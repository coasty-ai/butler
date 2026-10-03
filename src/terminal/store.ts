import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { settingsSchema, defaultSettings, type Settings } from "../core/schema";
import { seal, unseal, Vault } from "../storage/vault";
import { providerDefaults } from "../providers/catalog";
import { MemoryStore } from "../memory/store";
import { McpCatalogues } from "./catalogues";

export interface TerminalProfile {
  settings: Settings;
  secrets: Record<string, string>;
}
export const terminalHome = () =>
  process.env.BUTLER_DATA_DIR || join(homedir(), ".config", "butler");
const SERVICE = "ai.coarena.butler.terminal";
export function keychainKey(): Buffer {
  if (process.platform !== "darwin")
    throw new Error("Butler currently requires macOS and its Keychain.");
  const found = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", SERVICE, "-a", "vault", "-w"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (found.status === 0 && /^[a-f0-9]{64}$/.test(found.stdout.trim()))
    return Buffer.from(found.stdout.trim(), "hex");
  if (found.status !== 44)
    throw new Error("The Butler Keychain entry could not be opened.");
  const key = randomBytes(32);
  // Secret goes through stdin, never command-line arguments or diagnostics.
  const stored = spawnSync("/usr/bin/security", ["-i"], {
    input: `add-generic-password -U -s ${SERVICE} -a vault -w ${key.toString("hex")}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (stored.status !== 0 || /SecKeychain|error:/i.test(stored.stderr))
    throw new Error("Butler could not create its Keychain entry.");
  return key;
}
export function initialSettings(
  env: NodeJS.ProcessEnv = process.env,
): Settings {
  const provider = env.OPENAI_API_KEY
    ? "openai"
    : env.ANTHROPIC_API_KEY
      ? "anthropic"
      : env.GEMINI_API_KEY
        ? "google"
        : "ollama";
  return settingsSchema.parse({
    ...defaultSettings,
    ...providerDefaults[provider],
    provider,
    privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
    model: env.BUTLER_MODEL || providerDefaults[provider].model,
    ...(provider === "openai" && !env.BUTLER_MODEL
      ? {
          model: "gpt-6.1-sol",
          dialogModel: "gpt-6.1-sol",
          openaiServiceTier: "fast",
          inputPrice: 4,
          outputPrice: 20,
        }
      : {}),
    decisions: "off",
    decisionsChosen: true,
    persona: "jarvis",
    setupComplete: true,
  });
}
export class TerminalStore {
  readonly vault: Vault;
  readonly memory: MemoryStore;
  readonly catalogues: McpCatalogues;
  profile: TerminalProfile;
  constructor(
    readonly root = terminalHome(),
    private key = keychainKey(),
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, "profile.enc");
    if (existsSync(file)) {
      const saved = JSON.parse(
        unseal(key, readFileSync(file), "terminal-profile").toString(),
      );
      this.profile = {
        settings: settingsSchema.parse(saved.settings),
        secrets: saved.secrets ?? {},
      };
    } else this.profile = { settings: initialSettings(), secrets: {} };
    this.vault = new Vault(join(root, "runs"), key);
    this.memory = new MemoryStore(join(root, "memory"), key);
    this.catalogues = new McpCatalogues(join(root, "catalogues"), key);
  }
  save() {
    const file = join(this.root, "profile.enc");
    writeFileSync(
      file + ".tmp",
      seal(
        this.key,
        Buffer.from(JSON.stringify(this.profile)),
        "terminal-profile",
      ),
      { mode: 0o600 },
    );
    renameSync(file + ".tmp", file);
  }
  keyForProvider(): string {
    const s = this.profile.settings;
    const env =
      s.provider === "openai"
        ? "OPENAI_API_KEY"
        : s.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : s.provider === "google"
            ? "GEMINI_API_KEY"
            : "BUTLER_API_KEY";
    return (
      this.profile.secrets[`provider:${s.provider}`] || process.env[env] || ""
    );
  }
  saveBriefing(text: string) {
    const file = join(this.root, "latest-briefing.enc");
    writeFileSync(
      file,
      seal(this.key, Buffer.from(text), "terminal-briefing"),
      { mode: 0o600 },
    );
  }
  briefingContext(): { at: number; text: string } | undefined {
    const file = join(this.root, "latest-briefing.enc");
    return existsSync(file)
      ? { at: statSync(file).mtimeMs, text: this.latestBriefing() }
      : undefined;
  }
  latestBriefing(): string {
    const file = join(this.root, "latest-briefing.enc");
    return existsSync(file)
      ? unseal(this.key, readFileSync(file), "terminal-briefing").toString()
      : "No briefing saved yet.";
  }
}
