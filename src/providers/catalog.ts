import type { ProviderKind, Settings } from "../core/schema";

type Prices = Pick<Settings, "inputPrice" | "outputPrice">;

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

/**
 * A model's standard rates, and what the vendor's price list says about its
 * cached input and any announced change of price.
 */
interface ModelRates extends Prices {
  /**
   * The cached-input rate as a share of inputPrice, set only for an id whose
   * cached rate was read off the vendor's list. Without it cached tokens are
   * charged at the full input rate: a bill that can be overstated but never
   * understated, which is the side a cost cap must err on. (GPT-4o's cached
   * rate is half its input rate and o4-mini's a quarter, so no one share fits
   * a whole vendor.) Anthropic's cache rates are the same for every model and
   * live in src/providers/http.ts.
   */
  cachedInput?: number;
  /**
   * An announced price change: from 00:00 UTC on `from`, these rates replace
   * the ones above. UTC midnight comes before the vendor's own (Google's is
   * Pacific), so a rise is charged a few hours early rather than late. The
   * table holds only rises; a cut switched early would understate.
   */
  change?: Prices & { from: string };
}

/**
 * Standard, uncached dollars per million tokens by provider and exact model
 * id, checked 2026-09-18 against each vendor's own price list. A benchmark
 * matrix cell or a --model override takes its prices from here, so a cost
 * column compares models instead of charging every model at its provider's
 * default rate.
 *
 * Rates that depend on prompt size (GPT-5.5 and GPT-5.4 above 272k tokens,
 * Gemini Pro above 200k) are the small-prompt rate: one step here is a
 * screenshot and a few thousand tokens of context.
 */
export const modelPrices: Record<ProviderKind, Record<string, ModelRates>> = {
  // Local inference is free; the model is whatever the user pulled.
  ollama: {},
  // https://developers.openai.com/api/docs/pricing (standard tier, 2026-09-18).
  // Every GPT-5.x cached input is a tenth of its input rate.
  openai: {
    "gpt-5.5": { inputPrice: 5, outputPrice: 30, cachedInput: 0.1 },
    "gpt-5.4": { inputPrice: 2.5, outputPrice: 15, cachedInput: 0.1 },
    "gpt-5.4-mini": { inputPrice: 0.75, outputPrice: 4.5, cachedInput: 0.1 },
    "gpt-5.4-nano": { inputPrice: 0.2, outputPrice: 1.25, cachedInput: 0.1 },
    "gpt-5.2": { inputPrice: 1.75, outputPrice: 14, cachedInput: 0.1 },
    "gpt-5.1": { inputPrice: 1.25, outputPrice: 10, cachedInput: 0.1 },
    "gpt-5": { inputPrice: 1.25, outputPrice: 10, cachedInput: 0.1 },
    "gpt-5-mini": { inputPrice: 0.25, outputPrice: 2, cachedInput: 0.1 },
    "gpt-5-nano": { inputPrice: 0.05, outputPrice: 0.4, cachedInput: 0.1 },
  },
  // https://platform.claude.com/docs/en/about-claude/pricing (2026-09-18);
  // ids from https://platform.claude.com/docs/en/about-claude/models/overview.
  // Sonnet 5's launch rate of $2/$10 became its standard rate.
  anthropic: {
    // Cache hits on Fable 5.1 cost 0.025x input, not the 0.1x http.ts charges
    // every Anthropic model, so a Fable 5.1 run that caches is overstated.
    "claude-fable-5-1": { inputPrice: 10, outputPrice: 50 },
    "claude-fable-5": { inputPrice: 10, outputPrice: 50 },
    "claude-opus-5": { inputPrice: 5, outputPrice: 25 },
    "claude-opus-4-8": { inputPrice: 5, outputPrice: 25 },
    "claude-opus-4-7": { inputPrice: 5, outputPrice: 25 },
    "claude-opus-4-6": { inputPrice: 5, outputPrice: 25 },
    "claude-sonnet-5": { inputPrice: 2, outputPrice: 10 },
    "claude-sonnet-4-6": { inputPrice: 3, outputPrice: 15 },
    // Before the 4.6 generation an id is a dated snapshot and the dateless
    // name an alias for it; both reach the same model at the same rate.
    "claude-opus-4-5": { inputPrice: 5, outputPrice: 25 },
    "claude-sonnet-4-5": { inputPrice: 3, outputPrice: 15 },
    "claude-sonnet-4-5-20250929": { inputPrice: 3, outputPrice: 15 },
    "claude-haiku-4-5": { inputPrice: 1, outputPrice: 5 },
    "claude-haiku-4-5-20251001": { inputPrice: 1, outputPrice: 5 },
  },
  // https://ai.google.dev/gemini-api/docs/pricing (paid tier, text input,
  // 2026-09-18). Every context-caching price listed is a tenth of the input
  // rate; 3.5 Flash-Lite lists none, so its cached tokens are charged in full.
  google: {
    // Launch rates through 2026-12-31; the list gives $1.50/$7.50 (cached
    // $0.15) from 2027-01-01.
    "gemini-3.8-flash": {
      inputPrice: 0.75,
      outputPrice: 3.75,
      cachedInput: 0.1,
      change: { from: "2027-01-01", inputPrice: 1.5, outputPrice: 7.5 },
    },
    "gemini-3.7-flash": {
      inputPrice: 0.75,
      outputPrice: 3.75,
      cachedInput: 0.1,
      change: { from: "2027-01-01", inputPrice: 1.5, outputPrice: 7.5 },
    },
    "gemini-3.6-flash": {
      inputPrice: 0.75,
      outputPrice: 3.75,
      cachedInput: 0.1,
      change: { from: "2027-01-01", inputPrice: 1.5, outputPrice: 7.5 },
    },
    "gemini-3.5-flash": { inputPrice: 1.5, outputPrice: 9, cachedInput: 0.1 },
    "gemini-3.5-flash-lite": { inputPrice: 0.3, outputPrice: 2.5 },
    "gemini-3.1-flash-lite": {
      inputPrice: 0.25,
      outputPrice: 1.5,
      cachedInput: 0.1,
    },
    "gemini-3.1-pro-preview": {
      inputPrice: 2,
      outputPrice: 12,
      cachedInput: 0.1,
    },
    "gemini-2.5-pro": { inputPrice: 1.25, outputPrice: 10, cachedInput: 0.1 },
    "gemini-2.5-flash": { inputPrice: 0.3, outputPrice: 2.5, cachedInput: 0.1 },
    "gemini-2.5-flash-lite": {
      inputPrice: 0.1,
      outputPrice: 0.4,
      cachedInput: 0.1,
    },
  },
  // A gateway relays many upstream models at its own rates; the user enters them.
  compatible: {},
};

/** The table's entry for one exact model id. */
function rates(provider: ProviderKind, model: string): ModelRates | undefined {
  // Own keys only: "constructor" or "toString" typed as a model must not
  // find Object.prototype and fall through to the default model's rates.
  const table = modelPrices[provider];
  return Object.hasOwn(table, model) ? table[model] : undefined;
}

/**
 * The catalog's rates for one exact model id at a moment (now by default),
 * or undefined when it has none.
 */
export function modelPrice(
  provider: ProviderKind,
  model: string,
  at: Date = new Date(),
): Prices | undefined {
  const entry = rates(provider, model);
  if (!entry) return undefined;
  const { change } = entry;
  const current =
    change && at.getTime() >= Date.parse(`${change.from}T00:00:00Z`)
      ? change
      : entry;
  return { inputPrice: current.inputPrice, outputPrice: current.outputPrice };
}

/**
 * The vendor's cached-input rate for this model as a share of its input
 * rate, or undefined where the catalog has not checked one.
 */
export function cachedInputShare(
  provider: ProviderKind,
  model: string,
): number | undefined {
  return rates(provider, model)?.cachedInput;
}

/**
 * The provider's endpoint and default model, or, with `model`, that model at
 * its own rates. A model the catalog does not price gets zero rates rather
 * than the default model's: a cloud provider then refuses to start until
 * rates are entered, which is better than a cost column that quietly charges
 * every model the same. Callers that do not pass a model keep the old
 * behaviour exactly.
 */
export function selectProvider(
  settings: Settings,
  provider: ProviderKind,
  model?: string,
): Settings {
  const defaults = providerDefaults[provider];
  const chosen = model ?? defaults.model;
  const prices =
    model === undefined || provider === "ollama"
      ? {}
      : (modelPrice(provider, chosen) ?? { inputPrice: 0, outputPrice: 0 });
  return {
    ...settings,
    ...defaults,
    ...prices,
    model: chosen,
    provider,
    privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  };
}

/**
 * The `.env` names a cloud provider's key is imported from, first match wins
 * (electron/credentials.ts importEnvCredentials). The harness preflight reads
 * the same table to say which matrix cell has no key before anything is paid
 * for, so the two can never disagree about a name.
 */
export const providerKeyEnv = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
} as const satisfies Partial<Record<ProviderKind, readonly string[]>>;

// Bind saved keys to the provider AND exact normalized endpoint, never just a
// provider label. A custom endpoint must not inherit an official provider key.
export function credentialScope(
  provider: ProviderKind,
  endpoint: string,
): string {
  return `${provider}:${new URL(endpoint).toString().replace(/\/$/, "")}`;
}
