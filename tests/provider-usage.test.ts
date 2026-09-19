import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HttpProvider,
  anthropicCacheRates,
  parseResponse,
  parseUsage,
} from "../src/providers/http";
import {
  cachedInputShare,
  modelPrice,
  modelPrices,
  providerDefaults,
  selectProvider,
} from "../src/providers/catalog";
import {
  defaultSettings,
  providerSchema,
  settingsSchema,
  type Observation,
  type Settings,
} from "../src/core/schema";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoints: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  compatible: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434",
};
/*
 * A model whose cached rate the catalog has checked, per vendor. The discount
 * follows the model id, so each test says which model it bills.
 */
const checked: Record<string, string> = {
  openai: "gpt-5.4-mini",
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-5",
};
const settings = (
  provider: Settings["provider"],
  prices: Pick<Settings, "inputPrice" | "outputPrice">,
  model = checked[provider] ?? "test",
): Settings => ({
  ...defaultSettings,
  provider,
  privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  endpoint: endpoints[provider],
  model,
  ...prices,
});
// Each fixture: 2000 prompt tokens of which 1500 came from the cache, 50 out.
const openaiUsage = {
  input_tokens: 2000,
  input_tokens_details: { cached_tokens: 1500 },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 40 },
};
const googleUsage = {
  promptTokenCount: 2000,
  cachedContentTokenCount: 1500,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 20,
};
const action = { type: "click", frame_id: "frame", x: 0.2, y: 0.3 },
  args = { action_json: JSON.stringify(action) };

describe("cached prompt tokens", () => {
  it("bills OpenAI cached input at the cached rate and still counts it as input", () => {
    const usage = parseUsage(
      "openai",
      { usage: openaiUsage },
      settings("openai", { inputPrice: 0.75, outputPrice: 4.5 }),
    );
    expect(usage.inputTokens).toBe(2000);
    expect(usage.cachedInputTokens).toBe(1500);
    expect(usage.outputTokens).toBe(50);
    // ((500 + 1500 * 0.1) * 0.75 + 50 * 4.5) / 1e6
    expect(usage.cost).toBeCloseTo(0.0007125, 12);
    expect(cachedInputShare("openai", "gpt-5.4-mini")).toBe(0.1);
  });
  it("bills Gemini cached content at the cached rate, thoughts as output", () => {
    const usage = parseUsage(
      "google",
      { usageMetadata: googleUsage },
      settings("google", { inputPrice: 0.3, outputPrice: 2.5 }),
    );
    expect(usage.inputTokens).toBe(2000);
    expect(usage.cachedInputTokens).toBe(1500);
    expect(usage.outputTokens).toBe(50);
    // ((500 + 1500 * 0.1) * 0.3 + 50 * 2.5) / 1e6
    expect(usage.cost).toBeCloseTo(0.00032, 12);
    expect(cachedInputShare("google", "gemini-2.5-flash")).toBe(0.1);
  });
  it("charges the same for equally cached work on every discounting vendor", () => {
    // The point of the change: before it, the OpenAI and Google bills here
    // were 1.9x the Anthropic bill for identical work.
    const prices = { inputPrice: 2, outputPrice: 10 };
    const anthropic = parseUsage(
      "anthropic",
      {
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1500,
          output_tokens: 50,
        },
      },
      settings("anthropic", prices),
    );
    const openai = parseUsage(
      "openai",
      { usage: openaiUsage },
      settings("openai", prices),
    );
    const google = parseUsage(
      "google",
      { usageMetadata: googleUsage },
      settings("google", prices),
    );
    expect(anthropicCacheRates.read).toBe(
      cachedInputShare("openai", "gpt-5.4-mini"),
    );
    expect(openai.cost).toBeCloseTo(anthropic.cost, 12);
    expect(google.cost).toBeCloseTo(anthropic.cost, 12);
    expect(openai.inputTokens).toBe(anthropic.inputTokens);
    expect(google.inputTokens).toBe(anthropic.inputTokens);
    expect(anthropic.cost).toBeCloseTo(0.0018, 12);
  });
  it("leaves Anthropic accounting as it was", () => {
    const priced = settings("anthropic", { inputPrice: 2, outputPrice: 10 });
    const written = parseUsage(
      "anthropic",
      {
        usage: {
          input_tokens: 400,
          cache_creation_input_tokens: 1600,
          cache_read_input_tokens: 0,
          output_tokens: 50,
        },
      },
      priced,
    );
    expect(written.inputTokens).toBe(2000);
    expect(written.cost).toBeCloseTo(0.0053, 12);
    const read = parseUsage(
      "anthropic",
      {
        usage: {
          input_tokens: 400,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1600,
          output_tokens: 50,
        },
      },
      priced,
    );
    expect(read.cost).toBeCloseTo(0.00162, 12);
  });
  it("charges the full rate when nothing was cached, as before", () => {
    const prices = { inputPrice: 1, outputPrice: 2 };
    const bodies: [Settings["provider"], Record<string, unknown>][] = [
      ["openai", { usage: { input_tokens: 10, output_tokens: 2 } }],
      [
        "google",
        { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
      ],
      ["compatible", { usage: { prompt_tokens: 10, completion_tokens: 2 } }],
      ["ollama", { prompt_eval_count: 10, eval_count: 2 }],
    ];
    for (const [provider, body] of bodies) {
      const usage = parseUsage(provider, body, settings(provider, prices));
      expect(usage, provider).toEqual({
        inputTokens: 10,
        outputTokens: 2,
        // Every cloud provider reports its cache, as zero here; Ollama has none.
        ...(provider !== "ollama" && { cachedInputTokens: 0 }),
        cost: 0.000014,
      });
    }
  });
  it("ignores a malformed cached count and clamps one above the input total", () => {
    const priced = settings("openai", { inputPrice: 1, outputPrice: 0 });
    for (const cached of ["1500", -5, null, Number.NaN, undefined]) {
      const usage = parseUsage(
        "openai",
        {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: cached },
            output_tokens: 0,
          },
        },
        priced,
      );
      expect(usage.cost, String(cached)).toBeCloseTo(0.0001, 12);
    }
    // 5000 cached of 100: at most the whole prompt was cached.
    const over = parseUsage(
      "openai",
      {
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 5000 },
          output_tokens: 0,
        },
      },
      priced,
    );
    expect(over.inputTokens).toBe(100);
    expect(over.cost).toBeCloseTo(0.00001, 12);
    const google = parseUsage(
      "google",
      {
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 5000,
          candidatesTokenCount: 0,
        },
      },
      settings("google", { inputPrice: 1, outputPrice: 0 }),
    );
    expect(google.cost).toBeCloseTo(0.00001, 12);
  });
  it("gives a gateway's cached tokens no discount: the upstream rate is unknown", () => {
    const usage = parseUsage(
      "compatible",
      {
        usage: {
          prompt_tokens: 2000,
          prompt_tokens_details: { cached_tokens: 1500 },
          completion_tokens: 50,
        },
      },
      settings("compatible", { inputPrice: 1, outputPrice: 2 }),
    );
    expect(usage.cost).toBeCloseTo(0.0021, 12);
    expect(cachedInputShare("compatible", "gpt-5.4-mini")).toBeUndefined();
  });
  it("charges cached tokens in full for a model whose cached rate is unchecked", () => {
    // GPT-4o's cached input is half its input rate, o4-mini's and GPT-4.1's a
    // quarter (OpenAI's list, 2026-09-18). A flat tenth would bill them under
    // what the vendor charges, and the cost budget is enforced on this
    // number; charging in full errs the other way.
    const body = {
      usage: {
        input_tokens: 10000,
        input_tokens_details: { cached_tokens: 8000 },
        output_tokens: 100,
      },
    };
    const openai: [string, number, number, number][] = [
      // model, input, cached input, output ($ per million)
      ["gpt-4o", 2.5, 1.25, 10],
      ["gpt-4.1", 2, 0.5, 8],
      ["o4-mini", 1.1, 0.275, 4.4],
      ["gpt-unknown", 1, 1, 1],
    ];
    for (const [model, input, cachedRate, output] of openai) {
      const usage = parseUsage(
        "openai",
        body,
        settings("openai", { inputPrice: input, outputPrice: output }, model),
      );
      const billed = (2000 * input + 8000 * cachedRate + 100 * output) / 1e6;
      expect(usage.cost, model).toBeCloseTo(
        (10000 * input + 100 * output) / 1e6,
        12,
      );
      expect(usage.cost, model).toBeGreaterThanOrEqual(billed);
      expect(cachedInputShare("openai", model), model).toBeUndefined();
    }
    // A dated snapshot is not the alias the catalog checked.
    expect(cachedInputShare("openai", "gpt-5.4-mini-2026-03-17")).toBe(
      undefined,
    );
    // 3.5 Flash-Lite lists no caching price at all.
    for (const model of ["gemini-3.5-flash-lite", "gemini-unknown"]) {
      const usage = parseUsage(
        "google",
        { usageMetadata: googleUsage },
        settings("google", { inputPrice: 0.3, outputPrice: 2.5 }, model),
      );
      expect(usage.cost, model).toBeCloseTo((2000 * 0.3 + 50 * 2.5) / 1e6, 12);
    }
    // Inherited names are not models either.
    expect(cachedInputShare("openai", "constructor")).toBeUndefined();
  });
  it("discounts only at a share the vendor's list gives for that model", () => {
    for (const provider of ["openai", "google"] as const)
      for (const [model, entry] of Object.entries(modelPrices[provider]))
        if (entry.cachedInput !== undefined)
          // Every checked GPT-5.x and Gemini cached rate is a tenth.
          expect(cachedInputShare(provider, model), model).toBe(0.1);
    // Anthropic's cache rates are the same for every model and live in
    // http.ts; a share here would be silently ignored.
    for (const entry of Object.values(modelPrices.anthropic))
      expect(entry.cachedInput).toBeUndefined();
  });
  it("carries the discounted usage through parseResponse and the provider", async () => {
    const priced = settings("openai", { inputPrice: 0.75, outputPrice: 4.5 });
    const body = {
      output: [
        {
          type: "function_call",
          name: "coarena_action",
          arguments: JSON.stringify(args),
        },
      ],
      usage: openaiUsage,
    };
    expect(parseResponse("openai", body, priced).usage.cost).toBeCloseTo(
      0.0007125,
      12,
    );
    const o: Observation = {
      task: "local task",
      history: [],
      frame: {
        id: "frame",
        image: "data:image/png;base64,YWJj",
        sha256: "sha",
        synthetic: false,
        capturedAt: 0,
        geometry: {
          display_id: 1,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          native_width: 100,
          native_height: 100,
          model_width: 100,
          model_height: 100,
          scale_factor: 1,
        },
      },
    };
    const request = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body)));
    const result = await new HttpProvider(priced, "key", request).next(
      o,
      new AbortController().signal,
    );
    expect(result.action).toEqual(action);
    expect(result.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 50,
      cachedInputTokens: 1500,
      cost: expect.closeTo(0.0007125, 12),
    });
    const google = await new HttpProvider(
      settings("google", { inputPrice: 0.3, outputPrice: 2.5 }),
      "key",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: "coarena_action", args } }],
                },
              },
            ],
            usageMetadata: googleUsage,
          }),
        ),
      ),
    ).next(o, new AbortController().signal);
    expect(google.usage.cost).toBeCloseTo(0.00032, 12);
  });
});

describe("model prices", () => {
  const cloud = providerSchema.options.filter(
    (provider) => provider !== "ollama" && provider !== "compatible",
  );
  it("prices a chosen model at its own rate, not the provider default's", () => {
    const chosen = selectProvider(defaultSettings, "openai", "gpt-5.4");
    expect(chosen).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      inputPrice: 2.5,
      outputPrice: 15,
      privacy: "PRIVATE_BYOM",
    });
    expect(
      selectProvider(defaultSettings, "anthropic", "claude-opus-5"),
    ).toMatchObject({ model: "claude-opus-5", inputPrice: 5, outputPrice: 25 });
    expect(
      selectProvider(defaultSettings, "google", "gemini-3.5-flash"),
    ).toMatchObject({
      model: "gemini-3.5-flash",
      inputPrice: 1.5,
      outputPrice: 9,
    });
    expect(modelPrice("google", "gemini-2.5-flash-lite")).toEqual({
      inputPrice: 0.1,
      outputPrice: 0.4,
    });
    expect(modelPrice("openai", "gpt-unknown")).toBeUndefined();
    // A dated snapshot and its alias are the same model at the same rate.
    expect(modelPrice("anthropic", "claude-sonnet-4-5-20250929")).toEqual(
      modelPrice("anthropic", "claude-sonnet-4-5"),
    );
  });
  it("finds only the table's own ids, never an inherited property", () => {
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(modelPrice("openai", name), name).toBeUndefined();
      expect(
        selectProvider(defaultSettings, "openai", name),
        name,
      ).toMatchObject({ model: name, inputPrice: 0, outputPrice: 0 });
    }
  });
  it("keeps the two-argument form exactly as it was", () => {
    for (const provider of providerSchema.options) {
      const selected = selectProvider(defaultSettings, provider);
      expect(selected, provider).toMatchObject({
        provider,
        ...providerDefaults[provider],
      });
      // Passing the default model by name changes nothing either.
      expect(
        selectProvider(
          defaultSettings,
          provider,
          providerDefaults[provider].model,
        ),
      ).toEqual(selected);
    }
  });
  it("refuses to price an unknown model at another model's rate", () => {
    const unknown = selectProvider(defaultSettings, "openai", "gpt-unknown");
    expect(unknown.model).toBe("gpt-unknown");
    expect(unknown.inputPrice).toBe(0);
    expect(unknown.outputPrice).toBe(0);
    // The provider then fails closed instead of running with a wrong bill.
    expect(
      () => new HttpProvider(settingsSchema.parse(unknown), "key", fetch),
    ).toThrow(/token rates/);
    // Local models are free whatever their name.
    expect(
      selectProvider(defaultSettings, "ollama", "anything:7b"),
    ).toMatchObject({ model: "anything:7b", inputPrice: 0, outputPrice: 0 });
  });
  it("prices every provider default from the same table", () => {
    for (const provider of cloud) {
      const defaults = providerDefaults[provider];
      expect(modelPrice(provider, defaults.model), provider).toEqual({
        inputPrice: defaults.inputPrice,
        outputPrice: defaults.outputPrice,
      });
    }
  });
  it("holds only exact model ids with positive standard rates", () => {
    for (const provider of cloud) {
      const entries = Object.entries(modelPrices[provider]);
      expect(entries.length, provider).toBeGreaterThan(0);
      for (const [model, prices] of entries) {
        expect(model, provider).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
        expect(prices.inputPrice, model).toBeGreaterThan(0);
        expect(prices.outputPrice, model).toBeGreaterThan(prices.inputPrice);
        expect(
          settingsSchema.safeParse(
            selectProvider(defaultSettings, provider, model),
          ).success,
          model,
        ).toBe(true);
      }
    }
    expect(modelPrices.ollama).toEqual({});
    expect(modelPrices.compatible).toEqual({});
  });
  it("switches to an announced rate on its date", () => {
    // Google's list: Gemini 3.6-3.8 Flash at $0.75/$3.75 through 2026-12-31,
    // $1.50/$7.50 from 2027-01-01. Kept at the launch rate, a cap on one of
    // them would allow twice the intended spend from that day on.
    const before = new Date("2026-12-31T23:59:59.999Z");
    const after = new Date("2027-01-01T00:00:00.000Z");
    for (const model of [
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
    ]) {
      expect(modelPrice("google", model, before), model).toEqual({
        inputPrice: 0.75,
        outputPrice: 3.75,
      });
      expect(modelPrice("google", model, after), model).toEqual({
        inputPrice: 1.5,
        outputPrice: 7.5,
      });
      expect(cachedInputShare("google", model), model).toBe(0.1);
    }
    expect(modelPrice("google", "gemini-3.5-flash", after)).toEqual({
      inputPrice: 1.5,
      outputPrice: 9,
    });
    // selectProvider reads the clock, so a cell set up after the change is
    // priced at the new rate.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(after);
      expect(
        selectProvider(defaultSettings, "google", "gemini-3.8-flash"),
      ).toMatchObject({ inputPrice: 1.5, outputPrice: 7.5 });
      vi.setSystemTime(before);
      expect(
        selectProvider(defaultSettings, "google", "gemini-3.8-flash"),
      ).toMatchObject({ inputPrice: 0.75, outputPrice: 3.75 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("holds only announced rises, each with a real date", () => {
    // The switch is at 00:00 UTC, before the vendor's own midnight: early for
    // a rise errs high, but early for a cut would understate the bill.
    for (const provider of cloud)
      for (const [model, entry] of Object.entries(modelPrices[provider])) {
        if (!entry.change) continue;
        expect(entry.change.from, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Date.parse(`${entry.change.from}T00:00:00Z`), model).not.toBe(
          NaN,
        );
        expect(entry.change.inputPrice, model).toBeGreaterThanOrEqual(
          entry.inputPrice,
        );
        expect(entry.change.outputPrice, model).toBeGreaterThanOrEqual(
          entry.outputPrice,
        );
      }
  });
});

describe("scripts price the model they run", () => {
  /*
   * bench.mjs, live-task.mjs and the cycle runner check their cost caps
   * against the rates in the settings they build. A model set after
   * selectProvider keeps the provider default's rates: gpt-5.5 would be
   * charged as gpt-5.4-mini, a sixth or so of its bill, so a $8 cap would
   * let about $53 through. These scripts drive a paid model and are never
   * run by a test, so the rule reads their source.
   */
  const scripts = readdirSync(join(root, "scripts")).filter((file) =>
    file.endsWith(".mjs"),
  );
  /** Top-level arguments of each selectProvider(...) call in a source. */
  const callsIn = (source: string) =>
    [...source.matchAll(/\bselectProvider\(/g)].map((match) => {
      let depth = 1,
        args = 1,
        i = match.index! + match[0].length,
        last = "";
      for (; depth > 0 && i < source.length; i++) {
        const c = source[i];
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (c === "," && depth === 1) args++;
        if (depth > 0 && !/\s/.test(c)) last = c;
      }
      // A trailing comma before the closing parenthesis is not an argument.
      return last === "," ? args - 1 : args;
    });
  it("passes the model to selectProvider wherever a script picks one", () => {
    const checked: string[] = [];
    for (const file of scripts) {
      const source = readFileSync(join(root, "scripts", file), "utf8");
      const calls = callsIn(source);
      if (!calls.length) continue;
      checked.push(file);
      // provider-smoke.mjs runs each provider's default model and takes no
      // model choice, so two arguments price it correctly.
      if (file === "provider-smoke.mjs") {
        expect(source).not.toMatch(/--model|\bmodel:\s*\{\s*type/);
        continue;
      }
      for (const count of calls) expect(count, file).toBe(3);
    }
    expect(checked).toEqual(
      expect.arrayContaining(["bench.mjs", "live-task.mjs"]),
    );
  });
  it("counts arguments the way the rule needs", () => {
    expect(callsIn("selectProvider(a, b)")).toEqual([2]);
    expect(callsIn("selectProvider(a, f(b, c), d)")).toEqual([3]);
    expect(callsIn("selectProvider(\n  a,\n  b,\n  c,\n)")).toEqual([3]);
    expect(callsIn("x.selectProvider(a, { b, c })")).toEqual([2]);
  });
  it("gives a --model override or a matrix cell its own rates, and refuses an unpriced one", () => {
    // What the scripts build, for a model other than the provider default.
    const cell = settingsSchema.parse({
      ...selectProvider(defaultSettings, "openai", "gpt-5.5"),
      memory: false,
    });
    expect(cell).toMatchObject({
      model: "gpt-5.5",
      ...modelPrice("openai", "gpt-5.5"),
    });
    expect(cell.inputPrice).toBe(5);
    expect(cell.outputPrice).toBe(30);
    expect(
      settingsSchema.parse(
        selectProvider(defaultSettings, "anthropic", "claude-fable-5-1"),
      ),
    ).toMatchObject({ inputPrice: 10, outputPrice: 50 });
    // No --model: the provider default, as before.
    expect(selectProvider(defaultSettings, "openai", undefined)).toEqual(
      selectProvider(defaultSettings, "openai"),
    );
    // A model the catalog does not price fails at setup, before any gate.
    expect(
      () =>
        new HttpProvider(
          settingsSchema.parse(
            selectProvider(defaultSettings, "openai", "gpt-4o"),
          ),
          "key",
          fetch,
        ),
    ).toThrow(/token rates/);
  });
});
