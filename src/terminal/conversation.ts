import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Settings } from "../core/schema";
import { redactSecrets, scanText } from "../core/sanitize";
import type { TurnRecord } from "../assistant/types";
import { seal, unseal } from "../storage/vault";

const MAX_TURNS = 24;
const TTL = 24 * 60 * 60_000;
const MAX_BYTES = 64 * 1024;
const channels = new Set(["app", "voice", "message", "remote"]);

/** A bounded encrypted thread, separate from learned preferences and task authority. */
export class TerminalConversation {
  private file: string;
  constructor(
    root: string,
    private key: Buffer,
    private settings: () => Settings,
    private now = Date.now,
  ) {
    this.file = join(root, "conversation.enc");
  }
  private scope() {
    const s = this.settings();
    return JSON.stringify([s.privacy, s.provider, s.model, s.dialogModel]);
  }
  private bounded(turns: unknown): TurnRecord[] {
    if (!Array.isArray(turns)) return [];
    const now = this.now();
    return turns.slice(-MAX_TURNS).flatMap((t) => {
      if (
        !t ||
        !["user", "assistant"].includes(t.role) ||
        !channels.has(t.channel) ||
        typeof t.text !== "string" ||
        typeof t.untrusted !== "boolean" ||
        !Number.isFinite(t.at) ||
        t.at > now + 5000 ||
        now - t.at >= TTL ||
        scanText(t.text).some((f) => f.action === "BLOCK_UPLOAD")
      )
        return [];
      const text = redactSecrets(t.text)
        .trim()
        .slice(0, t.role === "user" ? 2000 : 1600);
      return text
        ? [
            {
              role: t.role,
              channel: t.channel,
              text,
              at: t.at,
              untrusted: t.untrusted,
            },
          ]
        : [];
    });
  }
  load(): TurnRecord[] {
    if (!this.settings().memory || !existsSync(this.file)) return [];
    try {
      if (statSync(this.file).size > MAX_BYTES) return [];
      const bytes = readFileSync(this.file);
      if (bytes.length > MAX_BYTES) return [];
      const record = JSON.parse(
        unseal(this.key, bytes, "terminal-conversation").toString(),
      );
      return record.scope === this.scope() ? this.bounded(record.turns) : [];
    } catch {
      return [];
    }
  }
  save(turns: TurnRecord[]) {
    const bounded = this.bounded(turns);
    if (!this.settings().memory || !bounded.length) {
      rmSync(this.file, { force: true });
      return;
    }
    const bytes = seal(
      this.key,
      Buffer.from(JSON.stringify({ scope: this.scope(), turns: bounded })),
      "terminal-conversation",
    );
    if (bytes.length > MAX_BYTES) return;
    writeFileSync(this.file + ".tmp", bytes, { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
}
