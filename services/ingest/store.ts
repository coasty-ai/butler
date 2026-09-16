import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { seal, unseal, digest } from "../../src/storage/vault";
import { consentVersion } from "../../src/contribution/bundle";
import { scanText } from "../../src/core/sanitize";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const createSchema = z
  .object({
    id: z.string().uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: z
      .object({
        sha256: sha,
        bytes: z
          .number()
          .int()
          .min(1)
          .max(20 * 1024 * 1024),
        chunks: z.number().int().min(1).max(80),
      })
      .strict(),
    consent: z
      .object({
        version: z.literal(consentVersion),
        run_id: z.string().uuid(),
        timestamp: z.string().datetime(),
        data_classes: z
          .array(
            z.enum([
              "statistics",
              "sanitized_task",
              "sanitized_actions",
              "corrections",
              "synthetic_frames",
            ]),
          )
          .min(1)
          .max(5),
        purpose: z.literal("computer-use-research-and-synthetic-environments"),
        retention: z.literal("alpha-7-days"),
        bundle_sha256: sha,
      })
      .strict(),
  })
  .strict();
type Stored = {
  id: string;
  tokenHash: string;
  manifest: z.infer<typeof createSchema>["manifest"];
  consent: z.infer<typeof createSchema>["consent"];
  createdAt: number;
  receipt?: string;
};
export class IngestStore {
  constructor(
    private root: string,
    private key: Buffer,
  ) {
    if (key.length !== 32)
      throw new Error("A 32-byte encryption key is required.");
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private dir(id: string) {
    z.string().uuid().parse(id);
    return join(this.root, id);
  }
  private read(id: string): Stored {
    return JSON.parse(
      unseal(
        this.key,
        readFileSync(join(this.dir(id), "manifest.enc")),
        id,
      ).toString(),
    );
  }
  private write(s: Stored) {
    const p = join(this.dir(s.id), "manifest.enc");
    writeFileSync(
      p + ".tmp",
      seal(this.key, Buffer.from(JSON.stringify(s)), s.id),
      { mode: 0o600 },
    );
    renameSync(p + ".tmp", p);
  }
  create(body: unknown) {
    const b = createSchema.parse(body);
    if (
      b.consent.bundle_sha256 !== b.manifest.sha256 ||
      b.manifest.chunks !== Math.ceil(b.manifest.bytes / (256 * 1024))
    )
      throw new Error("Manifest mismatch");
    const time = Date.parse(b.consent.timestamp);
    if (Math.abs(Date.now() - time) > 7 * 86400000)
      throw new Error("Expired consent");
    const path = this.dir(b.id);
    if (existsSync(path)) {
      const s = this.auth(b.id, b.token);
      if (s.manifest.sha256 !== b.manifest.sha256)
        throw new Error("Conflicting manifest");
      return { id: b.id };
    }
    mkdirSync(path, { mode: 0o700 });
    this.write({
      id: b.id,
      tokenHash: digest(b.token),
      manifest: b.manifest,
      consent: b.consent,
      createdAt: Date.now(),
    });
    return { id: b.id };
  }
  auth(id: string, token: string) {
    const s = this.read(id),
      a = Buffer.from(s.tokenHash),
      b = Buffer.from(digest(token));
    if (!timingSafeEqual(a, b)) throw new Error("Unauthorized");
    if (Date.now() - s.createdAt > 7 * 86400000)
      throw new Error("Expired contribution");
    return s;
  }
  status(id: string, token: string) {
    const s = this.auth(id, token);
    return {
      id,
      acked: readdirSync(this.dir(id))
        .filter((x) => /^\d+\.enc$/.test(x))
        .map((x) => Number(x.split(".")[0])),
      committed: !!s.receipt,
    };
  }
  chunk(id: string, index: number, token: string, body: unknown) {
    const s = this.auth(id, token);
    const b = z
      .object({ data: z.string().max(350000), sha256: sha })
      .strict()
      .parse(body);
    if (!Number.isInteger(index) || index < 0 || index >= s.manifest.chunks)
      throw new Error("Invalid chunk");
    const data = Buffer.from(b.data, "base64"),
      expected = Math.min(256 * 1024, s.manifest.bytes - index * 256 * 1024);
    if (data.length !== expected || digest(data) !== b.sha256)
      throw new Error("Checksum mismatch");
    const p = join(this.dir(id), index + ".enc");
    if (
      existsSync(p) &&
      digest(unseal(this.key, readFileSync(p), `${id}:${index}`)) !== b.sha256
    )
      throw new Error("Conflicting chunk");
    writeFileSync(p, seal(this.key, data, `${id}:${index}`), { mode: 0o600 });
    return { index, sha256: b.sha256 };
  }
  commit(id: string, token: string) {
    const s = this.auth(id, token),
      chunks: Buffer[] = [];
    for (let i = 0; i < s.manifest.chunks; i++)
      chunks.push(
        unseal(
          this.key,
          readFileSync(join(this.dir(id), i + ".enc")),
          `${id}:${i}`,
        ),
      );
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== s.manifest.bytes ||
      digest(bytes) !== s.manifest.sha256
    )
      throw new Error("Incomplete or corrupt upload");
    const bundle = JSON.parse(bytes.toString());
    if (
      bundle.version !== 1 ||
      bundle.run_ref !== s.consent.run_id ||
      !["statistics", "trajectory"].includes(bundle.level)
    )
      throw new Error("Invalid bundle");
    if (
      bundle.level === "trajectory" &&
      !s.consent.data_classes.includes("sanitized_task")
    )
      throw new Error("Consent scope mismatch");
    if (
      bundle.corrections?.length &&
      !s.consent.data_classes.includes("corrections")
    )
      throw new Error("Corrections not consented");
    if (
      bundle.frames?.length &&
      !s.consent.data_classes.includes("synthetic_frames")
    )
      throw new Error("Frames not consented");
    if (
      scanText(
        JSON.stringify({
          task: bundle.task,
          steps: bundle.steps,
          corrections: bundle.corrections,
        }),
      ).some((f) => f.action === "BLOCK_UPLOAD")
    )
      throw new Error("Quarantine rejected a detected secret");
    s.receipt = createHmac("sha256", this.key)
      .update(JSON.stringify(s.consent))
      .update(s.manifest.sha256)
      .digest("hex");
    this.write(s);
    return { receipt: s.receipt, sha256: s.manifest.sha256, quarantine: true };
  }
  delete(id: string, token: string) {
    this.auth(id, token);
    rmSync(this.dir(id), { recursive: true, force: true });
    return { deleted: id };
  }
  expire() {
    for (const id of readdirSync(this.root)) {
      if (!z.string().uuid().safeParse(id).success) continue;
      try {
        if (Date.now() - this.read(id).createdAt > 7 * 86400000)
          rmSync(this.dir(id), { recursive: true, force: true });
      } catch {
        /* corrupt objects remain quarantined for an operator */
      }
    }
  }
}
