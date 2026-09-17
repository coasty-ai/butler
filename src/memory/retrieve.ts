import type { MemoryContext } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import type { AppUsage, Episode, MemoryData, SystemIndex } from "./types";

/** Context bounds from docs/MEMORY.md. */
export const CONTEXT_LIMITS = {
  preferences: 5,
  episodes: 3,
  apps: 12,
  files: 10,
  folders: 8,
  planSteps: 12,
} as const;

export const bound = (text: string, max: number) =>
  text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;

export const STOPWORDS = new Set(
  (
    "a an the and or but nor to of in on at for with from by as into onto about " +
    "is are was were be been being am it its this that these those there here " +
    "i me my mine we us our you your he him his she her they them their " +
    "please pls can could would will should shall may might must just now then " +
    "so do does did some any also hey hi ok okay what which who whom how " +
    "let lets want wanna need like using use via for up out over"
  ).split(" "),
);

const QUOTES =
  /[\u2018\u2019\u201a\u201b\u2032\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb\u2039\u203a'"`]/g;

/** Lowercase tokens without punctuation (unicode quotes included) or stopwords. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(QUOTES, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && t.length <= 40 && !STOPWORDS.has(t))
    .slice(0, 128);
}

/** BM25 scores of each document for the query (k1 1.2, b 0.75). */
export function bm25(
  query: string[],
  documents: string[][],
  k1 = 1.2,
  b = 0.75,
): number[] {
  const n = documents.length;
  if (!n) return [];
  const terms = [...new Set(query)];
  const avg = documents.reduce((sum, d) => sum + d.length, 0) / n || 1;
  const frequency = new Map<string, number>();
  for (const doc of documents)
    for (const term of new Set(doc))
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return documents.map((doc) => {
    if (!doc.length) return 0;
    const counts = new Map<string, number>();
    for (const t of doc) counts.set(t, (counts.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score +=
        (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * doc.length) / avg));
    }
    return score;
  });
}

/** Home-relative paths only; never hidden segments, ~/Library or traversal. */
export function isSafeIndexPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("~/") || path.length > 500)
    return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const parts = path.slice(2).split("/").filter(Boolean);
  if (!parts.length) return false;
  if (parts[0] === "Library") return false;
  return !parts.some((p) => p.startsWith(".") || p === "node_modules");
}

const clean = (text: string, max: number) =>
  bound(redactSecrets(text.replace(/\s+/g, " ").trim()), max);

/** Browser, notes, music and mail apps for usage-derived preferences. */
export const APP_CATEGORIES: Record<string, string[]> = {
  browser: [
    "com.apple.Safari",
    "com.google.Chrome",
    "org.mozilla.firefox",
    "company.thebrowser.Browser",
    "com.brave.Browser",
    "com.microsoft.edgemac",
  ],
  "notes app": [
    "com.apple.Notes",
    "md.obsidian",
    "notion.id",
    "net.shinyfrog.bear",
    "com.evernote.Evernote",
  ],
  "music app": ["com.apple.Music", "com.spotify.client"],
  "mail app": [
    "com.apple.mail",
    "com.microsoft.Outlook",
    "com.readdle.smartemail-Mac",
    "com.superhuman.electron",
  ],
};

function usagePreferences(apps: Record<string, AppUsage>): string[] {
  const lines: string[] = [];
  for (const [category, ids] of Object.entries(APP_CATEGORIES)) {
    const best = ids
      .map((id) => (Object.hasOwn(apps, id) ? apps[id] : undefined))
      .filter((a): a is AppUsage => !!a && a.count >= 2)
      .sort(
        (a, b) => b.count - a.count || b.lastUsed.localeCompare(a.lastUsed),
      )[0];
    if (best)
      lines.push(clean(`Usually uses ${best.name} as the ${category}.`, 120));
  }
  return lines;
}

function episodeLine(episode: Episode, names: (id: string) => string): string {
  const ok = episode.outcome ?? episode.status === "completed";
  const mark = ok && episode.status === "completed" ? "✓" : "✗";
  const apps = [...new Set(episode.apps.map(names))].slice(0, 3).join(", ");
  const status =
    episode.outcome === false && episode.status === "completed"
      ? "completed, but the user said it did not work"
      : episode.status;
  return clean(
    `${mark} "${bound(episode.task, 120)}"${apps ? ` → ${apps}` : ""}; ${status}`,
    220,
  );
}

/** Build the bounded, task-relevant MemoryContext for the model. */
export function recallContext(
  data: MemoryData,
  task: string,
  index?: SystemIndex,
): MemoryContext {
  const query = tokenize(task);
  const querySet = new Set(query);
  const docs = [
    ...data.episodes.map((e) => e.tokens ?? tokenize(e.task)),
    ...data.preferences.map((p) => p.tokens ?? tokenize(p.text)),
  ];
  const scores = bm25(query, docs);
  const episodeScores = scores.slice(0, data.episodes.length);
  const preferenceScores = scores.slice(data.episodes.length);

  const indexApps = (index?.apps ?? []).filter(
    (a) => a && typeof a.name === "string" && typeof a.bundleId === "string",
  );
  const appName = (id: string) =>
    indexApps.find((a) => a.bundleId === id)?.name ??
    (Object.hasOwn(data.apps, id) ? data.apps[id].name : undefined) ??
    id;

  // Preferences: only those relevant to this task (a correction from another
  // task stays local), most relevant first, then the usage-derived app choices,
  // which always keep their room.
  const usage = usagePreferences(data.apps).filter(Boolean);
  const preferences = data.preferences
    .map((p, i) => ({ p, score: preferenceScores[i] ?? 0 }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.p.weight - a.p.weight ||
        b.p.updatedAt.localeCompare(a.p.updatedAt),
    )
    .map(({ p }) => clean(p.text, 200))
    .filter((line) => line && !usage.includes(line));
  const preferenceLines = [...new Set(preferences)]
    .slice(0, Math.max(0, CONTEXT_LIMITS.preferences - usage.length))
    .concat(usage)
    .slice(0, CONTEXT_LIMITS.preferences);

  const episodes = data.episodes
    .map((e, i) => ({ e, i, score: episodeScores[i] ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, CONTEXT_LIMITS.episodes)
    .map(({ e }) => episodeLine(e, appName));

  const context: MemoryContext = {
    preferences: preferenceLines,
    episodes,
  };

  // Apps: task-token matches first, then most used.
  const matches = (name: string) =>
    tokenize(name).filter((t) => querySet.has(t)).length;
  const apps: { name: string; bundleId: string }[] = [];
  const seen = new Set<string>();
  const addApp = (name: string, bundleId: string) => {
    if (seen.has(bundleId) || apps.length >= CONTEXT_LIMITS.apps) return;
    seen.add(bundleId);
    apps.push({ name: clean(name, 100), bundleId: bundleId.slice(0, 200) });
  };
  indexApps
    .map((a) => ({ a, score: matches(a.name) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name))
    .forEach(({ a }) => addApp(a.name, a.bundleId));
  const installed = new Set(indexApps.map((a) => a.bundleId));
  Object.values(data.apps)
    .filter((u) => !indexApps.length || installed.has(u.bundleId))
    .sort((a, b) => b.count - a.count || b.lastUsed.localeCompare(a.lastUsed))
    .forEach((u) => addApp(appName(u.bundleId), u.bundleId));
  if (apps.length) context.apps = apps;

  // Files: index matches first, then token-matching recent files.
  const files: NonNullable<MemoryContext["files"]> = [];
  const paths = new Set<string>();
  const addFile = (f: SystemIndex["matches"][number]) => {
    if (!f || !isSafeIndexPath(f.path) || typeof f.name !== "string") return;
    if (paths.has(f.path) || files.length >= CONTEXT_LIMITS.files) return;
    paths.add(f.path);
    files.push({
      name: clean(f.name, 120),
      path: clean(f.path, 300),
      kind: clean(String(f.kind ?? ""), 60),
      ...(f.lastUsed ? { lastUsed: clean(String(f.lastUsed), 40) } : {}),
    });
  };
  (index?.matches ?? []).forEach(addFile);
  (index?.recentFiles ?? [])
    .filter((f) => f && typeof f.name === "string" && matches(f.name) > 0)
    .forEach(addFile);
  if (files.length) context.files = files;

  const folders = (index?.folders ?? [])
    .filter((f) => f && typeof f.name === "string" && isSafeIndexPath(f.path))
    .map((f, i) => ({ f, i, score: matches(f.name) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, CONTEXT_LIMITS.folders)
    .map(({ f }) => ({ name: clean(f.name, 80), path: clean(f.path, 300) }));
  if (folders.length) context.folders = folders;
  return context;
}
