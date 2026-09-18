import { describe, it, expect, vi } from "vitest";
import {
  AGENDA_LINE_LIMIT,
  AGENDA_MAX_LINES,
  createAgenda,
  parseAgenda,
  withAgenda,
} from "../electron/agenda";
import { memoryForModel } from "../src/providers/http";
import type { MemoryAccess } from "../src/core/memory";

const reading = JSON.stringify({
  access: { calendar: "granted", reminders: "granted" },
  events: ["Today 3 PM–3:30 PM: Standup (Work)"],
  reminders: ["Send the deck to Prateek — due Tomorrow (Work)"],
});

describe("agenda helper output", () => {
  it("reads events as they are and marks reminders as things to do", () => {
    expect(parseAgenda(reading)).toEqual({
      access: { calendar: "granted", reminders: "granted" },
      lines: [
        "Today 3 PM–3:30 PM: Standup (Work)",
        "To do: Send the deck to Prateek — due Tomorrow (Work)",
      ],
    });
  });
  it("treats malformed or hostile output as nothing readable", () => {
    for (const stdout of ["", "not json", "[1,2]", '{"access":"granted"}'])
      expect(parseAgenda(stdout).lines).toEqual([]);
    const odd = parseAgenda(
      JSON.stringify({
        access: { calendar: "yes", reminders: 1 },
        events: [42, { title: "x" }, "  Lunch  "],
      }),
    );
    expect(odd.access).toEqual({ calendar: "unknown", reminders: "unknown" });
    expect(odd.lines).toEqual(["Lunch"]);
  });
  it("bounds every line and the whole list", () => {
    const long = parseAgenda(
      JSON.stringify({
        access: {},
        events: Array.from({ length: 30 }, () => "e".repeat(500)),
        reminders: Array.from({ length: 30 }, (_, i) => `task ${i}`),
      }),
    );
    expect(long.lines.length).toBeLessThanOrEqual(AGENDA_MAX_LINES);
    for (const line of long.lines)
      expect(line.length).toBeLessThanOrEqual(AGENDA_LINE_LIMIT);
    // Events are capped so reminders are never crowded out entirely.
    expect(long.lines.some((line) => line.startsWith("To do:"))).toBe(true);
  });
});

describe("agenda client", () => {
  it("reuses a reading for a minute, then reads again", async () => {
    let now = 0;
    const run = vi.fn(async () => reading);
    const agenda = createAgenda("/bin/agenda", { run, now: () => now });
    await agenda.read();
    await agenda.read();
    expect(run).toHaveBeenCalledTimes(1);
    now = 61_000;
    await agenda.read();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("/bin/agenda", "read", 3000);
  });
  it("never throws: a failed helper reads as no access and no lines", async () => {
    const agenda = createAgenda("/bin/agenda", {
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(await agenda.read()).toEqual([]);
    expect(await agenda.status()).toEqual({
      calendar: "unknown",
      reminders: "unknown",
    });
  });
  it("only the request call may prompt, and it waits for the user", async () => {
    const run = vi.fn(async () => reading);
    const agenda = createAgenda("/bin/agenda", { run });
    await agenda.status();
    expect(run).toHaveBeenLastCalledWith("/bin/agenda", "status", 3000);
    await agenda.request();
    expect(run).toHaveBeenLastCalledWith("/bin/agenda", "request", 120_000);
  });
});

describe("agenda in recalled context", () => {
  const source = { read: async () => ["Today 3 PM: Standup"] };
  it("adds the agenda to what memory recalls", async () => {
    const memory: MemoryAccess = {
      recall: async () => ({
        context: { preferences: ["Use Chrome"], episodes: [] },
      }),
      learn: vi.fn(),
    };
    const composed = withAgenda(memory, source)!;
    const recalled = await composed.recall("what's next?");
    expect(recalled.context.preferences).toEqual(["Use Chrome"]);
    expect(recalled.context.agenda).toEqual(["Today 3 PM: Standup"]);
    composed.learn({} as never);
    expect(memory.learn).toHaveBeenCalled();
  });
  it("works with learning off, and is absent when switched off", async () => {
    const alone = withAgenda(undefined, source)!;
    expect((await alone.recall("x")).context.agenda).toEqual([
      "Today 3 PM: Standup",
    ]);
    expect(withAgenda(undefined, undefined)).toBeUndefined();
  });
  it("a failed read leaves the recall untouched", async () => {
    const composed = withAgenda(undefined, {
      read: async () => {
        throw new Error("timeout");
      },
    })!;
    expect((await composed.recall("x")).context.agenda).toBeUndefined();
  });
  it("reaches the model bounded and redacted", () => {
    const model = memoryForModel({
      preferences: [],
      episodes: [],
      agenda: [
        "To do: rotate token=sk-fixtureSECRET123456",
        ...Array.from({ length: 30 }, (_, i) => `line ${i}`),
      ],
    }) as { agenda: string[] };
    expect(model.agenda.length).toBe(18);
    expect(model.agenda[0]).not.toContain("fixtureSECRET");
  });
});
