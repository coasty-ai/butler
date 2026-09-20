/**
 * Settings › Watching (.data/design/observer.md §4, §6): the settings block
 * and its defaults (off, structure, 14 days, 200k tokens, 10 minutes), the
 * pane rendered with a fake status and proposals (the switch, the tier's
 * two sentences, retention, pause and forget, What I've learned with
 * Approve / Not this / Never and replay counts), its mount after Modules,
 * the bridge on both sides, and main.ts's wiring pinned by source: the
 * observer created over the work log and consolidator, the tray item and
 * eye, the "watching" plan, the IPC cases, the setting pushed on save,
 * "routine" among the origins, the controller hook, snapshot fan-out and
 * the quit path. The controller's stub for lane O1 is pinned by name.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultSettings,
  observerSettingsSchema,
  settingsSchema,
  type Settings,
} from "../src/core/schema";
import {
  consolidationLine,
  digestLine,
  preferenceEvidence,
  procedureEvidence,
  procedureReplays,
  routineEvidence,
  routineReplays,
  routineSteps,
  SettingsWatching,
  summary,
  TIERS,
  tierInfo,
} from "../src/ui/settings-watching";
import type {
  AppInfo,
  Bridge,
  LearnedProposals,
  WatchingStatus,
} from "../src/ui/api";
import { previewBridge } from "../src/ui/preview";
import { emptyDayDigest } from "../src/observer/types";
import { NativeController, OBSERVE_EVENTS } from "../electron/controller";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the observer settings block", () => {
  it("defaults to off, structure, 14 days, 200k tokens and 10 idle minutes", () => {
    expect(observerSettingsSchema.parse({})).toEqual({
      on: false,
      tier: "structure",
      retentionDays: 14,
      dailyTokenBudget: 200_000,
      consolidateWhenIdleMin: 10,
    });
    expect(defaultSettings.observer).toEqual(observerSettingsSchema.parse({}));
    // A stored config from before watching existed parses as off.
    const { observer: _o, ...stored } = defaultSettings;
    expect(settingsSchema.parse(stored).observer.on).toBe(false);
    expect(
      settingsSchema.parse({
        ...defaultSettings,
        observer: { on: true, tier: "text" },
      }).observer,
    ).toMatchObject({
      on: true,
      tier: "text",
      retentionDays: 14,
    });
    for (const bad of [
      { tier: "video" },
      { retentionDays: 0 },
      { retentionDays: 91 },
      { dailyTokenBudget: 10 },
      { consolidateWhenIdleMin: 0 },
      { extra: true },
    ])
      expect(
        observerSettingsSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});

const status = (over: Partial<WatchingStatus> = {}): WatchingStatus => ({
  on: true,
  tier: "text",
  paused: false,
  state: "on",
  retentionDays: 14,
  path: "~/Library/Application Support/coarena-open-assist/observer",
  today: {
    ...emptyDayDigest("2026-09-19"),
    frames: 120,
    actions: 340,
    bytesWritten: 3 * 1024 * 1024,
    excluded: { protected: 4, secure_input: 2 },
    framesDropped: 3,
    dropped: { size: 0, credential: 2, invalid: 1, paused: 0, helper: 0 },
  },
  days: ["2026-09-18", "2026-09-19"],
  bytes: 5 * 1024 * 1024,
  consolidation: {
    lastAt: "2026-09-19T14:00:00.000Z",
    lastCode: "ok",
    tokensToday: 12_345,
    budget: 200_000,
    idleMinutes: 10,
  },
  ...over,
});
const learned = (): LearnedProposals => ({
  routines: [
    {
      id: "routine-a",
      kind: "routine",
      name: "Morning check-in",
      tokens: [],
      when: { weekdays: [1, 2, 3, 4, 5], hourRange: [9, 10] },
      steps: [
        { appId: "com.tinyspeck.slackmacgap", appName: "Slack" },
        { appId: "com.apple.mail", appName: "Mail" },
        { appId: "com.apple.Safari", appName: "Safari", host: "youtube.com" },
      ],
      seen: 5,
      firstSeen: "2026-09-08T00:00:00.000Z",
      lastSeen: "2026-09-18T12:00:00.000Z",
      confidence: 0.7,
      status: "proposed",
      runs: { completed: 0, corrected: 0, undone: 0, declined: 0, failed: 0 },
      correctionStreak: 0,
      corrections: ["use Chrome"],
    },
    {
      id: "routine-b",
      kind: "routine",
      name: "Evening wrap-up",
      tokens: [],
      when: { weekdays: [1, 2, 3, 4, 5], hourRange: [17, 18] },
      steps: [{ appId: "com.linear", appName: "Linear" }],
      seen: 9,
      firstSeen: "2026-09-01T00:00:00.000Z",
      lastSeen: "2026-09-18T12:00:00.000Z",
      confidence: 0.9,
      status: "approved",
      runs: { completed: 3, corrected: 1, undone: 0, declined: 0, failed: 0 },
      correctionStreak: 0,
    },
  ],
  procedures: [
    {
      id: "proc-a",
      kind: "procedure",
      trigger: "file the receipt from {slot0}",
      tokens: [],
      slots: ["slot0"],
      steps: [
        { action: { type: "open_app", name: "Finder" } },
        { action: { type: "click_control", label: "Receipts" } },
      ],
      observedRuns: 4,
      lastSeen: "2026-09-18T12:00:00.000Z",
      confidence: 0.6,
      status: "proposed",
    },
    {
      id: "proc-b",
      kind: "procedure",
      trigger: "send the weekly report",
      tokens: [],
      slots: [],
      steps: [{ action: { type: "open_app", name: "Mail" } }],
      observedRuns: 3,
      lastSeen: "2026-09-18T12:00:00.000Z",
      confidence: 0.8,
      status: "approved",
      skillId: "skill-x",
      replays: { successes: 2, failures: 1 },
    },
  ],
  preferences: [
    {
      id: "pref-a",
      kind: "preference",
      text: "Opens PDFs in Preview",
      tokens: [],
      weight: 6,
      source: "observed",
      status: "proposed",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-18T12:00:00.000Z",
    },
  ],
});

describe("the pane's words", () => {
  it("has three tiers, each with what is stored and what is sent", () => {
    expect(TIERS.map((t) => t.tier)).toEqual(["structure", "text", "pixels"]);
    for (const t of TIERS) {
      expect(t.stored).toMatch(/^(Stores|Also stores)/);
      expect(t.sent).toMatch(/^Sends the model/);
    }
    expect(tierInfo("pixels").sent).toContain("Pictures never leave this Mac");
    expect(tierInfo("structure").stored).toContain("Never the characters");
    expect(tierInfo("text").stored).toContain("credential");
  });

  it("sums up, counts and words evidence without content", () => {
    expect(summary(defaultSettings)).toBe("Off");
    const on: Settings = {
      ...defaultSettings,
      observer: { ...defaultSettings.observer, on: true, tier: "text" },
    };
    expect(summary(on, status())).toBe("Watching · with text");
    expect(summary(on, status({ paused: true }))).toBe("Paused · with text");
    expect(
      summary({ ...on, observer: { ...on.observer, tier: "structure" } }),
    ).toBe("Watching · structure");
    expect(digestLine(undefined)).toBe("Reading…");
    expect(digestLine(status())).toBe(
      "Today: 120 frames, 340 actions · 6 excluded at the source · 3 dropped · 2 days kept (5.0 MB)",
    );
    expect(consolidationLine(status())).toMatch(
      /^Last consolidated at .*: done\. 12,345 of 200,000 tokens used today\.$/,
    );
    expect(
      consolidationLine(
        status({
          consolidation: { tokensToday: 0, budget: 200_000, idleMinutes: 10 },
        }),
      ),
    ).toBe(
      "Not consolidated yet; runs after 10 minutes idle. 0 of 200,000 tokens used today.",
    );
    expect(
      consolidationLine(
        status({
          consolidation: {
            lastAt: "2026-09-19T14:00:00.000Z",
            lastCode: "privacy",
            tokensToday: 0,
            budget: 1,
            idleMinutes: 1,
          },
        }),
      ),
    ).toContain("not sent (Private local needs the local model)");
    const l = learned();
    expect(routineEvidence(l.routines[0])).toBe(
      "Seen 5 days, last Sep 18 · weekdays 9 am–10 am · confidence 70%",
    );
    expect(routineReplays(l.routines[0])).toBe("Not replayed yet");
    expect(routineReplays(l.routines[1])).toBe(
      "Replayed 4 times: 3 completed, 1 corrected, 0 undone, 0 declined, 0 failed",
    );
    expect(routineSteps(l.routines[0])).toBe(
      "Slack → Mail → Safari (youtube.com)",
    );
    expect(procedureEvidence(l.procedures[0])).toBe(
      "Observed 4 times, last Sep 18 · 2 steps · confidence 60%",
    );
    expect(procedureReplays(l.procedures[0])).toContain("Not replayed yet");
    expect(procedureReplays(l.procedures[1])).toBe(
      "Replayed 3 times: 2 worked, 1 did not",
    );
    expect(preferenceEvidence(l.preferences[0])).toBe(
      "Seen 6 times, last Sep 18",
    );
  });
});

describe("the pane", () => {
  const info = {
    settings: defaultSettings,
    tools: { apple: { state: "off", access: {} }, servers: [] },
  } as unknown as AppInfo;
  const api = {
    watchingStatus: async () => status(),
    learnedProposals: async () => learned(),
  } as unknown as Bridge;
  const render = (s: Settings) =>
    renderToStaticMarkup(
      React.createElement(SettingsWatching, {
        s,
        set: () => {},
        api,
        busy: false,
        info,
      }),
    );

  it("renders the switch, the tier sentences, retention, forget, and the privacy sentence", () => {
    const html = render(defaultSettings);
    expect(html).toContain("Watch how I work");
    expect(html).toContain('<option value="structure"');
    expect(html).toContain('<option value="pixels"');
    // The markup escapes the apostrophe in "site's"; a fragment without one is pinned.
    expect(html).toContain("Stores which application and window are in front");
    expect(html).toContain("Sends the model that same timeline");
    expect(html).toContain('type="number"');
    expect(html).toContain("Forget today");
    expect(html).toContain("Forget all");
    expect(html).toContain("Private local: the day");
    expect(html).toContain("Off</span>");
    // Before the status arrives.
    expect(html).toContain("Reading…");
    expect(html).toContain("Nothing proposed yet.");
    const byom: Settings = {
      ...defaultSettings,
      privacy: "PRIVATE_BYOM",
      provider: "anthropic",
      model: "claude-x",
      endpoint: "https://api.anthropic.com",
      observer: { ...defaultSettings.observer, on: true, tier: "pixels" },
    };
    const remote = render(byom);
    expect(remote).toContain("goes to anthropic (claude-x)");
    expect(remote).toContain("Pictures never leave this Mac");
    expect(remote).toContain("Watching · with pictures");
  });

  it("mounts after Modules and the bridge carries the five calls on both sides", () => {
    const ui = read("src/ui/main.tsx");
    expect(ui).toContain(
      'import { SettingsWatching } from "./settings-watching";',
    );
    const modules = ui.indexOf("<SettingsModules s={s}");
    const watching = ui.indexOf("<SettingsWatching s={s}");
    expect(modules).toBeGreaterThan(0);
    expect(watching).toBeGreaterThan(modules);
    const preload = read("electron/preload.ts");
    for (const call of [
      "watchingStatus",
      "setWatchingPaused",
      "forgetWatching",
      "learnedProposals",
      "decideProposal",
    ])
      expect(preload).toContain(`${call}: (`);
    expect(preload).toContain('watchingStatus: () => invoke("watchingStatus")');
    const api = read("src/ui/api.ts");
    expect(api).toContain("watchingStatus(): Promise<WatchingStatus>;");
    expect(api).toContain(
      "setWatchingPaused(paused: boolean): Promise<WatchingStatus>;",
    );
    expect(api).toContain(
      'forgetWatching(scope: "today" | "all"): Promise<WatchingStatus>;',
    );
    expect(api).toContain("learnedProposals(): Promise<LearnedProposals>;");
    expect(api).toContain("decideProposal(");
  });

  it("the preview watches nothing and proposes nothing", async () => {
    const bridge = previewBridge();
    const s = await bridge.watchingStatus();
    expect(s).toMatchObject({ on: false, state: "off", days: [], bytes: 0 });
    expect(s.today.frames).toBe(0);
    expect(await bridge.learnedProposals()).toEqual({
      routines: [],
      procedures: [],
      preferences: [],
    });
    expect(await bridge.decideProposal("routine", "x", "approve")).toEqual({
      routines: [],
      procedures: [],
      preferences: [],
    });
    expect((await bridge.forgetWatching("all")).on).toBe(false);
  });
});

describe("main.ts wiring, pinned by source", () => {
  const main = read("electron/main.ts");
  it("creates the observer over the work log and consolidator, and the routine scheduler", () => {
    expect(main).toContain(
      'import { createWorkLog, OBSERVER_DIR } from "../src/observer/log";',
    );
    expect(main).toContain(
      'import { createObserver, type Observer } from "./observer";',
    );
    expect(main).toContain(
      'import { createRoutineScheduler, type RoutineScheduler } from "./routines";',
    );
    const block = main.slice(
      main.indexOf("function getObserver()"),
      main.indexOf("function getRoutines()"),
    );
    expect(block).toContain("const directory = join(root, OBSERVER_DIR);");
    expect(block).toContain("key: master,");
    expect(block).toContain("tier: () => settings.observer.tier,");
    expect(block).toContain(
      "retentionDays: () => settings.observer.retentionDays,",
    );
    expect(block).toContain(
      "onDayEnd: (day) => void consolidator.dayEnd(day),",
    );
    expect(block).toContain("memory: () => memory?.data(),");
    expect(block).toContain("budget: createTokenBudget(directory),");
    expect(block).toContain("idleMs: () => presence.idleMs(),");
    expect(block).toContain("helperRunning: () => !!native,");
    expect(block).toContain("say: (text) =>");
    expect(block).toContain("conversation.say(");
    expect(block).toContain("onChange: () => updateTray(),");
    const scheduler = main.slice(
      main.indexOf("function getRoutines()"),
      main.indexOf("/** Settings with one server row replaced. */"),
    );
    expect(scheduler).toContain("typingIn: () => getObserver().typingIn(),");
    expect(scheduler).toContain(
      "start: (task, source) => startRun(task, false, source),",
    );
    expect(scheduler).toContain("listening: () => listening,");
  });

  it("shows the eye and the pause item in the menu bar, runs the watching plan and the IPC cases", () => {
    expect(main).toContain(
      'tray.setTitle(observer?.state() === "on" ? "Butler 👁" : "Butler");',
    );
    expect(main).toContain("const watchingLabel = observer?.menuLabel();");
    expect(main).toContain(".setPaused(!getObserver().paused)");
    expect(main).toContain('case "watching": {');
    expect(main).toContain('idleCard("Stopped watching.");');
    expect(main).toContain('idleCard("Watching again.");');
    expect(main).toContain('in Settings first.");');
    for (const c of [
      "watchingStatus",
      "setWatchingPaused",
      "forgetWatching",
      "learnedProposals",
      "decideProposal",
    ])
      expect(main).toContain(`case "${c}":`);
    expect(main).toContain('z.enum(["today", "all"]).parse(args[0])');
    expect(main).toContain('.enum(["routine", "procedure", "preference"])');
    expect(main).toContain(
      'z.enum(["approve", "dismiss", "never"]).parse(args[2])',
    );
    expect(main).toContain(
      "decideProposalIn(data, kind, id, decision, new Date())",
    );
  });

  it("pushes the setting on save, admits the routine origin, hooks the stream and follows runs and quit", () => {
    const save = main.slice(
      main.indexOf('case "saveSettings": {'),
      main.indexOf('case "saveSettings": {') + 8000,
    );
    expect(save).toContain("void getObserver()\n        .apply()");
    expect(main).toContain('"remote",\n        "routine",\n      ])');
    expect(main).toContain("observed: (event) => observer?.observed(event),");
    expect(main).toContain(
      "routines?.onSnapshot(s);\n  observer?.onSnapshot(s);",
    );
    expect(main).toContain("if (from?.undo) routines?.noteUndo();");
    expect(main).toContain("getObserver().start();");
    expect(main).toContain("routineClock = setInterval(");
    expect(main).toContain(
      "clearInterval(routineClock);\n  observer?.close();",
    );
    // The renderer's start still names no origin.
    expect(main).toContain('method === "start" ? args.slice(0, 2) : args');
  });

  it("allow-lists the observer's diagnostic keys and nothing content-bearing", () => {
    const d = read("electron/diagnostics.ts");
    for (const key of [
      '"excluded"',
      '"tokens"',
      '"routines"',
      '"procedures"',
      '"routineId"',
      '"removed"',
      '"imagesExpired"',
      '"on"',
      '"scope"',
    ])
      expect(d).toContain(key);
    expect(d).not.toContain('"windowTitle"');
    // WebPageRead's host is a fixed word (loopback | public | private) read
    // through hostCode, never the address: the key may appear, its reader
    // must be the code function.
    expect(d).toContain('if (field === "host") return hostCode(value);');
    expect(d).not.toContain('"textDigest"');
  });
});

describe("the controller's observe API (lane O1, landed)", () => {
  it("names observe(options), setObserveRun, the observed hook and the three events", () => {
    expect(OBSERVE_EVENTS).toEqual(
      new Set(["observe_frame", "observe_action", "observe_dropped"]),
    );
    expect(typeof NativeController.prototype.observe).toBe("function");
    expect(typeof NativeController.prototype.setObserveRun).toBe("function");
    const source = read("electron/controller.ts");
    expect(source).not.toContain("STUB for lane O2");
    expect(source).toContain("observed?: (event: ObservedEvent) => void;");
    expect(source).toContain(
      "async observe(options: ObserveOptions): Promise<ObserveState> {",
    );
    expect(source).toContain("setObserveRun(runId: string | undefined)");
  });
});
