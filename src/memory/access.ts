import type { MemoryContext } from "../core/schema";
import type {
  LearnInput,
  MemoryAccess,
  Recall,
  ReplayPlan,
  SystemIndex,
} from "../core/memory";
import { matchIntent, mayBeQuickIntent } from "./intents";
import { learnFromRun } from "./learn";
import { recallContext } from "./retrieve";
import { matchSkill, toPlan } from "./skills";
import { backgroundKnowledge, type MemoryStore } from "./store";
import type { MemoryData } from "./types";

export interface MemoryAccessOptions {
  /** Budget shared by the index lookups of one recall (default 1500 ms). */
  budgetMs?: number;
  /** Learning switch (settings.memory); disabled recall is empty. */
  enabled?: () => boolean;
  onError?: (error: unknown) => void;
  now?: () => Date;
}

const PLAN_NOTES = {
  replay:
    "A known procedure for this task. Its steps may run automatically; check the screen and finish or correct it.",
  hint: "A procedure that worked before for a similar task. Use it only as a hint and verify each step on screen.",
} as const;

/** Least remaining budget worth a Spotlight name-match request. */
const MIN_MATCH_LOOKUP_MS = 400;

const empty = (): Recall => ({ context: { preferences: [], episodes: [] } });

function withBudget<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    work.then(finish, () => finish(undefined));
  });
}

function appIdResolver(data: MemoryData, index: SystemIndex | undefined) {
  return (name: string) => {
    const key = name.toLowerCase();
    return (
      index?.apps?.find((a) => a?.name?.toLowerCase() === key)?.bundleId ??
      Object.values(data.apps).find((a) => a.name.toLowerCase() === key)
        ?.bundleId
    );
  };
}

/** Runner-facing memory: bounded recall and never-throwing learning. */
export function createMemoryAccess(
  store: MemoryStore,
  index: (query: string) => Promise<SystemIndex | undefined>,
  options: MemoryAccessOptions = {},
): MemoryAccess {
  const budget = options.budgetMs ?? 1500;
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Logging must not break a run.
    }
  };
  const enabled = () => {
    try {
      return options.enabled ? options.enabled() : true;
    } catch {
      return false;
    }
  };
  return {
    async recall(task: string, signal?: AbortSignal): Promise<Recall> {
      if (!enabled() || typeof task !== "string" || !task.trim())
        return empty();
      try {
        // One budget for every lookup of this recall.
        const deadline = Date.now() + budget;
        const lookup = async (
          query: string,
        ): Promise<SystemIndex | undefined> => {
          let pending: Promise<SystemIndex | undefined>;
          try {
            pending = Promise.resolve(index(query));
          } catch (error) {
            report(error);
            pending = Promise.resolve(undefined);
          }
          const system = await withBudget(
            pending.catch((error) => {
              report(error);
              return undefined;
            }),
            Math.max(0, deadline - Date.now()),
            signal,
          );
          return system &&
            typeof system === "object" &&
            Array.isArray(system.apps)
            ? {
                apps: system.apps,
                folders: Array.isArray(system.folders) ? system.folders : [],
                recentFiles: Array.isArray(system.recentFiles)
                  ? system.recentFiles
                  : [],
                matches: Array.isArray(system.matches) ? system.matches : [],
              }
            : undefined;
        };
        let valid: SystemIndex | undefined;
        let plan: ReplayPlan | undefined;
        let queried = true;
        if (mayBeQuickIntent(task)) {
          // App, URL and search intents read only the app list, which the
          // helper answers from its cache. The Spotlight name-match query
          // (up to about a second on the serial native queue, ahead of the
          // first capture) runs only when no such intent matches.
          valid = await lookup("");
          plan = matchIntent(task, valid, store.data());
          // A nearly spent budget sends nothing more to the helper's serial
          // queue: a request that cannot answer in time would only delay the
          // first capture.
          queried =
            !plan &&
            !signal?.aborted &&
            deadline - Date.now() >= (valid ? MIN_MATCH_LOOKUP_MS : 1);
        }
        if (queried) {
          // A timed-out name-match lookup keeps the apps, folders and recent
          // files the first lookup already returned.
          const matched = await lookup(task);
          valid = matched ?? valid;
        }
        const data = store.data();
        const context: MemoryContext = recallContext(data, task, valid);
        if (!plan) plan = matchIntent(task, valid, data);
        if (!plan) {
          const found = matchSkill(data.skills, task);
          if (found)
            plan = toPlan(
              found.skill,
              found.slotValues,
              appIdResolver(data, valid),
            );
        }
        if (plan)
          context.plan = {
            source: plan.source,
            note: PLAN_NOTES[plan.mode],
            steps: plan.outline,
          };
        // For the runner alone, beside the context the model gets.
        const background = backgroundKnowledge(
          data,
          options.now?.() ?? new Date(),
        );
        return {
          context,
          ...(plan ? { plan } : {}),
          ...(Object.keys(background).length ? { background } : {}),
        };
      } catch (error) {
        report(error);
        return empty();
      }
    },
    learn(input: LearnInput) {
      if (!enabled()) return;
      try {
        store.update((data) =>
          learnFromRun(data, input, options.now?.() ?? new Date()),
        );
      } catch (error) {
        report(error);
      }
    },
  };
}
