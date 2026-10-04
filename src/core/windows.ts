import type { Action, RunTarget, WindowContext } from "./schema";
import { redactSecrets } from "./sanitize";

/** Navigation gets a checked foreground transaction; ordinary input stays bound. */
export function windowNavigation(action: Action): boolean {
  if (["open_app", "open_file", "open_url"].includes(action.type)) return true;
  if (action.type === "menu_item")
    return (
      action.path[0] === "Window" ||
      (action.path[0] === "File" &&
        /^New (?:Window|Workspace)$/i.test(action.path.at(-1) ?? ""))
    );
  return (
    action.type === "hotkey" &&
    action.keys.includes("CMD") &&
    action.keys.includes("N") &&
    action.keys.every((key) => ["CMD", "SHIFT", "N"].includes(key))
  );
}

const text = (value: string, max: number) =>
  redactSecrets(value.replace(/\s+/g, " ").trim()).slice(0, max);
/** Saved window facts are hints, never reusable native tokens or input authority. */
export function windowContexts(
  value: WindowContext[] | undefined,
): WindowContext[] {
  return (Array.isArray(value) ? value : [])
    .slice(-8)
    .filter(
      (w) =>
        !!w &&
        typeof w === "object" &&
        Number.isInteger(w.pid) &&
        w.pid > 0 &&
        Number.isInteger(w.windowId) &&
        w.windowId > 0 &&
        typeof w.appId === "string" &&
        typeof w.appName === "string" &&
        typeof w.title === "string" &&
        Number.isFinite(Date.parse(w.lastSeenAt)),
    )
    .map((w) => ({
      appId: text(w.appId, 100),
      appName: text(w.appName, 80),
      pid: w.pid,
      windowId: w.windowId,
      title: text(w.title, 180),
      lastSeenAt: new Date(w.lastSeenAt).toISOString(),
      facts: (Array.isArray(w.facts) ? w.facts : [])
        .filter((v) => typeof v === "string")
        .slice(-3)
        .map((v) => text(v, 160)),
    }));
}

export function rememberWindow(
  previous: WindowContext[] | undefined,
  target: RunTarget,
  title = target.title,
  fact?: string,
): WindowContext[] {
  const windows = windowContexts(previous);
  const same = (w: WindowContext) =>
    w.appId === target.appId &&
    w.pid === target.pid &&
    w.windowId === target.windowId;
  const old = windows.find(same);
  const facts = old?.facts ?? [];
  const cleanFact = fact && text(fact, 160);
  return windowContexts([
    ...windows.filter((w) => !same(w)),
    {
      appId: target.appId,
      appName: target.appName,
      pid: target.pid,
      windowId: target.windowId,
      title,
      lastSeenAt: new Date().toISOString(),
      facts: cleanFact
        ? [...facts.filter((v) => v !== cleanFact), cleanFact]
        : facts,
    },
  ]);
}
