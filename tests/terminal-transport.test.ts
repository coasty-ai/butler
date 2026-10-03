import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { nativeModelFetch } from "../src/terminal/transport";
import { networkFailure } from "../src/providers/network";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let config = "";
  child.stdin.on("data", (chunk) => {
    config += chunk.toString();
  });
  const launch = vi.fn(() => child);
  const fallback = vi.fn();
  const request = nativeModelFetch(fallback as any, "darwin", launch as any);
  return { child, launch, fallback, request, config: () => config };
}
const init = {
  method: "POST",
  body: JSON.stringify({ text: 'Synthetic "quoted" text\nwith \\ backslash' }),
  headers: { Authorization: "Bearer synthetic-secret" },
  redirect: "error" as const,
};

test("streams a split HTTP response, keeps credentials on stdin and disables user curl configuration", async () => {
  const f = fixture();
  const response = f.request("https://example.test/v1/responses", init);
  expect(f.launch).toHaveBeenCalledWith(
    "/usr/bin/curl",
    ["-q", "--config", "-"],
    { stdio: "pipe" },
  );
  expect(JSON.stringify(f.launch.mock.calls)).not.toContain("synthetic-secret");
  expect(f.config()).toContain(
    'header = "authorization: Bearer synthetic-secret"',
  );
  expect(f.config()).not.toMatch(/insecure|location|output|verbose/);
  f.child.stdout.write("HTTP/2 200\r\ncontent-type: text/event-stream\r\n");
  f.child.stdout.write("\r\ndata: first\n\n");
  const result = await response;
  expect(result.status).toBe(200);
  const reader = result.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    "data: first\n\n",
  );
  f.child.stdout.write("data: second\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    "data: second\n\n",
  );
  f.child.emit("close", 0);
  expect((await reader.read()).done).toBe(true);
});
test("an informational response is skipped and non-success HTTP status reaches provider classification", async () => {
  const f = fixture();
  const response = f.request("https://example.test", init);
  f.child.stdout.write(
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nRetry-After: 20\r\n\r\n{}",
  );
  const result = await response;
  expect(result.status).toBe(429);
  expect(result.headers.get("retry-after")).toBe("20");
  f.child.emit("close", 0);
  expect(await result.json()).toEqual({});
});
test("redirects cannot forward model credentials", async () => {
  const f = fixture();
  const response = f.request("https://example.test", init);
  const rejected = expect(response).rejects.toMatchObject({
    code: "ERR_FAILED_REDIRECT",
  });
  f.child.stdout.write("HTTP/2 302\r\nlocation: https://other.test\r\n\r\n");
  await rejected;
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.config()).not.toContain("location =");
});
test("abort kills the request before headers and never exposes the abort reason", async () => {
  const f = fixture(),
    controller = new AbortController();
  const response = f.request("https://example.test", {
    ...init,
    signal: controller.signal,
  });
  const rejected = expect(response).rejects.toMatchObject({
    name: "AbortError",
    message: "Cancelled.",
  });
  controller.abort("private reason");
  await rejected;
  expect(f.child.kill).toHaveBeenCalledOnce();
});
test("abort and body cancellation terminate an already streaming request", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(),
      controller = new AbortController();
    const response = f.request("https://example.test", {
      ...init,
      signal: controller.signal,
    });
    f.child.stdout.write("HTTP/2 200\r\n\r\n");
    const result = await response;
    if (cancel) await result.body!.cancel();
    else {
      controller.abort();
      await expect(result.text()).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(f.child.kill).toHaveBeenCalledOnce();
    f.child.emit("close", null);
  }
});
test("transport failure after headers rejects the body with a fixed code, never curl stderr", async () => {
  const f = fixture();
  const response = f.request("https://example.test", init);
  f.child.stdout.write("HTTP/2 200\r\n\r\n");
  const result = await response;
  f.child.stderr.write("sensitive proxy and credential information");
  f.child.emit("close", 60);
  await expect(result.text()).rejects.toMatchObject({
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    message: "Model connection failed.",
  });
  expect(
    networkFailure(
      Object.assign(new Error("ignored"), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      }),
    ).retryable,
  ).toBe(false);
});
test("header overflow is bounded before any response is accepted", async () => {
  const f = fixture();
  const response = f.request("https://example.test", init);
  const rejected = expect(response).rejects.toMatchObject({
    code: "UND_ERR_HEADERS_OVERFLOW",
  });
  f.child.stdout.write("x".repeat(32769));
  await rejected;
  expect(f.child.kill).toHaveBeenCalledOnce();
});
test("pre-aborted requests never spawn and unsupported platforms retain the injected fetch", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    f.request("https://example.test", { ...init, signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.launch).not.toHaveBeenCalled();
  const fallback = vi.fn();
  expect(nativeModelFetch(fallback as any, "linux")).toBe(fallback);
});
test.skipIf(!existsSync("/usr/bin/curl"))(
  "the real system transport preserves JSON escaping and streams before the server finishes",
  async () => {
    let received = "";
    const server = createServer((request, response) => {
      request.on("data", (chunk) => {
        received += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("data: first\n\n");
        setTimeout(() => response.end("data: second\n\n"), 100);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as { port: number };
      const response = await nativeModelFetch(fetch, "darwin")(
        `http://127.0.0.1:${address.port}`,
        { ...init, signal: AbortSignal.timeout(2000) },
      );
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "data: first\n\n",
      );
      expect(JSON.parse(received)).toEqual(JSON.parse(init.body));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "data: second\n\n",
      );
      expect((await reader.read()).done).toBe(true);
      received = "";
      const literal = await nativeModelFetch(fetch, "darwin")(
        `http://127.0.0.1:${address.port}`,
        {
          ...init,
          body: "@/synthetic-private-file",
          signal: AbortSignal.timeout(2000),
        },
      );
      await literal.text();
      expect(received).toBe("@/synthetic-private-file");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
