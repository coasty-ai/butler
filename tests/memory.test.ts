import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionSchema } from "../src/core/schema";
import { createMemoryAccess } from "../src/memory/access";
import { BROWSERS, matchIntent } from "../src/memory/intents";
import { extractSkill, learnFromRun } from "../src/memory/learn";
import {
  bm25,
  CONTEXT_LIMITS,
  isSafeIndexPath,
  recallContext,
  tokenize,
} from "../src/memory/retrieve";
import {
  matchSkill,
  outlineOf,
  replayable,
  templateOf,
  toPlan,
} from "../src/memory/skills";
import {
  emptyMemory,
  MEMORY_FILE,
  MEMORY_LIMITS,
  MemoryStore,
  prune,
} from "../src/memory/store";
import type {
  Episode,
  LearnInput,
  MemoryData,
  Skill,
  SystemIndex,
  TrajectoryStep,
} from "../src/memory/types";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-memory-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-16T12:00:00.000Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const episode = (overrides: Partial<Episode> = {}): Episode => ({
  id: overrides.id ?? `run-${Math.random()}`,
  kind: "episode",
  task: "open calculator and compute 12*7",
  tokens: tokenize(overrides.task ?? "open calculator and compute 12*7"),
  status: "completed",
  apps: ["com.apple.calculator"],
  summary: "Done",
  corrections: [],
  actions: 3,
  cost: 0,
  createdAt: NOW.toISOString(),
  ...overrides,
});

const skill = (overrides: Partial<Skill> = {}): Skill => ({
  id: "skill-test",
  kind: "skill",
  trigger: "play {slot0} on youtube",
  tokens: ["play", "youtube"],
  slots: ["slot0"],
  steps: [
    { action: { type: "open_app", name: "Safari" } },
    {
      action: { type: "type_text", text: "{slot0}" },
      expectAppId: "com.apple.Safari",
    },
    { action: { type: "key", key: "ENTER" } },
  ],
  hintOnly: false,
  successes: 2,
  failures: 0,
  createdAt: NOW.toISOString(),
  lastUsed: NOW.toISOString(),
  ...overrides,
});

const index = (overrides: Partial<SystemIndex> = {}): SystemIndex => ({
  apps: [
    { name: "Calculator", bundleId: "com.apple.calculator" },
    { name: "Safari", bundleId: "com.apple.Safari" },
    { name: "Google Chrome", bundleId: "com.google.Chrome" },
    { name: "Google Drive", bundleId: "com.google.drivefs" },
    { name: "Notes", bundleId: "com.apple.Notes" },
    { name: "System Settings", bundleId: "com.apple.systempreferences" },
  ],
  folders: [
    { name: "Documents", path: "~/Documents" },
    { name: "Downloads", path: "~/Downloads" },
  ],
  recentFiles: [],
  matches: [],
  ...overrides,
});

const input = (overrides: Partial<LearnInput> = {}): LearnInput => ({
  runId: "11111111-1111-4111-8111-111111111111",
  task: "open calculator",
  status: "completed",
  synthetic: false,
  summary: "Opened Calculator",
  corrections: [],
  steps: [
    {
      action: { type: "open_app", name: "Calculator" },
      launchedAppId: "com.apple.calculator",
    },
  ],
  appsSeen: ["com.apple.finder", "com.apple.calculator"],
  usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
  ...overrides,
});

// A successful "play X on youtube" run with a labelled search field.
const youtubeSteps = (query: string): TrajectoryStep[] => [
  {
    action: { type: "open_app", name: "Safari" },
    appId: "com.apple.finder",
    launchedAppId: "com.apple.Safari",
  },
  {
    action: { type: "hotkey", keys: ["CMD", "L"] },
    appId: "com.apple.Safari",
  },
  {
    action: { type: "type_text", text: "youtube.com" },
    appId: "com.apple.Safari",
  },
  { action: { type: "key", key: "ENTER" }, appId: "com.apple.Safari" },
  { action: { type: "capture" }, appId: "com.apple.Safari" },
  {
    action: { type: "click", x: 0.5, y: 0.1, button: "left" },
    appId: "com.apple.Safari",
    target: { role: "AXTextField", label: "Search" },
  },
  { action: { type: "type_text", text: query }, appId: "com.apple.Safari" },
  { action: { type: "key", key: "ENTER" }, appId: "com.apple.Safari" },
  { action: { type: "done", summary: "Playing" }, appId: "com.apple.Safari" },
];

describe("MemoryStore", () => {
  it("round-trips encrypted data without plaintext on disk", () => {
    const dir = join(tempDir(), "memory");
    const key = randomBytes(32);
    const store = new MemoryStore(dir, key, () => NOW);
    expect(store.summary()).toEqual({
      episodes: 0,
      preferences: 0,
      skills: 0,
      apps: 0,
    });
    store.addEpisode(episode({ id: "a", task: "email the quarterly budget" }));
    store.upsertPreference("Use Google Chrome for browsing");
    store.recordAppUse("com.google.Chrome", "Google Chrome");
    store.upsertSkill(skill());
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
    store.flush();
    const path = join(dir, MEMORY_FILE);
    const raw = readFileSync(path);
    expect(raw.toString("latin1")).not.toContain("quarterly");
    expect(raw.toString("latin1")).not.toContain("Chrome");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(path + ".tmp")).toBe(false);

    const again = new MemoryStore(dir, key, () => NOW);
    expect(again.summary()).toEqual({
      episodes: 1,
      preferences: 1,
      skills: 1,
      apps: 1,
    });
    expect(again.data().episodes[0].task).toBe("email the quarterly budget");
    expect(again.data().apps["com.google.Chrome"].name).toBe("Google Chrome");
  });

  it("loads lazily and starts empty when the file is missing", () => {
    const dir = tempDir();
    const store = new MemoryStore(dir, randomBytes(32));
    expect(store.data()).toEqual(emptyMemory());
    store.flush();
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
  });

  it("recovers from a corrupt or foreign-key file and keeps a copy", () => {
    const dir = tempDir();
    const writer = new MemoryStore(dir, randomBytes(32));
    writer.addEpisode(episode({ id: "x" }));
    writer.flush();
    const onError = vi.fn();
    const reader = new MemoryStore(dir, randomBytes(32), () => NOW, {
      onError,
    });
    expect(reader.summary().episodes).toBe(0);
    expect(onError).toHaveBeenCalled();
    expect(existsSync(join(dir, MEMORY_FILE + ".corrupt"))).toBe(true);

    writeFileSync(join(dir, MEMORY_FILE), "garbage");
    const garbage = new MemoryStore(dir, randomBytes(32));
    expect(garbage.data().skills).toEqual([]);
    garbage.recordAppUse("com.apple.Notes", "Notes");
    garbage.flush();
    expect(new MemoryStore(dir, randomBytes(32)).summary().apps).toBe(0);
  });

  it("rejects decrypted data with the wrong shape", async () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const { seal } = await import("../src/storage/vault");
    writeFileSync(
      join(dir, MEMORY_FILE),
      seal(key, Buffer.from(JSON.stringify({ version: 2 })), "memory"),
    );
    expect(new MemoryStore(dir, key).data()).toEqual(emptyMemory());
    // A different AAD is not accepted either.
    writeFileSync(
      join(dir, MEMORY_FILE),
      seal(key, Buffer.from(JSON.stringify(emptyMemory())), "other"),
    );
    expect(new MemoryStore(dir, key).data()).toEqual(emptyMemory());
  });

  it("debounces writes", async () => {
    const dir = tempDir();
    const store = new MemoryStore(dir, randomBytes(32), () => NOW, {
      debounceMs: 20,
    });
    store.recordAppUse("com.apple.Notes", "Notes");
    store.recordAppUse("com.apple.Notes", "Notes");
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(true);
    expect(store.data().apps["com.apple.Notes"].count).toBe(2);
  });

  it("dedupes preferences, counts apps and marks skills", () => {
    const store = new MemoryStore(tempDir(), randomBytes(32), () => NOW);
    store.upsertPreference("Use Chrome, not Safari.");
    const pref = store.upsertPreference("use   chrome, not safari");
    expect(pref?.weight).toBe(2);
    expect(store.data().preferences).toHaveLength(1);
    expect(store.upsertPreference("   ")).toBeUndefined();
    store.recordAppUse("com.apple.Notes");
    store.recordAppUse("com.apple.Notes", "Notes");
    expect(store.data().apps["com.apple.Notes"]).toMatchObject({
      count: 2,
      name: "Notes",
    });
    expect(store.recordAppUse("__proto__", "x")).toBeUndefined();
    expect(Object.getPrototypeOf(store.data().apps)).toBe(Object.prototype);
    store.upsertSkill(skill({ successes: 1 }));
    store.markSkill("skill-test", true);
    store.markSkill("skill-test", false);
    expect(store.data().skills[0]).toMatchObject({ successes: 2, failures: 1 });
    expect(store.markSkill("missing", true)).toBeUndefined();
  });

  it("clears everything", () => {
    const dir = tempDir();
    const store = new MemoryStore(dir, randomBytes(32));
    store.addEpisode(episode());
    store.flush();
    writeFileSync(join(dir, MEMORY_FILE + ".corrupt"), "x");
    store.clear();
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
    expect(existsSync(join(dir, MEMORY_FILE + ".corrupt"))).toBe(false);
    expect(store.summary().episodes).toBe(0);
    store.flush();
    expect(existsSync(join(dir, MEMORY_FILE))).toBe(false);
  });
});

describe("caps and decay", () => {
  it("prunes stale episodes first, then the oldest", () => {
    const data = emptyMemory();
    for (let i = 0; i < 20; i++)
      data.episodes.push(episode({ id: `old-${i}`, createdAt: daysAgo(120) }));
    for (let i = 0; i < MEMORY_LIMITS.episodes - 5; i++)
      data.episodes.push(episode({ id: `new-${i}`, createdAt: daysAgo(1) }));
    prune(data, NOW);
    expect(data.episodes).toHaveLength(MEMORY_LIMITS.episodes - 5);
    expect(data.episodes.some((e) => e.id.startsWith("old"))).toBe(false);

    const fresh = emptyMemory();
    for (let i = 0; i < MEMORY_LIMITS.episodes + 10; i++)
      fresh.episodes.push(
        episode({ id: `e-${i}`, createdAt: daysAgo(10 - i / 100) }),
      );
    prune(fresh, NOW);
    expect(fresh.episodes).toHaveLength(MEMORY_LIMITS.episodes);
    expect(fresh.episodes[0].id).toBe("e-10");
    expect(fresh.episodes.at(-1)?.id).toBe(`e-${MEMORY_LIMITS.episodes + 9}`);
  });

  it("keeps stale entries while under the cap", () => {
    const data = emptyMemory();
    data.episodes.push(episode({ createdAt: daysAgo(400) }));
    data.skills.push(skill({ lastUsed: daysAgo(400) }));
    prune(data, NOW);
    expect(data.episodes).toHaveLength(1);
    expect(data.skills).toHaveLength(1);
  });

  it("caps skills, preferences and apps", () => {
    const data = emptyMemory();
    for (let i = 0; i < MEMORY_LIMITS.skills + 5; i++)
      data.skills.push(
        skill({
          id: `s-${i}`,
          trigger: `t ${i}`,
          lastUsed: i < 3 ? daysAgo(200) : daysAgo(1),
        }),
      );
    for (let i = 0; i < MEMORY_LIMITS.preferences + 3; i++)
      data.preferences.push({
        id: `p-${i}`,
        kind: "preference",
        text: `p ${i}`,
        tokens: ["p"],
        weight: i === 0 ? 10 : 1,
        source: "correction",
        createdAt: NOW.toISOString(),
        updatedAt: daysAgo(i),
      });
    for (let i = 0; i < MEMORY_LIMITS.apps + 2; i++)
      data.apps[`app.${i}`] = {
        bundleId: `app.${i}`,
        name: `App ${i}`,
        count: 1,
        lastUsed: daysAgo(i),
      };
    prune(data, NOW);
    expect(data.skills).toHaveLength(MEMORY_LIMITS.skills);
    expect(data.skills.some((s) => ["s-0", "s-1", "s-2"].includes(s.id))).toBe(
      false,
    );
    expect(data.preferences).toHaveLength(MEMORY_LIMITS.preferences);
    expect(data.preferences.some((p) => p.id === "p-0")).toBe(true);
    expect(data.preferences.some((p) => p.id === "p-202")).toBe(false);
    expect(Object.keys(data.apps)).toHaveLength(MEMORY_LIMITS.apps);
    expect(data.apps["app.0"]).toBeDefined();
    expect(data.apps[`app.${MEMORY_LIMITS.apps + 1}`]).toBeUndefined();
  });
});

describe("retrieval", () => {
  it("tokenizes without punctuation, quotes or stopwords", () => {
    expect(tokenize("Please open “Calculator”, and compute 12*7!")).toEqual([
      "open",
      "calculator",
      "compute",
      "12",
      "7",
    ]);
    expect(tokenize("Don’t use the Mail app")).toEqual(["dont", "mail", "app"]);
    expect(tokenize("")).toEqual([]);
  });

  it("ranks with BM25", () => {
    const docs = [
      ["open", "calculator"],
      ["open", "notes"],
      ["calculator", "compute", "calculator", "sum"],
      [],
    ];
    const scores = bm25(["calculator", "open"], docs);
    expect(scores[3]).toBe(0);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[2]).toBeGreaterThan(scores[1]);
    // The rare term outweighs the common one.
    const rare = bm25(["notes"], docs);
    const common = bm25(["open"], docs);
    expect(rare[1]).toBeGreaterThan(common[1]);
    expect(bm25(["x"], [])).toEqual([]);
  });

  it("formats relevant episode lines", () => {
    const data = emptyMemory();
    data.apps["com.apple.calculator"] = {
      bundleId: "com.apple.calculator",
      name: "Calculator",
      count: 1,
      lastUsed: NOW.toISOString(),
    };
    data.episodes.push(episode({ id: "1" }));
    data.episodes.push(
      episode({
        id: "2",
        task: "write a poem in notes",
        tokens: tokenize("write a poem in notes"),
        apps: [],
        status: "failed",
      }),
    );
    const context = recallContext(data, "compute 3*4 in calculator");
    expect(context.episodes).toEqual([
      '✓ "open calculator and compute 12*7" → Calculator; completed',
    ]);
    const failed = recallContext(data, "poem");
    expect(failed.episodes).toEqual(['✗ "write a poem in notes"; failed']);
    data.episodes.push(
      episode({
        id: "3",
        task: "poem again",
        tokens: ["poem", "again"],
        outcome: false,
        apps: ["com.unknown"],
      }),
    );
    expect(recallContext(data, "poem again").episodes[0]).toBe(
      '✗ "poem again" → com.unknown; completed, but the user said it did not work',
    );
  });

  it("bounds every list and redacts secrets", () => {
    const data = emptyMemory();
    for (let i = 0; i < 20; i++) {
      data.episodes.push(
        episode({
          id: `e${i}`,
          task: `open report ${i}`,
          tokens: ["open", "report", `${i}`],
        }),
      );
      data.preferences.push({
        id: `p${i}`,
        kind: "preference",
        text: `report preference ${i} ` + "x".repeat(400),
        tokens: ["report", "preference"],
        weight: 1,
        source: "correction",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      data.apps[`app.${i}`] = {
        bundleId: `app.${i}`,
        name: `App ${i}`,
        count: i,
        lastUsed: NOW.toISOString(),
      };
    }
    data.preferences.unshift({
      id: "secret",
      kind: "preference",
      text: "my report password: Hunter2secret!",
      tokens: ["report", "password", "hunter2secret"],
      weight: 5,
      source: "correction",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const files = Array.from({ length: 20 }, (_, i) => ({
      name: `report ${i}.pdf`,
      path: `~/Documents/report ${i}.pdf`,
      kind: "PDF",
    }));
    const context = recallContext(data, "open the report password", {
      apps: [],
      folders: Array.from({ length: 20 }, (_, i) => ({
        name: `Folder ${i}`,
        path: `~/Folder ${i}`,
      })),
      recentFiles: files,
      matches: files,
    });
    expect(context.preferences).toHaveLength(CONTEXT_LIMITS.preferences);
    expect(context.episodes).toHaveLength(CONTEXT_LIMITS.episodes);
    expect(context.apps).toHaveLength(CONTEXT_LIMITS.apps);
    expect(context.files).toHaveLength(CONTEXT_LIMITS.files);
    expect(context.folders).toHaveLength(CONTEXT_LIMITS.folders);
    expect(JSON.stringify(context)).not.toContain("Hunter2secret");
    expect(context.preferences[0]).toContain("[Sensitive text omitted]");
    expect(context.preferences.every((p) => p.length <= 200)).toBe(true);
    // Most-used apps first when no task match.
    expect(context.apps?.[0]).toEqual({ name: "App 19", bundleId: "app.19" });
  });

  it("orders task-matched apps and files first and filters unsafe paths", () => {
    const data = emptyMemory();
    data.apps["com.apple.Notes"] = {
      bundleId: "com.apple.Notes",
      name: "Notes",
      count: 50,
      lastUsed: NOW.toISOString(),
    };
    data.apps["com.removed.app"] = {
      bundleId: "com.removed.app",
      name: "Removed",
      count: 99,
      lastUsed: NOW.toISOString(),
    };
    const context = recallContext(data, "open budget in chrome", {
      ...index(),
      recentFiles: [
        {
          name: "Budget 2026.xlsx",
          path: "~/Documents/Budget 2026.xlsx",
          kind: "Excel",
        },
        { name: "Other.txt", path: "~/Documents/Other.txt", kind: "Text" },
      ],
      matches: [
        {
          name: "budget.numbers",
          path: "~/Desktop/budget.numbers",
          kind: "Numbers",
          lastUsed: "2026-09-01",
        },
        { name: "budget.key", path: "~/Library/Keys/budget.key", kind: "Key" },
        { name: "budget", path: "~/.secret/budget", kind: "Folder" },
        { name: "budget", path: "/Users/me/budget", kind: "Folder" },
      ],
    });
    expect(context.apps?.slice(0, 2)).toEqual([
      { name: "Google Chrome", bundleId: "com.google.Chrome" },
      { name: "Notes", bundleId: "com.apple.Notes" },
    ]);
    expect(context.apps?.some((a) => a.bundleId === "com.removed.app")).toBe(
      false,
    );
    expect(context.files?.map((f) => f.path)).toEqual([
      "~/Desktop/budget.numbers",
      "~/Documents/Budget 2026.xlsx",
    ]);
    expect(context.files?.[0].lastUsed).toBe("2026-09-01");
    expect(context.folders).toHaveLength(2);
    expect(isSafeIndexPath("~/Library")).toBe(false);
    expect(isSafeIndexPath("~/a/../b")).toBe(false);
    expect(isSafeIndexPath("~/a/node_modules/x")).toBe(false);
    expect(isSafeIndexPath("~/")).toBe(false);
  });

  it("sends only task-relevant preferences and keeps room for usage lines", () => {
    const data = emptyMemory();
    const learned = input({
      task: "email my doctor about the test results",
      corrections: [
        "send it to dr.lee@clinic.org, my oncologist, not the pharmacy at +1 415 555 0199",
      ],
    });
    learnFromRun(data, learned, NOW);
    expect(data.preferences).toHaveLength(1);
    expect(recallContext(data, "open calculator").preferences).toEqual([]);
    expect(
      recallContext(data, "send the results to my oncologist").preferences,
    ).toHaveLength(1);

    // Many relevant corrections do not push out the usage-derived choices.
    for (let i = 0; i < 8; i++)
      data.preferences.push({
        id: `p${i}`,
        kind: "preference",
        text: `for reports, detail ${i}`,
        tokens: ["reports", "detail", `${i}`],
        weight: 1,
        source: "correction",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    for (const [bundleId, name] of [
      ["com.google.Chrome", "Google Chrome"],
      ["com.apple.Notes", "Notes"],
    ])
      data.apps[bundleId] = {
        bundleId,
        name,
        count: 3,
        lastUsed: NOW.toISOString(),
      };
    const context = recallContext(data, "write the weekly reports");
    expect(context.preferences).toHaveLength(CONTEXT_LIMITS.preferences);
    expect(context.preferences.slice(-2)).toEqual([
      "Usually uses Google Chrome as the browser.",
      "Usually uses Notes as the notes app.",
    ]);
    expect(
      context.preferences.slice(0, 3).every((p) => p.startsWith("for reports")),
    ).toBe(true);
    expect(recallContext(data, "open calculator").preferences).toEqual([
      "Usually uses Google Chrome as the browser.",
      "Usually uses Notes as the notes app.",
    ]);
  });

  it("recalls a correction for the task it corrected", () => {
    const data = emptyMemory();
    learnFromRun(
      data,
      input({
        task: "email my doctor about the test results",
        corrections: ["send it to dr.lee@clinic.org, my oncologist"],
      }),
      NOW,
    );
    // The correction's own words do not overlap the task wording.
    expect(recallContext(data, "email the doctor").preferences).toEqual([
      "send it to dr.lee@clinic.org, my oncologist",
    ]);
    expect(
      recallContext(data, "email my doctor about the test results").preferences,
    ).toHaveLength(1);
    expect(recallContext(data, "open calculator").preferences).toEqual([]);
    // Reinforcing from another task merges its tokens, within a bound.
    learnFromRun(
      data,
      input({
        runId: "r2",
        task: "message the clinic about my appointment",
        corrections: ["send it to dr.lee@clinic.org, my oncologist"],
      }),
      NOW,
    );
    expect(data.preferences).toHaveLength(1);
    expect(data.preferences[0].weight).toBe(2);
    expect(data.preferences[0].tokens).toEqual(
      expect.arrayContaining(["doctor", "appointment"]),
    );
    expect(data.preferences[0].tokens.length).toBeLessThanOrEqual(40);
  });

  it("omits index sections without an index and adds usage preferences", () => {
    const data = emptyMemory();
    data.apps["com.google.Chrome"] = {
      bundleId: "com.google.Chrome",
      name: "Google Chrome",
      count: 4,
      lastUsed: NOW.toISOString(),
    };
    data.apps["com.apple.Safari"] = {
      bundleId: "com.apple.Safari",
      name: "Safari",
      count: 2,
      lastUsed: NOW.toISOString(),
    };
    const context = recallContext(data, "anything");
    expect(context.preferences).toEqual([
      "Usually uses Google Chrome as the browser.",
    ]);
    expect(context.files).toBeUndefined();
    expect(context.folders).toBeUndefined();
    expect(context.apps?.map((a) => a.name)).toEqual([
      "Google Chrome",
      "Safari",
    ]);
    expect(recallContext(emptyMemory(), "x")).toEqual({
      preferences: [],
      episodes: [],
    });
  });
});

describe("built-in intents", () => {
  const validate = (plan: ReturnType<typeof matchIntent>) => {
    for (const step of plan?.steps ?? [])
      expect(() =>
        actionSchema.parse({ ...step.action, frame_id: "f" }),
      ).not.toThrow();
  };

  it("opens a uniquely matching app", () => {
    for (const task of [
      "open calculator",
      "Open Calculator.",
      "launch the Calculator app",
      "please switch to calculator",
      "start Calculator",
      "go to calculator",
    ]) {
      const plan = matchIntent(task, index());
      expect(plan, task).toMatchObject({
        source: "intent",
        mode: "replay",
        steps: [{ action: { type: "open_app", name: "Calculator" } }],
        completeWhen: { appId: "com.apple.calculator" },
        outline: ["Open Calculator"],
      });
      validate(plan);
    }
    expect(matchIntent("switch to chrome", index())?.steps[0].action).toEqual({
      type: "open_app",
      name: "Google Chrome",
    });
    expect(matchIntent("open settings", index())?.completeWhen).toEqual({
      appId: "com.apple.systempreferences",
    });
    expect(matchIntent("open calculator", index())?.id).toBe(
      matchIntent("launch calculator", index())?.id,
    );
  });

  it("never treats an app bundle, script or code file name as a website", () => {
    expect(matchIntent("open Notes.app", index())).toMatchObject({
      steps: [{ action: { type: "open_app", name: "Notes" } }],
      completeWhen: { appId: "com.apple.Notes" },
    });
    for (const task of [
      "open setup.py",
      "open build.sh",
      "open deploy.command",
      "open main.swift",
      "open Photoshop.app",
    ])
      expect(matchIntent(task, index()), task).toBeUndefined();
    // An explicit web verb, a path or a scheme still navigates.
    expect(matchIntent("go to notes.app", index())?.completeWhen).toEqual({
      host: "notes.app",
    });
    expect(
      matchIntent("open notes.app/welcome", index())?.steps[2].action,
    ).toEqual({ type: "type_text", text: "notes.app/welcome" });
  });

  it("refuses ambiguous, unknown and multi-step requests", () => {
    for (const task of [
      "open google",
      "open photoshop",
      "open calculator and compute 12*7",
      "open safari and then go to youtube.com",
      "open notes, write hello",
      "open notes then type hello",
      "if it is raining open notes",
      "open notes unless it is late",
      "open",
      "calculator",
      "close calculator",
      "visit calculator",
      "open the new document",
    ])
      expect(matchIntent(task, index()), task).toBeUndefined();
    expect(matchIntent("open calculator", undefined)).toBeUndefined();
  });

  it("goes to a domain or https URL in the preferred browser", () => {
    const plan = matchIntent("go to youtube.com", index());
    expect(plan).toMatchObject({
      source: "intent",
      mode: "replay",
      completeWhen: { host: "youtube.com" },
      steps: [
        { action: { type: "open_app", name: "Safari" } },
        {
          action: { type: "hotkey", keys: ["CMD", "L"] },
          expectAppId: "com.apple.Safari",
        },
        {
          action: { type: "type_text", text: "youtube.com" },
          expectAppId: "com.apple.Safari",
        },
        {
          action: { type: "key", key: "ENTER" },
          expectAppId: "com.apple.Safari",
        },
      ],
      outline: [
        "Open Safari",
        "Press Command-L",
        'Type "youtube.com"',
        "Press Enter",
      ],
    });
    validate(plan);
    expect(
      matchIntent("Visit https://www.example.org/a?b=1", index()),
    ).toMatchObject({
      completeWhen: { host: "example.org" },
      steps: [
        {},
        {},
        { action: { text: "https://www.example.org/a?b=1" } },
        {},
      ],
    });
    expect(
      matchIntent("open www.GitHub.com/anthropics", index()),
    ).toMatchObject({
      completeWhen: { host: "github.com" },
    });
    expect(matchIntent("go to example.com:8080/x", index())).toMatchObject({
      completeWhen: { host: "example.com" },
      steps: [{}, {}, { action: { text: "example.com:8080/x" } }, {}],
    });
    for (const task of [
      "go to http://example.com",
      "go to file:///etc/passwd",
      "go to javascript:alert(1)",
      "go to youtube.com and search cats",
      "go to https://user:pw@example.com",
    ])
      expect(matchIntent(task, index()), task).toBeUndefined();
  });

  it("prefers the most used installed browser", () => {
    const data = emptyMemory();
    data.apps["com.google.Chrome"] = {
      bundleId: "com.google.Chrome",
      name: "Google Chrome",
      count: 5,
      lastUsed: NOW.toISOString(),
    };
    data.apps["com.apple.Safari"] = {
      bundleId: "com.apple.Safari",
      name: "Safari",
      count: 2,
      lastUsed: NOW.toISOString(),
    };
    data.apps["org.mozilla.firefox"] = {
      bundleId: "org.mozilla.firefox",
      name: "Firefox",
      count: 9,
      lastUsed: NOW.toISOString(),
    };
    // Firefox is not installed according to the index.
    const plan = matchIntent("go to example.com", index(), data);
    expect(plan?.steps[0].action).toEqual({
      type: "open_app",
      name: "Google Chrome",
    });
    expect(plan?.steps[1].expectAppId).toBe("com.google.Chrome");
    // Without an index, launched browsers count as installed.
    expect(
      matchIntent("go to example.com", undefined, data)?.steps[0].action,
    ).toEqual({ type: "open_app", name: "Firefox" });
    expect(
      matchIntent("go to example.com", undefined, emptyMemory())?.steps[0]
        .action,
    ).toEqual({ type: "open_app", name: "Safari" });
    expect(BROWSERS).toHaveLength(6);
  });

  it("searches Google", () => {
    for (const [task, url] of [
      ["search google for cats", "https://www.google.com/search?q=cats"],
      [
        "google best pizza near me",
        "https://www.google.com/search?q=best+pizza+near+me",
      ],
      // A fully quoted query may contain connector words.
      [
        "search the web for “c++ if statements”",
        "https://www.google.com/search?q=c%2B%2B+if+statements",
      ],
      [
        'search for "rust & go" on google',
        "https://www.google.com/search?q=rust+%26+go",
      ],
      [
        'google "don\'t stop me now"',
        "https://www.google.com/search?q=don't+stop+me+now",
      ],
    ]) {
      const plan = matchIntent(task, index());
      expect(plan?.steps[2].action, task).toEqual({
        type: "type_text",
        text: url,
      });
      expect(plan?.completeWhen).toEqual({ host: "google.com" });
      validate(plan);
    }
    for (const task of [
      "search google for cats, then open the first result",
      "google cats then open the first one",
      "search google for password: Hunter2secret!",
      "search google for",
      // Compound or conditional requests go to the model.
      "search the web for hotels in paris and email them to alice",
      "search google for cats and dogs",
      "search for rust & go on google",
      "google the weather if it is raining",
      "google flights when prices drop",
      "search google for cats unless it is late",
      'search google for "cats" and open the first result',
    ])
      expect(matchIntent(task, index()), task).toBeUndefined();
  });

  it("searches and plays on YouTube", () => {
    const search = matchIntent("search youtube for lofi beats", index());
    expect(search?.steps[2].action).toEqual({
      type: "type_text",
      text: "https://www.youtube.com/results?search_query=lofi+beats",
    });
    expect(search?.completeWhen).toEqual({ host: "youtube.com" });
    expect(matchIntent("youtube cat videos", index())?.steps[2].action).toEqual(
      {
        type: "type_text",
        text: "https://www.youtube.com/results?search_query=cat+videos",
      },
    );
    const play = matchIntent("play Bohemian Rhapsody on YouTube", index());
    expect(play?.steps[2].action).toEqual({
      type: "type_text",
      text: "https://www.youtube.com/results?search_query=Bohemian+Rhapsody",
    });
    expect(play?.completeWhen).toBeUndefined();
    expect(play?.mode).toBe("replay");
    expect(play?.id).not.toBe(search?.id);
    expect(matchIntent("play music", index())).toBeUndefined();
    for (const task of [
      "search youtube for lofi and play the first video",
      "search youtube for lofi & play the first video",
      "youtube lofi then play the first one",
      "play lofi on youtube when i get home",
      "search for cats and like the first video on youtube",
    ])
      expect(matchIntent(task, index()), task).toBeUndefined();
    expect(
      matchIntent('play "rock and roll" on youtube', index())?.steps[2].action,
    ).toEqual({
      type: "type_text",
      text: "https://www.youtube.com/results?search_query=rock+and+roll",
    });
  });

  it("opens a single matching file or folder", () => {
    const idx = index({
      matches: [
        { name: "Budget.xlsx", path: "~/Documents/Budget.xlsx", kind: "Excel" },
        { name: "Projects", path: "~/Projects", kind: "Folder" },
        { name: "notes.txt", path: "~/Desktop/notes.txt", kind: "Text" },
        { name: "notes.txt", path: "~/Documents/notes.txt", kind: "Text" },
        { name: "secret.pdf", path: "~/Library/secret.pdf", kind: "PDF" },
      ],
    });
    for (const task of [
      "open file Budget.xlsx",
      "open the document budget",
      "open budget.xlsx",
      "open my budget spreadsheet",
    ]) {
      const plan = matchIntent(task, idx);
      expect(plan, task).toMatchObject({
        mode: "replay",
        steps: [
          { action: { type: "open_file", path: "~/Documents/Budget.xlsx" } },
        ],
        completeWhen: { opened: true },
      });
      validate(plan);
    }
    expect(
      matchIntent("open the Projects folder", idx)?.steps[0].action,
    ).toEqual({ type: "open_file", path: "~/Projects" });
    for (const task of [
      "open notes.txt",
      "open file notes",
      "open secret.pdf",
      "open file missing.docx",
      "open file budget.xlsx and email it",
    ])
      expect(matchIntent(task, idx), task).toBeUndefined();
    expect(matchIntent("open budget.xlsx", undefined)).toBeUndefined();
  });
});

describe("skills", () => {
  it("templates tasks and matches with slot capture", () => {
    expect(templateOf("Play Lofi Beats on YouTube!", ["lofi beats"])).toBe(
      "play {slot0} on youtube",
    );
    expect(templateOf("say hi to hi-fi", ["hi"])).toBe("say {slot0} to hi-fi");
    expect(templateOf("Please open my budget for me.", [])).toBe(
      "open my budget",
    );
    const s = skill();
    expect(matchSkill([s], "Play Daft Punk on YouTube.")).toEqual({
      skill: s,
      slotValues: ["Daft Punk"],
    });
    expect(matchSkill([s], "play on youtube")).toBeUndefined();
    expect(matchSkill([s], "play daft punk on spotify")).toBeUndefined();
    expect(matchSkill([], "x")).toBeUndefined();
    const exact = skill({ id: "exact", trigger: "open my budget", slots: [] });
    expect(matchSkill([exact], "Open my budget")?.slotValues).toEqual([]);
  });

  it("does not match a task that splits into the slots in more than one way", () => {
    const text = skill({
      id: "text",
      trigger: "text {slot1} to {slot0}",
      slots: ["slot0", "slot1"],
      steps: [
        { action: { type: "open_app", name: "Messages" } },
        { action: { type: "type_text", text: "{slot0}" } },
        { action: { type: "type_text", text: "{slot1}" } },
      ],
      successes: 5,
    });
    expect(
      matchSkill([text], "text running late to Alice")?.slotValues,
    ).toEqual(["Alice", "running late"]);
    expect(
      matchSkill([text], "text I'm going to be late to Bob"),
    ).toBeUndefined();
    // Another unambiguous skill can still match the same task.
    const exact = skill({
      id: "exact",
      trigger: "text i'm going to be late to bob",
      slots: [],
      successes: 1,
    });
    expect(
      matchSkill([text, exact], "text I'm going to be late to Bob")?.skill.id,
    ).toBe("exact");
    // A repeated slot is matched consistently.
    const echo = skill({ id: "echo", trigger: "say {slot0} and {slot0}" });
    expect(matchSkill([echo], "say hi and hi")?.slotValues).toEqual(["hi"]);
    expect(matchSkill([echo], "say a and b and a and b")?.slotValues).toEqual([
      "a and b",
    ]);
  });

  it("prefers replayable skills", () => {
    const weak = skill({
      id: "weak",
      trigger: "play {slot0} on {slot1}",
      successes: 1,
      slots: ["slot0", "slot1"],
    });
    const strong = skill({ id: "strong", successes: 3 });
    expect(matchSkill([weak, strong], "play x on youtube")?.skill.id).toBe(
      "strong",
    );
  });

  it("applies replay thresholds", () => {
    expect(replayable(skill({ successes: 1 }))).toBe(false);
    expect(replayable(skill({ successes: 2 }))).toBe(true);
    expect(replayable(skill({ successes: 3, failures: 1 }))).toBe(true);
    expect(replayable(skill({ successes: 2, failures: 1 }))).toBe(false);
    expect(replayable(skill({ successes: 9, hintOnly: true }))).toBe(false);
  });

  it("builds plans with filled slots and completion", () => {
    const plan = toPlan(skill(), ["Daft Punk"]);
    expect(plan).toMatchObject({
      id: "skill:skill-test",
      source: "skill",
      mode: "replay",
      steps: [
        { action: { type: "open_app", name: "Safari" } },
        {
          action: { type: "type_text", text: "Daft Punk" },
          expectAppId: "com.apple.Safari",
        },
        { action: { type: "key", key: "ENTER" } },
      ],
    });
    expect(plan.completeWhen).toBeUndefined();
    expect(toPlan(skill({ successes: 1 }), ["x"]).mode).toBe("hint");
    // The stored skill is not mutated.
    expect(skill().steps[1].action.text).toBe("{slot0}");

    const opener = skill({
      trigger: "open my editor",
      steps: [
        {
          action: { type: "click" },
          target: { role: "AXButton", label: "Dock" },
        },
        { action: { type: "open_app", name: "Visual Studio Code" } },
      ],
    });
    const resolved = toPlan(opener, [], (name) =>
      name === "Visual Studio Code" ? "com.microsoft.VSCode" : undefined,
    );
    expect(resolved.completeWhen).toEqual({ appId: "com.microsoft.VSCode" });
    expect(resolved.outline).toEqual([
      'Click the button "Dock"',
      "Open Visual Studio Code",
    ]);
    expect(toPlan(opener, []).completeWhen).toBeUndefined();

    // Older skills pinned open steps to the start app; replay ignores that.
    const pinned = skill({
      steps: [
        {
          action: { type: "open_app", name: "Safari" },
          expectAppId: "com.apple.finder",
        },
        {
          action: { type: "open_file", path: "~/Documents/{slot0}" },
          expectAppId: "com.apple.Safari",
        },
        {
          action: { type: "type_text", text: "{slot0}" },
          expectAppId: "com.apple.TextEdit",
        },
      ],
    });
    expect(toPlan(pinned, ["a.txt"]).steps).toEqual([
      { action: { type: "open_app", name: "Safari" } },
      { action: { type: "open_file", path: "~/Documents/a.txt" } },
      {
        action: { type: "type_text", text: "a.txt" },
        expectAppId: "com.apple.TextEdit",
      },
    ]);
  });

  it("bounds outlines", () => {
    const steps = Array.from({ length: 20 }, () => ({
      action: { type: "wait", milliseconds: 100 },
    }));
    const outline = outlineOf(steps);
    expect(outline).toHaveLength(CONTEXT_LIMITS.planSteps);
    expect(outline.at(-1)).toBe("…and 9 more steps");
    expect(
      outlineOf([
        { action: { type: "type_text", text: "api_key=sk-abcdefghijklmnop" } },
      ])[0],
    ).not.toContain("sk-abcdefghijklmnop");
    expect(outlineOf([{ action: { type: "click" } }])[0]).toBe(
      "Click (position learned on screen)",
    );
  });
});

describe("learning", () => {
  it("records episodes, app usage and preferences", () => {
    const data = emptyMemory();
    const result = learnFromRun(
      data,
      input({
        task: "open calculator password: Hunter2secret!",
        corrections: ["Use Chrome instead", "password: Hunter2secret!", " "],
      }),
      NOW,
    );
    expect(result.episode).toBe(true);
    expect(data.episodes[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      actions: 1,
      cost: 0.01,
      apps: ["com.apple.calculator", "com.apple.finder"],
    });
    expect(JSON.stringify(data)).not.toContain("Hunter2secret");
    expect(data.apps["com.apple.calculator"]).toMatchObject({
      name: "Calculator",
      count: 1,
    });
    expect(data.apps["com.apple.finder"].count).toBe(1);
    expect(data.preferences.map((p) => p.text)).toEqual(["Use Chrome instead"]);
    learnFromRun(
      data,
      input({ runId: "r2", corrections: ["use chrome instead."] }),
      NOW,
    );
    expect(data.preferences).toHaveLength(1);
    expect(data.preferences[0].weight).toBe(2);
    expect(data.apps["com.apple.calculator"].count).toBe(2);
  });

  it("ignores synthetic runs", () => {
    const data = emptyMemory();
    expect(learnFromRun(data, input({ synthetic: true }), NOW)).toEqual({
      episode: false,
      preferences: 0,
    });
    expect(data).toEqual(emptyMemory());
  });

  it("extracts skills with slots and label-based pointer steps", () => {
    const data = emptyMemory();
    const result = learnFromRun(
      data,
      input({
        task: "Play lofi beats on YouTube",
        steps: youtubeSteps("lofi beats"),
      }),
      NOW,
    );
    expect(result.skill).toBe("created");
    const learned = data.skills[0];
    expect(learned).toMatchObject({
      trigger: "play {slot0} on youtube",
      slots: ["slot0"],
      hintOnly: false,
      successes: 1,
      failures: 0,
    });
    expect(learned.steps).toHaveLength(7);
    expect(learned.steps.map((s) => s.action.type)).toEqual([
      "open_app",
      "hotkey",
      "type_text",
      "key",
      "click",
      "type_text",
      "key",
    ]);
    expect(learned.steps[4]).toEqual({
      action: { type: "click", button: "left" },
      target: { role: "AXTextField", label: "Search" },
      expectAppId: "com.apple.Safari",
    });
    expect(learned.steps[2].action.text).toBe("youtube.com");
    expect(learned.steps[5].action.text).toBe("{slot0}");
    // The app frontmost before open_app is where the user started, not a precondition.
    expect(learned.steps[0]).toEqual({
      action: { type: "open_app", name: "Safari" },
    });
    expect(learned.steps[1].expectAppId).toBe("com.apple.Safari");
    expect(data.apps["com.apple.Safari"]).toMatchObject({
      name: "Safari",
      count: 1,
    });

    // Identical sequence: another success makes it replayable.
    const second = learnFromRun(
      data,
      input({
        runId: "r2",
        task: "play jazz on youtube",
        steps: youtubeSteps("jazz"),
      }),
      NOW,
    );
    expect(second.skill).toBe("merged");
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].successes).toBe(2);
    const found = matchSkill(data.skills, "play Miles Davis on YouTube");
    expect(found?.slotValues).toEqual(["Miles Davis"]);
    const plan = toPlan(found!.skill, found!.slotValues);
    expect(plan.mode).toBe("replay");
    expect(plan.steps[5].action).toEqual({
      type: "type_text",
      text: "Miles Davis",
    });
    expect(plan.steps[4].action).not.toHaveProperty("x");
  });

  it("merges runs started from different apps", () => {
    const data = emptyMemory();
    const from = (appId: string, query: string, open = "open_app") => {
      const steps = youtubeSteps(query);
      steps[0] =
        open === "open_app"
          ? { ...steps[0], appId }
          : {
              action: { type: "open_file", path: "~/Documents/Links" },
              appId,
              openedPath: "~/Documents/Links",
            };
      return steps;
    };
    const results = [
      ["com.apple.finder", "jazz"],
      ["com.tinyspeck.slackmacgap", "blues"],
      ["com.microsoft.VSCode", "funk"],
    ].map(
      ([appId, query], i) =>
        learnFromRun(
          data,
          input({
            runId: `run-${i}`,
            task: `play ${query} on youtube`,
            steps: from(appId, query),
          }),
          NOW,
        ).skill,
    );
    expect(results).toEqual(["created", "merged", "merged"]);
    expect(data.skills[0].successes).toBe(3);
    expect(data.skills[0].steps[0]).not.toHaveProperty("expectAppId");
    const plan = toPlan(data.skills[0], ["soul"]);
    expect(plan.mode).toBe("replay");
    expect(plan.steps[0]).not.toHaveProperty("expectAppId");

    // open_file is not pinned either.
    const opened = extractSkill(
      "open my links and search jazz",
      from("com.apple.Terminal", "jazz", "open_file"),
      NOW,
    );
    expect(opened?.steps[0]).toEqual({
      action: { type: "open_file", path: "~/Documents/Links" },
    });

    // A stored skill that pinned its open step still merges, and is cleaned.
    const old = emptyMemory();
    const learned = extractSkill(
      "play jazz on youtube",
      youtubeSteps("jazz"),
      NOW,
    )!;
    learned.steps[0] = { ...learned.steps[0], expectAppId: "com.apple.finder" };
    old.skills.push(learned);
    expect(
      learnFromRun(
        old,
        input({
          task: "play funk on youtube",
          steps: from("com.microsoft.VSCode", "funk"),
        }),
        NOW,
      ).skill,
    ).toBe("merged");
    expect(old.skills[0].successes).toBe(2);
    expect(old.skills[0].steps[0]).not.toHaveProperty("expectAppId");
  });

  it("merges runs that differ only in wait durations", () => {
    const data = emptyMemory();
    const withWait = (ms: number): TrajectoryStep[] => [
      {
        action: { type: "open_app", name: "Notes" },
        launchedAppId: "com.apple.Notes",
      },
      { action: { type: "wait", milliseconds: ms }, appId: "com.apple.Notes" },
      {
        action: { type: "hotkey", keys: ["CMD", "N"] },
        appId: "com.apple.Notes",
      },
    ];
    expect(
      learnFromRun(
        data,
        input({ task: "new note", steps: withWait(1000) }),
        NOW,
      ).skill,
    ).toBe("created");
    expect(
      learnFromRun(
        data,
        input({ runId: "b", task: "new note", steps: withWait(800) }),
        NOW,
      ).skill,
    ).toBe("merged");
    expect(data.skills[0].successes).toBe(2);
    expect(data.skills[0].steps[1].action).toEqual({
      type: "wait",
      milliseconds: 1000,
    });
  });

  it("keeps pointer steps replay cannot resolve as hints and cuts labels like native", () => {
    const menu = extractSkill(
      "export this as pdf",
      [
        {
          action: { type: "click", x: 0.1, y: 0 },
          appId: "com.apple.Preview",
          target: { role: "AXMenuBarItem", label: "File" },
        },
        {
          action: { type: "click", x: 0.1, y: 0.2 },
          appId: "com.apple.Preview",
          target: { role: "AXMenuItem", label: "Export as PDF…" },
        },
      ],
      NOW,
    );
    expect(menu?.hintOnly).toBe(true);
    expect(menu?.steps[1].target).toEqual({
      role: "AXMenuItem",
      label: "Export as PDF…",
    });
    for (const role of ["AXButton", "AXLink", "button", "AXTab", "AXComboBox"])
      expect(
        extractSkill(
          "press save now",
          [
            {
              action: { type: "click", x: 0.5, y: 0.5 },
              target: { role, label: "Save" },
            },
          ],
          NOW,
        )?.hintOnly,
        role,
      ).toBe(false);
    for (const role of ["AXDockItem", "AXCell", "AXImage", ""])
      expect(
        extractSkill(
          "press save now",
          [
            {
              action: { type: "click", x: 0.5, y: 0.5 },
              target: { role, label: "Save" },
            },
          ],
          NOW,
        )?.hintOnly,
        role,
      ).toBe(true);

    const long = "A".repeat(79) + "😀" + "tail of a very long accessible name";
    const cut = extractSkill(
      "open the long link",
      [
        {
          action: { type: "click", x: 0.5, y: 0.5 },
          target: { role: "AXLink", label: long },
        },
      ],
      NOW,
    );
    // 80 UTF-16 units without splitting the emoji, and no ellipsis.
    expect(cut?.steps[0].target?.label).toBe("A".repeat(79));
    expect(cut?.hintOnly).toBe(false);
    const exact = "B".repeat(100);
    expect(
      extractSkill(
        "open the other link",
        [
          {
            action: { type: "click", x: 0.5, y: 0.5 },
            target: { role: "AXLink", label: exact },
          },
        ],
        NOW,
      )?.steps[0].target?.label,
    ).toBe("B".repeat(80));
  });

  it("marks label-less pointer steps as hint only", () => {
    const steps = youtubeSteps("jazz");
    steps[5] = { action: { type: "click", x: 0.2, y: 0.3 } };
    const learned = extractSkill("play jazz on youtube", steps, NOW);
    expect(learned?.hintOnly).toBe(true);
    expect(learned?.steps[4]).toEqual({ action: { type: "click" } });
    const drag = extractSkill(
      "tidy the desktop",
      [
        {
          action: {
            type: "drag",
            start_x: 0,
            start_y: 0,
            end_x: 1,
            end_y: 1,
            duration_ms: 200,
          },
          target: { role: "AXImage", label: "file" },
        },
      ],
      NOW,
    );
    expect(drag?.hintOnly).toBe(true);
    expect(drag?.steps[0].action).toEqual({ type: "drag" });
  });

  it("drops skills containing credentials or with nothing reusable", () => {
    const data = emptyMemory();
    const steps: TrajectoryStep[] = [
      { action: { type: "open_app", name: "Notes" } },
      { action: { type: "type_text", text: "password: Hunter2secret!" } },
    ];
    expect(
      learnFromRun(data, input({ task: "note my login", steps }), NOW).skill,
    ).toBe("dropped");
    expect(data.skills).toHaveLength(0);
    expect(JSON.stringify(data)).not.toContain("Hunter2secret");
    expect(
      extractSkill(
        "check",
        [
          { action: { type: "capture" } },
          { action: { type: "done", summary: "" } },
        ],
        NOW,
      ),
    ).toBeUndefined();
    // A task that is entirely a slot is too generic.
    expect(
      extractSkill(
        "hello world",
        [{ action: { type: "type_text", text: "hello world" } }],
        NOW,
      ),
    ).toBeUndefined();
    expect(
      extractSkill(
        "long",
        Array.from({ length: 31 }, () => ({
          action: { type: "wait", milliseconds: 1 },
        })),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("learns skills only from successful runs", () => {
    for (const overrides of [
      { status: "failed" as const },
      { status: "cancelled" as const },
      { outcome: false },
      { steps: [] },
    ]) {
      const data = emptyMemory();
      learnFromRun(data, input(overrides), NOW);
      expect(data.skills, JSON.stringify(overrides)).toHaveLength(0);
      expect(data.episodes).toHaveLength(1);
    }
    const data = emptyMemory();
    learnFromRun(data, input({ outcome: true }), NOW);
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].trigger).toBe("open calculator");
  });

  it("replaces a skill that cannot replay with a new successful sequence", () => {
    const data = emptyMemory();
    learnFromRun(data, input(), NOW);
    learnFromRun(data, input({ runId: "a2" }), NOW);
    const id = data.skills[0].id;
    expect(replayable(data.skills[0])).toBe(true);
    const other: TrajectoryStep[] = [
      { action: { type: "hotkey", keys: ["CMD", "SPACE"] } },
      { action: { type: "type_text", text: "Calc" } },
      { action: { type: "key", key: "ENTER" } },
    ];
    // A proven, replayable skill is kept.
    expect(
      learnFromRun(data, input({ runId: "b", steps: other }), NOW).skill,
    ).toBe("kept");
    expect(data.skills[0].steps).toHaveLength(1);
    // One abandoned replay demotes it (2 successes, 1 failure): the working
    // sequence replaces it instead of leaving a stale hint forever.
    data.skills[0].failures = 1;
    expect(
      learnFromRun(data, input({ runId: "c", steps: other }), NOW).skill,
    ).toBe("replaced");
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0]).toMatchObject({ id, successes: 1, failures: 0 });
    expect(data.skills[0].steps).toHaveLength(3);

    // An unproven first run (here hint only) gives way to a later sequence.
    const noisy = emptyMemory();
    expect(
      learnFromRun(
        noisy,
        input({
          task: "export notes as pdf",
          steps: [{ action: { type: "click", x: 0.4, y: 0.4 } }],
        }),
        NOW,
      ).skill,
    ).toBe("created");
    expect(noisy.skills[0].hintOnly).toBe(true);
    const keyboard: TrajectoryStep[] = [
      { action: { type: "hotkey", keys: ["CMD", "P"] } },
      { action: { type: "key", key: "ENTER" } },
    ];
    expect(
      learnFromRun(
        noisy,
        input({ runId: "k1", task: "export notes as pdf", steps: keyboard }),
        NOW,
      ).skill,
    ).toBe("replaced");
    expect(
      learnFromRun(
        noisy,
        input({ runId: "k2", task: "export notes as pdf", steps: keyboard }),
        NOW,
      ).skill,
    ).toBe("merged");
    expect(noisy.skills[0]).toMatchObject({ hintOnly: false, successes: 2 });
    expect(replayable(noisy.skills[0])).toBe(true);
  });

  it("keeps a proven skill through a recovered interruption and one bad run", () => {
    const data = emptyMemory();
    learnFromRun(data, input(), NOW);
    learnFromRun(data, input({ runId: "a2" }), NOW);
    const id = data.skills[0].id;
    expect(data.skills[0]).toMatchObject({ successes: 2, failures: 0 });
    const other: TrajectoryStep[] = [
      { action: { type: "hotkey", keys: ["CMD", "SPACE"] } },
      { action: { type: "type_text", text: "Calc" } },
      { action: { type: "wait", ms: 300 } },
      { action: { type: "key", key: "ENTER" } },
    ];
    const plan = (abandonReason: string) => ({
      id: `skill:${id}`,
      source: "skill" as const,
      completedSteps: 0,
      abandoned: true,
      abandonReason,
    });
    // An accidental pause the run recovered from is neutral.
    for (const reason of ["paused", "takeover", "interrupted"]) {
      const result = learnFromRun(
        data,
        input({ runId: `i-${reason}`, steps: other, plan: plan(reason) }),
        NOW,
      );
      expect(result.planEvidence).toBeUndefined();
      expect(result.skill).toBe("kept");
    }
    expect(data.skills[0]).toMatchObject({ successes: 2, failures: 0 });
    expect(replayable(data.skills[0])).toBe(true);

    // A pause that ended the run, or a correction, is still a failure.
    expect(
      learnFromRun(
        data,
        input({
          runId: "cancel",
          status: "cancelled",
          steps: other,
          plan: plan("paused"),
        }),
        NOW,
      ).planEvidence,
    ).toBe("failure");
    data.skills[0].failures = 0;
    expect(
      learnFromRun(
        data,
        input({
          runId: "corr",
          steps: other,
          corrections: ["use spotlight instead"],
          plan: plan("paused"),
        }),
        NOW,
      ).planEvidence,
    ).toBe("failure");
    data.skills[0].failures = 0;

    // A real failure demotes the skill but cannot also overwrite it in the
    // same run; a later differing success replaces it.
    const failed = learnFromRun(
      data,
      input({ runId: "mc", steps: other, plan: plan("missing_control") }),
      NOW,
    );
    expect(failed).toMatchObject({ planEvidence: "failure", skill: "kept" });
    expect(data.skills[0]).toMatchObject({ successes: 2, failures: 1 });
    expect(data.skills[0].steps).toHaveLength(1);
    expect(
      learnFromRun(data, input({ runId: "next", steps: other }), NOW).skill,
    ).toBe("replaced");
    expect(data.skills[0].steps).toHaveLength(4);
  });

  it("does not learn or credit skills from hands-on runs", () => {
    for (const overrides of [
      { handsOn: true },
      { corrections: ["actually text mary instead"] },
    ] as Partial<LearnInput>[]) {
      const label = JSON.stringify(overrides);
      const data = emptyMemory();
      const result = learnFromRun(
        data,
        input({
          task: "play jazz on youtube",
          steps: youtubeSteps("jazz"),
          ...overrides,
        }),
        NOW,
      );
      expect(result.skill, label).toBeUndefined();
      expect(data.skills, label).toHaveLength(0);
      // Episodes, app usage and correction preferences are still recorded.
      expect(data.episodes, label).toHaveLength(1);
      expect(data.apps["com.apple.Safari"]?.count, label).toBe(1);
      expect(data.preferences, label).toHaveLength(
        overrides.corrections ? 1 : 0,
      );

      // A fully replayed skill that needed the user is not credited.
      data.skills.push(skill({ id: "skill-yt", successes: 2 }));
      const replay = learnFromRun(
        data,
        input({
          runId: "replay",
          task: "play jazz on youtube",
          steps: youtubeSteps("jazz"),
          plan: {
            id: "skill:skill-yt",
            source: "skill",
            completedSteps: 3,
            abandoned: false,
          },
          ...overrides,
        }),
        NOW,
      );
      expect(replay.planEvidence, label).toBeUndefined();
      expect(data.skills[0], label).toMatchObject({
        successes: 2,
        failures: 0,
      });
      // An abandoned one still counts as a failure, and nothing is learned.
      const abandoned = learnFromRun(
        data,
        input({
          runId: "abandoned",
          task: "play jazz on youtube",
          steps: youtubeSteps("jazz"),
          plan: {
            id: "skill:skill-yt",
            source: "skill",
            completedSteps: 1,
            abandoned: true,
          },
          ...overrides,
        }),
        NOW,
      );
      expect(abandoned.planEvidence, label).toBe("failure");
      expect(abandoned.skill, label).toBeUndefined();
      expect(data.skills[0], label).toMatchObject({
        successes: 2,
        failures: 1,
      });
      expect(data.skills[0].steps, label).toHaveLength(3);
    }
    // A blank correction is not a correction.
    const blank = emptyMemory();
    expect(learnFromRun(blank, input({ corrections: ["  "] }), NOW).skill).toBe(
      "created",
    );
  });

  it("records a failure when a full replay ends failed or cancelled", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const data = emptyMemory();
      data.skills.push(skill({ id: "skill-yt", successes: 2 }));
      const plan = {
        id: "skill:skill-yt",
        source: "skill" as const,
        completedSteps: 3,
        abandoned: false,
      };
      const result = learnFromRun(
        data,
        input({ task: "play jazz on youtube", status, plan }),
        NOW,
      );
      expect(result.planEvidence, status).toBe("failure");
      expect(data.skills[0], status).toMatchObject({
        successes: 2,
        failures: 1,
      });
      expect(replayable(data.skills[0]), status).toBe(false);
      // The user said it worked: no failure.
      expect(
        learnFromRun(
          data,
          input({ runId: "ok", status, outcome: true, plan }),
          NOW,
        ).planEvidence,
        status,
      ).toBeUndefined();
      // A partial replay that was not abandoned stays neutral.
      expect(
        learnFromRun(
          data,
          input({
            runId: "partial",
            status,
            plan: { ...plan, completedSteps: 1 },
          }),
          NOW,
        ).planEvidence,
        status,
      ).toBeUndefined();
      expect(data.skills[0].failures, status).toBe(1);
    }
  });

  it("does not count a built-in intent's own launch as app usage", () => {
    const data = emptyMemory();
    // "go to github.com": the intent opens Safari, then the model opens Chrome.
    const run = (runId: string) =>
      learnFromRun(
        data,
        input({
          runId,
          task: "go to github.com",
          steps: [
            {
              action: { type: "open_app", name: "Safari" },
              appId: "com.apple.finder",
              launchedAppId: "com.apple.Safari",
              fromPlan: "intent",
            },
            {
              action: { type: "hotkey", keys: ["CMD", "L"] },
              appId: "com.apple.Safari",
              fromPlan: "intent",
            },
            {
              action: { type: "open_app", name: "Google Chrome" },
              appId: "com.apple.Safari",
              launchedAppId: "com.google.Chrome",
            },
          ],
          appsSeen: [
            "com.apple.finder",
            "com.apple.Safari",
            "com.google.Chrome",
          ],
          plan: {
            id: "intent:url:x",
            source: "intent",
            completedSteps: 2,
            abandoned: true,
          },
        }),
        NOW,
      );
    run("r1");
    run("r2");
    expect(data.apps["com.apple.Safari"]).toBeUndefined();
    expect(data.apps["com.google.Chrome"]).toMatchObject({
      name: "Google Chrome",
      count: 2,
    });
    expect(data.apps["com.apple.finder"].count).toBe(2);
    expect(data.episodes[0].apps).toContain("com.apple.Safari");
    expect(
      matchIntent("go to github.com", index(), data)?.steps[0].action,
    ).toEqual({ type: "open_app", name: "Google Chrome" });

    // Already frontmost before the intent launched it: the user was using it.
    const frontmost = emptyMemory();
    learnFromRun(
      frontmost,
      input({
        task: "go to github.com",
        steps: [
          {
            action: { type: "open_app", name: "Safari" },
            appId: "com.apple.Safari",
            launchedAppId: "com.apple.Safari",
            fromPlan: "intent",
          },
        ],
        appsSeen: ["com.apple.Safari"],
      }),
      NOW,
    );
    expect(frontmost.apps["com.apple.Safari"].count).toBe(1);
  });

  it("updates plan evidence", () => {
    const data = emptyMemory();
    const s = skill({ id: "skill-yt", successes: 2 });
    data.skills.push(s);
    const replayed = youtubeSteps("jazz");
    // Completed replay: success, no duplicate skill.
    let result = learnFromRun(
      data,
      input({
        task: "play jazz on youtube",
        steps: replayed,
        plan: {
          id: "skill:skill-yt",
          source: "skill",
          completedSteps: 3,
          abandoned: false,
        },
      }),
      NOW,
    );
    expect(result.planEvidence).toBe("success");
    expect(result.skill).toBeUndefined();
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].successes).toBe(3);
    // Partial replay without abandonment: no evidence.
    result = learnFromRun(
      data,
      input({
        runId: "p",
        plan: {
          id: "skill:skill-yt",
          source: "skill",
          completedSteps: 1,
          abandoned: false,
        },
      }),
      NOW,
    );
    expect(result.planEvidence).toBeUndefined();
    // Abandoned: failure, and the model's successful sequence is considered.
    result = learnFromRun(
      data,
      input({
        runId: "q",
        task: "play jazz on youtube",
        steps: replayed,
        plan: {
          id: "skill:skill-yt",
          source: "skill",
          completedSteps: 1,
          abandoned: true,
        },
      }),
      NOW,
    );
    expect(result.planEvidence).toBe("failure");
    expect(data.skills[0].failures).toBe(1);
    expect(result.skill).toBe("kept");
    // User said a replay did not work: failure.
    result = learnFromRun(
      data,
      input({
        runId: "r",
        outcome: false,
        plan: {
          id: "skill:skill-yt",
          source: "skill",
          completedSteps: 3,
          abandoned: false,
        },
      }),
      NOW,
    );
    expect(result.planEvidence).toBe("failure");
    // Intent plans never create skills.
    const intent = emptyMemory();
    result = learnFromRun(
      intent,
      input({
        plan: {
          id: "intent:app:x",
          source: "intent",
          completedSteps: 1,
          abandoned: false,
        },
      }),
      NOW,
    );
    expect(result.skill).toBeUndefined();
    expect(intent.skills).toHaveLength(0);
    expect(intent.episodes).toHaveLength(1);
  });

  it("tolerates malformed input", () => {
    const data = emptyMemory();
    expect(() =>
      learnFromRun(
        data,
        {
          ...input(),
          corrections: [42 as unknown as string],
          appsSeen: [null as unknown as string],
          steps: [null as unknown as TrajectoryStep, { action: {} }],
        },
        NOW,
      ),
    ).not.toThrow();
    expect(learnFromRun(data, null as unknown as LearnInput, NOW).episode).toBe(
      false,
    );
  });
});

describe("memory access", () => {
  const store = () =>
    new MemoryStore(tempDir(), randomBytes(32), () => NOW, { debounceMs: 5 });

  it("recalls context and prefers built-in intents", async () => {
    const s = store();
    s.update((data: MemoryData) => {
      data.skills.push(
        skill({
          id: "calc",
          trigger: "open calculator",
          slots: [],
          successes: 5,
        }),
      );
    });
    const lookups: string[] = [];
    const access = createMemoryAccess(s, async (query) => {
      lookups.push(query);
      return index();
    });
    const recall = await access.recall("open calculator");
    // An app intent needs only the cached app list, never a name-match query.
    expect(lookups).toEqual([""]);
    expect(recall.plan?.source).toBe("intent");
    expect(recall.context.plan).toMatchObject({
      source: "intent",
      steps: ["Open Calculator"],
    });
    expect(recall.context.plan?.note).toMatch(/known procedure/);
    expect(recall.context.apps?.[0]).toEqual({
      name: "Calculator",
      bundleId: "com.apple.calculator",
    });
  });

  it("queries index name matches only for file intents, skills and model runs", async () => {
    const s = store();
    s.upsertSkill(skill({ trigger: "queue {slot0} in music" }));
    const report = {
      name: "report.pdf",
      path: "~/Documents/report.pdf",
      kind: "document",
    };
    const lookups: string[] = [];
    const access = createMemoryAccess(s, async (query) => {
      lookups.push(query);
      // Like the helper: a query-less index has no name matches.
      return index(query ? { matches: [report] } : {});
    });
    const recallOf = async (task: string) => {
      lookups.length = 0;
      return access.recall(task);
    };

    expect((await recallOf("go to github.com")).plan?.completeWhen).toEqual({
      host: "github.com",
    });
    expect(lookups).toEqual([""]);
    expect((await recallOf("search google for usb cables")).plan?.source).toBe(
      "intent",
    );
    expect(lookups).toEqual([""]);

    const file = await recallOf("open report.pdf");
    expect(file.plan?.steps[0].action).toEqual({
      type: "open_file",
      path: "~/Documents/report.pdf",
    });
    expect(lookups).toEqual(["", "open report.pdf"]);
    expect(file.context.files?.[0]?.path).toBe("~/Documents/report.pdf");

    // "open Notes and write" is multi-step: the model gets the file matches.
    await recallOf("open Notes and write a list");
    expect(lookups).toEqual(["", "open Notes and write a list"]);

    expect((await recallOf("queue daft punk in music")).plan?.source).toBe(
      "skill",
    );
    expect(lookups).toEqual(["queue daft punk in music"]);
    await recallOf("write a letter");
    expect(lookups).toEqual(["write a letter"]);
  });

  it("sends no name-match query once the quick lookup spent the budget", async () => {
    const s = store();
    const lookups: string[] = [];
    const access = createMemoryAccess(
      s,
      (query) => {
        lookups.push(query);
        return new Promise(() => {});
      },
      { budgetMs: 30 },
    );
    const recall = await access.recall("open the Q3 report file");
    expect(recall.plan).toBeUndefined();
    expect(lookups).toEqual([""]);
  });

  it("keeps the quick lookup when the name-match lookup times out", async () => {
    const s = store();
    const lookups: string[] = [];
    const slowMatches = (budgetMs: number) =>
      createMemoryAccess(
        s,
        (query) => {
          lookups.push(query);
          return query ? new Promise(() => {}) : Promise.resolve(index());
        },
        { budgetMs },
      );
    const recall = await slowMatches(600).recall("open the budget spreadsheet");
    expect(lookups).toEqual(["", "open the budget spreadsheet"]);
    // The quick lookup's folders survive (apps appear only when matched or used).
    expect(recall.context.folders).toEqual([
      { name: "Documents", path: "~/Documents" },
      { name: "Downloads", path: "~/Downloads" },
    ]);

    // Too little budget left: no request that could only delay the capture.
    lookups.length = 0;
    const short = await slowMatches(300).recall("open the budget spreadsheet");
    expect(lookups).toEqual([""]);
    expect(short.context.folders).toHaveLength(2);
  });

  it("falls back to skills and marks hints", async () => {
    const s = store();
    s.upsertSkill(skill({ successes: 1, trigger: "queue {slot0} in music" }));
    const access = createMemoryAccess(s, async () => index());
    const recall = await access.recall("queue Daft Punk on my stereo in music");
    expect(recall.plan).toMatchObject({ source: "skill", mode: "hint" });
    expect(recall.context.plan?.note).toMatch(/hint/);
    expect(recall.plan?.steps[1].action.text).toBe("Daft Punk on my stereo");
    expect((await access.recall("write a letter")).plan).toBeUndefined();
    expect(
      (await access.recall("write a letter")).context.plan,
    ).toBeUndefined();
  });

  it("resolves completeWhen for skills ending in open_app", async () => {
    const s = store();
    s.upsertSkill(
      skill({
        trigger: "set up my workspace",
        slots: [],
        steps: [
          { action: { type: "open_app", name: "Notes" } },
          { action: { type: "open_app", name: "Calculator" } },
        ],
      }),
    );
    const recall = await createMemoryAccess(s, async () => index()).recall(
      "Set up my workspace",
    );
    expect(recall.plan).toMatchObject({
      mode: "replay",
      completeWhen: { appId: "com.apple.calculator" },
    });
  });

  it("stays within budget when the index is slow, failing or aborted", async () => {
    const s = store();
    const onError = vi.fn();
    const slow = createMemoryAccess(s, () => new Promise(() => {}), {
      budgetMs: 30,
      onError,
    });
    const started = Date.now();
    const recall = await slow.recall("go to youtube.com");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(recall.plan?.completeWhen).toEqual({ host: "youtube.com" });
    expect(recall.context.apps).toBeUndefined();

    const rejecting = createMemoryAccess(
      s,
      async () => {
        throw new Error("helper gone");
      },
      { onError },
    );
    expect((await rejecting.recall("open calculator")).plan).toBeUndefined();
    expect(onError).toHaveBeenCalled();

    const throwing = createMemoryAccess(
      s,
      () => {
        throw new Error("sync");
      },
      { onError },
    );
    expect((await throwing.recall("go to example.com")).plan).toBeDefined();

    const malformed = createMemoryAccess(
      s,
      async () => ({ apps: "nope" }) as unknown as SystemIndex,
    );
    expect((await malformed.recall("open calculator")).plan).toBeUndefined();

    const controller = new AbortController();
    const aborted = createMemoryAccess(s, () => new Promise(() => {}), {
      budgetMs: 60_000,
    });
    const pending = aborted.recall("open calculator", controller.signal);
    controller.abort();
    expect((await pending).context.preferences).toEqual([]);
  });

  it("returns empty recall when disabled or when data access fails", async () => {
    const s = store();
    s.upsertPreference("Use Chrome");
    const disabled = createMemoryAccess(s, async () => index(), {
      enabled: () => false,
    });
    expect(await disabled.recall("open calculator")).toEqual({
      context: { preferences: [], episodes: [] },
    });
    disabled.learn(input());
    expect(s.summary().episodes).toBe(0);

    const onError = vi.fn();
    const broken = createMemoryAccess(
      {
        data: () => {
          throw new Error("disk");
        },
      } as unknown as MemoryStore,
      async () => index(),
      { onError },
    );
    expect(await broken.recall("open calculator")).toEqual({
      context: { preferences: [], episodes: [] },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("learns without throwing and persists", async () => {
    const dir = tempDir();
    const key = randomBytes(32);
    const s = new MemoryStore(dir, key, () => NOW);
    const access = createMemoryAccess(s, async () => index(), {
      now: () => NOW,
    });
    access.learn(input());
    access.learn(input({ runId: "two" }));
    s.flush();
    const reloaded = new MemoryStore(dir, key, () => NOW);
    expect(reloaded.summary()).toMatchObject({ episodes: 2, skills: 1 });
    expect(reloaded.data().skills[0].successes).toBe(2);
    const recall = await createMemoryAccess(
      reloaded,
      async () => undefined,
    ).recall("open calculator please");
    expect(recall.context.episodes[0]).toBe(
      '✓ "open calculator" → Calculator, com.apple.finder; completed',
    );
    // No index: the learned skill replays.
    expect(recall.plan).toMatchObject({
      source: "skill",
      mode: "replay",
      completeWhen: { appId: "com.apple.calculator" },
    });

    const onError = vi.fn();
    const failing = createMemoryAccess(
      {
        update: () => {
          throw new Error("disk full");
        },
      } as unknown as MemoryStore,
      async () => undefined,
      {
        onError: (error) => {
          onError(error);
          throw new Error("logger broke");
        },
      },
    );
    expect(() => failing.learn(input())).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => access.learn(null as unknown as LearnInput)).not.toThrow();
  });
});
