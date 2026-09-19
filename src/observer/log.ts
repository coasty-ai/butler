/**
 * The work log (.data/design/observer.md §3): what watching saw, encrypted
 * with the vault key like memory (AES-256-GCM, AAD "observer"), one
 * append-only file per local day under <directory>/YYYY-MM-DD.jsonl.enc,
 * each line one sealed event as base64. Every string passes redactSecrets
 * before it is written and a frame that would carry a credential finding is
 * dropped and counted; a day holds at most MAX_DAY_BYTES, frames beyond it
 * are dropped and counted; pictures are written only at tier "pixels" and
 * stripped after 24 h; raw days older than the retention setting are deleted
 * at start and at midnight. pause() writes nothing; forget() deletes files.
 * digest() is counts only, for the report (§7).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "../storage/vault";
import { redactSecrets, scanText } from "../core/sanitize";
import type { ObserverTier } from "../core/schema";
import type { MemoryData } from "../memory/types";
import {
  emptyDayDigest,
  memoryDigest,
  observedEventSchema,
  type DayDigest,
  type ObservedEvent,
  type WorkLogDigest,
} from "./types";

export const OBSERVER_AAD = "observer";
/** The folder under userData. */
export const OBSERVER_DIR = "observer";
export const MAX_DAY_BYTES = 50 * 1024 * 1024;
export const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.enc$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day of a moment, as the file is named. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
/** The day `days` before (or after, negative) a day key, in local time. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + days, 12));
}
/** Milliseconds until the next local midnight (plus a second's slack). */
export function msUntilMidnight(now: Date): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    1,
  );
  return Math.max(1000, next.getTime() - now.getTime());
}

export type DropReason = "size" | "credential" | "invalid" | "paused";
export type AppendResult =
  | { written: true; event: ObservedEvent; bytes: number }
  | { written: false; reason: DropReason };

/** Whether any string in the value carries a credential-shaped span. */
export function carriesCredential(value: unknown): boolean {
  if (typeof value === "string")
    return scanText(value).some((f) => f.action === "BLOCK_UPLOAD");
  if (Array.isArray(value)) return value.some(carriesCredential);
  if (value && typeof value === "object")
    return Object.values(value).some(carriesCredential);
  return false;
}
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  return value;
}
/**
 * The event as the log writes it for the tier in force: an excluded frame
 * keeps only its code, time, application and run id; a picture only at
 * "pixels"; the words only at "text" and above; every string redacted.
 * Undefined when the event is not one of the stream's or carries a
 * credential finding.
 */
export function prepareEvent(
  raw: unknown,
  tier: ObserverTier,
): { event: ObservedEvent } | { drop: "invalid" | "credential" } {
  const parsed = observedEventSchema.safeParse(raw);
  if (!parsed.success) return { drop: "invalid" };
  let event = parsed.data;
  if (event.event === "observe_frame") {
    if (event.excluded)
      event = {
        event: "observe_frame",
        atMs: event.atMs,
        excluded: event.excluded,
        controls: [],
        ...(event.appId ? { appId: event.appId } : {}),
        ...(event.runId && event.excluded === "own_run"
          ? { runId: event.runId }
          : {}),
      };
    else {
      const { image, textDigest, runId: _runId, ...rest } = event;
      event = {
        ...rest,
        ...(tier !== "structure" && textDigest !== undefined
          ? { textDigest }
          : {}),
        ...(tier === "pixels" && image !== undefined ? { image } : {}),
      };
    }
  }
  // The picture is opaque bytes, never text: it is neither scanned nor redacted.
  let image: string | undefined;
  let scanned: ObservedEvent = event;
  if (event.event === "observe_frame" && event.image !== undefined) {
    const { image: picture, ...rest } = event;
    image = picture;
    scanned = rest;
  }
  if (carriesCredential(scanned)) return { drop: "credential" };
  const redacted = redactDeep(scanned);
  if (redacted.event === "observe_frame" && image !== undefined)
    redacted.image = image;
  return { event: redacted };
}

export interface WorkLogOptions {
  /** The observer folder (userData/observer); created on first write. */
  directory: string;
  /** The vault master key. */
  key: Buffer;
  tier: () => ObserverTier;
  retentionDays: () => number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  /** Called after the midnight pass with the day that just ended. */
  onDayEnd?: (day: string) => void;
  /** Memory, for the digest's counts of proposals and replays (counts only). */
  memory?: () =>
    Pick<MemoryData, "routines" | "procedures" | "preferences"> | undefined;
}

export interface WorkLog {
  readonly directory: string;
  readonly paused: boolean;
  /** Writes one event of the stream, or refuses it and says why. */
  append(raw: unknown): AppendResult;
  pause(): void;
  resume(): void;
  /** The helper reported frames dropped at the source: counted, nothing written. */
  noteHelperDrop(count?: number): void;
  /** The days on disk, oldest first. */
  days(): string[];
  /** Every readable event of a day, in file order; a bad line is skipped. */
  read(day: string): ObservedEvent[];
  /** One day's counts. Today's are kept live; another day's are read from its file. */
  dayDigest(day?: string): DayDigest;
  /** Every day's counts and memory's, for the report (design §7). Counts only. */
  digest(): WorkLogDigest;
  /** Bytes on disk over every day. */
  bytes(): number;
  /** Deletes a day's file ("today" for the current day) or every file. */
  forget(scope: string | "all" | "today"): void;
  /** Deletes days past retention and strips pictures older than 24 h. */
  applyRetention(): { removed: string[]; imagesExpired: number };
  /** Arms the midnight pass (retention, day roll, onDayEnd); idempotent. */
  scheduleMidnight(): void;
  close(): void;
}

export function createWorkLog(options: WorkLogOptions): WorkLog {
  const now = options.now ?? (() => new Date());
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting must not break the log.
    }
  };
  let paused = false;
  let midnight: ReturnType<typeof setTimeout> | undefined;
  /** Today's counts, rebuilt from the file when the day is first touched. */
  let current: DayDigest | undefined;
  const pathOf = (day: string) => {
    if (!DAY_KEY.test(day)) throw new Error("Invalid day.");
    return join(options.directory, `${day}.jsonl.enc`);
  };
  const sizeOf = (day: string) => {
    const path = pathOf(day);
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch {
      return 0;
    }
  };
  const count = (into: Record<string, number>, key: string) => {
    into[key] = (into[key] ?? 0) + 1;
  };
  const tally = (digest: DayDigest, event: ObservedEvent) => {
    if (event.event === "observe_frame") {
      if (event.excluded) count(digest.excluded, event.excluded);
      else {
        digest.frames += 1;
        count(digest.apps, event.appId ?? "");
        if (event.image !== undefined) digest.images += 1;
      }
    } else if (event.event === "observe_action") {
      digest.actions += 1;
      count(digest.actionKinds, event.kind);
    } else digest.dropped.helper += event.dropped ?? event.count ?? 1;
  };
  const refuse = (digest: DayDigest, reason: DropReason, raw: unknown) => {
    digest.dropped[reason] += 1;
    digest.framesDropped += 1;
    try {
      digest.bytesDropped += JSON.stringify(raw)?.length ?? 0;
    } catch {
      // A value JSON cannot measure adds nothing.
    }
  };
  const lines = (day: string): string[] => {
    const path = pathOf(day);
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch (error) {
      report(error);
      return [];
    }
  };
  const decode = (line: string): ObservedEvent | undefined => {
    try {
      const parsed = observedEventSchema.safeParse(
        JSON.parse(
          unseal(
            options.key,
            Buffer.from(line, "base64"),
            OBSERVER_AAD,
          ).toString(),
        ),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const encode = (event: ObservedEvent) =>
    seal(
      options.key,
      Buffer.from(JSON.stringify(event)),
      OBSERVER_AAD,
    ).toString("base64") + "\n";
  const read = (day: string): ObservedEvent[] =>
    lines(day)
      .map(decode)
      .filter((e): e is ObservedEvent => !!e);
  const digestOf = (day: string): DayDigest => {
    const digest = emptyDayDigest(day);
    for (const event of read(day)) tally(digest, event);
    digest.bytesWritten = sizeOf(day);
    return digest;
  };
  const today = (): DayDigest => {
    const day = dayKey(now());
    if (!current || current.day !== day) current = digestOf(day);
    return current;
  };
  const write = (day: string, text: string) => {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    appendFileSync(pathOf(day), text, { mode: 0o600 });
  };
  const rewrite = (day: string, events: ObservedEvent[]) => {
    const path = pathOf(day);
    const tmp = path + ".tmp";
    writeFileSync(tmp, events.map(encode).join(""), { mode: 0o600 });
    renameSync(tmp, path);
  };
  const days = (): string[] => {
    if (!existsSync(options.directory)) return [];
    try {
      return readdirSync(options.directory)
        .map((name) => DAY_FILE.exec(name)?.[1])
        .filter((day): day is string => !!day)
        .sort();
    } catch (error) {
      report(error);
      return [];
    }
  };
  const forget = (scope: string) => {
    const targets =
      scope === "all" ? days() : [scope === "today" ? dayKey(now()) : scope];
    for (const day of targets) {
      const path = pathOf(day);
      for (const suffix of ["", ".tmp"]) rmSync(path + suffix, { force: true });
    }
    if (scope === "all" || targets.includes(dayKey(now()))) {
      // Today's counts start over, except what the log itself refused.
      const refused = current
        ? {
            dropped: current.dropped,
            framesDropped: current.framesDropped,
            bytesDropped: current.bytesDropped,
          }
        : undefined;
      current = { ...emptyDayDigest(dayKey(now())), ...refused };
    }
  };
  const applyRetention = () => {
    const at = now();
    const todayKey = dayKey(at);
    const keepFrom = shiftDay(
      todayKey,
      -(Math.max(1, Math.floor(options.retentionDays())) - 1),
    );
    const removed: string[] = [];
    let imagesExpired = 0;
    for (const day of days()) {
      if (day < keepFrom) {
        forget(day);
        removed.push(day);
        continue;
      }
      // Pictures older than a day go, the frame stays.
      const events = read(day);
      const cutoff = at.getTime() - IMAGE_TTL_MS;
      let stripped = 0;
      const kept = events.map((event) => {
        if (
          event.event === "observe_frame" &&
          event.image !== undefined &&
          event.atMs < cutoff
        ) {
          stripped += 1;
          const { image: _image, ...rest } = event;
          return rest as ObservedEvent;
        }
        return event;
      });
      if (stripped) {
        try {
          rewrite(day, kept);
          imagesExpired += stripped;
          if (current?.day === day) {
            current.images = Math.max(0, current.images - stripped);
            current.bytesWritten = sizeOf(day);
          }
        } catch (error) {
          report(error);
        }
      }
    }
    return { removed, imagesExpired };
  };
  const log: WorkLog = {
    directory: options.directory,
    get paused() {
      return paused;
    },
    append(raw) {
      const digest = today();
      if (paused) {
        refuse(digest, "paused", raw);
        return { written: false, reason: "paused" };
      }
      const prepared = prepareEvent(raw, options.tier());
      if ("drop" in prepared) {
        refuse(digest, prepared.drop, raw);
        return { written: false, reason: prepared.drop };
      }
      const line = encode(prepared.event);
      if (digest.bytesWritten + line.length > MAX_DAY_BYTES) {
        refuse(digest, "size", prepared.event);
        return { written: false, reason: "size" };
      }
      try {
        write(digest.day, line);
      } catch (error) {
        report(error);
        refuse(digest, "invalid", prepared.event);
        return { written: false, reason: "invalid" };
      }
      digest.bytesWritten += line.length;
      tally(digest, prepared.event);
      return { written: true, event: prepared.event, bytes: line.length };
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    noteHelperDrop(n = 1) {
      today().dropped.helper += Math.max(0, Math.floor(n));
    },
    days,
    read,
    dayDigest(day) {
      if (!day || day === dayKey(now())) return structuredClone(today());
      return digestOf(day);
    },
    digest() {
      const todayKey = dayKey(now());
      const list = days();
      if (!list.includes(todayKey)) list.push(todayKey);
      return {
        days: list
          .sort()
          .map((day) =>
            day === todayKey ? structuredClone(today()) : digestOf(day),
          ),
        ...memoryDigest(options.memory?.()),
      };
    },
    bytes() {
      return days().reduce((sum, day) => sum + sizeOf(day), 0);
    },
    forget,
    applyRetention,
    scheduleMidnight() {
      if (midnight) return;
      const arm = () => {
        midnight = setTimeout(() => {
          midnight = undefined;
          const ended = current?.day ?? shiftDay(dayKey(now()), -1);
          try {
            applyRetention();
          } catch (error) {
            report(error);
          }
          current = undefined;
          try {
            if (ended !== dayKey(now())) options.onDayEnd?.(ended);
          } catch (error) {
            report(error);
          }
          arm();
        }, msUntilMidnight(now()));
        midnight.unref?.();
      };
      arm();
    },
    close() {
      if (midnight) clearTimeout(midnight);
      midnight = undefined;
    },
  };
  return log;
}
