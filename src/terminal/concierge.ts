import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { OAuthClient } from "./oauth";
import { execFile } from "node:child_process";
import { moduleEndpoint } from "../core/schema";

export const SETUP_APPS = [
  "github",
  "gmail",
  "slack",
  "claude-code",
  "codex",
  "calendar",
  "reminders",
  "notes",
  "mail",
] as const;
export type SetupApp = (typeof SETUP_APPS)[number];
const aliases: Record<string, SetupApp | "all"> = {
  github: "github",
  gmail: "gmail",
  slack: "slack",
  "slack bot": "slack",
  "claude code": "claude-code",
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  calendar: "calendar",
  reminders: "reminders",
  notes: "notes",
  mail: "mail",
  "apple mail": "mail",
  "my apps": "all",
  "all my apps": "all",
  "my connections": "all",
  "all my connections": "all",
  everything: "all",
  "all apps": "all",
  all: "all",
};
const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(
      /^(?:please|can you|could you|help me|i want you to|i would like you to|i'd like you to)\s+/,
      "",
    )
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");

/** Explicit setup requests only: quoted mentions and compound tasks stay with chat. */
export function setupRequest(text: string): SetupApp[] | undefined {
  if (
    ["continue setup", "finish setup", "set it all up"].includes(
      normalize(text),
    )
  )
    return [...SETUP_APPS];
  const match =
    /^(?:connect|set up|setup|link|hook up|integrate)\s+(.+?)(?:\s+(?:for me|with butler|to butler))?$/.exec(
      normalize(text),
    );
  if (!match) return undefined;
  const names = match[1]
    .split(/\s*,\s*|\s+and\s+|\s*\+\s*/)
    .map((name) => aliases[name]);
  if (!names.length || names.some((name) => !name)) return undefined;
  return names.includes("all")
    ? [...SETUP_APPS]
    : [...new Set(names as SetupApp[])];
}

/** Typed conveniences share the existing command handlers, including their checks. */
export function naturalControl(text: string): string | undefined {
  const words = normalize(text);
  const controls: Record<string, string> = {
    "read replies aloud": "/voice on",
    "speak your replies": "/voice on",
    "turn voice on": "/voice on",
    "turn voice off": "/voice off",
    "stop talking": "/voice off",
    "test your voice": "/voice test",
    "listen for me": "/listen on",
    "start listening": "/listen on",
    "stop listening": "/listen off",
    "watch my notifications": "/notifications on",
    "stop watching notifications": "/notifications off",
    pause: "/pause",
    "pause work": "/pause",
    stop: "/stop",
    "stop work": "/stop",
    resume: "/resume",
    "resume work": "/resume",
    "show my connections": "/connections",
    "which apps are connected": "/connections",
    "show my apps": "/apps",
    "check your permissions": "/doctor",
    "check permissions": "/doctor",
    "use openai": "/model openai",
    "use gpt-6.1 sol fast": "/model openai gpt-6.1-sol fast",
    "set your api key": "/key",
    "change your api key": "/key",
    "remember our conversations": "/memory on",
    "turn memory off": "/memory off",
    "what do you remember about me": "/memory",
    "start a fresh conversation": "/new",
    "start a new conversation": "/new",
    "stop regular briefings": "/briefings off",
    "stop scheduled briefings": "/briefings off",
    "show the last briefing": "/latest",
    "what can you do": "/help",
    help: "/help",
    "help advanced": "/help advanced",
    quit: "/quit",
  };
  if (controls[words]) return controls[words];
  const period =
    /^(?:brief me|check my apps|give me a briefing) every (\d{1,4}) (minutes?|hours?)$/.exec(
      words,
    );
  if (period) {
    const minutes = Number(period[1]) * (period[2].startsWith("hour") ? 60 : 1);
    if (minutes >= 5 && minutes <= 1440) return `/briefings ${minutes}`;
  }
  return undefined;
}

/** Read only bounded Desktop OAuth downloads after the owner requests Gmail setup. */
export function googleClientFile(path: string): OAuthClient | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return;
    const value = JSON.parse(readFileSync(path, "utf8")).installed;
    if (
      typeof value?.client_id !== "string" ||
      typeof value?.client_secret !== "string" ||
      !value.client_id.endsWith(".apps.googleusercontent.com") ||
      !value.client_secret ||
      value.client_id.length > 512 ||
      value.client_secret.length > 1024
    )
      return;
    return { clientId: value.client_id, clientSecret: value.client_secret };
  } catch {
    return;
  }
}
export function findGoogleClient(folders: string[]): OAuthClient | undefined {
  const found = new Map<string, OAuthClient>();
  for (const folder of folders) {
    try {
      const names = readdirSync(folder)
        .filter((name) => /^client_secret[^/]*\.json$/.test(name))
        .slice(0, 20);
      for (const name of names) {
        try {
          const client = googleClientFile(join(folder, name));
          if (!client) continue;
          const previous = found.get(client.clientId);
          if (previous && previous.clientSecret !== client.clientSecret) return;
          found.set(client.clientId, client);
        } catch {}
      }
    } catch {}
  }
  // Never silently choose between different Google projects.
  return found.size === 1 ? [...found.values()][0] : undefined;
}

export function browserSetupTask(
  app: "gmail" | "slack" | "github",
  browser: string,
): string {
  const steps =
    app === "gmail"
      ? "Go to https://console.cloud.google.com/apis/credentials. Prepare the existing project's Gmail read-only integration and a Desktop OAuth client named Butler. Do not change projects, enable an API, publish a consent screen or create credentials yourself. Ask me to perform those final steps and download the Desktop client JSON."
      : app === "slack"
        ? "Go to https://api.slack.com/apps. Find the existing Butler Slack app, or prepare a new internal app named Butler. Explain any missing read permissions, workspace approval or installation. Do not create an app, change permissions, install it, invite a bot or approve access yourself."
        : "Go to https://github.com/settings/tokens. Help me prepare read-only GitHub access for Butler. Do not create a token or grant access yourself.";
  return `In ${browser}, help set up ${app} for Butler. ${steps} Navigate and prepare ordinary forms only. Stop for sign-in, account choices, access approvals, credential creation and security warnings. Never read, copy, reveal or type passwords, tokens or authentication codes. Finish by telling me the single next step. The connection is not finished until Butler verifies it.`;
}

/** LaunchServices opens a new page; this never reads tabs or clicks a grant. */
export async function openSetupPage(
  address: string,
  protectedDomains: string[],
  launch: (url: string) => Promise<boolean> = (url) =>
    new Promise((resolve) =>
      execFile("/usr/bin/open", [url], { timeout: 5000 }, (error) =>
        resolve(!error),
      ),
    ),
): Promise<boolean> {
  if (!moduleEndpoint(address)) return false;
  const url = new URL(address);
  if (
    url.username ||
    url.password ||
    /[?&](?:access_token|token|api_key|secret)=/i.test(url.search) ||
    protectedDomains.some(
      (domain) =>
        url.hostname === domain.toLowerCase() ||
        url.hostname.endsWith("." + domain.toLowerCase()),
    )
  )
    return false;
  return launch(url.href);
}
