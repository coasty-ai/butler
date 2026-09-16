import { createServer } from "node:http";
import { IngestStore } from "./store";
const key = process.env.INGEST_ENCRYPTION_KEY;
if (!key || !/^[a-f0-9]{64}$/.test(key))
  throw new Error(
    "Set INGEST_ENCRYPTION_KEY to 32 random bytes encoded as hex.",
  );
const store = new IngestStore(
  process.env.INGEST_DATA_DIR ?? ".data/ingest",
  Buffer.from(key, "hex"),
);
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const send = (status: number, data: unknown) => {
    res.writeHead(status);
    res.end(JSON.stringify(data));
  };
  try {
    if (req.headers.origin) {
      send(403, { error: "Browser origins are not accepted." });
      return;
    }
    const parts = (req.url ?? "").split("/").filter(Boolean),
      token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 400000) {
        send(413, { error: "Request too large." });
        return;
      }
      chunks.push(chunk);
    }
    const body = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true, mode: "local-development" });
      return;
    }
    if (parts[0] !== "contributions") {
      send(404, { error: "Not found" });
      return;
    }
    if (parts.length === 1 && req.method === "POST") {
      send(201, store.create(body));
      return;
    }
    const id = parts[1];
    if (!id) {
      send(404, { error: "Not found" });
      return;
    }
    if (parts.length === 2 && req.method === "GET")
      send(200, store.status(id, token));
    else if (parts.length === 2 && req.method === "DELETE")
      send(200, store.delete(id, token));
    else if (
      parts.length === 4 &&
      parts[2] === "chunks" &&
      req.method === "PUT"
    )
      send(200, store.chunk(id, Number(parts[3]), token, body));
    else if (
      parts.length === 3 &&
      parts[2] === "commit" &&
      req.method === "POST"
    )
      send(200, store.commit(id, token));
    else send(404, { error: "Not found" });
  } catch {
    send(400, { error: "Invalid, unauthorized or incomplete contribution." });
  }
});
store.expire();
const expiry = setInterval(() => store.expire(), 3600000);
expiry.unref();
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.listen(Number(process.env.INGEST_PORT ?? 4319), "127.0.0.1", () =>
  console.log("Contribution development service: http://127.0.0.1:4319"),
);
