import type { ProviderKind, Settings } from "../core/schema";

// Standard, uncached token rates checked 2026-09-16. Editable in Settings.
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// https://ai.google.dev/gemini-api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
export const providerDefaults = {
  ollama: {
    endpoint: "http://127.0.0.1:11434",
    // Matches defaultSettings.model and the README's pull command. The 2b
    // variant works on small Macs but grounds GUI controls much less reliably.
    model: "qwen3-vl:8b",
    inputPrice: 0,
    outputPrice: 0,
  },
  openai: {
    endpoint: "https://api.openai.com",
    model: "gpt-5.4-mini",
    inputPrice: 0.75,
    outputPrice: 4.5,
  },
  anthropic: {
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    inputPrice: 2,
    outputPrice: 10,
  },
  google: {
    endpoint: "https://generativelanguage.googleapis.com",
    model: "gemini-3.5-flash-lite",
    inputPrice: 0.3,
    outputPrice: 2.5,
  },
  compatible: {
    endpoint: "https://openrouter.ai/api/v1",
    model: "",
    inputPrice: 0,
    outputPrice: 0,
  },
} satisfies Record<
  ProviderKind,
  Pick<Settings, "endpoint" | "model" | "inputPrice" | "outputPrice">
>;

export function selectProvider(
  settings: Settings,
  provider: ProviderKind,
): Settings {
  return {
    ...settings,
    ...providerDefaults[provider],
    provider,
    privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  };
}

// Bind saved keys to the provider AND exact normalized endpoint, never just a
// provider label. A custom endpoint must not inherit an official provider key.
export function credentialScope(
  provider: ProviderKind,
  endpoint: string,
): string {
  return `${provider}:${new URL(endpoint).toString().replace(/\/$/, "")}`;
}
