// The long suite's fixture web server.
//
// Serves the pages a task registered for its token (src/gym/bench/fixtures.ts)
// on the loopback interface and nowhere else: a bind to any other address is
// refused before a socket opens, and the server never proxies or fetches. It
// logs which pages were opened and what a form posted, per token, for the
// graders; nothing is written to disk.
//
//   node scripts/bench-fixtures.mjs            # serve on 127.0.0.1:47831 until Ctrl-C
//   FIXTURE_PORT=47900 node scripts/bench-fixtures.mjs
//
// The harness imports startFixtureServer() and passes it the store it built;
// this file stays free of TypeScript imports so it loads without tsx.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Must agree with FIXTURE_PORT in src/gym/bench/graders.ts (tested). */
export const DEFAULT_PORT = 47831;
// Literal addresses only: "localhost" is whatever /etc/hosts says it is, and
// a name that resolves off the machine would publish the pages and the form.
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const BODY_LIMIT = 64 * 1024;

/**
 * Starts serving `store` (a FixtureStore) and resolves to the contract's
 * FixtureHandle plus close(). Port 0 picks a free port.
 */
export function startFixtureServer(store, options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  if (!LOOPBACK_HOSTS.has(host)) {
    const error = new Error(
      `The fixture server binds loopback only, not ${host}.`,
    );
    error.code = "FIXTURE_HOST";
    return Promise.reject(error);
  }
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    request.on("end", () => {
      const reply = store.respond({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body: size <= BODY_LIMIT ? Buffer.concat(chunks).toString("utf8") : "",
      });
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
    });
  });
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound =
        typeof address === "object" && address ? address.port : port;
      const url = `http://${host === "::1" ? "[::1]" : host}:${bound}`;
      resolve({
        port: bound,
        url,
        register(token, pages) {
          store.register(token, pages);
          return `${url}/${token}`;
        },
        read: (token) => store.read(token),
        reset: (token) => store.reset(token),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Standalone use registers tsx so the page module loads under plain node,
  // the way bench.mjs does.
  const { register } = await import("tsx/esm/api");
  register();
  const { createFixtureStore } = await import("../src/gym/bench/fixtures.ts");
  const port = Number(process.env.FIXTURE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("FIXTURE_PORT must be a port number.");
    process.exit(2);
  }
  const handle = await startFixtureServer(createFixtureStore(port), { port });
  console.log(
    `Fixture server on ${handle.url} (loopback only). Ctrl-C to stop.`,
  );
  process.on("SIGINT", async () => {
    await handle.close();
    process.exit(0);
  });
}
