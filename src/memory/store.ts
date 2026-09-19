import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { seal, unseal } from "../storage/vault";
import type {
  AppBackground,
  AppUsage,
  Episode,
  MemoryData,
  Preference,
  Procedure,
  Routine,
  Skill,
} from "./types";
import type {
  BackgroundKnowledge,
  BackgroundObservation,
  BackgroundRoute,
} from "../core/memory";
import { bound, tokenize } from "./retrieve";

/** Retrieval tokens kept per preference (its text plus task context). */
const MAX_PREFERENCE_TOKENS = 40;

export { bound };

/** Hard caps from docs/MEMORY.md. Apps are bounded to keep the file small. */
export const MEMORY_LIMITS = {
  episodes: 500,
  preferences: 200,
  skills: 150,
  apps: 300,
  routines: 100,
  procedures: 100,
} as const;
/** Episodes and skills unused for this long are pruned first at the cap. */
export const DECAY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MEMORY_FILE = "memory.enc";
const AAD = "memory";

export const emptyMemory = (): MemoryData => ({
  version: 2,
  episodes: [],
  preferences: [],
  skills: [],
  apps: {},
  routines: [],
  procedures: [],
});

export const stableId = (prefix: string, value: string) =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

/** Lowercase, collapse whitespace and trim trailing sentence punctuation. */
export const normalizeText = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,\s]+$/u, "")
    .toLowerCase();

// ---------------------------------------------------------------------------
// Pure mutators over MemoryData (used by the store and by learn.ts).

export function addEpisodeTo(data: MemoryData, episode: Episode) {
  const index = data.episodes.findIndex((e) => e.id === episode.id);
  if (index >= 0) data.episodes[index] = episode;
  else data.episodes.push(episode);
}

/** Stored text and id of the preference `text` upserts (undefined when blank). */
function preferenceOf(text: string): { clean: string; id: string } | undefined {
  const clean = bound(text.replace(/\s+/g, " ").trim(), 300);
  const key = normalizeText(clean);
  return key ? { clean, id: stableId("pref", key) } : undefined;
}

export function upsertPreferenceIn(
  data: MemoryData,
  text: string,
  source: Preference["source"],
  now: Date,
  /** Extra retrieval tokens, e.g. the task a correction was given for. */
  contextTokens: string[] = [],
): Preference | undefined {
  const found = preferenceOf(text);
  if (!found) return undefined;
  const { clean, id } = found;
  const stamp = now.toISOString();
  const merge = (base: string[]) =>
    [...new Set([...base, ...contextTokens])].slice(0, MAX_PREFERENCE_TOKENS);
  const existing = data.preferences.find((p) => p.id === id);
  if (existing) {
    existing.weight += 1;
    existing.updatedAt = stamp;
    existing.tokens = merge(existing.tokens ?? tokenize(existing.text));
    return existing;
  }
  const preference: Preference = {
    id,
    kind: "preference",
    text: clean,
    tokens: merge(tokenize(clean)),
    weight: 1,
    source,
    createdAt: stamp,
    updatedAt: stamp,
  };
  data.preferences.push(preference);
  return preference;
}

/**
 * Removes what learning took from one run (a deleted local run): its episode,
 * keyed by the run id, and the weight each of its corrections added to a
 * correction preference. A preference other runs also reinforced keeps their
 * weight; one left with none is removed. Skills and app counts carry no run id
 * and are kept. Returns whether the run had an episode.
 */
export function forgetRunIn(data: MemoryData, runId: string): boolean {
  const episode = data.episodes.find((e) => e.id === runId);
  if (!episode) return false;
  data.episodes = data.episodes.filter((e) => e.id !== runId);
  const added = new Map<string, number>();
  const corrections = Array.isArray(episode.corrections)
    ? episode.corrections
    : [];
  for (const correction of corrections) {
    if (typeof correction !== "string") continue;
    const found = preferenceOf(correction);
    if (found) added.set(found.id, (added.get(found.id) ?? 0) + 1);
  }
  if (!added.size) return true;
  data.preferences = data.preferences.filter((preference) => {
    const weight =
      preference.source === "correction" ? added.get(preference.id) : 0;
    if (!weight) return true;
    preference.weight -= weight;
    return preference.weight > 0;
  });
  return true;
}

export function recordAppUseIn(
  data: MemoryData,
  bundleId: string,
  name: string | undefined,
  now: Date,
): AppUsage | undefined {
  const id = bundleId.trim().slice(0, 200);
  if (!id || id === "__proto__") return undefined;
  const existing = Object.hasOwn(data.apps, id) ? data.apps[id] : undefined;
  const cleanName = name?.trim().slice(0, 100);
  if (existing) {
    existing.count += 1;
    existing.lastUsed = now.toISOString();
    if (cleanName && (existing.name === existing.bundleId || !existing.name))
      existing.name = cleanName;
    return existing;
  }
  const usage: AppUsage = {
    bundleId: id,
    name: cleanName || id,
    count: 1,
    lastUsed: now.toISOString(),
  };
  data.apps[id] = usage;
  return usage;
}

/** A background verdict this old is tried once more instead of applied. */
export const BACKGROUND_RETRY_DAYS = 30;
const BACKGROUND_ROUTES: readonly BackgroundRoute[] = [
  "press",
  "write",
  "post",
  "keys",
];
/**
 * What one run's postcondition reads say about an application's background
 * routes (design §5): one "works" is enough; a "noop" or "echo" needs two
 * consistent observations before it is stored. A verdict a run did not
 * observe is kept as it was. Returns the stored entry, or undefined when the
 * observations decided nothing.
 */
export function recordBackgroundIn(
  data: MemoryData,
  bundleId: string,
  name: string | undefined,
  observations: BackgroundObservation[],
  now: Date,
): AppBackground | undefined {
  const verdicts: BackgroundKnowledge = {};
  for (const route of BACKGROUND_ROUTES) {
    const seen = observations.filter((o) => o.route === route);
    if (!seen.length) continue;
    if (seen.some((o) => o.verdict === "works")) verdicts[route] = "works";
    else if (seen.filter((o) => o.verdict === "noop").length >= 2)
      verdicts[route] = "noop";
    else if (seen.filter((o) => o.verdict === "echo").length >= 2)
      verdicts[route] = "echo";
  }
  if (!Object.keys(verdicts).length) return undefined;
  const usage =
    (Object.hasOwn(data.apps, bundleId) ? data.apps[bundleId] : undefined) ??
    recordAppUseIn(data, bundleId, name, now);
  if (!usage) return undefined;
  usage.background = {
    ...usage.background,
    ...verdicts,
    observedAt: now.toISOString(),
  };
  return usage.background;
}
/**
 * The routes to skip per application, for the runner (design §5): verdicts
 * observed within BACKGROUND_RETRY_DAYS; "works" says nothing to skip and
 * is left out.
 */
export function backgroundKnowledge(
  data: MemoryData,
  now: Date,
): Record<string, BackgroundKnowledge> {
  const cutoff = now.getTime() - BACKGROUND_RETRY_DAYS * DAY_MS;
  const known: Record<string, BackgroundKnowledge> = {};
  for (const usage of Object.values(data.apps)) {
    const learned = usage.background;
    if (!learned || time(learned.observedAt) < cutoff) continue;
    const skips: BackgroundKnowledge = {};
    for (const route of BACKGROUND_ROUTES)
      if (learned[route] === "noop" || learned[route] === "echo")
        skips[route] = learned[route];
    if (Object.keys(skips).length) known[usage.bundleId] = skips;
  }
  return known;
}

export function upsertSkillIn(data: MemoryData, skill: Skill) {
  const index = data.skills.findIndex(
    (s) => s.id === skill.id || s.trigger === skill.trigger,
  );
  if (index >= 0) data.skills[index] = skill;
  else data.skills.push(skill);
}

export function markSkillIn(
  data: MemoryData,
  id: string,
  success: boolean,
  now: Date,
): Skill | undefined {
  const skill = data.skills.find((s) => s.id === id);
  if (!skill) return undefined;
  if (success) skill.successes += 1;
  else skill.failures += 1;
  skill.lastUsed = now.toISOString();
  return skill;
}

const time = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * Enforce caps. When a cap is exceeded, entries unused for DECAY_DAYS are
 * removed first, then the oldest (or weakest) entries.
 */
export function prune(data: MemoryData, now: Date) {
  const cutoff = now.getTime() - DECAY_DAYS * DAY_MS;
  if (data.episodes.length > MEMORY_LIMITS.episodes) {
    let kept = data.episodes.filter((e) => time(e.createdAt) >= cutoff);
    if (kept.length > MEMORY_LIMITS.episodes)
      kept = kept
        .map((e, i) => ({ e, i }))
        .sort((a, b) => time(b.e.createdAt) - time(a.e.createdAt) || b.i - a.i)
        .slice(0, MEMORY_LIMITS.episodes)
        .sort((a, b) => a.i - b.i)
        .map((x) => x.e);
    data.episodes = kept;
  }
  if (data.skills.length > MEMORY_LIMITS.skills) {
    let kept = data.skills.filter((s) => time(s.lastUsed) >= cutoff);
    if (kept.length > MEMORY_LIMITS.skills)
      kept = [...kept]
        .sort(
          (a, b) =>
            time(b.lastUsed) - time(a.lastUsed) ||
            b.successes - b.failures - (a.successes - a.failures),
        )
        .slice(0, MEMORY_LIMITS.skills);
    data.skills = kept;
  }
  if (data.preferences.length > MEMORY_LIMITS.preferences)
    data.preferences = [...data.preferences]
      .sort(
        (a, b) => b.weight - a.weight || time(b.updatedAt) - time(a.updatedAt),
      )
      .slice(0, MEMORY_LIMITS.preferences);
  const apps = Object.values(data.apps);
  if (apps.length > MEMORY_LIMITS.apps) {
    const kept = apps
      .sort((a, b) => time(b.lastUsed) - time(a.lastUsed) || b.count - a.count)
      .slice(0, MEMORY_LIMITS.apps);
    data.apps = Object.fromEntries(kept.map((a) => [a.bundleId, a]));
  }
  // What watching proposed: approved entries are kept ahead of proposed
  // ones, then the most recently seen; retired and refused go first.
  const rank = (status: string) =>
    status === "approved" ? 2 : status === "proposed" ? 1 : 0;
  if (data.routines.length > MEMORY_LIMITS.routines)
    data.routines = [...data.routines]
      .sort(
        (a, b) =>
          rank(b.status) - rank(a.status) ||
          time(b.lastSeen) - time(a.lastSeen),
      )
      .slice(0, MEMORY_LIMITS.routines);
  if (data.procedures.length > MEMORY_LIMITS.procedures)
    data.procedures = [...data.procedures]
      .sort(
        (a, b) =>
          rank(b.status) - rank(a.status) ||
          time(b.lastSeen) - time(a.lastSeen),
      )
      .slice(0, MEMORY_LIMITS.procedures);
}

/**
 * Reads a version 1 or 2 file. A version 1 file (before watching existed)
 * has no routines or procedures and gets empty lists; every record it holds
 * is kept. Anything else is invalid.
 */
function coerce(value: unknown): MemoryData {
  if (!value || typeof value !== "object") throw new Error("Invalid memory");
  const v = value as Partial<Omit<MemoryData, "version">> & {
    version?: unknown;
  };
  if (
    (v.version !== 1 && v.version !== 2) ||
    !Array.isArray(v.episodes) ||
    !Array.isArray(v.preferences) ||
    !Array.isArray(v.skills) ||
    !v.apps ||
    typeof v.apps !== "object" ||
    Array.isArray(v.apps) ||
    (v.version === 2 &&
      (!Array.isArray(v.routines) || !Array.isArray(v.procedures)))
  )
    throw new Error("Invalid memory");
  const object = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object";
  const status = (x: unknown) =>
    x === "proposed" || x === "approved" || x === "retired" || x === "never";
  return {
    version: 2,
    episodes: v.episodes.filter(
      (e): e is Episode =>
        object(e) && e.kind === "episode" && typeof e.task === "string",
    ),
    preferences: v.preferences.filter(
      (p): p is Preference =>
        object(p) && p.kind === "preference" && typeof p.text === "string",
    ),
    skills: v.skills.filter(
      (s): s is Skill =>
        object(s) &&
        s.kind === "skill" &&
        typeof s.trigger === "string" &&
        Array.isArray(s.steps),
    ),
    apps: Object.fromEntries(
      Object.entries(v.apps).filter(
        ([, a]) =>
          object(a) &&
          typeof a.bundleId === "string" &&
          typeof a.count === "number",
      ),
    ) as Record<string, AppUsage>,
    routines: (v.version === 2 ? v.routines! : []).filter(
      (r): r is Routine =>
        object(r) &&
        r.kind === "routine" &&
        typeof r.name === "string" &&
        Array.isArray(r.steps) &&
        object(r.when) &&
        status(r.status),
    ),
    procedures: (v.version === 2 ? v.procedures! : []).filter(
      (p): p is Procedure =>
        object(p) &&
        p.kind === "procedure" &&
        typeof p.trigger === "string" &&
        Array.isArray(p.steps) &&
        status(p.status),
    ),
  };
}

export interface MemoryStoreOptions {
  /** Delay before a scheduled write (default 1000 ms). */
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Encrypted local memory (AES-256-GCM via the vault key, AAD "memory").
 * Loads lazily, tolerates a missing or corrupt file, writes atomically.
 */
export class MemoryStore {
  private state?: MemoryData;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private readonly debounceMs: number;

  constructor(
    readonly directory: string,
    private readonly key: Buffer,
    private readonly now: () => Date = () => new Date(),
    private readonly options: MemoryStoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1000;
  }

  get path() {
    return join(this.directory, MEMORY_FILE);
  }

  /** The live data (loaded on first use). Mutate through update(). */
  data(): MemoryData {
    if (!this.state) this.state = this.load();
    return this.state;
  }

  private load(): MemoryData {
    if (!existsSync(this.path)) return emptyMemory();
    try {
      return coerce(
        JSON.parse(unseal(this.key, readFileSync(this.path), AAD).toString()),
      );
    } catch (error) {
      try {
        copyFileSync(this.path, this.path + ".corrupt");
      } catch {
        // Keeping the copy is best effort.
      }
      this.options.onError?.(error);
      return emptyMemory();
    }
  }

  /** Apply a change, enforce caps and schedule a debounced save. */
  update<T>(change: (data: MemoryData) => T): T {
    const data = this.data();
    const result = change(data);
    prune(data, this.now());
    this.schedule();
    return result;
  }

  private schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch (error) {
        this.options.onError?.(error);
      }
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write pending changes now (tests and application quit). */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty || !this.state) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tmp = this.path + ".tmp";
    writeFileSync(
      tmp,
      seal(this.key, Buffer.from(JSON.stringify(this.state)), AAD),
      { mode: 0o600 },
    );
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  /** Forget everything: delete the file and start empty. */
  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirty = false;
    this.state = emptyMemory();
    for (const suffix of ["", ".tmp", ".corrupt"])
      rmSync(this.path + suffix, { force: true });
  }

  summary() {
    const data = this.data();
    return {
      episodes: data.episodes.length,
      preferences: data.preferences.length,
      skills: data.skills.length,
      apps: Object.keys(data.apps).length,
      routines: data.routines.length,
      procedures: data.procedures.length,
    };
  }

  addEpisode(episode: Episode) {
    this.update((data) => addEpisodeTo(data, episode));
  }

  upsertPreference(text: string, source: Preference["source"] = "correction") {
    return this.update((data) =>
      upsertPreferenceIn(data, text, source, this.now()),
    );
  }

  recordAppUse(bundleId: string, name?: string) {
    return this.update((data) =>
      recordAppUseIn(data, bundleId, name, this.now()),
    );
  }

  upsertSkill(skill: Skill) {
    this.update((data) => upsertSkillIn(data, skill));
  }

  markSkill(id: string, success: boolean) {
    return this.update((data) => markSkillIn(data, id, success, this.now()));
  }
}
