import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, type Settings } from "../src/core/schema";
import { anthropicCacheRates } from "../src/providers/http";
import { LocalDiagnostics } from "../electron/diagnostics";
import {
  buildTextRequest,
  completeText,
  forgetUnsupportedOptions,
  parseSse,
  streamText,
  TextModelError,
  textLimit,
  textSettings,
  type TextCall,
} from "../src/providers/text";

const providers = [
  "openai",
  "anthropic",
  "google",
  "compatible",
  "ollama",
] as const;
type ProviderKind = (typeof providers)[number];
const configs: Record<ProviderKind, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  compatible: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434",
};
const s = (provider: ProviderKind, model = "test"): Settings => ({
  ...defaultSettings,
  provider,
  privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
  endpoint: configs[provider],
  model,
  inputPrice: 1,
  outputPrice: 2,
});
const key = (provider: ProviderKind) =>
  provider === "ollama" ? "" : "SECRET-KEY";
const call: TextCall = {
  system: "SYSTEM PROMPT",
  input: "USER TEXT",
  maxOutputTokens: 300,
};
const fixtureDir = fileURLToPath(new URL("./fixtures/text/", import.meta.url));
const fixture = (provider: ProviderKind) =>
  readFileSync(
    join(
      fixtureDir,
      provider === "ollama" ? "ollama.ndjson" : `${provider}.sse`,
    ),
    "utf8",
  );
// Every fixture streams the same reply and the same token counts.
const replyText = "ACT answer\nSAY Spotify is open. Anything else?";
const usageFor = (provider: ProviderKind) => ({
  inputTokens: 412,
  outputTokens: 14,
  cost:
    provider === "anthropic"
      ? // 12 uncached + 400 cache reads at the read rate, 14 out at 2/M.
        ((12 + 400 * anthropicCacheRates.read) * 1 + 14 * 2) / 1e6
      : (412 * 1 + 14 * 2) / 1e6,
});

/** A response whose body arrives in the given pieces; `cancelled` notes a release. */
function streamed(
  pieces: (string | (() => Promise<string>))[],
  init: ResponseInit = {},
) {
  const encoder = new TextEncoder();
  const state = { cancelled: false };
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= pieces.length) return controller.close();
        const piece = pieces[index++];
        controller.enqueue(
          encoder.encode(typeof piece === "string" ? piece : await piece()),
        );
      },
      cancel() {
        state.cancelled = true;
      },
    }),
    { status: 200, ...init },
  );
  return { response, state };
}
const chunked = (text: string, size: number) => {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size)
    pieces.push(text.slice(i, i + size));
  return pieces;
};
const sse = (events: { event?: string; data: unknown }[]) =>
  events
    .map(
      (e) =>
        (e.event ? `event: ${e.event}\n` : "") +
        `data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join("");
const ndjson = (lines: unknown[]) =>
  lines.map((line) => JSON.stringify(line) + "\n").join("");
const never = () => new Promise<string>(() => {});
async function collect(
  stream: AsyncGenerator<string, { code: string }>,
): Promise<{
  deltas: string[];
  outcome: Awaited<ReturnType<typeof completeText>> | undefined;
  error?: unknown;
}> {
  const deltas: string[] = [];
  try {
    for (;;) {
      const next = await stream.next();
      if (next.done)
        return {
          deltas,
          outcome: { ...next.value, text: deltas.join("") } as never,
        };
      deltas.push(next.value);
    }
  } catch (error) {
    return { deltas, outcome: undefined, error };
  }
}
const signal = () => new AbortController().signal;

beforeEach(() => forgetUnsupportedOptions());
afterEach(() => vi.useRealTimers());

describe("text request building", () => {
  it("builds each provider's streaming request with no image and no tools", () => {
    for (const provider of providers) {
      const r = buildTextRequest(s(provider), key(provider), call);
      const body = JSON.stringify(r.body);
      expect(body).not.toMatch(/tools|image|input_image|inlineData/);
      expect(body).toContain("SYSTEM PROMPT");
      expect(body).toContain("USER TEXT");
      expect(r.headers["Content-Type"]).toBe("application/json");
    }
    const openai = buildTextRequest(s("openai"), "SECRET-KEY", call);
    expect(openai.url).toBe("https://api.openai.com/v1/responses");
    expect(openai.format).toBe("sse");
    expect(openai.headers.Authorization).toBe("Bearer SECRET-KEY");
    expect(openai.body).toMatchObject({
      stream: true,
      store: false,
      instructions: "SYSTEM PROMPT",
      max_output_tokens: 300,
    });
    expect(openai.body.reasoning).toBeUndefined();
    const anthropic = buildTextRequest(s("anthropic"), "SECRET-KEY", call);
    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropic.headers["x-api-key"]).toBe("SECRET-KEY");
    expect(anthropic.body).toMatchObject({
      stream: true,
      max_tokens: 300,
      system: [
        {
          type: "text",
          text: "SYSTEM PROMPT",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "USER TEXT" }],
    });
    const google = buildTextRequest(
      s("google", "gemini-2.5-flash"),
      "SECRET-KEY",
      call,
    );
    expect(google.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(google.headers["x-goog-api-key"]).toBe("SECRET-KEY");
    expect(google.body.generationConfig).toEqual({ maxOutputTokens: 300 });
    const compatible = buildTextRequest(s("compatible"), "SECRET-KEY", call);
    expect(compatible.url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(compatible.body).toMatchObject({
      stream: true,
      max_tokens: 300,
      stream_options: { include_usage: true },
    });
    const ollama = buildTextRequest(s("ollama"), "", call);
    expect(ollama.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(ollama.format).toBe("ndjson");
    expect(ollama.body).toMatchObject({
      stream: true,
      think: false,
      keep_alive: "10m",
      options: { num_predict: 300 },
    });
    expect(ollama.body.format).toBeUndefined();
  });
  it("sends reasoning effort only to models that take it", () => {
    const effort = { ...call, effort: "none" as const };
    expect(
      buildTextRequest(s("openai", "gpt-5.4-mini"), "k", effort).body.reasoning,
    ).toEqual({ effort: "none" });
    expect(
      buildTextRequest(s("openai", "gpt-4.1"), "k", effort).body.reasoning,
    ).toBeUndefined();
    expect(
      buildTextRequest(s("openai", "gpt-5.4-mini"), "k", call).body.reasoning,
    ).toBeUndefined();
    expect(
      buildTextRequest(s("anthropic", "claude-sonnet-5"), "k", effort).body
        .output_config,
    ).toEqual({ effort: "low" });
    expect(
      buildTextRequest(s("anthropic", "claude-haiku-4-5"), "k", effort).body
        .output_config,
    ).toBeUndefined();
    expect(
      buildTextRequest(s("google"), "k", effort).body.generationConfig
        .thinkingConfig,
    ).toEqual({ thinkingBudget: 0 });
    expect(
      buildTextRequest(s("google"), "k", { ...call, effort: "low" }).body
        .generationConfig.thinkingConfig,
    ).toBeUndefined();
  });
  it("passes a medium effort through to OpenAI and keeps Claude at low", () => {
    // The done audit asks for medium (src/core/done-audit.ts DONE_AUDIT_EFFORT):
    // OpenAI reasoning models take the word as is; the Claude mapping stays
    // at its lowest level; Gemini keeps its default thinking budget.
    const medium = { ...call, effort: "medium" as const };
    expect(
      buildTextRequest(s("openai", "gpt-5.4-mini"), "k", medium).body.reasoning,
    ).toEqual({ effort: "medium" });
    expect(
      buildTextRequest(s("anthropic", "claude-sonnet-5"), "k", medium).body
        .output_config,
    ).toEqual({ effort: "low" });
    expect(
      buildTextRequest(s("google"), "k", medium).body.generationConfig
        .thinkingConfig,
    ).toBeUndefined();
  });
  it("textSettings runs on the dialog model when one is set", () => {
    const base = s("openai", "gpt-5.4");
    expect(textSettings({ ...base, dialogModel: "gpt-5.4-mini" }).model).toBe(
      "gpt-5.4-mini",
    );
    expect(textSettings({ ...base, dialogModel: "" }).model).toBe("gpt-5.4");
    expect(textSettings(base).model).toBe("gpt-5.4");
    expect(textSettings({ ...base, dialogModel: "x" }).provider).toBe("openai");
  });
});

describe("SSE parsing", () => {
  it("splits complete events off a buffer, tolerating CRLF, comments and multi-line data", () => {
    const text =
      ': keep-alive\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: {"x":1}\n\nevent: partial\ndata: half';
    const { events, rest } = parseSse(text);
    expect(events).toEqual([
      { event: "a", data: "1\n2" },
      { event: undefined, data: '{"x":1}' },
    ]);
    expect(rest).toBe("event: partial\ndata: half");
    expect(parseSse(rest + "\n\n").events).toEqual([
      { event: "partial", data: "half" },
    ]);
    // A CR at the end may be half of a CRLF still in flight.
    expect(parseSse("data: x\r").events).toEqual([]);
    expect(parseSse("data: x\r\n\r\n").events).toEqual([
      { event: undefined, data: "x" },
    ]);
    // An event without data lines is not dispatched.
    expect(parseSse("event: ping\n\n").events).toEqual([]);
  });
});

describe("streaming text", () => {
  it("parses each provider's recorded stream at any chunk boundary and reads usage", async () => {
    for (const provider of providers) {
      const text = fixture(provider);
      for (const size of [1, 3, 7, 64, text.length]) {
        const request = vi.fn(
          async () => streamed(chunked(text, size)).response,
        );
        const result = await collect(
          streamText(s(provider), key(provider), call, request, signal()),
        );
        expect(result.error, `${provider} size ${size}`).toBeUndefined();
        expect(result.deltas.join("")).toBe(replyText);
        expect(result.outcome).toMatchObject({
          code: "ok",
          usage: usageFor(provider),
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [url, init] = request.mock.calls[0] as unknown as [
          string,
          RequestInit,
        ];
        expect(url).toBe(
          buildTextRequest(s(provider), key(provider), call).url,
        );
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
    }
  });
  it("completeText joins the stream and keeps the outcome", async () => {
    const request = vi.fn(async () => streamed([fixture("ollama")]).response);
    const result = await completeText(s("ollama"), "", call, request, signal());
    expect(result).toEqual({
      text: replyText,
      code: "ok",
      usage: usageFor("ollama"),
    });
  });
  it("applies the privacy gate before any request", async () => {
    const request = vi.fn();
    for (const settings of [
      { ...s("ollama"), endpoint: "http://10.0.0.5:11434" },
      { ...s("ollama"), model: "qwen/cloud" },
      {
        ...s("ollama"),
        provider: "openai" as const,
        endpoint: "https://api.openai.com",
      },
      { ...s("openai"), endpoint: "http://api.openai.com" },
    ]) {
      const error = await completeText(
        settings,
        "k",
        call,
        request,
        signal(),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(TextModelError);
      expect(error.code).toBe("privacy");
    }
    const noKey = await completeText(
      s("openai"),
      "",
      call,
      request,
      signal(),
    ).catch((e) => e);
    expect(noKey.code).toBe("http_401");
    expect(request).not.toHaveBeenCalled();
  });
  it("maps refusal, truncation and empty replies to outcome codes", async () => {
    const cases: [ProviderKind, string, string][] = [
      [
        "openai",
        sse([
          {
            event: "response.output_text.delta",
            data: { type: "response.output_text.delta", delta: "Partial" },
          },
          {
            event: "response.incomplete",
            data: {
              type: "response.incomplete",
              response: {
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                usage: { input_tokens: 5, output_tokens: 300 },
              },
            },
          },
        ]),
        "truncated",
      ],
      [
        "openai",
        sse([
          {
            event: "response.refusal.delta",
            data: { type: "response.refusal.delta", delta: "I can't" },
          },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "refusal", refusal: "I can't" }],
                  },
                ],
                usage: { input_tokens: 5, output_tokens: 3 },
              },
            },
          },
        ]),
        "refused",
      ],
      [
        "openai",
        sse([
          {
            event: "response.incomplete",
            data: {
              type: "response.incomplete",
              response: {
                status: "incomplete",
                incomplete_details: { reason: "content_filter" },
                usage: { input_tokens: 5, output_tokens: 300 },
              },
            },
          },
        ]),
        "refused",
      ],
      [
        "anthropic",
        sse([
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: { usage: { input_tokens: 5, output_tokens: 1 } },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Partial" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "max_tokens" },
              usage: { output_tokens: 300 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
        "truncated",
      ],
      [
        "anthropic",
        sse([
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: { usage: { input_tokens: 5, output_tokens: 1 } },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "refusal" },
              usage: { output_tokens: 2 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
        "refused",
      ],
      [
        "anthropic",
        sse([
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: { usage: { input_tokens: 5, output_tokens: 1 } },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: "hmm" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
        "empty",
      ],
      [
        "google",
        sse([
          {
            data: {
              candidates: [
                {
                  content: { parts: [{ text: "Partial" }] },
                  finishReason: "MAX_TOKENS",
                },
              ],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 300 },
            },
          },
        ]),
        "truncated",
      ],
      [
        "google",
        sse([
          {
            data: {
              candidates: [
                {
                  content: { parts: [{ text: "Partial" }] },
                  finishReason: "SAFETY",
                },
              ],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
            },
          },
        ]),
        "refused",
      ],
      [
        "google",
        sse([
          {
            data: {
              promptFeedback: { blockReason: "SAFETY" },
              usageMetadata: { promptTokenCount: 5 },
            },
          },
        ]),
        "refused",
      ],
      [
        "google",
        sse([
          {
            data: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "secret reasoning", thought: true }],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 0,
                thoughtsTokenCount: 9,
              },
            },
          },
        ]),
        "empty",
      ],
      [
        "compatible",
        sse([
          {
            data: {
              choices: [{ delta: { content: "Partial" }, finish_reason: null }],
            },
          },
          { data: { choices: [{ delta: {}, finish_reason: "length" }] } },
          { data: "[DONE]" },
        ]),
        "truncated",
      ],
      [
        "compatible",
        sse([
          {
            data: { choices: [{ delta: {}, finish_reason: "content_filter" }] },
          },
          { data: "[DONE]" },
        ]),
        "refused",
      ],
      [
        "compatible",
        sse([
          {
            data: {
              choices: [{ delta: { content: "\n  " }, finish_reason: null }],
            },
          },
          { data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
        ]),
        "empty",
      ],
      [
        "ollama",
        ndjson([
          { message: { role: "assistant", content: "Partial" }, done: false },
          {
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "length",
            prompt_eval_count: 5,
            eval_count: 300,
          },
        ]),
        "truncated",
      ],
      [
        "ollama",
        ndjson([
          {
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 5,
            eval_count: 0,
          },
        ]),
        "empty",
      ],
    ];
    for (const [provider, body, code] of cases) {
      const result = await completeText(
        s(provider),
        key(provider),
        call,
        async () => streamed(chunked(body, 5)).response,
        signal(),
      );
      expect(result.code, `${provider} ${code}`).toBe(code);
      expect(result.text).not.toContain("secret reasoning");
      if (code === "empty") expect(result.text.trim()).toBe("");
    }
    // A truncated reply still counts its usage.
    const cut = await completeText(
      s("ollama"),
      "",
      call,
      async () =>
        streamed([
          ndjson([
            {
              message: { content: "x" },
              done: true,
              done_reason: "length",
              prompt_eval_count: 5,
              eval_count: 300,
            },
          ]),
        ]).response,
      signal(),
    );
    expect(cut.usage).toEqual({
      inputTokens: 5,
      outputTokens: 300,
      cost: (5 + 600) / 1e6,
    });
  });
  it("cuts a runaway reply at the text cap and releases the connection", async () => {
    const piece = sse([
      {
        data: {
          choices: [
            { delta: { content: "x".repeat(1000) }, finish_reason: null },
          ],
        },
      },
    ]);
    const { response, state } = streamed(
      Array.from({ length: (textLimit / 1000) * 2 }, () => piece),
    );
    const result = await collect(
      streamText(s("compatible"), "k", call, async () => response, signal()),
    );
    expect(result.error).toBeUndefined();
    const total = result.deltas.join("").length;
    expect(total).toBeLessThanOrEqual(textLimit);
    expect(total).toBeGreaterThan(textLimit - 1000);
    expect(result.outcome?.code).toBe("truncated");
    expect(state.cancelled).toBe(true);
  });
  it("times out at the deadline before headers and mid-stream", async () => {
    vi.useFakeTimers();
    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    );
    const pending = completeText(
      s("ollama"),
      "",
      call,
      slow as never,
      signal(),
      {
        deadlineMs: 2500,
      },
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2499);
    expect(slow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(error).toBeInstanceOf(TextModelError);
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("2.5 seconds");

    // Mid-stream: the first delta is delivered, then the deadline ends it.
    const { response, state } = streamed([
      ndjson([{ message: { content: "Hello" }, done: false }]),
      never,
    ]);
    const stream = streamText(
      s("ollama"),
      "",
      call,
      async () => response,
      signal(),
    );
    expect((await stream.next()).value).toBe("Hello");
    const rest = stream.next().catch((e) => e);
    await vi.advanceTimersByTimeAsync(6001);
    const late = await rest;
    expect(late).toBeInstanceOf(TextModelError);
    expect(late.code).toBe("timeout");
    expect(state.cancelled).toBe(true);
  });
  it("stops reading when the caller aborts or leaves the loop early", async () => {
    const aborter = new AbortController();
    const first = streamed([
      ndjson([{ message: { content: "Hello" }, done: false }]),
      never,
    ]);
    const stream = streamText(
      s("ollama"),
      "",
      call,
      async () => first.response,
      aborter.signal,
    );
    expect((await stream.next()).value).toBe("Hello");
    const rest = stream.next().catch((e) => e);
    aborter.abort();
    expect((await rest).message).toBe("Cancelled.");
    expect(first.state.cancelled).toBe(true);

    const second = streamed([
      ndjson([{ message: { content: "Hello" }, done: false }]),
      ndjson([{ message: { content: " there" }, done: false }]),
      never,
    ]);
    for await (const delta of streamText(
      s("ollama"),
      "",
      call,
      async () => second.response,
      signal(),
    )) {
      expect(delta).toBe("Hello");
      break;
    }
    expect(second.state.cancelled).toBe(true);

    // An already-aborted signal never sends the request, and is the same
    // quiet cancel as a later abort: "Cancelled.", not an error code, and a
    // TextFailed trace that says so.
    const request = vi.fn();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    aborter.abort();
    const early = await completeText(
      s("ollama"),
      "",
      call,
      request,
      aborter.signal,
      { diagnostics: (event, data = {}) => events.push({ event, data }) },
    ).catch((e) => e);
    expect(early).toBeInstanceOf(Error);
    expect(early).not.toBeInstanceOf(TextModelError);
    expect(early.message).toBe("Cancelled.");
    expect(request).not.toHaveBeenCalled();
    expect(events.map((e) => e.event)).toEqual(["TextFailed"]);
    expect(events[0].data).toMatchObject({ cancelled: true, timedOut: false });
  });
  it("never retries in turn mode and retries once before headers in side calls", async () => {
    vi.useFakeTimers();
    const ok = () => streamed([fixture("compatible")]).response;
    const flaky = () =>
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 503 }))
        .mockImplementationOnce(async () => ok());
    let request = flaky();
    const turn = await completeText(
      s("compatible"),
      "k",
      call,
      request,
      signal(),
    ).catch((e) => e);
    expect(turn).toBeInstanceOf(TextModelError);
    expect(turn.code).toBe("http_503");
    expect(request).toHaveBeenCalledTimes(1);

    request = flaky();
    const side = completeText(s("compatible"), "k", call, request, signal(), {
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect((await side).text).toBe(replyText);
    expect(request).toHaveBeenCalledTimes(2);

    // A second failure is not retried again.
    request = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockImplementationOnce(async () => ok());
    const twice = completeText(s("compatible"), "k", call, request, signal(), {
      retry: true,
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect((await twice).code).toBe("http_502");
    expect(request).toHaveBeenCalledTimes(2);

    // Transport interruptions retry the same way; unknown hosts do not.
    request = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed SECRET", { cause: { code: "ECONNRESET" } }),
      )
      .mockImplementationOnce(async () => ok());
    const reset = completeText(s("compatible"), "k", call, request, signal(), {
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect((await reset).text).toBe(replyText);
    request = vi
      .fn()
      .mockRejectedValue(
        new TypeError("fetch failed SECRET", { cause: { code: "ENOTFOUND" } }),
      );
    const dns = await completeText(
      s("compatible"),
      "k",
      call,
      request,
      signal(),
      { retry: true },
    ).catch((e) => e);
    expect(dns.code).toBe("network");
    expect(dns.message).not.toContain("SECRET");
    expect(request).toHaveBeenCalledTimes(1);

    // A Retry-After hint that cannot fit before the deadline is not waited for.
    request = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "Retry-After": "10" } }),
      );
    const hinted = await completeText(
      s("compatible"),
      "k",
      call,
      request,
      signal(),
      { retry: true },
    ).catch((e) => e);
    expect(hinted.code).toBe("http_429");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("maps quota exhaustion and other HTTP failures to codes without the body", async () => {
    const quota = await completeText(
      s("openai", "gpt-5.4-mini"),
      "k",
      call,
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "insufficient_quota", message: "SECRET" },
          }),
          { status: 429 },
        ),
      signal(),
      { retry: true },
    ).catch((e) => e);
    expect(quota.code).toBe("quota");
    expect(quota.message).not.toContain("SECRET");
    for (const status of [401, 404, 422]) {
      const error = await completeText(
        s("openai"),
        "k",
        call,
        async () => new Response("SECRET_TOKEN body", { status }),
        signal(),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(TextModelError);
      expect(error.code).toBe(`http_${status}`);
      expect(error.message).not.toContain("SECRET");
    }
  });
  it("drops an option the provider rejects once, and remembers it for the model", async () => {
    const bodies: Record<string, unknown>[] = [];
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      return body.reasoning
        ? new Response('{"error":{"message":"SECRET unsupported"}}', {
            status: 400,
          })
        : streamed([fixture("openai")]).response;
    });
    const settings = s("openai", "gpt-5.4-mini");
    const effort = { ...call, effort: "none" as const };
    const first = await completeText(
      settings,
      "k",
      effort,
      request as never,
      signal(),
    );
    expect(first.text).toBe(replyText);
    expect(bodies.map((b) => "reasoning" in b)).toEqual([true, false]);

    // Remembered: the next call for this model skips the option outright.
    await completeText(settings, "k", effort, request as never, signal());
    expect(bodies.length).toBe(3);
    expect(bodies[2].reasoning).toBeUndefined();
    // Another model still gets it (and, here, loses it the same way).
    await completeText(
      s("openai", "gpt-5.4"),
      "k",
      effort,
      request as never,
      signal(),
    );
    expect(bodies.slice(3).map((b) => "reasoning" in b)).toEqual([true, false]);
    forgetUnsupportedOptions();
    await completeText(settings, "k", effort, request as never, signal());
    expect(bodies.slice(5).map((b) => "reasoning" in b)).toEqual([true, false]);

    // Ollama's think flag is dropped the same way.
    const thinks: unknown[] = [];
    const ollama = await completeText(
      s("ollama"),
      "",
      call,
      async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        thinks.push(body.think);
        return body.think === false
          ? new Response('{"error":"does not support thinking"}', {
              status: 400,
            })
          : streamed([fixture("ollama")]).response;
      },
      signal(),
    );
    expect(ollama.text).toBe(replyText);
    expect(thinks).toEqual([false, undefined]);

    // A 400 with nothing optional to drop, or a second 400, is the error.
    const plain = await completeText(
      s("openai", "gpt-4.1"),
      "k",
      call,
      async () => new Response("SECRET", { status: 400 }),
      signal(),
    ).catch((e) => e);
    expect(plain.code).toBe("http_400");
    forgetUnsupportedOptions();
    const stubborn = vi.fn(async () => new Response("SECRET", { status: 400 }));
    const twice = await completeText(
      settings,
      "k",
      effort,
      stubborn,
      signal(),
    ).catch((e) => e);
    expect(twice.code).toBe("http_400");
    expect(stubborn).toHaveBeenCalledTimes(2);
    // The retry without the option was rejected too, so the option was not
    // the cause and is not remembered: the next call sends it again rather
    // than running every later turn at the model's default effort.
    const again = await completeText(
      settings,
      "k",
      effort,
      stubborn,
      signal(),
    ).catch((e) => e);
    expect(again.code).toBe("http_400");
    expect(stubborn).toHaveBeenCalledTimes(4);
    const sent = stubborn.mock.calls.map(
      (c: unknown[]) =>
        "reasoning" in JSON.parse((c[1] as RequestInit).body as string),
    );
    expect(sent).toEqual([true, false, true, false]);
    // Once a request without the option gets a different answer, even a
    // failure, the option is remembered and skipped from the first attempt.
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(new Response("SECRET", { status: 400 }))
      .mockResolvedValueOnce(new Response("SECRET", { status: 500 }))
      .mockImplementation(async () => streamed([fixture("openai")]).response);
    expect(
      (
        await completeText(settings, "k", effort, flaky, signal()).catch(
          (e) => e,
        )
      ).code,
    ).toBe("http_500");
    expect(
      (await completeText(settings, "k", effort, flaky, signal())).text,
    ).toBe(replyText);
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(
      "reasoning" in
        JSON.parse((flaky.mock.calls[2][1] as RequestInit).body as string),
    ).toBe(false);
  });
  it("reports a stream that closes early or breaks as a transport or parse error", async () => {
    const early = await collect(
      streamText(
        s("openai"),
        "k",
        call,
        async () =>
          streamed([
            sse([
              {
                event: "response.output_text.delta",
                data: { type: "response.output_text.delta", delta: "Hello" },
              },
            ]),
          ]).response,
        signal(),
      ),
    );
    expect(early.deltas).toEqual(["Hello"]);
    expect((early.error as TextModelError).code).toBe("network");

    // A connection that drops while the body is being read is a network
    // failure with the transport's code, not a malformed stream; a body that
    // breaks for no recognised reason stays a parse error.
    const breaking = (failure: Error) => {
      const encoder = new TextEncoder();
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return controller.error(failure);
            sent = true;
            controller.enqueue(
              encoder.encode(
                sse([
                  {
                    event: "response.output_text.delta",
                    data: {
                      type: "response.output_text.delta",
                      delta: "Hello",
                    },
                  },
                ]),
              ),
            );
          },
        }),
        { status: 200 },
      );
    };
    const reset = await collect(
      streamText(
        s("openai"),
        "k",
        call,
        async () =>
          breaking(
            new TypeError("terminated SECRET", {
              cause: { code: "ECONNRESET", message: "read SECRET" },
            }),
          ),
        signal(),
      ),
    );
    expect(reset.deltas).toEqual(["Hello"]);
    expect((reset.error as TextModelError).code).toBe("network");
    expect((reset.error as TextModelError).message).toContain("ECONNRESET");
    expect((reset.error as TextModelError).message).not.toContain("SECRET");
    const broken = await collect(
      streamText(
        s("openai"),
        "k",
        call,
        async () => breaking(new Error("boom SECRET")),
        signal(),
      ),
    );
    expect((broken.error as TextModelError).code).toBe("parse");
    expect((broken.error as TextModelError).message).not.toContain("SECRET");

    const cases: [ProviderKind, string][] = [
      ["openai", "data: not json\n\n"],
      [
        "openai",
        sse([{ event: "error", data: { type: "error", message: "SECRET" } }]),
      ],
      [
        "anthropic",
        sse([
          {
            event: "error",
            data: { type: "error", error: { message: "SECRET" } },
          },
        ]),
      ],
      ["google", sse([{ data: { error: { message: "SECRET" } } }])],
      ["compatible", sse([{ data: { error: { message: "SECRET" } } }])],
      ["ollama", ndjson([{ error: "SECRET model not found" }])],
      ["ollama", "{broken\n"],
    ];
    for (const [provider, body] of cases) {
      const error = await completeText(
        s(provider),
        key(provider),
        call,
        async () => streamed([body]).response,
        signal(),
      ).catch((e) => e);
      expect(error, `${provider}: ${body.slice(0, 20)}`).toBeInstanceOf(
        TextModelError,
      );
      expect(error.code).toBe("parse");
      expect(error.message).not.toContain("SECRET");
    }
  });
  it("traces timings, sizes and codes but never a character of text", async () => {
    vi.useFakeTimers();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const diagnostics = (event: string, data: Record<string, unknown> = {}) =>
      events.push({ event, data });
    const { response } = streamed([
      ndjson([{ message: { content: "ACT answer" }, done: false }]),
      async () => {
        await vi.advanceTimersByTimeAsync(0);
        return ndjson([
          {
            message: { content: "\nSAY Spotify is open." },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 412,
            eval_count: 9,
          },
        ]);
      },
    ]);
    const result = await completeText(
      s("ollama"),
      "",
      call,
      async () => response,
      signal(),
      { diagnostics },
    );
    expect(result.code).toBe("ok");
    const serialized = JSON.stringify(events);
    for (const secret of [
      "SYSTEM PROMPT",
      "USER TEXT",
      "Spotify",
      "ACT answer",
    ])
      expect(serialized).not.toContain(secret);
    expect(events.map((e) => e.event)).toEqual([
      "TextAttempt",
      "TextHeaders",
      "TextResponse",
    ]);
    const done = events[2].data;
    expect(done).toMatchObject({
      provider: "ollama",
      model: "test",
      httpStatus: 200,
      code: "ok",
      textLength: result.text.length,
      usage: { inputTokens: 412, outputTokens: 9 },
    });
    expect(typeof done.ttftMs).toBe("number");
    expect(typeof done.durationMs).toBe("number");
    expect(typeof done.bytes).toBe("number");
    expect(typeof done.requestId).toBe("string");

    events.length = 0;
    const pending = completeText(
      s("ollama"),
      "",
      call,
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
      signal(),
      { diagnostics, deadlineMs: 1000 },
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).code).toBe("timeout");
    expect(events.at(-1)).toMatchObject({
      event: "TextFailed",
      data: { timedOut: true, cancelled: false, name: "TextModelError" },
    });
    expect(JSON.stringify(events)).not.toContain("USER TEXT");

    // The transport's own exception echoes a rejected header value, key and
    // all: only the allow-listed failure and its code reach a sink.
    events.length = 0;
    const leak = await completeText(
      s("compatible"),
      "SECRET-KEY",
      call,
      vi
        .fn()
        .mockRejectedValue(
          new TypeError(
            'Headers.append: "Bearer SECRET-KEY" is an invalid header value.',
            { cause: { code: "ECONNRESET", message: "socket SECRET-KEY" } },
          ),
        ),
      signal(),
      { diagnostics },
    ).catch((e) => e);
    expect(leak.code).toBe("network");
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(JSON.stringify(events)).not.toContain("Headers.append");
    expect(events.map((e) => e.event)).toEqual([
      "TextAttempt",
      "TextTransportError",
      "TextFailed",
    ]);
    expect(events[1].data).toMatchObject({
      retryable: true,
      code: "ECONNRESET",
      error: leak.message,
    });
    events.length = 0;
    await completeText(
      s("compatible"),
      "SECRET-KEY",
      call,
      vi.fn().mockRejectedValue(new Error("unrecognised SECRET-KEY")),
      signal(),
      { diagnostics },
    ).catch(() => undefined);
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(events[1].data.code).toBeUndefined();
  });
  it("keeps ttftMs through the local diagnostics allow-list", () => {
    const directory = mkdtempSync(join(tmpdir(), "assist-text-diagnostics-"));
    try {
      const log = new LocalDiagnostics(
        directory,
        () => [],
        () => {},
      );
      log.write("TextResponse", {
        ttftMs: 412,
        durationMs: 900,
        code: "ok",
        text: "ACT answer",
      });
      log.write("TextResponse", { ttftMs: Number.POSITIVE_INFINITY });
      log.write("TextResponse", { ttftMs: "412" });
      const lines = readFileSync(log.file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data);
      expect(lines).toEqual([
        { ttftMs: 412, durationMs: 900, code: "ok" },
        {},
        {},
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
