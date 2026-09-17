import { session } from "electron";
import { HttpProvider } from "../src/providers/http";
import type { Settings } from "../src/core/schema";
import { trace, type DiagnosticSink } from "../src/core/diagnostics";

// Use macOS/Chromium networking, including system proxy configuration. Keep
// provider traffic separate from renderer cookies/cache in an in-memory session.
export function desktopTransport(diagnostics?: DiagnosticSink): typeof fetch {
  let useNode = false;
  return async (input, init) => {
    if (useNode)
      return fetch(input, { ...init, credentials: "omit", cache: "no-store" });
    const network = session.fromPartition("provider-requests", {
      cache: false,
    });
    try {
      return await network.fetch(input instanceof URL ? input.href : input, {
        ...init,
        credentials: "omit",
        bypassCustomProtocolHandlers: true,
      });
    } catch (error) {
      // Never accept a failed TLS record. Discard pooled connections so the
      // provider's bounded retry establishes a fresh, verified connection.
      if (
        error instanceof Error &&
        error.message.includes("net::ERR_SSL_BAD_RECORD_MAC_ALERT")
      ) {
        await network.closeAllConnections().catch(() => {});
        // On this Mac, Chromium can repeatedly fail TLS records while Node's TLS
        // transport succeeds with the same payload. Switch on the next bounded
        // retry only for a DIRECT route; never silently bypass a system proxy.
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const proxy = await Promise.race([
            network.resolveProxy(url).catch(() => "UNKNOWN"),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("UNKNOWN"), 1000);
            }),
          ]);
          if (proxy.trim() === "DIRECT" && !init?.signal?.aborted) {
            useNode = true;
            trace(diagnostics, "ProviderTransportSwitch", {
              source: "chromium_to_node",
              code: "ERR_SSL_BAD_RECORD_MAC_ALERT",
            });
          }
        } finally {
          clearTimeout(timer);
        }
      }
      throw error;
    }
  };
}

export function createDesktopProvider(
  settings: Settings,
  key: string,
  diagnostics?: DiagnosticSink,
) {
  return new HttpProvider(
    settings,
    key,
    desktopTransport(diagnostics),
    diagnostics,
  );
}
