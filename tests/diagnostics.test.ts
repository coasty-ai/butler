import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiagnostics } from "../electron/diagnostics";
import { trace } from "../src/core/diagnostics";
import type { Snapshot } from "../src/core/schema";

function fixture(
  run: (log: LocalDiagnostics, directory: string, output: string[]) => void,
  maxBytes?: number,
) {
  const directory = mkdtempSync(join(tmpdir(), "assist-diagnostics-"));
  const output: string[] = [];
  try {
    run(
      new LocalDiagnostics(
        directory,
        () => ["fixture-secret-value"],
        (line) => output.push(line),
        maxBytes,
      ),
      directory,
      output,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
describe("local diagnostic stream", () => {
  it("preserves UUID correlation IDs while redacting phone-like text", () =>
    fixture((log) => {
      const id = "dda590c3-1234-4567-8cd6-c0e751c0cd36";
      log.write("Test", { requestId: id, error: "Call 555-123-4567" });
      const event = JSON.parse(readFileSync(log.file, "utf8"));
      expect(event.data.requestId).toBe(id);
      expect(event.data.error).not.toContain("555-123-4567");
    }));
  it("redacts known keys and sensitive error text, excluding content payloads", () =>
    fixture((log, directory, output) => {
      log.write("ProviderTransportError", {
        error:
          "fixture-secret-value email person@example.com https://secret.test/path",
        cause: { error: "Bearer supersecret-token" },
        headers: { Authorization: "fixture-secret-value" },
        task: "private task",
        image: "private screenshot",
        text: "private typed text",
        durationMs: 123,
      });
      const raw = readFileSync(log.file, "utf8");
      for (const secret of [
        "fixture-secret-value",
        "person@example.com",
        "secret.test",
        "supersecret-token",
        "private task",
        "private screenshot",
        "private typed text",
      ])
        expect(raw).not.toContain(secret);
      expect(JSON.parse(raw).data.durationMs).toBe(123);
      expect(output.join("")).toBe(raw);
      expect(statSync(log.file).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }));
  it("rotates bounded files without losing the newest event", () =>
    fixture((log, directory) => {
      for (let i = 0; i < 30; i++) log.write("Tick", { attempt: i });
      expect(readdirSync(directory).length).toBeLessThanOrEqual(4);
      const lines = readFileSync(log.file, "utf8").trim().split("\n");
      expect(JSON.parse(lines.at(-1)!).data.attempt).toBe(29);
      for (const name of readdirSync(directory))
        expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }, 400));
  it("emits each journal event/state once without persisting task or typed text", () =>
    fixture((log) => {
      const snapshot: Snapshot = {
        run: {
          id: crypto.randomUUID(),
          task: "hidden task",
          createdAt: new Date().toISOString(),
          status: "executing",
          privacy: "PRIVATE_LOCAL",
          provider: "tutorial",
          model: "Scripted tutorial",
          synthetic: true,
          actions: 0,
          frames: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          summary: "",
        },
        frame: null,
        message: "hidden message",
        events: [],
      };
      snapshot.events.push({
        event_id: crypto.randomUUID(),
        run_id: snapshot.run!.id,
        sequence_number: 1,
        monotonic_timestamp: 0,
        wall_clock_timestamp: new Date().toISOString(),
        schema_version: 1,
        type: "ActionProposed",
        data: { action: { type: "type_text", text: "hidden typed text" } },
      });
      log.snapshot(snapshot);
      log.snapshot(snapshot);
      const raw = readFileSync(log.file, "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(events.map((x) => x.event)).toEqual([
        "ActionProposed",
        "RunState",
      ]);
      expect(events[0].data.textLength).toBe(17);
      expect(raw).not.toContain("hidden");
    }));
  it("does not let a broken output sink interrupt task execution", () => {
    expect(() =>
      trace(() => {
        throw Error("Disk full");
      }, "Test"),
    ).not.toThrow();
    fixture((log) => {
      const data: Record<string, unknown> = {};
      data.cause = data;
      expect(() => log.write("Cycle", data)).not.toThrow();
    });
  });
});
