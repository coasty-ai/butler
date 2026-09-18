import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault, digest } from "../src/storage/vault";
import {
  prepareBundle,
  reviewSchema,
  consentVersion,
} from "../src/contribution/bundle";
import {
  uploadBundle,
  deleteContribution,
  type UploadState,
} from "../src/contribution/client";
import { IngestStore, createSchema } from "../services/ingest/store";
import { seedTask, gradeTask, workflowCandidate } from "../src/gym/workflow";
import type { Run } from "../src/core/schema";
const makeRun = (): Run => ({
  id: crypto.randomUUID(),
  task: "Find invoice for jane@example.com",
  createdAt: new Date().toISOString(),
  status: "completed",
  privacy: "PRIVATE_LOCAL",
  provider: "ollama",
  model: "local",
  synthetic: false,
  actions: 1,
  frames: 1,
  usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  summary: "done",
});
const dir = () => mkdtempSync(join(tmpdir(), "open-assist-test-"));
describe("encrypted durable history", () => {
  it("keeps content out of files, chains events and recovers interrupted tails", () => {
    const root = dir(),
      v = new Vault(root, randomBytes(32)),
      r = makeRun();
    r.status = "thinking";
    v.begin(r);
    v.append(r.id, "RunStarted", { text: "private-secret-marker" });
    v.append(r.id, "FrameCaptured");
    const p = join(root, r.id, "events.enc");
    expect(readFileSync(p, "utf8")).not.toContain("private-secret-marker");
    expect(
      readFileSync(join(root, r.id, "run.enc")).includes(
        Buffer.from("jane@example.com"),
      ),
    ).toBe(false);
    appendFileSync(p, "partial-write");
    v.recover();
    expect(v.getRun(r.id).status).toBe("failed");
    expect(v.events(r.id)).toHaveLength(3);
    expect(v.events(r.id)[2].sequence_number).toBe(3);
    v.remove(r.id);
    expect(v.list()).toHaveLength(0);
  });
  it("detects tampered or reordered journal entries", () => {
    const root = dir(),
      v = new Vault(root, randomBytes(32)),
      r = makeRun();
    v.begin(r);
    v.append(r.id, "RunStarted");
    v.append(r.id, "RunCompleted");
    const p = join(root, r.id, "events.enc"),
      lines = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, lines.reverse().join("\n") + "\n");
    expect(() => v.events(r.id)).toThrow();
  });
  it("rejects traversal through run IDs", () =>
    expect(() =>
      new Vault(dir(), randomBytes(32)).getRun("../config"),
    ).toThrow());
});
describe("review and consent", () => {
  it("never allows consent to default to true", () =>
    expect(
      reviewSchema.safeParse({
        runId: crypto.randomUUID(),
        level: "statistics",
        excludedFrames: [],
        excludedEvents: [],
      }).success,
    ).toBe(false));
  it("redacts task identifiers, removes private images and excludes selected actions", () => {
    const r = makeRun(),
      e: any = {
        event_id: crypto.randomUUID(),
        type: "ActionExecuted",
        data: {
          action: {
            type: "type_text",
            text: "jane@example.com",
            frame_id: "local",
          },
        },
      },
      f: any = { id: "frame", synthetic: false, image: "SECRET_SCREEN" };
    const b = prepareBundle(r, [e], [f], {
      runId: r.id,
      level: "trajectory",
      excludedFrames: [],
      excludedEvents: [e.event_id],
    });
    expect(b.task).not.toContain("jane@example.com");
    expect(b.frames).toHaveLength(0);
    expect(b.steps).toHaveLength(0);
    expect(JSON.stringify(b)).not.toContain("SECRET_SCREEN");
  });
  it("statistics bundle contains no task, steps, screenshots or arbitrary model identifier", () => {
    const r = makeRun();
    r.model = "my-private-file";
    const b = prepareBundle(r, [], [], {
      runId: r.id,
      level: "statistics",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(b.task).toBeUndefined();
    expect(b.steps).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("my-private-file");
  });
});
function ingestHarness() {
  const store = new IngestStore(dir(), randomBytes(32));
  let requests = 0;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    requests++;
    const p = new URL(url).pathname.split("/").filter(Boolean),
      body = init.body ? JSON.parse(String(init.body)) : undefined,
      token =
        (init.headers as any)?.Authorization?.replace("Bearer ", "") ?? "";
    try {
      let result;
      if (p.length === 1 && init.method === "POST") result = store.create(body);
      else if (p.length === 2 && init.method === "GET")
        result = store.status(p[1], token);
      else if (p[2] === "chunks")
        result = store.chunk(p[1], Number(p[3]), token, body);
      else if (p[2] === "commit") result = store.commit(p[1], token);
      else if (init.method === "DELETE") result = store.delete(p[1], token);
      else throw Error("bad route");
      return new Response(JSON.stringify(result), { status: 200 });
    } catch {
      return new Response("{}", { status: 400 });
    }
  }) as typeof fetch;
  return { store, fetcher, getCount: () => requests };
}
describe("resumable upload protocol", () => {
  it("uploads, verifies receipt and deletes encrypted contribution", async () => {
    const h = ingestHarness(),
      r = makeRun(),
      bundle = prepareBundle(r, [], [], {
        runId: r.id,
        level: "trajectory",
        excludedFrames: [],
        excludedEvents: [],
      });
    let state: UploadState | undefined;
    const result = await uploadBundle(
      bundle,
      "http://127.0.0.1:4319",
      state,
      (s) => (state = s),
      h.fetcher,
    );
    expect(result.receipt).toHaveLength(64);
    expect(h.store.status(result.id, result.token).committed).toBe(true);
    await deleteContribution(result, h.fetcher);
    expect(() => h.store.status(result.id, result.token)).toThrow();
  });
  it("resumes after the initial create response is lost and handles duplicate chunks", async () => {
    const h = ingestHarness(),
      r = makeRun(),
      b = prepareBundle(r, [], [], {
        runId: r.id,
        level: "statistics",
        excludedFrames: [],
        excludedEvents: [],
      });
    let state: UploadState | undefined,
      first = true;
    const unreliable = (async (...a: Parameters<typeof fetch>) => {
      const result = await h.fetcher(...a);
      if (first) {
        first = false;
        throw Error("Network lost");
      }
      return result;
    }) as typeof fetch;
    await expect(
      uploadBundle(
        b,
        "http://127.0.0.1:4319",
        undefined,
        (s) => (state = s),
        unreliable,
      ),
    ).rejects.toThrow();
    const result = await uploadBundle(
      b,
      "http://127.0.0.1:4319",
      state,
      (s) => (state = s),
      h.fetcher,
    );
    expect(result.receipt).toBeTruthy();
    const bytes = Buffer.from(JSON.stringify(b));
    expect(
      h.store.chunk(result.id, 0, result.token, {
        data: bytes.toString("base64"),
        sha256: digest(bytes),
      }).sha256,
    ).toBe(digest(bytes));
  });
  it("refuses missing chunks, forged tokens, missing consent and invalid checksums", () => {
    const h = ingestHarness(),
      id = crypto.randomUUID(),
      token = randomBytes(32).toString("hex"),
      bytes = Buffer.from("{}"),
      hash = digest(bytes),
      create = {
        id,
        token,
        manifest: { sha256: hash, bytes: 2, chunks: 1 },
        consent: {
          version: consentVersion,
          run_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          data_classes: ["statistics"],
          purpose: "computer-use-research-and-synthetic-environments",
          retention: "alpha-7-days",
          bundle_sha256: hash,
        },
      };
    expect(() => h.store.create({ ...create, consent: undefined })).toThrow();
    h.store.create(create);
    expect(() => h.store.commit(id, token)).toThrow();
    expect(() => h.store.status(id, "forged")).toThrow();
    expect(() =>
      h.store.chunk(id, 0, token, { data: "YWI=", sha256: hash }),
    ).toThrow();
  });
  it("fails checksum mismatch even after HTTP success and retains local state", async () => {
    const r = makeRun(),
      b = prepareBundle(r, [], [], {
        runId: r.id,
        level: "statistics",
        excludedFrames: [],
        excludedEvents: [],
      });
    let state: UploadState | undefined;
    const fake = (async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/contributions")
            ? {}
            : url.includes("/chunks/")
              ? { sha256: "wrong" }
              : { acked: [] },
        ),
      )) as typeof fetch;
    await expect(
      uploadBundle(
        b,
        "http://127.0.0.1:4319",
        undefined,
        (s) => (state = s),
        fake,
      ),
    ).rejects.toThrow("checksum");
    expect(state?.receipt).toBeUndefined();
  });
});
describe("synthetic Gym", () => {
  it("resets deterministically and grades exact result with untouched distractor", () => {
    const task = seedTask(42);
    expect(seedTask(42)).toEqual(task);
    expect(seedTask(43)).not.toEqual(task);
    expect(
      gradeTask(task, task.expected, [{ type: "drag" }, { type: "type_text" }])
        .pass,
    ).toBe(true);
    expect(gradeTask(task, task.initial, [{ type: "drag" }]).pass).toBe(false);
    const damaged = structuredClone(task.expected);
    damaged.cards[1].note = "tampered";
    expect(gradeTask(task, damaged, [{ type: "drag" }]).pass).toBe(false);
    expect(gradeTask(task, task.expected, [{ type: "shell" }]).pass).toBe(
      false,
    );
    expect(gradeTask(task, task.expected, []).pass).toBe(false);
    expect(
      gradeTask(task, task.expected, [{ type: "open_app" }, { type: "drag" }])
        .pass,
    ).toBe(true);
    expect(
      gradeTask(task, task.expected, [{ type: "drag" }, { type: "fail" }]).pass,
    ).toBe(false);
  });
  it("exports opened applications only as an abstract slot", () => {
    const r = makeRun(),
      e: any = {
        event_id: crypto.randomUUID(),
        type: "ActionExecuted",
        data: {
          action: {
            type: "open_app",
            name: "Acme Private CRM",
            frame_id: "local",
          },
          launched: {
            appId: "com.acme.private-crm",
            name: "Acme Private CRM",
            frontmost: true,
            wasRunning: false,
          },
        },
      },
      typed: any = {
        event_id: crypto.randomUUID(),
        type: "ActionExecuted",
        data: {
          action: { type: "type_text", text: "hello", frame_id: "local" },
        },
      };
    const b = prepareBundle(r, [e, typed], [], {
      runId: r.id,
      level: "trajectory",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(b.steps?.[0]).toEqual({ type: "open_app", name: "<APP>" });
    expect(JSON.stringify(b)).not.toContain("Acme");
    expect(JSON.stringify(b)).not.toContain("com.acme");
    expect(JSON.stringify(b)).not.toContain("launched");
    const candidate = workflowCandidate(b, "receipt");
    expect(candidate.ordered_steps).toEqual([
      { action: "open_app", app_slot: "<APP>" },
      { action: "type_text", input_slot: "<TEXT>" },
    ]);
    expect(candidate.input_slots).toEqual(["<TEXT>", "<APP>"]);
    expect(JSON.stringify(candidate)).not.toContain("Acme");
    expect(
      workflowCandidate({ ...b, steps: [] }, "receipt").input_slots,
    ).toEqual(["<TEXT>"]);
  });
  it("exports opened files only as an abstract slot", () => {
    const r = makeRun(),
      opened: any = {
        event_id: crypto.randomUUID(),
        type: "ActionExecuted",
        data: {
          action: {
            type: "open_file",
            path: "~/Documents/Jane Private/Salary 2026.xlsx",
            frame_id: "local",
          },
          opened: {
            path: "~/Documents/Jane Private/Salary 2026.xlsx",
            kind: "document",
            appId: "com.microsoft.Excel",
          },
        },
      },
      app: any = {
        event_id: crypto.randomUUID(),
        type: "ActionExecuted",
        data: { action: { type: "open_app", name: "Acme", frame_id: "l" } },
      },
      typed: any = {
        event_id: crypto.randomUUID(),
        type: "ActionExecuted",
        data: {
          action: { type: "type_text", text: "hello", frame_id: "local" },
        },
      };
    const b = prepareBundle(r, [opened, typed], [], {
      runId: r.id,
      level: "trajectory",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(b.steps?.[0]).toEqual({ type: "open_file", path: "<FILE>" });
    const json = JSON.stringify(b);
    for (const leaked of [
      "Salary",
      "Jane",
      "Documents",
      "~/",
      "Excel",
      "opened",
    ])
      expect(json).not.toContain(leaked);
    const candidate = workflowCandidate(b, "receipt");
    expect(candidate.ordered_steps).toEqual([
      { action: "open_file", file_slot: "<FILE>" },
      { action: "type_text", input_slot: "<TEXT>" },
    ]);
    expect(candidate.input_slots).toEqual(["<TEXT>", "<FILE>"]);
    expect(JSON.stringify(candidate)).not.toContain("Salary");
    const both = prepareBundle(r, [app, opened], [], {
      runId: r.id,
      level: "trajectory",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(workflowCandidate(both, "receipt").input_slots).toEqual([
      "<TEXT>",
      "<APP>",
      "<FILE>",
    ]);
    // An application named to open the item in is masked like a launched one.
    const openedIn: any = {
      event_id: crypto.randomUUID(),
      type: "ActionExecuted",
      data: {
        action: {
          type: "open_file",
          path: "~/work/proj",
          app: "Acme Internal Tool",
          frame_id: "local",
        },
      },
    };
    const named = prepareBundle(r, [openedIn], [], {
      runId: r.id,
      level: "trajectory",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(named.steps?.[0]).toEqual({
      type: "open_file",
      path: "<FILE>",
      app: "<APP>",
    });
    expect(JSON.stringify(named)).not.toContain("Acme");
    // Statistics bundles contain no steps at all.
    const stats = prepareBundle(r, [opened], [], {
      runId: r.id,
      level: "statistics",
      excludedFrames: [],
      excludedEvents: [],
    });
    expect(JSON.stringify(stats)).not.toContain("Salary");
    expect(
      gradeTask(seedTask(1), seedTask(1).expected, [
        { type: "open_file" },
        { type: "drag" },
      ]).pass,
    ).toBe(true);
  });
  it("requires a receipt and never exports raw source text", () => {
    const r = makeRun(),
      b = prepareBundle(r, [], [], {
        runId: r.id,
        level: "trajectory",
        excludedFrames: [],
        excludedEvents: [],
      });
    expect(() => workflowCandidate(b, "")).toThrow();
    expect(JSON.stringify(workflowCandidate(b, "receipt"))).not.toContain(
      "jane",
    );
  });
});
