/**
 * The user's site recipes file (src/voice/recipes-file.ts, electron/recipes.ts;
 * design modules.md §2 `recipes`): entries validated one by one and
 * rejected by index with a code, templates pinned to https on the entry's
 * own host with one {q}, the merge over the built-ins by key, the loader's
 * absent-file, watch and status paths, and the merged table reaching the
 * fast decider through installRecipes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECIPES_FILE_LIMITS,
  checkRecipeEntry,
  mergeRecipes,
  parseRecipesFile,
} from "../src/voice/recipes-file";
import {
  RECIPES,
  activeRecipes,
  installRecipes,
  siteByKey,
  siteByName,
} from "../src/voice/recipes";
import { clauseOf, decideFast } from "../src/voice/fast";
import {
  RECIPES_WATCH_DEBOUNCE_MS,
  createRecipesFile,
} from "../electron/recipes";
import { defaultSettings } from "../src/core/schema";

const HN = {
  key: "hn",
  label: "Hacker News",
  names: ["hacker news", "hn"],
  domain: "ycombinator.com",
  host: "hn.algolia.com",
  home: "https://news.ycombinator.com/",
  templates: { search: "https://hn.algolia.com/?q={q}" },
};
afterEach(() => installRecipes(RECIPES));

describe("parsing the recipes file", () => {
  it("accepts a sound entry and rejects each bad one by index with a code", () => {
    const parsed = parseRecipesFile(
      JSON.stringify([
        HN,
        "not an object",
        { ...HN, key: "Bad Key" },
        { ...HN, key: "a", label: "x".repeat(41) },
        { ...HN, key: "b", names: [] },
        { ...HN, key: "c", names: ["n".repeat(41)] },
        { ...HN, key: "d", domain: "not a host" },
        { ...HN, key: "e", home: "http://news.ycombinator.com/" },
        { ...HN, key: "f", home: "https://example.com/" },
        {
          ...HN,
          key: "g",
          templates: { search: "http://hn.algolia.com/?q={q}" },
        },
        {
          ...HN,
          key: "h",
          templates: { search: "https://hn.algolia.com/?q={q}&again={q}" },
        },
        { ...HN, key: "i", templates: { search: "https://hn.algolia.com/" } },
        {
          ...HN,
          key: "j",
          templates: { search: "https://user:pw@hn.algolia.com/?q={q}" },
        },
        {
          ...HN,
          key: "k",
          templates: { search: "https://evil.example/?q={q}" },
        },
        {
          ...HN,
          key: "l",
          templates: { other: "https://hn.algolia.com/?q={q}" },
        },
        { ...HN, key: "m", extra: true },
        { ...HN, key: "hn" },
      ]),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.entries).toEqual([HN]);
    expect(parsed.rejected).toEqual([
      { index: 1, code: "not_object" },
      { index: 2, code: "key" },
      { index: 3, code: "label" },
      { index: 4, code: "names" },
      { index: 5, code: "names" },
      { index: 6, code: "domain" },
      { index: 7, code: "home_scheme" },
      { index: 8, code: "home_host" },
      { index: 9, code: "template_scheme" },
      { index: 10, code: "template_placeholder" },
      { index: 11, code: "template_placeholder" },
      { index: 12, code: "template_credentials" },
      { index: 13, code: "template_host" },
      { index: 14, code: "templates" },
      { index: 15, code: "invalid" },
      { index: 16, code: "duplicate_key" },
    ]);
    // Every code is trace-shaped.
    for (const r of parsed.rejected)
      expect(r.code).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });
  it("loads nothing from a file that is not a JSON array, and caps the count", () => {
    expect(parseRecipesFile("{ nope")).toEqual({
      entries: [],
      rejected: [],
      error: "not_json",
    });
    expect(parseRecipesFile('{"key":"x"}')).toEqual({
      entries: [],
      rejected: [],
      error: "not_array",
    });
    const many = Array.from(
      { length: RECIPES_FILE_LIMITS.entries + 2 },
      (_, i) => ({ ...HN, key: `s${i}` }),
    );
    const parsed = parseRecipesFile(JSON.stringify(many));
    expect(parsed.entries).toHaveLength(RECIPES_FILE_LIMITS.entries);
    expect(parsed.rejected).toEqual([
      { index: 100, code: "too_many" },
      { index: 101, code: "too_many" },
    ]);
  });
  it("lowercases names, keeps an application entry, and lets the home page sit under the domain", () => {
    const checked = checkRecipeEntry({
      ...HN,
      names: ["Hacker News"],
      app: "Hacker News App",
      templates: {},
      home: "https://news.ycombinator.com/news",
    });
    expect(checked).toEqual({
      ok: true,
      recipe: {
        ...HN,
        names: ["hacker news"],
        templates: {},
        home: "https://news.ycombinator.com/news",
        app: "Hacker News App",
      },
    });
  });
});

describe("merging over the built-ins", () => {
  it("replaces a built-in of the same key in place and appends new keys", () => {
    const youtube = {
      ...RECIPES[0],
      templates: {
        search:
          "https://www.youtube.com/results?search_query={q}&sp=EgIQAQ%253D%253D",
      },
    };
    const merged = mergeRecipes(RECIPES, [HN, youtube]);
    expect(merged).toHaveLength(RECIPES.length + 1);
    expect(merged[0]).toEqual(youtube);
    expect(merged.at(-1)).toEqual(HN);
    expect(merged.slice(1, -1)).toEqual(RECIPES.slice(1));
    expect(mergeRecipes()).toEqual(RECIPES);
  });
  it("installed, the merged table reaches the lookups and the fast decider", () => {
    expect(siteByName("hacker news")).toBeUndefined();
    installRecipes(mergeRecipes(RECIPES, [HN]));
    expect(activeRecipes()).toHaveLength(RECIPES.length + 1);
    expect(siteByKey("hn")?.label).toBe("Hacker News");
    expect(siteByName("hn")).toBe(siteByKey("hn"));
    const ctx = { protectedHosts: defaultSettings.protectedDomains };
    expect(decideFast(clauseOf("search hacker news for rust"), ctx)).toEqual({
      kind: "open_url",
      url: "https://hn.algolia.com/?q=rust",
      siteKey: "hn",
      label: "Hacker News search for rust",
    });
    expect(decideFast(clauseOf("go to hacker news"), ctx)).toEqual({
      kind: "open_url",
      url: "https://news.ycombinator.com/",
      siteKey: "hn",
      label: "Hacker News",
    });
    // A user entry on a protected host is still refused by the floor.
    installRecipes(
      mergeRecipes(RECIPES, [
        {
          ...HN,
          key: "chase",
          names: ["chase bank"],
          domain: "chase.com",
          host: "www.chase.com",
          home: "https://www.chase.com/",
          templates: { search: "https://www.chase.com/search?q={q}" },
        },
      ]),
    );
    expect(decideFast(clauseOf("go to chase bank"), ctx)).toEqual({
      kind: "none",
      reason: "protected",
    });
    expect(
      decideFast(clauseOf("search chase bank for mortgage rates"), ctx),
    ).toEqual({ kind: "none", reason: "protected" });
    installRecipes(RECIPES);
    expect(siteByName("hacker news")).toBeUndefined();
  });
});

describe("the loader", () => {
  const traced = () => {
    const traces: { event: string; data: Record<string, unknown> }[] = [];
    return {
      traces,
      trace: (event: string, data: Record<string, unknown> = {}) =>
        traces.push({ event, data }),
    };
  };
  it("treats an absent file as the built-ins, and a present one as the merge with every rejection traced by index and code", () => {
    const installed: number[] = [];
    let text: string | undefined;
    const { traces, trace } = traced();
    const file = createRecipesFile({
      path: "/tmp/data/recipes.json",
      trace,
      read: () => text,
      watch: () => () => {},
      install: (table) => installed.push(table.length),
      now: () => 42,
    });
    expect(file.load()).toEqual({
      path: "/tmp/data/recipes.json",
      exists: false,
      loaded: 0,
      builtin: RECIPES.length,
      total: RECIPES.length,
      rejected: [],
      readAt: 42,
    });
    expect(installed).toEqual([RECIPES.length]);
    expect(traces).toEqual([]);
    text = JSON.stringify([HN, { ...HN, key: "x", host: "evil.example" }]);
    expect(file.load()).toMatchObject({
      exists: true,
      loaded: 1,
      total: RECIPES.length + 1,
      rejected: [{ index: 1, code: "template_host" }],
    });
    expect(installed).toEqual([RECIPES.length, RECIPES.length + 1]);
    expect(traces).toEqual([
      {
        event: "RecipesFileRejected",
        data: { index: 1, code: "template_host" },
      },
      { event: "RecipesFileLoaded", data: { loaded: 1, rejected: 1 } },
    ]);
    expect(JSON.stringify(traces)).not.toMatch(/algolia|Hacker/);
    text = "not json";
    expect(file.load()).toMatchObject({
      exists: true,
      loaded: 0,
      error: "not_json",
      total: RECIPES.length,
    });
    expect(file.status().error).toBe("not_json");
  });
  it("re-reads once the watched file has settled, and stops on close", () => {
    vi.useFakeTimers();
    try {
      let onChange: ((file: string) => void) | undefined;
      let stopped = 0;
      const reads: number[] = [];
      let text: string | undefined;
      const file = createRecipesFile({
        path: "/tmp/data/recipes.json",
        read: () => {
          reads.push(Date.now());
          return text;
        },
        watch: (dir, fn) => {
          expect(dir).toBe("/tmp/data");
          onChange = fn;
          return () => stopped++;
        },
        install: () => {},
      });
      file.load();
      expect(reads).toHaveLength(1);
      text = JSON.stringify([HN]);
      onChange!("other.json");
      vi.advanceTimersByTime(RECIPES_WATCH_DEBOUNCE_MS * 2);
      expect(reads).toHaveLength(1);
      onChange!("recipes.json");
      onChange!("recipes.json");
      vi.advanceTimersByTime(RECIPES_WATCH_DEBOUNCE_MS - 1);
      expect(reads).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(reads).toHaveLength(2);
      expect(file.status().loaded).toBe(1);
      file.close();
      expect(stopped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
