import { spawn } from "node:child_process";

/** Curl's macOS SecureTransport path avoids the observed Node TLS record failures. */
export function nativeModelFetch(
  fallback: typeof fetch = globalThis.fetch,
  platform: string = process.platform,
  launch: typeof spawn = spawn,
): typeof fetch {
  if (platform !== "darwin") return fallback;
  return (async (input, init) => {
    // Model adapters use string URLs and JSON POST bodies. Other callers keep
    // ordinary fetch semantics instead of silently losing Request options.
    if (
      !(typeof input === "string" || input instanceof URL) ||
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      (init.redirect && !["error", "manual"].includes(init.redirect))
    )
      return fallback(input, init);
    const url = new URL(String(input));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new TypeError("Invalid model endpoint.");
    const headers = new Headers(init.headers);
    const signal = init.signal;
    if (signal?.aborted) throw cancelled();
    const config = [
      "silent",
      "show-error",
      "include",
      "no-buffer",
      "globoff",
      "suppress-connect-headers",
      'proto = "=http,https"',
      "connect-timeout = 10",
      'request = "POST"',
      `url = ${quote(url.href)}`,
      ...Array.from(
        headers,
        ([name, value]) => `header = ${quote(`${name}: ${value}`)}`,
      ),
      'header = "Expect:"',
      `data-raw = ${quote(init.body)}`,
    ].join("\n");
    return new Promise<Response>((resolve, reject) => {
      // -q must be first: no ~/.curlrc can enable redirects, logging or insecure TLS.
      // Credentials and body travel over stdin, never argv, environment or files.
      const child = launch("/usr/bin/curl", ["-q", "--config", "-"], {
        stdio: "pipe",
      });
      let pending = Buffer.alloc(0);
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      let delivered = false;
      let ended = false;
      const remove = () => signal?.removeEventListener("abort", abort);
      const fail = (error: Error) => {
        if (ended) return;
        ended = true;
        remove();
        child.kill();
        if (delivered) body?.error(error);
        else reject(error);
      };
      const abort = () => fail(cancelled());
      const enqueue = (chunk: Buffer) => {
        if (!chunk.length || ended) return;
        body!.enqueue(new Uint8Array(chunk));
        if ((body!.desiredSize ?? 0) <= 0) child.stdout!.pause();
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (ended) return;
        if (delivered) return enqueue(chunk);
        pending = Buffer.concat([pending, chunk]);
        while (!delivered) {
          const boundary = pending.indexOf("\r\n\r\n");
          if (boundary < 0) {
            if (pending.length > 32_768)
              fail(transportError("UND_ERR_HEADERS_OVERFLOW"));
            return;
          }
          if (boundary > 32_768)
            return fail(transportError("UND_ERR_HEADERS_OVERFLOW"));
          const lines = pending
            .subarray(0, boundary)
            .toString("latin1")
            .split("\r\n");
          pending = pending.subarray(boundary + 4);
          const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(
            lines.shift() || "",
          );
          if (!status) return fail(transportError("UND_ERR_SOCKET"));
          const code = Number(status[1]);
          if (code >= 100 && code < 200) continue;
          if (
            init.redirect === "error" &&
            [301, 302, 303, 307, 308].includes(code)
          )
            return fail(transportError("ERR_FAILED_REDIRECT"));
          const responseHeaders = new Headers();
          try {
            for (const line of lines) {
              const colon = line.indexOf(":");
              if (colon > 0)
                responseHeaders.append(
                  line.slice(0, colon),
                  line.slice(colon + 1).trim(),
                );
            }
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
              pull() {
                child.stdout!.resume();
              },
              cancel() {
                if (!ended) {
                  ended = true;
                  remove();
                  child.kill();
                }
              },
            });
            const response = new Response(
              [204, 205, 304].includes(code) ? null : stream,
              {
                status: code,
                statusText: status[2] || "",
                headers: responseHeaders,
              },
            );
            delivered = true;
            resolve(response);
            enqueue(pending);
            pending = Buffer.alloc(0);
          } catch {
            fail(transportError("UND_ERR_SOCKET"));
          }
        }
      });
      // Raw stderr can include endpoints and proxy credentials. Never retain it.
      child.stderr!.resume();
      child.stdin!.on("error", () => fail(transportError("EPIPE")));
      child.on("error", () => fail(transportError("ECONNREFUSED")));
      child.on("close", (code) => {
        if (ended) return;
        if (code !== 0) return fail(transportError(exitCode(code)));
        if (!delivered) return fail(transportError("UND_ERR_SOCKET"));
        ended = true;
        remove();
        body?.close();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      child.stdin!.end(config);
    });
  }) as typeof fetch;
}
const cancelled = () => new DOMException("Cancelled.", "AbortError");
const transportError = (code: string) =>
  Object.assign(new TypeError("Model connection failed."), { code });
const exitCode = (code: number | null) =>
  ({
    5: "ERR_PROXY_CONNECTION_FAILED",
    6: "ENOTFOUND",
    7: "ECONNREFUSED",
    18: "UND_ERR_SOCKET",
    28: "ETIMEDOUT",
    35: "ERR_SSL_CONNECTION_FAILED",
    52: "UND_ERR_SOCKET",
    55: "ECONNRESET",
    56: "ECONNRESET",
    60: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  })[code ?? -1] || "UND_ERR_SOCKET";
/** Curl config escaping, not shell quoting. No command is interpreted by a shell. */
const quote = (text: string) =>
  '"' +
  text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") +
  '"';
