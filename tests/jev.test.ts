import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIALOG_SYSTEM } from "../src/assistant/prompt";
import { DIALOG_ACTS } from "../src/assistant/protocol";
import { jevStartCandidate } from "../src/assistant/arbitrate";
import {
  defaultSettings,
  settingsSchema,
  type Settings,
} from "../src/core/schema";
import { selectProvider } from "../src/providers/catalog";
import {
  APP_DIALOG_VARIANT,
  DECISIONS_ENDPOINT,
  JEV_ACT_QUESTION_ID,
  JEV_CREDENTIAL_SCOPE,
  JEV_KEY_ENV,
  JEV_MODEL,
  JEV_PROVIDER,
  JEV_SERVED_MODEL,
  JEV_START_MAX_CHARS,
  JEV_START_MIN_P,
  JEV_TIMEOUT_MS,
  decisionsRequest,
  dialogActQuestion,
  estimateCost,
  jevStartWords,
  jevState,
} from "../src/providers/jev";
import {
  importEnvCredentials,
  jevKey,
  providerKey,
  withJevKey,
  withProviderKey,
} from "../electron/credentials";
import {
  JEV_ACT_QUESTION,
  askJevAct,
  jevEnabled,
  jevSettingsToSave,
  type JevVerdict,
} from "../electron/jev";
import { jevHint, jevKeyField, jevKeyToSave } from "../src/ui/settings-voice";

const KEY = "sk-or-v1-TESTKEY-0123456789abcdef";
const question = dialogActQuestion(
  APP_DIALOG_VARIANT,
  DIALOG_SYSTEM,
  DIALOG_ACTS,
);
const start = (text: string) =>
  ({ kind: "start", text, taskSource: "user_words" }) as const;

/** A 200 from TypeSafe on the pinned build, unless a field says otherwise. */
function served(
  o: {
    act?: string;
    p?: number;
    provider?: string | null;
    model?: string | null;
    usage?: Record<string, number> | null;
    answers?: unknown;
  } = {},
) {
  const act = o.act ?? "start";
  const p = o.p ?? 0.97;
  const probabilities = Object.fromEntries(DIALOG_ACTS.map((a) => [a, 0]));
  if (act in probabilities) probabilities[act] = p;
  return {
    ...(o.model === null ? {} : { model: o.model ?? JEV_SERVED_MODEL }),
    ...(o.provider === null ? {} : { provider: o.provider ?? JEV_PROVIDER }),
    answers:
      o.answers !== undefined
        ? o.answers
        : {
            [JEV_ACT_QUESTION_ID]: {
              type: "choice",
              choice: act,
              probabilities,
              confidence: p,
            },
          },
    ...(o.usage === null
      ? {}
      : {
          usage: o.usage ?? {
            input_tokens: 900,
            output_tokens: 32,
            cost: 0.00004,
          },
        }),
    id: "gen-dec-1",
  };
}
type Reply =
  | { body: unknown; status?: number; header?: string | null; delayMs?: number }
  | { never: true }
  | { throws: true };
/** A fetch that serves the Decisions endpoint from `reply`, recording the request. */
function fakeFetch(reply: Reply) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(init.body as string) });
    if ("throws" in reply) throw new TypeError("fetch failed");
    const signal = init.signal!;
    if ("never" in reply)
      return new Promise<Response>((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        ),
      );
    if (reply.delayMs)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    const headers: Record<string, string> =
      reply.header === null
        ? {}
        : { "x-provider-name": reply.header ?? JEV_PROVIDER };
    return new Response(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
      { status: reply.status ?? 200, headers },
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const state = {
  channel: "voice",
  user: "add a meeting with dana at six pm tomorrow",
  turns: [],
};

describe("jev: the words a verdict may start", () => {
  it("wants at least three content words, no deictic word and a short request", () => {
    expect(jevStartWords("add a meeting with dana at six pm tomorrow")).toBe(
      true,
    );
    expect(jevStartWords("email the q3 deck to dana")).toBe(true);
    expect(jevStartWords("open spotify")).toBe(false);
    expect(jevStartWords("")).toBe(false);
    for (const key of [
      "do it",
      "do that",
      "do this",
      "same again",
      "send it to dana",
      "send that to her",
      "open this one",
      "put them in the folder",
      "email him the deck",
      "open the one over there",
    ])
      expect(jevStartWords(key), key).toBe(false);
    // Function words alone are not content.
    expect(jevStartWords("can you please go ahead and let us")).toBe(false);
    const long = "email dana about the plan " + "x".repeat(JEV_START_MAX_CHARS);
    expect(jevStartWords("email dana about the plan", long)).toBe(false);
  });

  it("jevStartCandidate adds the fast-start guards: a start plan, no question, no back-reference", () => {
    const text = "add a meeting with dana at six pm tomorrow";
    expect(jevStartCandidate(start(text), text)).toBe(true);
    // Typed with punctuation and a leading please: still the same words.
    expect(jevStartCandidate(start(text), `Please ${text}.`)).toBe(true);
    for (const t of [
      "is spotify open right now",
      "what's on my calendar tomorrow",
      "add a meeting with dana tomorrow?",
      "can you tell me the weather",
      "send that to dana please",
      "do it again for dana",
      "email the same to dana",
      "send them the deck now",
      "open spotify",
      "open this one now",
    ])
      expect(jevStartCandidate(start(t), t), t).toBe(false);
    expect(jevStartCandidate({ kind: "revise", text }, text)).toBe(false);
    expect(jevStartCandidate({ kind: "replace", text }, text)).toBe(false);
    expect(jevStartCandidate({ kind: "queue", text }, text)).toBe(false);
    expect(jevStartCandidate({ kind: "status" }, text)).toBe(false);
  });

  it("never offers words that only point at something else, even as a start plan", () => {
    // The router asks about these, and Jev's own word filter refuses them
    // too; the classifier is checked here as well so the two layers can
    // never drift apart silently.
    for (const t of [
      "go ahead and accept the invite from them",
      "yeah pick the second option on the screen",
      "sure send it to them right now please",
      "reply yes to the message from them",
    ])
      expect(jevStartCandidate(start(t), t), t).toBe(false);
    // An ordinary task still qualifies.
    const t = "print the boarding pass for the denver flight";
    expect(jevStartCandidate(start(t), t)).toBe(true);
  });

  it("never offers a report frame: an imperative that asks for an answer in words", () => {
    // Live Jev (2026-09-18) answered both with a confident start; the text
    // model answers them in words, so they must wait for it.
    for (const t of [
      "tell me whether the invoice from acme was paid",
      "tell me whether the denver deck is finished",
      "tell me if the invoice from acme was paid",
      "let me know if the denver deck is ready",
      "let me know whether dana replied about the deck",
      "can you tell me what time the standup is today",
      "please tell me how to export the deck as a pdf",
      "say whether the nightly build passed",
      "report if the tests failed on main",
      "Tell me when the next train to denver leaves.",
    ])
      expect(jevStartCandidate(start(t), t), t).toBe(false);
    // A report verb that names a task, not a question, still qualifies.
    for (const t of [
      "tell dana the meeting moved to six",
      "say hello to dana in messages",
      "let dana know the deck is ready",
    ])
      expect(jevStartCandidate(start(t), t), t).toBe(true);
  });

  it("builds the act question once, at load, from the real prompt", () => {
    expect(JEV_ACT_QUESTION).toEqual(question);
  });

  it("asks the wording the eval measured best, over the prompt's own act lines", () => {
    expect(APP_DIALOG_VARIANT).toBe("original");
    expect(Object.keys(question.criteria).sort()).toEqual(
      [...DIALOG_ACTS].sort(),
    );
    expect(question.criteria.start).not.toMatch(/\bTASK\b/);
    expect(JEV_START_MIN_P).toBe(0.85);
    expect(JEV_TIMEOUT_MS).toBe(600);
    expect(jevState('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("jev: one call through OpenRouter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the pinned model with ZDR forced, the key only in the header, and reads a start", async () => {
    const f = fakeFetch({ body: served({ act: "start", p: 0.93 }) });
    const verdict = await askJevAct({
      fetch: f.fetch,
      key: KEY,
      state,
      question,
    });
    expect(verdict).toEqual({
      ok: true,
      act: "start",
      p: 0.93,
      confidence: 0.93,
      ms: expect.any(Number),
      cost: 0.00004,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(DECISIONS_ENDPOINT);
    expect(f.calls[0].init.method).toBe("POST");
    expect(
      (f.calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${KEY}`);
    expect(f.calls[0].body).toEqual({
      model: JEV_MODEL,
      state,
      questions: { [JEV_ACT_QUESTION_ID]: question },
      provider: { zdr: true, data_collection: "deny", allow_fallbacks: false },
    });
    expect(JSON.stringify(f.calls[0].body)).not.toContain(KEY);
    expect(JSON.stringify(verdict)).not.toContain(KEY);
  });

  it("discards an answer from another provider, a missing header or another build", async () => {
    const cases: [Reply, string][] = [
      [{ body: served({ provider: "OpenAI" }) }, "wrong_provider"],
      [{ body: served({ provider: null }) }, "wrong_provider"],
      [{ body: served(), header: "OpenAI" }, "wrong_provider"],
      [{ body: served(), header: null }, "wrong_provider"],
      [
        { body: served({ model: "typesafe/jev-1.14-20261001" }) },
        "wrong_model",
      ],
      [{ body: served({ model: null }) }, "wrong_model"],
      [{ body: served({ answers: {} }) }, "no_answer"],
      [{ body: served({ act: "launch" }) }, "bad_choice"],
      [
        { body: served({ answers: { act: { type: "noul", noul: 0.9 } } }) },
        "bad_type",
      ],
      [{ body: "<html>bad gateway</html>", status: 200 }, "bad_body"],
      [
        {
          body: { error: { message: "rate limited", code: 429 } },
          status: 429,
        },
        "http_429",
      ],
      [{ body: "upstream", status: 502 }, "http_502"],
      [{ throws: true }, "network"],
    ];
    for (const [reply, code] of cases) {
      const f = fakeFetch(reply);
      const verdict = await askJevAct({
        fetch: f.fetch,
        key: KEY,
        state,
        question,
      });
      expect(verdict, code).toMatchObject({ ok: false, code });
      // Never a retry on the hot path, whatever failed.
      expect(f.fetch, code).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up at the hard timeout, honours the caller's abort, and never runs without a key", async () => {
    const f = fakeFetch({ never: true });
    const pending = askJevAct({ fetch: f.fetch, key: KEY, state, question });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS - 1);
    let settled: JevVerdict | undefined;
    void pending.then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toMatchObject({ ok: false, code: "timeout" });
    expect(f.calls[0].init.signal!.aborted).toBe(true);
    // A slow answer past the deadline is a timeout too, not a late start.
    const slow = fakeFetch({ body: served(), delayMs: JEV_TIMEOUT_MS + 50 });
    const late = askJevAct({ fetch: slow.fetch, key: KEY, state, question });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 100);
    expect(await late).toMatchObject({ ok: false, code: "timeout" });
    const controller = new AbortController();
    const g = fakeFetch({ never: true });
    const cancelled = askJevAct({
      fetch: g.fetch,
      key: KEY,
      state,
      question,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(await cancelled).toMatchObject({ ok: false, code: "cancelled" });
    const h = fakeFetch({ body: served() });
    expect(
      await askJevAct({ fetch: h.fetch, key: "  ", state, question }),
    ).toEqual({
      ok: false,
      code: "no_key",
      ms: 0,
      cost: 0,
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("charges what the response says it cost, or the pessimistic estimate when it does not say", async () => {
    const request = decisionsRequest(state, {
      [JEV_ACT_QUESTION_ID]: question,
    });
    const estimate = estimateCost(request);
    expect(estimate).toBeGreaterThan(0);
    const billed = fakeFetch({
      body: served({
        usage: { input_tokens: 900, output_tokens: 32, cost: 0.00005 },
      }),
    });
    expect(
      (await askJevAct({ fetch: billed.fetch, key: KEY, state, question }))
        .cost,
    ).toBe(0.00005);
    const listPrice = fakeFetch({
      body: served({ usage: { input_tokens: 1_000_000 } }),
    });
    expect(
      (await askJevAct({ fetch: listPrice.fetch, key: KEY, state, question }))
        .cost,
    ).toBeCloseTo(0.042, 6);
    const unpriced = fakeFetch({ body: served({ usage: null }) });
    expect(
      (await askJevAct({ fetch: unpriced.fetch, key: KEY, state, question }))
        .cost,
    ).toBe(estimate);
    const failed = fakeFetch({ body: "nope", status: 500 });
    expect(
      (await askJevAct({ fetch: failed.fetch, key: KEY, state, question }))
        .cost,
    ).toBe(estimate);
    const never = fakeFetch({ never: true });
    const pending = askJevAct({
      fetch: never.fetch,
      key: KEY,
      state,
      question,
    });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 1);
    expect((await pending).cost).toBe(estimate);
  });
});

describe("jev: the key and the setting", () => {
  const roots: string[] = [];
  afterEach(() =>
    roots
      .splice(0)
      .forEach((root) => rmSync(root, { recursive: true, force: true })),
  );
  const envFile = (content: string) => {
    const root = mkdtempSync(join(tmpdir(), "open-assist-jev-"));
    roots.push(root);
    const file = join(root, ".env");
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  };
  const byom: Settings = {
    ...selectProvider(defaultSettings, "openai"),
    decisions: "jev",
  };

  it("keeps the OpenRouter key in its own vault slot, apart from every provider key", () => {
    const openai = selectProvider(defaultSettings, "openai");
    let keys = withProviderKey({}, openai, "provider-key");
    keys = withJevKey(keys, ` ${KEY} `);
    expect(jevKey(keys)).toBe(KEY);
    expect(keys[JEV_CREDENTIAL_SCOPE]).toBe(KEY);
    expect(providerKey(keys, openai)).toBe("provider-key");
    expect(
      providerKey(keys, {
        provider: "compatible",
        endpoint: "https://openrouter.ai/api/v1",
      }),
    ).toBe("");
    expect(jevKey(withJevKey(keys, ""))).toBe("");
    expect(providerKey(withJevKey(keys, ""), openai)).toBe("provider-key");
    expect(jevKey({})).toBe("");
  });

  it("imports OPENROUTER_API_KEY from a .env on a debug launch, like the provider keys", () => {
    expect(JEV_KEY_ENV).toEqual(["OPENROUTER_API_KEY"]);
    const keys = importEnvCredentials(
      envFile(`OPENAI_API_KEY=test-openai\nOPENROUTER_API_KEY="${KEY}"\n`),
      {},
    );
    expect(jevKey(keys)).toBe(KEY);
    expect(providerKey(keys, selectProvider(defaultSettings, "openai"))).toBe(
      "test-openai",
    );
    expect(Object.keys(keys)).toHaveLength(2);
    // The OpenRouter key alone is an import too.
    expect(
      jevKey(importEnvCredentials(envFile(`OPENROUTER_API_KEY=${KEY}`), {})),
    ).toBe(KEY);
    expect(() => importEnvCredentials(envFile("OTHER=1"), {})).toThrow(
      "Could not import",
    );
  });

  it("refuses to enable the decider without a key and forces it off in local mode", () => {
    expect(() => jevSettingsToSave(byom, {})).toThrow("OpenRouter");
    const keys = withJevKey({}, KEY);
    expect(jevSettingsToSave(byom, keys)).toEqual(byom);
    expect(jevSettingsToSave({ ...byom, decisions: "off" }, {})).toEqual({
      ...byom,
      decisions: "off",
    });
    const local: Settings = {
      ...defaultSettings,
      decisions: "jev",
      dialogModel: "qwen3:8b",
    };
    expect(jevSettingsToSave(local, keys).decisions).toBe("off");
    expect(jevEnabled(byom, KEY)).toBe(true);
    expect(jevEnabled(byom, " ")).toBe(false);
    expect(jevEnabled({ ...byom, decisions: "off" }, KEY)).toBe(false);
    expect(jevEnabled(local, KEY)).toBe(false);
  });

  it("is off by default, also for a config saved before it existed, and accepts only off or jev", () => {
    expect(defaultSettings.decisions).toBe("off");
    const older: Record<string, unknown> = structuredClone(defaultSettings);
    delete older.decisions;
    expect(settingsSchema.parse(older).decisions).toBe("off");
    expect(
      settingsSchema.safeParse({ ...defaultSettings, decisions: "jev" })
        .success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({ ...defaultSettings, decisions: "always" })
        .success,
    ).toBe(false);
  });

  it("saves the key field only once it was touched, so an emptied field clears the slot", () => {
    // Untouched: the vault keeps whatever it has (undefined leaves the slot).
    expect(jevKeyToSave(false, "")).toBeUndefined();
    expect(jevKeyToSave(false, "typed")).toBeUndefined();
    // Touched and emptied: "" reaches withJevKey, which deletes the slot.
    expect(jevKeyToSave(true, "")).toBe("");
    expect(jevKeyToSave(true, "   ")).toBe("");
    expect(jevKeyToSave(true, ` ${KEY} `)).toBe(KEY);
    // The field: a stored key counts until the user changes the field; an
    // emptied field over a stored key means removal on save.
    expect(jevKeyField({ stored: true, touched: false, typed: "" })).toEqual({
      ready: true,
      removing: false,
      placeholder: "Stored securely",
    });
    expect(jevKeyField({ stored: true, touched: true, typed: "" })).toEqual({
      ready: false,
      removing: true,
      placeholder: "Removed when you save",
    });
    expect(jevKeyField({ stored: true, touched: true, typed: KEY }).ready).toBe(
      true,
    );
    expect(jevKeyField({ stored: false, touched: false, typed: "" })).toEqual({
      ready: false,
      removing: false,
      placeholder: "Your OpenRouter key",
    });
    expect(jevKeyField({ stored: false, touched: true, typed: " " })).toEqual({
      ready: false,
      removing: false,
      placeholder: "Your OpenRouter key",
    });
    expect(
      jevKeyField({ stored: false, touched: true, typed: KEY }).ready,
    ).toBe(true);
    // Removing the key while the decider is on is refused by the save, with
    // the one fixed line, so a toggle can never be "on" over an empty slot.
    expect(() =>
      jevSettingsToSave(byom, withJevKey(withJevKey({}, KEY), "")),
    ).toThrow("OpenRouter API key");
  });

  it("explains the toggle: local mode, a missing key, or what leaves the Mac", () => {
    expect(jevHint(defaultSettings, true)).toMatch(/local mode/);
    expect(jevHint(byom, false)).toMatch(/OpenRouter API key/);
    const on = jevHint(byom, true);
    expect(on).toMatch(/zero data retention/);
    expect(on).toMatch(/never screen text/);
    expect(on).toMatch(/OpenRouter and TypeSafe/);
  });
});
