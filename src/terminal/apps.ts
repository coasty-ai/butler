import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RunBrowser } from "../core/schema";

const browserNames: [string, string, RegExp][] = [
  ["Google Chrome", "com.google.Chrome", /\b(?:chrome|google chrome)\b/i],
  ["Safari", "com.apple.Safari", /\bsafari\b/i],
  ["Firefox", "org.mozilla.firefox", /\bfirefox\b/i],
  ["Brave Browser", "com.brave.Browser", /\bbrave(?: browser)?\b/i],
  [
    "Microsoft Edge",
    "com.microsoft.edgemac",
    /\b(?:microsoft edge|edge browser)\b/i,
  ],
];
/** Resolve explicit browsers first; a web task starts in an installed browser. */
export function taskBrowser(
  task: string,
  apps: { name: string }[],
): RunBrowser | undefined {
  const named = browserNames.find(([, , pattern]) => pattern.test(task));
  if (named) return { name: named[0], bundleId: named[1] };
  if (
    !/https?:\/\/|\b(?:browser|website|web page|youtube|gmail|google drive|google docs|github\.com|slack\.com)\b/i.test(
      task,
    )
  )
    return undefined;
  const installed = browserNames.find(([name]) =>
    apps.some((app) => app.name === name),
  );
  return installed && { name: installed[0], bundleId: installed[1] };
}

const connections: Record<string, string> = {
  slack: "/connect slack bot or /connect slack oauth",
  calendar: "/connect calendar",
  reminders: "/connect reminders",
  notes: "/connect notes",
  mail: "/connect mail",
  claude: "/connect claude-code (CLI sign-in required)",
  codex: "/connect codex (CLI sign-in required)",
  "google chrome": "/connect playwright (extension required)",
};
/** Inventory app bundles without capturing a screen or opening any application. */
export function installedApps(
  folders = [
    "/Applications",
    "/System/Applications",
    join(homedir(), "Applications"),
  ],
) {
  const names = new Set<string>();
  for (const folder of folders) {
    try {
      for (const entry of readdirSync(folder))
        if (entry.endsWith(".app")) names.add(entry.slice(0, -4));
    } catch {}
  }
  return [...names]
    .sort()
    .slice(0, 200)
    .map((name) => ({
      name,
      connection:
        connections[name.toLowerCase()] ||
        "/connect mcp or /connect import <config.json>",
      desktop: `/cua <task in ${name}>`,
    }));
}
