// Only allow-listed transport codes reach the UI/log. Raw errors can contain
// request headers, URLs, response bodies or other private data.
const transient = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_ABORTED",
  "ERR_NETWORK_CHANGED",
  "ERR_TIMED_OUT",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_HTTP2_PROTOCOL_ERROR",
  "ERR_SSL_BAD_RECORD_MAC_ALERT",
  "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
]);
const dns = new Set(["ENOTFOUND", "ERR_NAME_NOT_RESOLVED"]);
const offline = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_INTERNET_DISCONNECTED",
]);
const refused = new Set(["ECONNREFUSED", "ERR_CONNECTION_REFUSED"]);
const certificate = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CERT_COMMON_NAME_INVALID",
  "ERR_CERT_DATE_INVALID",
  "ERR_CERT_INVALID",
]);
const proxy = new Set([
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_NO_SUPPORTED_PROXIES",
]);
const redirect = new Set([
  "ERR_TOO_MANY_REDIRECTS",
  "ERR_UNSAFE_REDIRECT",
  "ERR_FAILED_REDIRECT",
]);

/** Only these transport codes belong in content-free diagnostics. */
export const providerTransportCode = (value: unknown): string | undefined =>
  typeof value === "string" &&
  [transient, dns, offline, refused, certificate, proxy, redirect].some((set) =>
    set.has(value),
  )
    ? value
    : undefined;

/**
 * The allow-listed failure for a transport error: a fixed message, and the
 * transport code it matched (absent for an unrecognised error), which is safe
 * to log where the raw error's message is not.
 */
export function networkFailure(error: unknown): {
  retryable: boolean;
  message: string;
  code?: string;
} {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  let recovered: ReturnType<typeof networkFailure> | undefined;
  let fetchFailed = false;
  // Node may wrap multiple connection attempts in AggregateError.errors,
  // rather than the single cause chain used by Chromium and older Node.
  for (let depth = 0; queue.length && depth < 32; depth++) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (value.cause) queue.push(value.cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors.slice(0, 16));
    fetchFailed ||=
      current instanceof TypeError && value.message === "fetch failed";
    const code =
      typeof value.code === "string"
        ? value.code
        : typeof value.message === "string"
          ? value.message.match(/\bnet::(ERR_[A-Z0-9_]+)\b/)?.[1]
          : undefined;
    if (code) {
      if (transient.has(code))
        recovered = {
          code,
          retryable: true,
          message: `Connection to the provider was interrupted (${code}). Try again.`,
        };
      if (dns.has(code))
        return {
          code,
          retryable: false,
          message: `Cannot resolve the provider address (${code}). Check your network or DNS settings.`,
        };
      if (offline.has(code))
        return {
          code,
          retryable: false,
          message: `The network is unavailable (${code}). Reconnect and try again.`,
        };
      if (refused.has(code))
        return {
          code,
          retryable: false,
          message: `The provider refused the connection (${code}). Check that its endpoint is running.`,
        };
      if (certificate.has(code))
        return {
          code,
          retryable: false,
          message: `The provider's secure connection could not be verified (${code}). Check your system clock or network certificate settings.`,
        };
      if (proxy.has(code))
        return {
          code,
          retryable: false,
          message: `Could not connect through the network proxy (${code}). Check your proxy or VPN settings.`,
        };
      if (redirect.has(code))
        return {
          code,
          retryable: false,
          message:
            "The provider tried to redirect the request. Check the configured endpoint.",
        };
    }
  }
  if (recovered) return recovered;
  return {
    retryable: fetchFailed,
    message:
      "Provider connection failed. Try again; if it persists, check your network or proxy settings.",
  };
}

export function retryDelay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
