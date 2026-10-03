import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../src/core/schema";
import { providerDiagnostics, probeModel } from "../src/terminal/doctor";

const roots: string[] = [];
afterEach(() => {
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});
const settings = {
  ...defaultSettings,
  provider: "openai" as const,
  privacy: "PRIVATE_BYOM" as const,
  model: "gpt-6.1-sol",
  endpoint: "https://api.openai.com",
  openaiServiceTier: "fast" as const,
  inputPrice: 4,
  outputPrice: 20,
};
test("dialogue traces keep context counts and fixed decisions without words or arbitrary codes", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-dialog-trace-"));
  roots.push(root);
  const trace = providerDiagnostics(root, () => []);
  trace("DialogTurn", {
    phase: "turn",
    channel: "voice",
    turns: 12,
    text: "Private fixture message",
  });
  trace("DialogTurn", {
    phase: "decided",
    code: "timeout",
    actMs: 100,
    task: "Private fixture task",
  });
  trace("DialogTurn", {
    phase: "Private fixture phase",
    code: "PRIVATE_BODY_FIXTURE",
    turns: "Private fixture turns",
  });
  trace("TextFailed", { code: "parse", error: "Private fixture error" });
  const records = readFileSync(join(root, "current.jsonl"), "utf8");
  expect(records).not.toContain("Private");
  expect(records).not.toContain("PRIVATE_BODY_FIXTURE");
  const rows = records
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s).data);
  expect(rows[0]).toEqual({ phase: "turn", channel: "voice", turns: 12 });
  expect(rows[1]).toEqual({ phase: "decided", code: "timeout", actMs: 100 });
  expect(rows[2]).toEqual({});
  expect(rows[3]).toEqual({ code: "parse" });
});
test("voice diagnostics retain finite measurements and fixed phases, never speech", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-voice-trace-"));
  roots.push(root);
  const trace = providerDiagnostics(root, () => []);
  trace("VoiceInput", {
    phase: "transcript_final",
    confidence: 0.9,
    segments: 1,
    micLevel: 0.2,
    textLength: 27,
    text: "Private fixture sentence",
  });
  trace("VoiceInput", {
    phase: "Private fixture phase",
    confidence: "Private fixture confidence",
    segments: "Private fixture segments",
    micLevel: "Private fixture level",
    error: "Private fixture error",
  });
  const records = readFileSync(join(root, "current.jsonl"), "utf8");
  expect(records).not.toContain("Private");
  expect(
    records
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).data),
  ).toEqual([
    {
      phase: "transcript_final",
      confidence: 0.9,
      segments: 1,
      micLevel: 0.2,
      textLength: 27,
    },
    {},
  ]);
});
test("CLI provider diagnostics retain transport and HTTP codes, never tasks, images or raw errors", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-doctor-test-"));
  roots.push(root);
  const trace = providerDiagnostics(root, () => ["synthetic-secret-value"]);
  trace("ProviderTransportError", {
    attempt: 2,
    durationMs: 100,
    retryable: true,
    code: "ECONNRESET",
    error: "private response fixture",
    cause: { code: "ECONNRESET", error: "synthetic-secret-value" },
    task: "private task fixture",
    image: "data:image/png;base64,fixture",
    requestId: "private request fixture",
  });
  trace("ProviderHeaders", {
    httpStatus: 503,
    attempt: 1,
    model: "gpt-6.1-sol",
    provider: "openai",
  });
  trace("ProviderTransportError", {
    code: "ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC",
    error: "private TLS error fixture",
  });
  trace("ProviderFailed", {
    code: "PRIVATE_BODY_FIXTURE",
    error: "private response fixture",
  });
  const text = readFileSync(join(root, "current.jsonl"), "utf8");
  expect(text).toContain("ECONNRESET");
  expect(text).toContain("ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC");
  expect(text).toContain('"httpStatus":503');
  for (const value of [
    "private",
    "synthetic-secret-value",
    "data:image",
    "PRIVATE_BODY_FIXTURE",
  ])
    expect(text).not.toContain(value);
});
test("model check uses a generated PNG through the configured Fast vision/tool transport", async () => {
  const request = vi.fn(async () =>
    Response.json({
      output: [
        {
          type: "function_call",
          name: "coarena_action",
          arguments: JSON.stringify({
            action: {
              type: "done",
              frame_id: "fixture",
              summary: "Synthetic connection result",
            },
          }),
        },
      ],
    }),
  );
  const result = await probeModel(
    settings,
    "synthetic-key",
    undefined,
    request,
  );
  expect(result).toMatchObject({ reachable: true, usableReply: true });
  const [url, init] = request.mock.calls[0] as any;
  expect(url).toBe("https://api.openai.com/v1/responses");
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({
    model: "gpt-6.1-sol",
    service_tier: "fast",
    reasoning: { effort: "low" },
  });
  const input = body.input[0].content.find(
    (part: any) => part.type === "input_image",
  );
  const png = Buffer.from(input.image_url.split(",")[1], "base64");
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(png.readUInt32BE(16)).toBe(256);
  expect(body.tools[0].name).toBe("coarena_action");
});
test("model check reports access errors and permanent billing limits without response bodies", async () => {
  for (const status of [401, 403]) {
    const result = await probeModel(
      settings,
      "synthetic-key",
      undefined,
      vi.fn(async () => new Response("private response fixture", { status })),
    );
    expect(result.reachable).toBe(false);
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.error).not.toContain("private");
  }
  const request = vi.fn(async () =>
    Response.json(
      {
        error: {
          code: "project_spend_limit_exceeded",
          message: "private response fixture",
        },
      },
      { status: 429 },
    ),
  );
  const result = await probeModel(
    settings,
    "synthetic-key",
    undefined,
    request,
  );
  expect(result).toMatchObject({
    reachable: false,
    error:
      "Provider quota or billing limit reached. Check your plan and credits.",
  });
  expect(request).toHaveBeenCalledOnce();
});
test("model check explains a Retry-After that exceeds its deadline and cancellation stays bounded", async () => {
  const request = vi.fn(
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "90" } }),
  );
  expect(
    await probeModel(settings, "synthetic-key", undefined, request),
  ).toMatchObject({
    reachable: false,
    error: expect.stringContaining("Wait 90 seconds"),
  });
  expect(request).toHaveBeenCalledOnce();
  const controller = new AbortController();
  controller.abort();
  expect(
    await probeModel(
      settings,
      "synthetic-key",
      undefined,
      request,
      controller.signal,
    ),
  ).toMatchObject({
    reachable: false,
    error: expect.stringContaining("cancelled"),
  });
  expect(request).toHaveBeenCalledOnce();
});
