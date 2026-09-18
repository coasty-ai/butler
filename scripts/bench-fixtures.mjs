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
// The harnesses (bench.mjs, harness-cycle.mjs) run it as a child process
// through spawnFixtureServer(): a server that hangs or crashes then cannot
// take the harness's event loop, its timers or its Ctrl-C handling with it,
// and the child ends when its parent does, however the parent ends.
// startFixtureServer() serves a store in the calling process (the tests).
// This file stays free of TypeScript imports so it loads without tsx.
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Set in the child's environment by spawnFixtureServer. */
const CHILD_ENV = "OPEN_ASSIST_FIXTURE_CHILD";

const emptyLog = (port) => ({ port, visits: [], submissions: [] });

/**
 * Starts this script as a child process serving on 127.0.0.1:`port` (0 picks
 * a free one) and resolves to the contract's FixtureHandle plus flush(),
 * alive() and close(), or rejects with the child's failure code
 * (FIXTURE_PORT when the port is taken or cannot be bound). The child owns
 * the pages and the log; the parent keeps a mirror of each token's log that
 * the child updates as requests arrive, so read() stays synchronous, and
 * flush() waits until every update the child sent before it has arrived.
 *
 * Never orphaned: the child exits when the IPC channel closes, which
 * happens whenever this process ends (exit, crash, kill -9), and close()
 * falls back to SIGKILL. It ignores the Ctrl-C the terminal sends the whole
 * process group, so it outlives the parent's first Ctrl-C long enough for
 * the attempt being stopped to clean up.
 */
export function spawnFixtureServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, [CHILD_ENV]: "1", FIXTURE_PORT: String(port) },
    // Nothing the child could print belongs on the harness's terminal.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    // Not the parent's loader hooks or inspector flags.
    execArgv: [],
  });
  const logs = new Map();
  const waiting = new Map();
  let next = 0;
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  // A send on a closed channel must never crash the harness.
  child.on("error", () => {});
  const send = (message) => {
    if (child.connected) child.send(message, () => {});
  };
  const stop = () => {
    if (!gone()) child.kill("SIGKILL");
  };
  process.once("exit", stop);
  return new Promise((resolve, reject) => {
    let bound;
    const timer = setTimeout(() => {
      stop();
      const error = new Error("The fixture server did not start.");
      error.code = "FIXTURE_TIMEOUT";
      reject(error);
    }, options.timeoutMs ?? 20000);
    child.on("exit", () => {
      clearTimeout(timer);
      for (const done of waiting.values()) done();
      waiting.clear();
      if (!bound) {
        const error = new Error("The fixture server exited.");
        error.code = "FIXTURE_EXITED";
        reject(error);
      }
    });
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        clearTimeout(timer);
        bound = { port: message.port, url: message.url };
        resolve({
          port: bound.port,
          url: bound.url,
          pid: child.pid,
          register(token, pages) {
            logs.set(token, emptyLog(bound.port));
            send({ type: "register", token, pages });
            return `${bound.url}/${token}`;
          },
          read(token) {
            const log = logs.get(token) ?? emptyLog(bound.port);
            return {
              port: bound.port,
              visits: [...log.visits],
              submissions: log.submissions.map((s) => ({
                path: s.path,
                fields: { ...s.fields },
              })),
            };
          },
          reset(token) {
            if (logs.has(token)) logs.set(token, emptyLog(bound.port));
            send({ type: "reset", token });
          },
          flush(timeoutMs = 2000) {
            return new Promise((done) => {
              if (!child.connected) return done();
              const id = ++next;
              const timeout = setTimeout(() => {
                waiting.delete(id);
                done();
              }, timeoutMs);
              waiting.set(id, () => {
                clearTimeout(timeout);
                done();
              });
              send({ type: "ping", id });
            });
          },
          alive: () => !gone() && child.connected,
          close() {
            return new Promise((done) => {
              process.removeListener("exit", stop);
              if (gone()) return done();
              const kill = setTimeout(stop, 2000);
              child.once("exit", () => {
                clearTimeout(kill);
                done();
              });
              if (child.connected) send({ type: "close" });
              else stop();
            });
          },
        });
      } else if (message.type === "failed") {
        clearTimeout(timer);
        stop();
        const error = new Error("The fixture server could not start.");
        error.code = message.code;
        reject(error);
      } else if (message.type === "log" && logs.has(message.token)) {
        logs.set(message.token, message.log);
      } else if (message.type === "pong") {
        waiting.get(message.id)?.();
        waiting.delete(message.id);
      }
    });
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && process.send && process.env[CHILD_ENV] === "1") {
  // The harness's child (spawnFixtureServer above).
  const { register } = await import("tsx/esm/api");
  register();
  const { createFixtureStore, routeOf } =
    await import("../src/gym/bench/fixtures.ts");
  // The parent decides when this ends; its channel closing always does.
  process.on("SIGINT", () => {});
  process.on("disconnect", () => process.exit(0));
  const port = Number(process.env.FIXTURE_PORT ?? DEFAULT_PORT);
  const store = createFixtureStore(port);
  // Every request a token's log could change reports that log to the parent
  // before the response goes out: by the time the model has read the page
  // and acted on it, the parent's mirror holds the visit.
  const watched = {
    ...store,
    respond(request) {
      const reply = store.respond(request);
      const route = routeOf(request.url ?? "/");
      if (route && store.tokens().includes(route.token))
        process.send?.({
          type: "log",
          token: route.token,
          log: store.read(route.token),
        });
      return reply;
    },
  };
  let handle;
  try {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw Object.assign(new Error(), { code: "FIXTURE_PORT" });
    handle = await startFixtureServer(watched, { port });
  } catch (error) {
    const code =
      error?.code === "EADDRINUSE" ||
      error?.code === "EADDRNOTAVAIL" ||
      error?.code === "EACCES" ||
      error?.code === "FIXTURE_PORT"
        ? "FIXTURE_PORT"
        : "FIXTURE_FAILED";
    process.send({ type: "failed", code }, () => process.exit(1));
  }
  if (handle) {
    process.on("message", async (message) => {
      if (!message || typeof message !== "object") return;
      try {
        if (message.type === "register")
          store.register(message.token, message.pages);
        else if (message.type === "reset") store.reset(message.token);
        else if (message.type === "ping")
          process.send?.({ type: "pong", id: message.id });
        else if (message.type === "close") {
          await handle.close();
          process.exit(0);
        }
      } catch {
        // A register the store refused (not a bench token) serves nothing.
      }
    });
    process.send({ type: "ready", port: handle.port, url: handle.url });
  }
} else if (invokedDirectly) {
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
