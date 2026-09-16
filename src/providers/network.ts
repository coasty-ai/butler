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

export function networkFailure(error: unknown): {
  retryable: boolean;
  message: string;
} {
  let current = error;
  for (
    let depth = 0;
    current && typeof current === "object" && depth < 5;
    depth++
  ) {
    const value = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const code =
      typeof value.code === "string"
        ? value.code
        : typeof value.message === "string"
          ? value.message.match(/\bnet::(ERR_[A-Z0-9_]+)\b/)?.[1]
          : undefined;
    if (code) {
      if (transient.has(code))
        return {
          retryable: true,
          message: `Connection to the provider was interrupted (${code}). Try again.`,
        };
      if (dns.has(code))
        return {
          retryable: false,
          message: `Cannot resolve the provider address (${code}). Check your network or DNS settings.`,
        };
      if (offline.has(code))
        return {
          retryable: false,
          message: `The network is unavailable (${code}). Reconnect and try again.`,
        };
      if (refused.has(code))
        return {
          retryable: false,
          message: `The provider refused the connection (${code}). Check that its endpoint is running.`,
        };
      if (certificate.has(code))
        return {
          retryable: false,
          message: `The provider's secure connection could not be verified (${code}). Check your system clock or network certificate settings.`,
        };
      if (proxy.has(code))
        return {
          retryable: false,
          message: `Could not connect through the network proxy (${code}). Check your proxy or VPN settings.`,
        };
      if (redirect.has(code))
        return {
          retryable: false,
          message:
            "The provider tried to redirect the request. Check the configured endpoint.",
        };
    }
    current = value.cause;
  }
  return {
    retryable: false,
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
