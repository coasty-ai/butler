import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  existsSync,
  rmSync,
  renameSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import type { Frame, JournalEvent, Recorder, Run } from "../core/schema";
export function seal(key: Buffer, data: Buffer, aad: string): Buffer {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), encrypted]);
}
export function unseal(key: Buffer, data: Buffer, aad: string): Buffer {
  if (data.length < 28) throw new Error("Invalid encrypted object");
  const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}
export const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
export class Vault implements Recorder {
  constructor(
    readonly root: string,
    private key: Buffer,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private dir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run id");
    return join(this.root, id);
  }
  private put(path: string, data: unknown, aad: string) {
    const tmp = path + ".tmp";
    writeFileSync(tmp, seal(this.key, Buffer.from(JSON.stringify(data)), aad), {
      mode: 0o600,
    });
    renameSync(tmp, path);
  }
  private get<T>(path: string, aad: string): T {
    return JSON.parse(unseal(this.key, readFileSync(path), aad).toString());
  }
  begin(run: Run) {
    mkdirSync(this.dir(run.id), { recursive: true, mode: 0o700 });
    this.save(run);
  }
  save(run: Run) {
    this.put(join(this.dir(run.id), "run.enc"), run, run.id);
  }
  list(): Run[] {
    return readdirSync(this.root)
      .filter((x) => /^[a-f0-9-]{36}$/.test(x))
      .flatMap((id) => {
        try {
          return [this.getRun(id)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  getRun(id: string): Run {
    return this.get(join(this.dir(id), "run.enc"), id);
  }
  events(id: string): JournalEvent[] {
    const path = join(this.dir(id), "events.enc");
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const complete = lines.slice(0, -1);
    if (lines.at(-1))
      truncateSync(
        path,
        Buffer.byteLength(complete.join("\n") + (complete.length ? "\n" : "")),
      );
    let previous = "";
    return complete.map((line, i) => {
      const entry = this.getEvent(line, id, i + 1, previous);
      previous = digest(line);
      return entry;
    });
  }
  private getEvent(
    line: string,
    id: string,
    n: number,
    prev: string,
  ): JournalEvent {
    const item = JSON.parse(
      unseal(
        this.key,
        Buffer.from(line, "base64"),
        `${id}:${n}:${prev}`,
      ).toString(),
    );
    if (item.sequence_number !== n) throw new Error("Invalid journal sequence");
    return item;
  }
  append(
    id: string,
    type: string,
    data: Record<string, unknown> = {},
  ): JournalEvent {
    const existing = this.events(id),
      path = join(this.dir(id), "events.enc"),
      n = existing.length + 1;
    const prev = existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").at(-1)
      : undefined;
    const event: JournalEvent = {
      event_id: randomUUID(),
      run_id: id,
      sequence_number: n,
      monotonic_timestamp: performance.now(),
      wall_clock_timestamp: new Date().toISOString(),
      schema_version: 1,
      type,
      data,
    };
    appendFileSync(
      path,
      seal(
        this.key,
        Buffer.from(JSON.stringify(event)),
        `${id}:${n}:${prev ? digest(prev) : ""}`,
      ).toString("base64") + "\n",
      { mode: 0o600 },
    );
    return event;
  }
  frame(id: string, frame: Frame) {
    const path = join(this.dir(id), frame.sha256 + ".frame");
    if (!existsSync(path)) this.put(path, frame, `${id}:${frame.sha256}`);
  }
  frames(id: string): Frame[] {
    return readdirSync(this.dir(id))
      .filter((x) => x.endsWith(".frame"))
      .map((x) =>
        this.get<Frame>(join(this.dir(id), x), `${id}:${x.slice(0, -6)}`),
      )
      .sort((a, b) => a.capturedAt - b.capturedAt);
  }
  remove(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true });
  }
  saveContribution(id: string, bundle: unknown) {
    this.put(
      join(this.dir(id), "contribution.enc"),
      bundle,
      `${id}:contribution`,
    );
  }
  contribution<T>(id: string): T {
    return this.get<T>(
      join(this.dir(id), "contribution.enc"),
      `${id}:contribution`,
    );
  }
  recover() {
    for (const run of this.list()) {
      if (!["completed", "failed", "cancelled"].includes(run.status)) {
        this.events(run.id);
        run.status = "failed";
        run.summary =
          "Interrupted by an application restart. No actions were replayed.";
        this.append(run.id, "RunFailed", { code: "PROCESS_RESTART" });
        this.save(run);
      }
    }
  }
}
