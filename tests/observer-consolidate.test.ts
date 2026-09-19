/**
 * Consolidation (.data/design/observer.md §4) with a fake model: the
 * timeline carries structure and never a picture (words only at tier
 * text), a planted routine comes back through the model's reply and the
 * merge, malformed JSON is rejected whole, the budget cuts the timeline and
 * refuses when spent, Private local reaches only the local model, prior
 * days accumulate, and the memory merge's duplicate, status, retire and
 * contradiction rules hold.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, type Settings } from "../src/core/schema";
import { emptyMemory, upsertPreferenceIn } from "../src/memory/store";
import { recallContext } from "../src/memory/retrieve";
import {
  buildTimeline,
  CONSOLIDATION_INSTRUCTION,
  consolidateDay,
  createConsolidator,
  createTokenBudget,
  dedupeRoutines,
  estimateTokens,
  mergeConsolidated,
  mergeProposals,
  modelOf,
  parseConsolidation,
  proposalsOf,
  retireStale,
  RETIRE_AFTER_DAYS,
  timelineOf,
  titleStem,
  type ConsolidatedDay,
  type ConsolidationModel,
  type DayTimeline,
  type ModelCall,
} from "../src/observer/consolidate";
import type { ObservedEvent } from "../src/observer/types";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-consolidate-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DAY = "2026-09-14"; // a Monday
const at = (h: number, m = 0) => new Date(2026, 8, 14, h, m).getTime();
const SLACK = "com.tinyspeck.slackmacgap";
const MAIL = "com.apple.mail";
const LINEAR = "com.linear";
const SAFARI = "com.apple.Safari";
/** A morning: Slack, Mail, Linear, then Safari on youtube. */
function morning(): ObservedEvent[] {
  return [
    {
      event: "observe_frame",
      atMs: at(8, 52),
      appId: SLACK,
      appName: "Slack",
      windowTitle: "general (3) - Acme",
      focusedLabel: "Message #general",
      controls: [],
    },
    {
      event: "observe_action",
      atMs: at(8, 53),
      appId: SLACK,
      kind: "click",
      target: { role: "AXButton", label: "Send" },
    },
    {
      event: "observe_action",
      atMs: at(8, 53),
      appId: SLACK,
      kind: "typing",
      typed: { field: "Message #general", chars: 40, ms: 9000 },
    },
    {
      event: "observe_frame",
      atMs: at(8, 57),
      appId: MAIL,
      appName: "Mail",
      windowTitle: "Inbox (12 messages) — 2026-09-14",
      controls: [],
    },
    {
      event: "observe_action",
      atMs: at(8, 58),
      appId: MAIL,
      kind: "key_chord",
      chord: "CMD+R",
    },
    {
      event: "observe_frame",
      atMs: at(9, 1),
      appId: LINEAR,
      appName: "Linear",
      windowTitle: "My issues",
      textDigest: "Triage: 4 issues need estimates",
      controls: [],
    },
    {
      event: "observe_action",
      atMs: at(9, 2),
      appId: LINEAR,
      kind: "scroll",
      scroll: { direction: "down", ticks: 12 },
    },
    {
      event: "observe_frame",
      atMs: at(9, 20),
      appId: SAFARI,
      appName: "Safari",
      host: "youtube.com",
      windowTitle: "Lo-fi beats - YouTube",
      image: "PICTUREBYTES",
      controls: [],
    },
    {
      event: "observe_frame",
      atMs: at(9, 21),
      excluded: "protected",
      appId: "com.1password.1password",
      controls: [],
    },
    {
      event: "observe_frame",
      atMs: at(9, 22),
      excluded: "own_run",
      appId: SAFARI,
      runId: "r1",
      controls: [],
    },
    {
      event: "observe_action",
      atMs: at(9, 25),
      appId: SAFARI,
      kind: "menu_item",
      menu: ["File", "New Tab"],
    },
  ];
}
const REPLY = {
  routines: [
    {
      name: "Morning check-in",
      weekdays: [1, 2, 3, 4, 5],
      hourRange: [8, 10],
      steps: [
        { appId: SLACK },
        { appId: MAIL },
        { appId: LINEAR, action: "triage issues" },
      ],
      seen: 1,
      confidence: 0.7,
    },
  ],
  procedures: [
    {
      trigger: "file the receipt from {slot0}",
      slots: ["slot0"],
      steps: [
        { action: { type: "open_app", name: "Finder" } },
        {
          action: { type: "click_control", label: "Receipts" },
          target: { role: "AXStaticText", label: "Receipts" },
          expectAppId: "com.apple.finder",
        },
      ],
      observedRuns: 4,
      confidence: 0.6,
    },
  ],
  preferences: [
    { text: "Reads Slack before Mail in the morning", evidence: 1 },
    { text: "Uses Safari for YouTube", evidence: 1, stance: "supports" },
  ],
};
const fakeModel = (
  text: string | ((call: ModelCall) => string),
  usage = { inputTokens: 1200, outputTokens: 300, cost: 0.004 },
  code = "ok",
): ConsolidationModel & { calls: ModelCall[] } => {
  const calls: ModelCall[] = [];
  const model = (async (call: ModelCall) => {
    calls.push(call);
    return {
      text: typeof text === "function" ? text(call) : text,
      usage,
      code,
    };
  }) as ConsolidationModel & { calls: ModelCall[] };
  model.calls = calls;
  return model;
};
const timeline = (tier: DayTimeline["tier"] = "structure"): DayTimeline =>
  timelineOf(DAY, morning(), tier, new Date(2026, 8, 14, 12));

describe("the timeline", () => {
  it("renders stretches with app, host, title stems, focus and action kinds, never a picture", () => {
    const t = buildTimeline(morning(), {
      tier: "structure",
      maxChars: 100_000,
      day: DAY,
    });
    expect(t.frames).toBe(4);
    expect(t.actions).toBe(5);
    expect(t.excluded).toBe(2);
    expect(t.segments).toBe(4);
    expect(t.text).toContain("Day: 2026-09-14 (Monday)");
    expect(t.text).toContain(`08:52–08:53 ${SLACK} (Slack)`);
    expect(t.text).toContain('titles: "general - Acme"');
    expect(t.text).toContain("focus: Message #general");
    expect(t.text).toContain('click "Send"');
    expect(t.text).toContain('typing in "Message #general"');
    expect(t.text).toContain("key_chord CMD+R");
    expect(t.text).toContain("scroll down");
    expect(t.text).toContain("menu_item File > New Tab");
    expect(t.text).toContain("host=youtube.com");
    expect(t.text).toContain(
      "Excluded frames (not shown): protected×1, own_run×1",
    );
    expect(t.text).not.toContain("PICTUREBYTES");
    expect(t.text).not.toContain("Triage");
    expect(t.text).not.toContain("1password");
    expect(t.text).not.toContain("(3)");
    expect(t.text).not.toContain("12 messages");
    expect(t.appNames).toEqual({
      [SLACK]: "Slack",
      [MAIL]: "Mail",
      [LINEAR]: "Linear",
      [SAFARI]: "Safari",
    });
  });

  it("adds the words at tier text and pixels, and drops them first to fit", () => {
    const text = buildTimeline(morning(), {
      tier: "text",
      maxChars: 100_000,
      day: DAY,
    });
    expect(text.text).toContain("text: Triage: 4 issues need estimates");
    expect(text.withoutText).toBe(false);
    const pixels = buildTimeline(morning(), {
      tier: "pixels",
      maxChars: 100_000,
      day: DAY,
    });
    expect(pixels.text).toContain("text: Triage");
    expect(pixels.text).not.toContain("PICTUREBYTES");
    const tight = buildTimeline(morning(), {
      tier: "text",
      maxChars: 420,
      day: DAY,
    });
    expect(tight.withoutText).toBe(true);
    expect(tight.text).not.toContain("Triage");
    expect(tight.text.length).toBeLessThanOrEqual(420);
    expect(tight.cut).toBeGreaterThan(0);
    expect(tight.text).toContain("later stretches left out to fit");
    // The morning survives the cut.
    expect(tight.text).toContain(SLACK);
  });

  it("strips numbers, dates and counts from a title", () => {
    expect(titleStem("Inbox (12 messages) — 2026-09-14")).toBe("Inbox");
    expect(titleStem("general (3) - Acme")).toBe("general - Acme");
    expect(titleStem(undefined)).toBe("");
    expect(titleStem("x".repeat(100))).toHaveLength(60);
  });

  it("timelineOf splits frames and actions and strips pictures", () => {
    const t = timeline("pixels");
    expect(t).toMatchObject({ day: DAY, weekday: "Monday", tier: "pixels" });
    expect(t.frames).toHaveLength(6);
    expect(t.actions).toHaveLength(5);
    expect(t.frames.some((f) => f.image !== undefined)).toBe(false);
    expect(typeof t.utcOffsetMinutes).toBe("number");
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});

describe("consolidateDay", () => {
  it("recovers a planted routine, the procedure and the preferences through the fake model", async () => {
    const model = fakeModel(JSON.stringify(REPLY));
    const result = await consolidateDay(timeline(), model);
    expect(result.code).toBe("ok");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].system).toBe(CONSOLIDATION_INSTRUCTION);
    expect(model.calls[0].input).toContain(SLACK);
    expect(model.calls[0].input).not.toContain("PICTUREBYTES");
    expect(model.calls[0].maxOutputTokens).toBe(4000);
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cost: 0.004,
    });
    expect(result.frames).toBe(4);
    expect(result.routines).toEqual([
      {
        name: "Morning check-in",
        when: { weekdays: [1, 2, 3, 4, 5], hourRange: [8, 10] },
        steps: [
          { appId: SLACK, appName: "Slack" },
          { appId: MAIL, appName: "Mail" },
          { appId: LINEAR, appName: "Linear", action: "triage issues" },
        ],
        seen: 1,
        lastSeen: DAY,
        confidence: 0.7,
      },
    ]);
    expect(result.procedures[0]).toMatchObject({
      trigger: "file the receipt from {slot0}",
      slots: ["slot0"],
      observedRuns: 4,
      status: "proposed",
      lastSeen: DAY,
    });
    expect(result.procedures[0].steps).toHaveLength(2);
    expect(result.preferences.map((p) => p.text)).toEqual([
      "Reads Slack before Mail in the morning",
      "Uses Safari for YouTube",
    ]);
    expect(result.preferences[0]).toMatchObject({
      evidence: 1,
      stance: "supports",
      lastSeen: DAY,
    });
  });

  it("rejects malformed JSON, a wrong shape and a refusal whole", async () => {
    for (const [text, error] of [
      ["I cannot help with that.", "no_object"],
      ["{ routines: [ ", "no_object"],
      ['{"routines": [{"name": 5}]}', "schema"],
      [
        '{"routines": [{"name": "x", "weekdays": [9], "hourRange": [8, 10], "steps": [], "seen": 1, "confidence": 0.5}]}',
        "schema",
      ],
      [
        '{"procedures": [{"trigger": "t", "steps": [{"action": {"type": "shell"}}], "observedRuns": 3, "confidence": 0.5}]}',
        "schema",
      ],
      ['{"routines": [}', "not_json"],
    ] as const) {
      const result = await consolidateDay(timeline(), fakeModel(text));
      expect(result.code, text).toBe("parse");
      expect(result.error).toBe(error);
      expect(result.routines).toEqual([]);
    }
    const refused = await consolidateDay(
      timeline(),
      fakeModel("", undefined, "refused"),
    );
    expect(refused.code).toBe("model");
    expect(refused.error).toBe("refused");
    const thrown = await consolidateDay(timeline(), async () => {
      throw new Error("boom");
    });
    expect(thrown.code).toBe("model");
    // A fenced reply and one with a sentence around it are read.
    const fenced = await consolidateDay(
      timeline(),
      fakeModel("```json\n" + JSON.stringify(REPLY) + "\n```"),
    );
    expect(fenced.code).toBe("ok");
    const wrapped = await consolidateDay(
      timeline(),
      fakeModel("Here you go: " + JSON.stringify(REPLY) + " Done."),
    );
    expect(wrapped.code).toBe("ok");
    expect(parseConsolidation("{}").ok).toBe(true);
  });

  it("respects the budget: cuts the timeline to fit and refuses when spent", async () => {
    const long: ObservedEvent[] = [];
    for (let i = 0; i < 400; i++)
      long.push({
        event: "observe_frame",
        atMs: at(8) + i * 60_000,
        appId: i % 2 ? SLACK : MAIL,
        appName: i % 2 ? "Slack" : "Mail",
        windowTitle: `Window number ${i} with a fairly long title about topic ${i}`,
        controls: [],
      });
    const model = fakeModel(JSON.stringify({}));
    const t = timelineOf(DAY, long, "structure");
    const roomy = await consolidateDay(t, model);
    const cut = await consolidateDay(t, model, undefined, {
      remainingTokens: 4000,
    });
    expect(cut.code).toBe("ok");
    expect(model.calls[1].input.length).toBeLessThan(
      model.calls[0].input.length,
    );
    expect(estimateTokens(model.calls[1].input)).toBeLessThanOrEqual(4000);
    expect(roomy.code).toBe("ok");
    const spent = await consolidateDay(t, model, undefined, {
      remainingTokens: 2500,
    });
    expect(spent.code).toBe("budget");
    expect(model.calls).toHaveLength(2);
    const empty = await consolidateDay(
      { ...t, frames: [], actions: [] },
      model,
    );
    expect(empty.code).toBe("empty");
    expect(model.calls).toHaveLength(2);
    // Only excluded frames: nothing to ask about.
    const excludedOnly = await consolidateDay(
      timelineOf(
        DAY,
        [
          {
            event: "observe_frame",
            atMs: at(9),
            excluded: "locked",
            controls: [],
          },
        ],
        "structure",
      ),
      model,
    );
    expect(excludedOnly.code).toBe("empty");
    expect(model.calls).toHaveLength(2);
  });

  it("accumulates prior days: a routine seen again adds its day and widens its window", async () => {
    const day1 = await consolidateDay(
      timeline(),
      fakeModel(JSON.stringify(REPLY)),
    );
    const reply2 = {
      ...REPLY,
      routines: [
        {
          ...REPLY.routines[0],
          name: "Morning apps",
          weekdays: [2],
          hourRange: [9, 11],
          seen: 1,
          confidence: 0.8,
        },
      ],
      preferences: [
        { text: "Reads Slack before Mail in the morning", evidence: 1 },
        { text: "Uses Safari for YouTube", evidence: 2, stance: "contradicts" },
      ],
    };
    const t2 = { ...timeline(), day: "2026-09-15", weekday: "Tuesday" };
    const day2 = await consolidateDay(
      t2,
      fakeModel(JSON.stringify(reply2)),
      day1,
    );
    expect(day2.routines).toHaveLength(1);
    expect(day2.routines[0]).toMatchObject({
      seen: 2,
      lastSeen: "2026-09-15",
      confidence: 0.8,
      when: { weekdays: [1, 2, 3, 4, 5], hourRange: [8, 11] },
    });
    expect(day2.procedures[0].observedRuns).toBe(8);
    expect(day2.preferences.map((p) => [p.text, p.evidence])).toEqual([
      ["Reads Slack before Mail in the morning", 2],
    ]);
    // A day the model answers nothing for keeps the prior as it was.
    const day3 = await consolidateDay(
      { ...t2, day: "2026-09-16" },
      fakeModel("{}"),
      day2,
    );
    expect(day3.code).toBe("ok");
    expect(day3.routines[0].seen).toBe(2);
    // A failed day too.
    const day4 = await consolidateDay(
      { ...t2, day: "2026-09-17" },
      fakeModel("nope"),
      day2,
    );
    expect(day4.code).toBe("parse");
    expect(day4.routines).toEqual(day2.routines);
    // mergeConsolidated alone: the same sequence on the same day does not double count.
    const same = mergeConsolidated(day1, day1);
    expect(same.routines[0].seen).toBe(1);
  });

  it("modelOf refuses to send anywhere but the local model under Private local", async () => {
    const remote: Settings = {
      ...defaultSettings,
      privacy: "PRIVATE_LOCAL",
      provider: "openai",
      model: "gpt-5",
      endpoint: "https://api.openai.com",
    };
    let fetched = 0;
    const fetch = (async () => {
      fetched += 1;
      throw new Error("must not be called");
    }) as unknown as typeof globalThis.fetch;
    const result = await consolidateDay(
      timeline(),
      modelOf(remote, "key", fetch),
    );
    expect(result.code).toBe("privacy");
    expect(fetched).toBe(0);
    // The default settings are local Ollama: the gate lets the call through
    // to fetch, which stands in for the local server here.
    const local = modelOf(
      defaultSettings,
      "",
      (async () =>
        new Response(
          [
            JSON.stringify({
              message: { role: "assistant", content: JSON.stringify(REPLY) },
              done: false,
            }),
            JSON.stringify({
              message: { role: "assistant", content: "" },
              done: true,
              prompt_eval_count: 900,
              eval_count: 200,
            }),
          ].join("\n") + "\n",
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        )) as unknown as typeof globalThis.fetch,
    );
    const ok = await consolidateDay(timeline(), local);
    expect(ok.code).toBe("ok");
    expect(ok.routines).toHaveLength(1);
    expect(ok.usage.inputTokens).toBe(900);
  });
});

describe("merging into memory", () => {
  const stamp = new Date("2026-09-14T20:00:00.000Z");
  const proposals = () =>
    proposalsOf(REPLY as never, DAY, { [SLACK]: "Slack" });

  it("adds new proposals as proposed and merges duplicates without touching status", () => {
    const data = emptyMemory();
    const counts = mergeProposals(data, proposals(), stamp);
    expect(counts).toEqual({
      routines: { added: 1, merged: 0 },
      procedures: { added: 1, merged: 0 },
      preferences: { added: 2, merged: 0, lowered: 0 },
    });
    const routine = data.routines[0];
    expect(routine).toMatchObject({
      kind: "routine",
      name: "Morning check-in",
      status: "proposed",
      seen: 1,
      firstSeen: "2026-09-14T12:00:00.000Z",
      lastSeen: "2026-09-14T12:00:00.000Z",
      runs: { completed: 0, corrected: 0, undone: 0, declined: 0, failed: 0 },
      correctionStreak: 0,
    });
    expect(routine.id).toMatch(/^routine-[0-9a-f]{16}$/);
    expect(routine.tokens).toContain(SLACK.toLowerCase());
    expect(data.procedures[0]).toMatchObject({
      kind: "procedure",
      trigger: "file the receipt from {slot0}",
      status: "proposed",
      observedRuns: 4,
    });
    expect(data.procedures[0].id).toMatch(/^proc-/);
    expect(data.preferences.map((p) => [p.source, p.status, p.weight])).toEqual(
      [
        ["observed", "proposed", 1],
        ["observed", "proposed", 1],
      ],
    );
    // The next day: the same routine merges, seen grows by one day, window widens.
    routine.status = "approved";
    const next = proposalsOf(
      {
        ...REPLY,
        routines: [
          {
            ...REPLY.routines[0],
            weekdays: [6],
            hourRange: [7, 9],
            confidence: 0.95,
          },
        ],
      } as never,
      "2026-09-15",
    );
    const again = mergeProposals(
      data,
      next,
      new Date("2026-09-15T20:00:00.000Z"),
    );
    expect(again.routines).toEqual({ added: 0, merged: 1 });
    expect(data.routines).toHaveLength(1);
    expect(data.routines[0]).toMatchObject({
      status: "approved",
      seen: 2,
      lastSeen: "2026-09-15T12:00:00.000Z",
      when: { weekdays: [1, 2, 3, 4, 5, 6], hourRange: [7, 10] },
      // An approved routine's confidence is the replays', not the model's.
      confidence: 0.7,
    });
    expect(data.preferences[0].weight).toBe(2);
    // The same day merged twice does not count twice.
    mergeProposals(data, next, new Date("2026-09-15T21:00:00.000Z"));
    expect(data.routines[0].seen).toBe(2);
  });

  it("keeps a refused proposal refused and re-proposes a retired one", () => {
    const data = emptyMemory();
    mergeProposals(data, proposals(), stamp);
    data.routines[0].status = "never";
    data.procedures[0].status = "never";
    data.preferences[0].status = "never";
    const w = data.preferences[0].weight;
    mergeProposals(data, proposalsOf(REPLY as never, "2026-09-15"), stamp);
    expect(data.routines[0].status).toBe("never");
    expect(data.routines[0].seen).toBe(1);
    expect(data.procedures[0].status).toBe("never");
    expect(data.preferences[0].weight).toBe(w);
    data.routines[0].status = "retired";
    data.procedures[0].status = "retired";
    mergeProposals(data, proposalsOf(REPLY as never, "2026-09-16"), stamp);
    expect(data.routines[0].status).toBe("proposed");
    expect(data.procedures[0].status).toBe("proposed");
  });

  it("lowers a contradicted preference and removes an observed one with nothing left", () => {
    const data = emptyMemory();
    mergeProposals(data, proposals(), stamp);
    upsertPreferenceIn(data, "Uses Chrome for docs", "correction", stamp);
    const contradiction = proposalsOf(
      {
        routines: [],
        procedures: [],
        preferences: [
          {
            text: "Uses Safari for YouTube",
            evidence: 3,
            stance: "contradicts",
          },
          { text: "Uses Chrome for docs", evidence: 5, stance: "contradicts" },
        ],
      },
      "2026-09-15",
    );
    const counts = mergeProposals(data, contradiction, stamp);
    expect(counts.preferences.lowered).toBe(2);
    expect(data.preferences.map((p) => p.text)).toEqual([
      "Reads Slack before Mail in the morning",
      "Uses Chrome for docs",
    ]);
    // A correction keeps one vote.
    expect(data.preferences[1].weight).toBe(1);
  });

  it("retires what was unseen for 30 days and dedupes routines that grew alike", () => {
    const data = emptyMemory();
    mergeProposals(data, proposals(), stamp);
    const later = new Date(
      stamp.getTime() + (RETIRE_AFTER_DAYS + 1) * 86_400_000,
    );
    expect(retireStale(data, new Date(stamp.getTime() + 86_400_000))).toBe(0);
    expect(retireStale(data, later)).toBe(2);
    expect(data.routines[0].status).toBe("retired");
    expect(data.procedures[0].status).toBe("retired");
    // Two routines with the same tokens merge into the first.
    data.routines.push({
      ...data.routines[0],
      id: "routine-twin",
      seen: 2,
      status: "approved",
      lastSeen: "2026-10-01T00:00:00.000Z",
    });
    expect(dedupeRoutines(data)).toBe(1);
    expect(data.routines).toHaveLength(1);
    expect(data.routines[0]).toMatchObject({
      seen: 3,
      status: "approved",
      lastSeen: "2026-10-01T00:00:00.000Z",
    });
  });

  it("keeps a proposed observed preference out of recall until approved", () => {
    const data = emptyMemory();
    mergeProposals(data, proposals(), stamp);
    const before = recallContext(data, "open youtube in safari");
    expect(before.preferences).toEqual([]);
    data.preferences[1].status = "approved";
    const after = recallContext(data, "open youtube in safari");
    expect(after.preferences).toEqual(["Uses Safari for YouTube"]);
    data.preferences[1].status = "never";
    expect(recallContext(data, "open youtube in safari").preferences).toEqual(
      [],
    );
  });
});

describe("the consolidator", () => {
  const settingsOn = (over: Partial<Settings["observer"]> = {}): Settings => ({
    ...defaultSettings,
    observer: { ...defaultSettings.observer, on: true, ...over },
  });
  function harness(
    o: {
      settings?: Settings;
      events?: ObservedEvent[];
      idleMs?: number;
      runActive?: boolean;
      model?: ConsolidationModel;
      /** Build the model from the settings (modelOf) instead of a fake. */
      realModel?: boolean;
      now?: () => Date;
    } = {},
  ) {
    const dir = tempDir();
    const data = emptyMemory();
    const traces: { event: string; data: Record<string, unknown> }[] = [];
    const events = o.events ?? morning();
    const state = {
      idleMs: o.idleMs ?? 15 * 60_000,
      runActive: o.runActive ?? false,
      settings: o.settings ?? settingsOn(),
      events,
    };
    const consolidator = createConsolidator({
      settings: () => state.settings,
      key: () => "",
      fetch: (async () => {
        throw new Error("no network in tests");
      }) as unknown as typeof globalThis.fetch,
      log: {
        read: () => state.events,
        dayDigest: () => ({
          frames: state.events.filter(
            (e) => e.event === "observe_frame" && !e.excluded,
          ).length,
          actions: state.events.filter((e) => e.event === "observe_action")
            .length,
        }),
      },
      memory: () => ({ update: (change) => change(data) }),
      budget: createTokenBudget(dir),
      idleMs: () => state.idleMs,
      runActive: () => state.runActive,
      trace: (event, d = {}) => traces.push({ event, data: d }),
      now: o.now ?? (() => new Date(2026, 8, 14, 12)),
      model: o.realModel
        ? undefined
        : (o.model ?? fakeModel(JSON.stringify(REPLY))),
    });
    return { consolidator, data, traces, state, dir };
  }

  it("runs when idle long enough, at most every two hours, and only with new events", async () => {
    const now = { t: new Date(2026, 8, 14, 12) };
    const h = harness({ now: () => now.t });
    h.state.idleMs = 5 * 60_000;
    expect(await h.consolidator.tick()).toBeUndefined();
    h.state.idleMs = 10 * 60_000;
    const first = await h.consolidator.tick();
    expect(first?.code).toBe("ok");
    expect(h.data.routines).toHaveLength(1);
    const traced = h.traces.find((t) => t.event === "ObserverConsolidated")!;
    expect(traced.data).toMatchObject({
      code: "ok",
      reason: "idle",
      frames: 4,
      actions: 5,
      tokens: 1200,
      outputTokens: 300,
      cost: 0.004,
      routines: 1,
      procedures: 1,
      preferences: 2,
    });
    expect(typeof traced.data.durationMs).toBe("number");
    expect(JSON.stringify(traced.data)).not.toContain("Slack");
    // Nothing new: no second run even when idle.
    expect(await h.consolidator.tick()).toBeUndefined();
    h.state.events = [
      ...h.state.events,
      { event: "observe_action", atMs: at(12), appId: SLACK, kind: "click" },
    ];
    // Too soon.
    now.t = new Date(2026, 8, 14, 13, 30);
    expect(await h.consolidator.tick()).toBeUndefined();
    now.t = new Date(2026, 8, 14, 14, 1);
    expect((await h.consolidator.tick())?.code).toBe("ok");
    expect(h.consolidator.status()).toMatchObject({
      lastCode: "ok",
      tokensToday: 2400,
    });
    expect(h.consolidator.status().lastAt).toBe(now.t.toISOString());
  });

  it("never runs while a run is going or with watching off, and defers the day's end", async () => {
    const h = harness({ runActive: true });
    expect(await h.consolidator.tick()).toBeUndefined();
    expect(await h.consolidator.dayEnd(DAY)).toBeUndefined();
    h.state.runActive = false;
    h.state.idleMs = 0;
    // The deferred day end runs at the next quiet tick whatever the idle time.
    const deferred = await h.consolidator.tick();
    expect(deferred?.code).toBe("ok");
    expect(
      h.traces.find((t) => t.event === "ObserverConsolidated")?.data.reason,
    ).toBe("day_end");
    h.state.settings = defaultSettings;
    expect(await h.consolidator.tick()).toBeUndefined();
    expect(await h.consolidator.dayEnd(DAY)).toBeUndefined();
  });

  it("spends the day's budget across restarts and stops at it", async () => {
    const dir = tempDir();
    const budget = createTokenBudget(dir);
    budget.add(DAY, 150_000);
    expect(createTokenBudget(dir).used(DAY)).toBe(150_000);
    expect(createTokenBudget(dir).used("2026-09-15")).toBe(0);
    budget.add("2026-09-15", 10);
    expect(budget.used(DAY)).toBe(0);
    const h = harness({ settings: settingsOn({ dailyTokenBudget: 1000 }) });
    const spent = await h.consolidator.run(DAY, "test");
    expect(spent.code).toBe("budget");
    expect(h.data.routines).toEqual([]);
    expect(h.traces.at(-1)?.data).toMatchObject({
      code: "budget",
      routines: 0,
    });
  });

  it("routes Private local to the local model only and merges nothing on a bad reply", async () => {
    const bad = harness({ model: fakeModel("not json") });
    const result = await bad.consolidator.run(DAY, "test");
    expect(result.code).toBe("parse");
    expect(bad.data.routines).toEqual([]);
    expect(bad.data.preferences).toEqual([]);
    const remote = harness({
      settings: {
        ...settingsOn(),
        privacy: "PRIVATE_LOCAL",
        provider: "anthropic",
        model: "claude",
        endpoint: "https://api.anthropic.com",
      },
      realModel: true,
    });
    // Without a test model the consolidator builds modelOf from the settings.
    const r = await remote.consolidator.run(DAY, "test");
    expect(r.code).toBe("privacy");
    expect(remote.traces.at(-1)?.data).toMatchObject({ code: "privacy" });
  });
});

/** The eval's shape (lane O3): a ConsolidatedDay is the design §4 output plus usage. */
it("consolidateDay's return carries the §4 keys the eval scores", async () => {
  const result: ConsolidatedDay = await consolidateDay(
    timeline(),
    fakeModel(JSON.stringify(REPLY)),
  );
  expect(Object.keys(result).sort()).toEqual(
    [
      "actions",
      "appNames",
      "code",
      "frames",
      "preferences",
      "procedures",
      "routines",
      "usage",
    ].sort(),
  );
  expect(Object.keys(result.routines[0]).sort()).toEqual([
    "confidence",
    "lastSeen",
    "name",
    "seen",
    "steps",
    "when",
  ]);
  expect(Object.keys(result.procedures[0]).sort()).toEqual([
    "confidence",
    "lastSeen",
    "observedRuns",
    "slots",
    "status",
    "steps",
    "trigger",
  ]);
});
