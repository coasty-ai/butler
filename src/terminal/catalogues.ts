import type { Tool } from "@modelcontextprotocol/client";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { digest, seal, unseal } from "../storage/vault";

const MAX_BYTES = 128 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const tools = (value: unknown): value is Tool[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 64 &&
  new Set(value.map((t) => (object(t) ? t.name : undefined))).size ===
    value.length &&
  value.every(
    (t) =>
      object(t) &&
      typeof t.name === "string" &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(t.name) &&
      object(t.inputSchema) &&
      t.inputSchema.type === "object" &&
      (t.title === undefined || typeof t.title === "string") &&
      (t.description === undefined || typeof t.description === "string") &&
      (t.annotations === undefined || object(t.annotations)),
  );

/** Encrypted discovery data, never authority to execute a cached tool. */
export class McpCatalogues {
  constructor(
    private root: string,
    private key: Buffer,
    private now = Date.now,
  ) {}

  read(id: string, signature: string): Tool[] | undefined {
    if (!ID.test(id)) return;
    const file = join(this.root, id + ".enc");
    try {
      if (!existsSync(file) || statSync(file).size > MAX_BYTES + 28) return;
      const saved: unknown = JSON.parse(
        unseal(
          this.key,
          readFileSync(file),
          "terminal-catalogue:" + id,
        ).toString(),
      );
      if (
        !object(saved) ||
        saved.signature !== digest(signature) ||
        typeof saved.at !== "number" ||
        !Number.isFinite(saved.at) ||
        saved.at > this.now() ||
        this.now() - saved.at >= MAX_AGE ||
        !tools(saved.tools)
      )
        return;
      return saved.tools;
    } catch {
      return;
    }
  }

  save(id: string, signature: string, listed: readonly Tool[]) {
    if (!ID.test(id) || !tools(listed)) return;
    const data = Buffer.from(
      JSON.stringify({
        signature: digest(signature),
        at: this.now(),
        tools: listed,
      }),
    );
    if (data.length > MAX_BYTES) return;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, id + ".enc");
    writeFileSync(
      file + ".tmp",
      seal(this.key, data, "terminal-catalogue:" + id),
      { mode: 0o600 },
    );
    renameSync(file + ".tmp", file);
  }
}
