import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
