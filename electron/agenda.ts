import { execFile } from "node:child_process";
import type { MemoryAccess } from "../src/core/memory";

/**
 * The user's calendar and reminders, read by the coarena-agenda helper with
 * their permission, as short lines for the model's "what needs doing" context.
 * Titles, times, calendar and list names only (docs/PRIVACY.md).
 */
export type AgendaAccessState =
  | "granted"
  | "denied"
  | "restricted"
  | "notDetermined"
  | "writeOnly"
  | "unknown";
export interface AgendaAccess {
  calendar: AgendaAccessState;
  reminders: AgendaAccessState;
}
export interface AgendaReading {
  access: AgendaAccess;
  lines: string[];
}
type Run = (
  binary: string,
  command: string,
  timeoutMs: number,
) => Promise<string>;
const run: Run = (binary, command, timeoutMs) =>
  new Promise((resolve, reject) =>
    execFile(
      binary,
      [command],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  );
const STATES = new Set<AgendaAccessState>([
  "granted",
  "denied",
  "restricted",
  "notDetermined",
  "writeOnly",
]);
const state = (value: unknown): AgendaAccessState =>
  STATES.has(value as AgendaAccessState)
    ? (value as AgendaAccessState)
    : "unknown";
export const AGENDA_LINE_LIMIT = 200;
export const AGENDA_MAX_LINES = 18;
const lines = (value: unknown, limit: number, prefix = ""): string[] =>
  Array.isArray(value)
    ? value
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => (prefix + line).slice(0, AGENDA_LINE_LIMIT))
    : [];
/**
 * The helper's JSON, checked field by field. Events read as they are;
 * reminders are marked "To do:" so the model can tell a meeting from a task.
 * Anything malformed reads as no access and no lines, never as an error.
 */
export function parseAgenda(stdout: string): AgendaReading {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>;
  } catch {
    /* Malformed output is treated as nothing readable. */
  }
  const access = (data.access ?? {}) as Record<string, unknown>;
  const events = lines(data.events, 8);
  const reminders = lines(data.reminders, 10, "To do: ");
  return {
    access: {
      calendar: state(access.calendar),
      reminders: state(access.reminders),
    },
    lines: [...events, ...reminders].slice(0, AGENDA_MAX_LINES),
  };
}
export interface AgendaOptions {
  run?: Run;
  now?: () => number;
  /** How long a reading is reused; the agenda changes slowly. */
  cacheMs?: number;
  timeoutMs?: number;
}
export function createAgenda(binary: string, options: AgendaOptions = {}) {
  const exec = options.run ?? run;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 3_000;
  let cached: { at: number; reading: AgendaReading } | undefined;
  let pending: Promise<AgendaReading> | undefined;
  const unavailable: AgendaReading = {
    access: { calendar: "unknown", reminders: "unknown" },
    lines: [],
  };
  const invoke = async (command: string, timeout = timeoutMs) => {
    try {
      return parseAgenda(await exec(binary, command, timeout));
    } catch {
      return unavailable;
    }
  };
  return {
    /** Which access macOS has granted; never shows a prompt. */
    async status(): Promise<AgendaAccess> {
      return (await invoke("status")).access;
    },
    /**
     * Asks macOS for Calendar and Reminders access. The only call that can
     * show a prompt, so it is only made from the Settings window, and it
     * waits long enough for the user to answer.
     */
    async request(): Promise<AgendaAccess> {
      cached = undefined;
      return (await invoke("request", 120_000)).access;
    },
    /** Upcoming events and pressing reminders, reused for a minute. */
    async read(): Promise<string[]> {
      if (cached && now() - cached.at < cacheMs) return cached.reading.lines;
      pending ??= invoke("read").finally(() => (pending = undefined));
      const reading = await pending;
      cached = { at: now(), reading };
      return reading.lines;
    },
    forget() {
      cached = undefined;
    },
  };
}
export type AgendaSource = Pick<ReturnType<typeof createAgenda>, "read">;
/**
 * Adds the agenda to what the runner recalls before a task. Independent of
 * learning: with memory off and the agenda on, the run still knows what is on
 * the user's plate; a failed or slow read simply leaves it out.
 */
export function withAgenda(
  memory: MemoryAccess | undefined,
  agenda: AgendaSource | undefined,
): MemoryAccess | undefined {
  if (!agenda) return memory;
  return {
    async recall(task, signal) {
      const [recalled, lines] = await Promise.all([
        memory
          ? memory.recall(task, signal)
          : Promise.resolve({ context: { preferences: [], episodes: [] } }),
        agenda.read().catch(() => [] as string[]),
      ]);
      if (!lines.length) return recalled;
      return { ...recalled, context: { ...recalled.context, agenda: lines } };
    },
    learn(input) {
      memory?.learn(input);
    },
  };
}
