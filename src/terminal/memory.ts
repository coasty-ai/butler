import { createMemoryAccess } from "../memory/access";
import { recallContext } from "../memory/retrieve";
import type { MemoryAccess, SystemIndex } from "../core/memory";
import { scanText } from "../core/sanitize";
import type { TerminalStore } from "./store";

/** Learning and recall share the CLI's encrypted profile key and live switch. */
export function terminalMemory(
  store: TerminalStore,
  index: (query: string) => Promise<SystemIndex | undefined>,
): MemoryAccess {
  const access = createMemoryAccess(store.memory, index, {
    enabled: () => store.profile.settings.memory,
    budgetMs: 500,
  });
  return {
    ...access,
    learn(input) {
      access.learn(input);
      // A completed task must survive an immediate exit/restart.
      store.memory.flush();
    },
  };
}
/** Conversation retrieval is local: no helper, UI capture or model call. */
export function conversationMemory(store: TerminalStore, words: string) {
  if (!store.profile.settings.memory) return undefined;
  const { preferences, episodes } = recallContext(store.memory.data(), words);
  return preferences.length || episodes.length
    ? { preferences, episodes }
    : undefined;
}
export function rememberPreference(store: TerminalStore, text: string) {
  if (!store.profile.settings.memory)
    throw new Error(
      "Memory is off. Use /memory on before saving a preference.",
    );
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 300)
    throw new Error("Use /remember with a preference of 1–300 characters.");
  if (scanText(clean).some((finding) => finding.action === "BLOCK_UPLOAD"))
    throw new Error("Keep credentials in /key or /connect, not in memory.");
  const preference = store.memory.upsertPreference(clean, "correction");
  if (!preference)
    throw new Error("Use /remember with a meaningful preference.");
  store.memory.flush();
  return preference;
}
/** Explicit personal preferences only; reminder/action requests retain their route. */
export function rememberRequest(text: string) {
  return /^(?:please\s+)?remember(?:\s+that)?\s+((?:i\b|my\b|we\b|our\b).+)$/i
    .exec(text.trim())?.[1]
    ?.trim();
}
