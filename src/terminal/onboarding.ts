import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SETUP_APPS, type SetupApp } from "./concierge";

export const onboardingSchema = z.object({
  phase: z.enum(["new", "later", "connecting", "waiting", "ready"]),
  apps: z.array(z.enum(SETUP_APPS)).max(SETUP_APPS.length).default([]),
  pending: z.array(z.enum(SETUP_APPS)).max(SETUP_APPS.length).default([]),
  desktopReady: z.array(z.enum(SETUP_APPS)).max(SETUP_APPS.length).default([]),
  activeApp: z.enum(SETUP_APPS).optional(),
  desktopFirst: z.boolean().default(true),
});
export type Onboarding = z.infer<typeof onboardingSchema>;
export const freshOnboarding = (): Onboarding =>
  onboardingSchema.parse({ phase: "new" });

const names: Record<SetupApp, string> = {
  calendar: "Calendar",
  reminders: "Reminders",
  mail: "Mail",
  notes: "Notes",
  gmail: "Gmail",
  slack: "Slack",
  github: "GitHub",
  codex: "Codex",
  "claude-code": "Claude Code",
};
export const appNames = (apps: readonly SetupApp[]) =>
  apps.map((app) => names[app]).join(", ");

/** Locate known coding CLIs without launching them or reading their accounts. */
export function installedCodingClis(path = process.env.PATH || ""): SetupApp[] {
  const folders = [...new Set(path.split(":"))].filter((p) =>
    p.startsWith("/"),
  );
  return (["codex", "claude-code"] as const).filter((app) =>
    folders.slice(0, 30).some((folder) => {
      try {
        accessSync(
          join(folder, app === "codex" ? "codex" : "claude"),
          constants.X_OK,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/** Local utilities work first; ordinary web accounts do not require developer keys. */
export function onboardingApps(
  installed: readonly { name: string }[],
  coding: readonly SetupApp[],
): SetupApp[] {
  const present = new Set(installed.map((app) => app.name.toLowerCase()));
  const apps: SetupApp[] = [];
  for (const app of ["calendar", "reminders", "mail", "notes"] as const)
    if (present.has(app)) apps.push(app);
  // Web access uses existing browser sign-in; no new OAuth client is required.
  apps.push("gmail", "slack", "github");
  for (const app of coding)
    if ((app === "codex" || app === "claude-code") && !apps.includes(app))
      apps.push(app);
  return apps;
}

export function continuesSetup(text: string): boolean {
  return /^(?:done|i(?:'|’)m done|i(?:'|’)ve finished|continue setup|finish setup|resume setup)[.!?]*$/i.test(
    text.trim(),
  );
}
export function startsOnboarding(text: string): boolean {
  return /^(?:get me ready|set me up|get started|start setup)[.!?]*$/i.test(
    text.trim(),
  );
}

/** This prepares ordinary app access, not an API token or a cloud access grant. */
export function desktopSetupTask(
  app: "gmail" | "slack" | "github",
  browser: string,
  slackInstalled: boolean,
): string {
  const target = app === "slack" && slackInstalled ? "Slack" : browser;
  const address = {
    gmail: "https://mail.google.com/",
    slack: "https://app.slack.com/",
    github: "https://github.com/",
  }[app];
  return `In ${target}, get ${names[app]} ready for Butler to use through computer control. ${target === "Slack" ? "Open the existing Slack workspace." : `Open ${address}.`} Use the account already signed in. Verify the normal app home or inbox is accessible, without reading messages, notifications, private repositories or other personal content. If sign-in or an account/workspace choice is needed, ask me to do it and wait. Never read, copy, reveal or type passwords, authentication codes or tokens. Never create developer credentials, install apps, change permissions or approve access. Finish only after verifying the app is usable. This prepares computer use; it does not establish an MCP connection.`;
}
