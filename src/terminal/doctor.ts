import { deflateSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { LocalDiagnostics } from "../../electron/diagnostics";
import type { DiagnosticSink } from "../core/diagnostics";
import {
  ProviderTransientError,
  providerUnavailableMessage,
} from "../core/errors";
import type { Settings, Frame } from "../core/schema";
import { HttpProvider } from "../providers/http";
import { networkFailure, providerTransportCode } from "../providers/network";

/** Default CLI logs contain only response status, transport codes and measurements. */
export function providerDiagnostics(
  directory: string,
  secrets: () => string[],
): DiagnosticSink {
  const log = new LocalDiagnostics(
    directory,
    secrets,
    () => {},
    undefined,
    false,
  );
  return (event, data = {}) => {
    const safe: Record<string, unknown> = {};
    for (const key of [
      "requestId",
      "frameId",
      "provider",
      "model",
      "attempt",
      "httpStatus",
      "durationMs",
      "delayMs",
      "retryable",
      "retryAfter",
      "cancelled",
      "timedOut",
      "bytes",
    ])
      if (data[key] !== undefined) {
        const value = data[key];
        if (["requestId", "frameId"].includes(key)) {
          if (
            typeof value === "string" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              value,
            )
          )
            safe[key] = value;
        } else if (key === "provider") {
          if (
            ["openai", "anthropic", "google", "ollama", "compatible"].includes(
              String(value),
            )
          )
            safe[key] = value;
        } else if (key === "model") {
          if (
            typeof value === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(value)
          )
            safe[key] = value;
        } else if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0
        )
          safe[key] = value;
        else if (typeof value === "boolean") safe[key] = value;
      }
    const code =
      providerTransportCode(data.code) ||
      providerTransportCode(
        (data.cause as { code?: unknown } | undefined)?.code,
      );
    if (code) safe.code = code;
    log.write(event, safe);
  };
}
function fixtureFrame(): Frame {
  const crc = (data: Buffer) => {
    let value = -1;
    for (const byte of data) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ -1) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const width = 256,
    height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const pixels = Buffer.alloc((width + 1) * height, 160);
  for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return {
    id: randomUUID(),
    image: "data:image/png;base64," + png.toString("base64"),
    sha256: createHash("sha256").update(png).digest("hex"),
    capturedAt: Date.now(),
    synthetic: true,
    geometry: {
      display_id: 1,
      x: 0,
      y: 0,
      width,
      height,
      native_width: width,
      native_height: height,
      model_width: width,
      model_height: height,
      scale_factor: 1,
    },
  };
}
/** Exercises the same vision/tool-call transport without capturing or controlling a desktop. */
export async function probeModel(
  settings: Settings,
  key: string,
  diagnostics?: DiagnosticSink,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const started = Date.now();
  const timeout = AbortSignal.timeout(20_000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const result = await new HttpProvider(
      settings,
      key,
      request,
      diagnostics,
    ).next(
      {
        task: "Synthetic connection test. Return done with a brief test confirmation. Do not request any computer input.",
        history: [],
        frame: fixtureFrame(),
      },
      abort,
    );
    return {
      reachable: true,
      usableReply:
        !result.problem &&
        (result.action as { type?: unknown } | undefined)?.type === "done",
      durationMs: Date.now() - started,
    };
  } catch (error) {
    let message =
      "The model connection check failed. Check the configured endpoint and local diagnostics.";
    if (!key && settings.provider !== "ollama")
      message = "Add the model API key with /key.";
    else if (timeout.aborted)
      message = "The model connection check timed out after 20 seconds.";
    else if (signal?.aborted)
      message = "The model connection check was cancelled.";
    else if (error instanceof ProviderTransientError)
      message = providerUnavailableMessage(error);
    else if (error instanceof Error) {
      const http = error.message.match(/^Provider returned HTTP (\d{3})\./);
      const code = providerTransportCode(
        error.message.match(/\(([A-Z0-9_]+)\)/)?.[1],
      );
      if (http)
        message = `The model service returned HTTP ${http[1]}. Check credentials, model access and quota.`;
      else if (code) message = networkFailure({ code }).message;
      else if (
        error.message ===
        "Provider quota or billing limit reached. Check your plan and credits."
      )
        message = error.message;
    }
    return {
      reachable: false,
      error: message,
      durationMs: Date.now() - started,
    };
  }
}
