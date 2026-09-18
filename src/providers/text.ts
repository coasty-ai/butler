import type { Settings, Usage } from "../core/schema";
import { validateProviderEndpoint } from "../core/privacy";
import { errorDetails, trace, type DiagnosticSink } from "../core/diagnostics";
import { networkFailure, retryDelay } from "./network";
import {
  parseUsage,
  quotaExhausted,
  readPrefix,
  refused,
  retryAfter,
  truncated,
} from "./http";

/**
 * A text-only model call: one system instruction and one user message, no
 * image and no tools. The dialog, status and progress features all go
 * through this one client so they share the privacy gate, the deadline and
 * the usage accounting of the run provider without touching its step loop.
 */
export interface TextCall {
  system: string;
  input: string;
  maxOutputTokens: number;
  /**
   * How much a reasoning model may think before answering. Omitted keeps the
   * provider default; a model that rejects the option with HTTP 400 loses it
   * for the rest of the process, once a request without it gets through.
   */
  effort?: "none" | "minimal" | "low";
}
export interface TextOutcome {
  usage: Usage;
  /**
   * ok: the model finished. truncated: it hit maxOutputTokens (or the local
   * text cap). refused: the model or provider declined; asking again with the
   * same input will not help. empty: it finished without producing any text.
   */
  code: "ok" | "truncated" | "refused" | "empty";
}
export type TextModelErrorCode =
  "network" | "timeout" | "quota" | "privacy" | "parse" | `http_${number}`;
/**
 * The call produced nothing usable. The message is always one of the fixed,
 * content-free strings in this module, so it can be logged and spoken.
 */
export class TextModelError extends Error {
  constructor(
    readonly code: TextModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TextModelError";
  }
}
export interface TextOptions {
  /** Whole call, including retries and the body. Default 6 s. */
  deadlineMs?: number;
  /**
   * Retry once, before any text has arrived, on an interrupted connection,
   * HTTP 429 or 5xx. Off by default: a spoken turn is better served by the
   * fixed fallback line than by a late answer.
   */
  retry?: boolean;
  diagnostics?: DiagnosticSink;
}

/**
 * The settings a text call runs under: the dedicated dialog model when one is
 * set, otherwise the run model. Everything else (provider, endpoint, privacy
 * mode, prices) is shared, so the same privacy gate applies to both. The
 * dialogModel field lands with the settings schema of this increment; until
 * then any Settings value simply has none.
 */
export function textSettings(s: Settings & { dialogModel?: string }): Settings {
  return { ...s, model: s.dialogModel || s.model };
}

type Json = Record<string, any>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

export interface TextRequest {
  url: string;
  headers: Record<string, string>;
  body: Json;
  format: "sse" | "ndjson";
  /** Body options the provider may reject with HTTP 400 (see `unsupported`). */
  optional: string[];
}

// Same model families as src/providers/http.ts: OpenAI reasoning models take
// a reasoning effort, and these Claude models take output_config.effort.
const openaiReasoningModel = /^(gpt-5|o[1-9])/;
const anthropicEffortModel =
  /claude-(opus|sonnet)-(4-6|4-7|4-8|5)|claude-(fable|mythos)-5/;

/**
 * Options a provider rejected with HTTP 400, per provider and model, so the
 * one-time retry without them is not repeated on every call. Remembered only
 * once a request without them was answered with something other than 400: a
 * 400 for another reason (an oversized input, say) must not cost the model
 * its option for the whole session. Process-local; forgetting only costs one
 * extra round trip.
 */
const unsupported = new Map<string, Set<string>>();
const unsupportedKey = (s: Settings) => `${s.provider}|${s.model}`;
/** Test hook: forget every option remembered as unsupported. */
export function forgetUnsupportedOptions() {
  unsupported.clear();
}

/**
 * The streaming request for one provider. Nothing here changes between calls
 * except the two messages, so provider prompt caches stay warm across turns.
 */
export function buildTextRequest(
  settings: Settings,
  key: string,
  call: TextCall,
  without: ReadonlySet<string> = unsupported.get(unsupportedKey(settings)) ??
    new Set(),
): TextRequest {
  const endpoint = validateProviderEndpoint(settings)
    .toString()
    .replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const optional: string[] = [];
  const option = (name: string, value: Json): Json => {
    if (without.has(name)) return {};
    optional.push(name);
    return value;
  };
  const maxTokens = Math.max(1, Math.floor(call.maxOutputTokens));
  const messages = [
    { role: "system", content: call.system },
    { role: "user", content: call.input },
  ];
  switch (settings.provider) {
    case "ollama":
      return {
        url: endpoint + "/api/chat",
        headers,
        format: "ndjson",
        optional,
        body: {
          model: settings.model,
          stream: true,
          keep_alive: "10m",
          // Thinking would spend num_predict before the reply starts; models
          // that cannot think reject the flag, so it is optional.
          ...option("think", { think: false }),
          messages,
          options: { num_predict: maxTokens },
        },
      };
    case "anthropic":
      return {
        url: endpoint + "/v1/messages",
        headers: {
          ...headers,
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        format: "sse",
        optional,
        body: {
          model: settings.model,
          max_tokens: maxTokens,
          stream: true,
          // Every requested effort maps to the lowest level these models offer.
          ...(call.effort && anthropicEffortModel.test(settings.model)
            ? option("output_config", { output_config: { effort: "low" } })
            : {}),
          // Anthropic caches only at an explicit breakpoint; the instruction
          // is identical on every turn.
          system: [
            {
              type: "text",
              text: call.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: call.input }],
        },
      };
    case "google":
      return {
        url:
          endpoint +
          `/v1beta/models/${encodeURIComponent(settings.model)}:streamGenerateContent?alt=sse`,
        headers: { ...headers, "x-goog-api-key": key },
        format: "sse",
        optional,
        body: {
          systemInstruction: { parts: [{ text: call.system }] },
          contents: [{ role: "user", parts: [{ text: call.input }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            // Thinking tokens count against maxOutputTokens on Gemini 2.5/3;
            // models that cannot switch it off reject the budget with 400.
            ...(call.effort === "none" || call.effort === "minimal"
              ? option("thinkingConfig", {
                  thinkingConfig: { thinkingBudget: 0 },
                })
              : {}),
          },
        },
      };
    case "openai":
      return {
        url: endpoint + "/v1/responses",
        headers: { ...headers, Authorization: `Bearer ${key}` },
        format: "sse",
        optional,
        body: {
          model: settings.model,
          store: false,
          stream: true,
          instructions: call.system,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: call.input }],
            },
          ],
          max_output_tokens: maxTokens,
          ...(call.effort && openaiReasoningModel.test(settings.model)
            ? option("reasoning", { reasoning: { effort: call.effort } })
            : {}),
        },
      };
    case "compatible":
      return {
        url: endpoint + "/chat/completions",
        headers: { ...headers, Authorization: `Bearer ${key}` },
        format: "sse",
        optional,
        body: {
          model: settings.model,
          stream: true,
          max_tokens: maxTokens,
          // Usage arrives in a final chunk only when asked for; some
          // compatible servers reject the option.
          ...option("stream_options", {
            stream_options: { include_usage: true },
          }),
          messages,
        },
      };
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}
/**
 * Splits the complete server-sent events off a buffer. Events are delimited
 * by a blank line; `rest` is everything from the first unfinished event on,
 * so a chunk boundary anywhere in the text is harmless. Comment lines and
 * unknown fields are ignored; multiple data lines join with a newline.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let consumed = 0;
  let position = 0;
  let event: string | undefined;
  let data: string[] = [];
  while (position < buffer.length) {
    const cr = buffer.indexOf("\r", position),
      lf = buffer.indexOf("\n", position);
    const end = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
    if (end === -1) break;
    // CRLF is one terminator. A CR split from its LF by a chunk boundary is
    // harmless: nothing before a blank line is consumed, so the next call
    // re-parses the pending lines with the LF in place.
    const next =
      buffer[end] === "\r" && buffer[end + 1] === "\n" ? end + 2 : end + 1;
    const line = buffer.slice(position, end);
    position = next;
    if (line === "") {
      if (data.length) events.push({ event, data: data.join("\n") });
      event = undefined;
      data = [];
      consumed = position;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { events, rest: buffer.slice(consumed) };
}
/** Complete newline-terminated lines off a buffer, and the unfinished tail. */
function splitLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines: lines.map((l) => l.replace(/\r$/, "")), rest };
}

const malformedMessage = "Provider returned a malformed stream.";
const closedEarlyMessage = "Provider closed the stream before finishing.";
const streamErrorMessage = "Provider reported an error in the stream.";
const quotaMessage =
  "Provider quota or billing limit reached. Check your plan and credits.";
const sizeMessage = "Provider response exceeded the size limit.";
/** Raw body bytes; SSE framing costs far more than the text it carries. */
const bodyLimit = 4 * 1024 * 1024;
/** Text characters yielded before the stream is cut as truncated. */
export const textLimit = 32000;

/**
 * Turns one provider's stream into text deltas and, once it has ended, into
 * an object shaped like that provider's non-streaming response, so parseUsage,
 * refused and truncated from http.ts read it unchanged.
 */
function createReader(
  kind: Settings["provider"],
  format: TextRequest["format"],
) {
  let buffer = "";
  let ended = false;
  let refusal = false;
  // Per-provider state gathered from the events.
  let response: Json | undefined; // openai: the completed response
  const usage: Json = {}; // anthropic: cumulative usage
  let stopReason: string | undefined; // anthropic
  let usageMetadata: Json | undefined, // google
    finishReason: string | undefined,
    promptFeedback: Json | undefined;
  let chatUsage: Json | undefined, // compatible
    finish: string | undefined;
  let last: Json | undefined; // ollama: the done line
  const fail = (message: string): never => {
    throw new TextModelError("parse", message);
  };
  const handle = (data: Json): string | undefined => {
    switch (kind) {
      case "openai":
        switch (data.type) {
          case "response.output_text.delta":
            return typeof data.delta === "string" ? data.delta : undefined;
          case "response.refusal.delta":
            refusal = true;
            return;
          case "response.completed":
          case "response.incomplete":
            response = isObject(data.response) ? data.response : {};
            ended = true;
            return;
          case "response.failed":
          case "error":
            return fail(streamErrorMessage);
          default:
            return;
        }
      case "anthropic":
        switch (data.type) {
          case "message_start":
            if (isObject(data.message?.usage))
              Object.assign(usage, data.message.usage);
            return;
          case "content_block_delta":
            return data.delta?.type === "text_delta" &&
              typeof data.delta.text === "string"
              ? data.delta.text
              : undefined;
          case "message_delta":
            if (isObject(data.usage)) Object.assign(usage, data.usage);
            if (typeof data.delta?.stop_reason === "string") {
              stopReason = data.delta.stop_reason;
              ended = true;
            }
            return;
          case "message_stop":
            ended = true;
            return;
          case "error":
            return fail(streamErrorMessage);
          default:
            return;
        }
      case "google": {
        if (isObject(data.error)) return fail(streamErrorMessage);
        if (isObject(data.usageMetadata)) usageMetadata = data.usageMetadata;
        if (isObject(data.promptFeedback) && data.promptFeedback.blockReason) {
          promptFeedback = data.promptFeedback;
          ended = true;
        }
        const candidate = Array.isArray(data.candidates)
          ? data.candidates[0]
          : undefined;
        if (!isObject(candidate)) return;
        if (typeof candidate.finishReason === "string") {
          finishReason = candidate.finishReason;
          ended = true;
        }
        const parts = candidate.content?.parts;
        let text = "";
        if (Array.isArray(parts))
          for (const part of parts)
            if (
              isObject(part) &&
              typeof part.text === "string" &&
              !part.thought
            )
              text += part.text;
        return text || undefined;
      }
      case "compatible": {
        if (isObject(data.error)) return fail(streamErrorMessage);
        if (isObject(data.usage)) chatUsage = data.usage;
        const choice = Array.isArray(data.choices)
          ? data.choices[0]
          : undefined;
        if (!isObject(choice)) return;
        if (typeof choice.finish_reason === "string") {
          finish = choice.finish_reason;
          ended = true;
        }
        const content = choice.delta?.content;
        return typeof content === "string" ? content : undefined;
      }
      case "ollama": {
        if (data.error !== undefined) return fail(streamErrorMessage);
        if (data.done === true) {
          last = data;
          ended = true;
        }
        const content = data.message?.content;
        return typeof content === "string" ? content : undefined;
      }
    }
  };
  const parse = (text: string): Json | undefined => {
    if (text.trim() === "[DONE]") {
      ended = true;
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return fail(malformedMessage);
    }
    return isObject(value) ? value : fail(malformedMessage);
  };
  return {
    get ended() {
      return ended;
    },
    get refusal() {
      return refusal;
    },
    /** Feeds decoded body text; returns the text deltas it completed. */
    push(chunk: string): string[] {
      buffer += chunk;
      let items: string[];
      if (format === "sse") {
        const { events, rest } = parseSse(buffer);
        buffer = rest;
        items = events.map((e) => e.data);
      } else {
        const { lines, rest } = splitLines(buffer);
        buffer = rest;
        items = lines.filter((line) => line.trim());
      }
      const deltas: string[] = [];
      for (const item of items) {
        const data = parse(item);
        if (!data) continue;
        const delta = handle(data);
        if (delta) deltas.push(delta);
      }
      return deltas;
    },
    /** The provider's response as its non-streaming shape (see above). */
    final(): Json {
      switch (kind) {
        case "openai":
          return response ?? {};
        case "anthropic":
          return { stop_reason: stopReason ?? null, usage: { ...usage } };
        case "google":
          return {
            candidates: finishReason ? [{ finishReason }] : [],
            ...(usageMetadata && { usageMetadata }),
            ...(promptFeedback && { promptFeedback }),
          };
        case "compatible":
          return {
            choices: [{ finish_reason: finish ?? null }],
            ...(chatUsage && { usage: chatUsage }),
          };
        case "ollama":
          return last ?? {};
      }
    },
  };
}

/**
 * An exception from reading the body: a connection that dropped mid-reply is
 * a network failure (with the transport's code, for latency and failure
 * analysis); anything else is the stream making no sense.
 */
function bodyFailure(error: unknown): TextModelError {
  const failure = networkFailure(error);
  return failure.code
    ? new TextModelError("network", failure.message)
    : new TextModelError("parse", malformedMessage);
}
const defaultDeadlineMs = 6000;
const retryableStatus = (status: number) =>
  status === 429 || (status >= 500 && status !== 501 && status !== 505);
const httpMessage = (status: number) =>
  status === 429
    ? "The provider is rate limiting requests (HTTP 429). Try again shortly."
    : status >= 500
      ? `The provider is temporarily unavailable (HTTP ${status}). Try again shortly.`
      : `Provider returned HTTP ${status}. Verify credentials, model access and quota.`;

/**
 * Streams the model's text as it arrives and returns the outcome once the
 * stream ends. Throws TextModelError, or a plain "Cancelled." error when the
 * caller's signal aborts, whether before the request or mid-stream (leaving
 * the loop early does the same quietly). Diagnostics carry timings, sizes and
 * codes only; never a character of the prompt or the reply, and never the
 * transport's own message, which can echo a header value.
 */
export async function* streamText(
  s: Settings,
  key: string,
  call: TextCall,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
  o: TextOptions = {},
): AsyncGenerator<string, TextOutcome> {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const log = (event: string, data: Record<string, unknown> = {}) =>
    trace(o.diagnostics, event, {
      requestId,
      provider: s.provider,
      model: s.model,
      ...data,
    });
  // The privacy gate runs before anything leaves the process, exactly as for
  // the run provider; a missing key fails here rather than at the provider.
  try {
    validateProviderEndpoint(s);
  } catch (error) {
    throw new TextModelError(
      "privacy",
      error instanceof Error ? error.message : "Endpoint not allowed.",
    );
  }
  if (s.provider !== "ollama" && !key)
    throw new TextModelError("http_401", "Add a provider API key in Settings.");
  const deadlineMs = o.deadlineMs ?? defaultDeadlineMs;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  // A signal already aborted is caught by the first check inside the loop,
  // so it is reported like any other cancel: "Cancelled.", traced, no request.
  if (signal.aborted) abort();
  let timedOut = false;
  // One deadline covers connection, retries and the whole body.
  const deadline = Date.now() + deadlineMs;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, deadlineMs);
  let retried = false;
  // Options left out after a 400, and not yet known to have been the cause.
  let dropped: string[] | undefined;
  const without = new Set(unsupported.get(unsupportedKey(s)));
  let ttftMs: number | undefined;
  let chars = 0;
  let sawText = false;
  try {
    for (let attempt = 1; ; attempt++) {
      controller.signal.throwIfAborted();
      const request = buildTextRequest(s, key, call, without);
      const attemptStarted = performance.now();
      log("TextAttempt", { attempt });
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failure = networkFailure(error);
        // The allow-listed failure, never the transport's own message: a
        // rejected header value is echoed back with the key in it.
        log("TextTransportError", {
          attempt,
          durationMs: Math.round(performance.now() - attemptStarted),
          retryable: failure.retryable,
          ...(failure.code && { code: failure.code }),
          error: failure.message,
        });
        if (failure.retryable && o.retry && !retried) {
          retried = true;
          log("TextRetry", { attempt, delayMs: 250 });
          await retryDelay(250, controller.signal);
          continue;
        }
        throw new TextModelError("network", failure.message);
      }
      const status = response.status;
      log("TextHeaders", {
        attempt,
        httpStatus: status,
        durationMs: Math.round(performance.now() - attemptStarted),
      });
      if (dropped && status !== 400) {
        // The request without the options was not rejected as malformed, so
        // they were the cause: later calls for this model skip them outright.
        const memory = unsupported.get(unsupportedKey(s)) ?? new Set<string>();
        for (const name of dropped) memory.add(name);
        unsupported.set(unsupportedKey(s), memory);
        dropped = undefined;
      }
      if (status === 400 && request.optional.length) {
        // The provider may have rejected an optional body parameter
        // (reasoning effort, think, thinking budget, usage in the stream):
        // leave it out and ask once more. Nothing has been streamed yet, and
        // the retry carries no options, so a second 400 is the error.
        await response.body?.cancel();
        dropped = request.optional;
        for (const name of dropped) without.add(name);
        log("TextRetry", { attempt, httpStatus: status, delayMs: 0 });
        continue;
      }
      if (status === 429 && quotaExhausted(await readPrefix(response, 4096)))
        throw new TextModelError("quota", quotaMessage);
      if (retryableStatus(status)) {
        if (status !== 429) await response.body?.cancel();
        const hinted =
          status === 429 || status === 503
            ? retryAfter(response.headers.get("retry-after"))
            : undefined;
        const delayMs = hinted ?? 500;
        // A retry that cannot finish before the deadline is not attempted.
        if (o.retry && !retried && delayMs <= deadline - Date.now() - 250) {
          retried = true;
          log("TextRetry", {
            attempt,
            httpStatus: status,
            delayMs,
            retryAfter: hinted !== undefined,
          });
          await retryDelay(delayMs, controller.signal);
          continue;
        }
        throw new TextModelError(`http_${status}`, httpMessage(status));
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new TextModelError(`http_${status}`, httpMessage(status));
      }
      const body = response.body?.getReader();
      if (!body) throw new TextModelError("parse", closedEarlyMessage);
      const reader = createReader(s.provider, request.format);
      const decoder = new TextDecoder();
      let bytes = 0;
      let capped = false;
      let drained = false;
      // Every read races the abort signal: the deadline and the caller's
      // cancel must end the stream even on a transport whose body reader
      // does not reject on abort.
      let unhook = () => {};
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(new Error("Cancelled."));
        if (controller.signal.aborted) fail();
        controller.signal.addEventListener("abort", fail, { once: true });
        unhook = () => controller.signal.removeEventListener("abort", fail);
      });
      aborted.catch(() => undefined);
      try {
        // Deltas pass through here so the first-token time and the cap are
        // measured on what the caller actually receives.
        const consume = function* (deltas: string[]) {
          for (const delta of deltas) {
            if (ttftMs === undefined)
              ttftMs = Math.round(performance.now() - started);
            chars += delta.length;
            if (delta.trim()) sawText = true;
            if (chars > textLimit) {
              capped = true;
              return;
            }
            yield delta;
          }
        };
        while (!capped) {
          const { done, value } = await Promise.race([body.read(), aborted]);
          if (done) break;
          bytes += value.length;
          if (bytes > bodyLimit) throw new TextModelError("parse", sizeMessage);
          for (const delta of consume(
            reader.push(decoder.decode(value, { stream: true })),
          ))
            yield delta;
        }
        if (!capped) {
          drained = true;
          for (const delta of consume(reader.push(decoder.decode())))
            yield delta;
        }
      } finally {
        // A consumer that stops reading, the deadline and the cap all release
        // the connection here.
        unhook();
        if (!drained) await body.cancel().catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      if (!capped && !reader.ended)
        throw new TextModelError("network", closedEarlyMessage);
      const data = reader.final();
      // Usage first: a billed reply counts even when its content is rejected.
      const usage = parseUsage(s.provider, data, s);
      const code: TextOutcome["code"] =
        reader.refusal || refused(s.provider, data)
          ? "refused"
          : capped || truncated(s.provider, data)
            ? "truncated"
            : sawText
              ? "ok"
              : "empty";
      log("TextResponse", {
        attempt,
        httpStatus: status,
        durationMs: Math.round(performance.now() - started),
        ttftMs,
        bytes,
        textLength: chars,
        code,
        usage,
      });
      return { usage, code };
    }
  } catch (error) {
    // The trace describes what the caller receives, not the transport's
    // own abort or parse exception.
    const failure = signal.aborted
      ? new Error("Cancelled.")
      : timedOut
        ? new TextModelError(
            "timeout",
            `Provider did not respond within ${(deadlineMs / 1000).toFixed(1).replace(/\.0$/, "")} seconds.`,
          )
        : error instanceof TextModelError
          ? error
          : bodyFailure(error);
    log("TextFailed", {
      cancelled: signal.aborted,
      timedOut,
      durationMs: Math.round(performance.now() - started),
      ttftMs,
      textLength: chars,
      ...errorDetails(failure),
    });
    throw failure;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** streamText collected: the whole reply with its outcome. */
export async function completeText(
  s: Settings,
  key: string,
  call: TextCall,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
  o: TextOptions = {},
): Promise<TextOutcome & { text: string }> {
  const stream = streamText(s, key, call, fetch, signal, o);
  const parts: string[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { ...next.value, text: parts.join("") };
    parts.push(next.value);
  }
}
