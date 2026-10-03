import type { Settings } from "../core/schema";
import type { ToolAccess } from "../core/tools";
import { toolDecision } from "../core/tool-policy";
import { zoneParts } from "../core/tool-text";
import { sanitizeResult } from "../tools/result";
import { redactCodes } from "../assistant/state";
import type { BriefingFacts, BriefingSource } from "./types";

export const BRIEFING_INPUT_CHARS = 16_000;
export interface WorkspaceReading {
  at: number;
  openApps: string[];
  notifications: string[];
  appsMore: number;
  notificationsMore: number;
  accessibility: boolean;
  notificationWatching: boolean;
}
const clean = (text: string, limit = 2400) =>
  sanitizeResult(text, 1, limit).text;
/** Only metadata and banners: a malformed helper reply is unavailable. */
export function parseWorkspace(value: unknown): WorkspaceReading | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r.at !== "number" ||
    !Number.isFinite(r.at) ||
    !Array.isArray(r.openApps) ||
    !Array.isArray(r.notifications)
  )
    return undefined;
  const lines = (xs: unknown[], limit: number) =>
    xs
      .filter((x): x is string => typeof x === "string")
      .slice(0, limit)
      .map((x) => clean(x, 400));
  const count = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x)
      ? Math.max(0, Math.floor(x))
      : 0;
  return {
    at: r.at,
    openApps: lines(r.openApps, 64),
    notifications: lines(r.notifications, 100),
    appsMore: count(r.appsMore),
    notificationsMore: count(r.notificationsMore),
    accessibility: r.accessibility === true,
    notificationWatching: r.notificationWatching === true,
  };
}
/** Explicit saved queries can use rolling dates, without a planning model. */
export function briefingArgs(
  args: Record<string, unknown>,
  access: ToolAccess,
  since: number,
): Record<string, unknown> {
  const clock = access.clock();
  const p = zoneParts(clock.now, clock.zone);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const today = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 1);
  const variables: Record<string, string> = {
    today,
    tomorrow: day.toISOString().slice(0, 10),
    since: new Date(since).toISOString(),
    now: clock.now.toISOString(),
  };
  const replace = (v: unknown, depth = 0): unknown => {
    if (depth > 4) throw new Error("Arguments are too deeply nested.");
    if (typeof v === "string")
      return v.replace(
        /\{\{(today|tomorrow|since|now)\}\}/g,
        (_, name: string) => variables[name],
      );
    if (Array.isArray(v)) return v.map((x) => replace(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, replace(x, depth + 1)]),
      );
    return v;
  };
  return replace(args) as Record<string, unknown>;
}
/** Abort-aware deadlines also bound a broken connector that ignores signals. */
export function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: unknown, value?: T) => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
      controller.abort();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new Error("Read interrupted or timed out."));
    if (parent.aborted) return abort();
    parent.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, ms);
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}
export async function collectBriefing(o: {
  settings: Settings;
  since: number;
  signal: AbortSignal;
  now?: () => number;
  workspace: (since: number) => Promise<unknown>;
  agenda: () => Promise<{
    access: { calendar: string; reminders: string };
    lines: string[];
  }>;
  tools?: ToolAccess;
}): Promise<BriefingFacts> {
  const at = (o.now ?? Date.now)();
  const s = o.settings;
  const source = (
    id: string,
    title: string,
    state: BriefingSource["state"],
    detail: string,
    text = "",
  ): BriefingSource => ({ id, title, state, detail, text: clean(text) });
  const workspace = bounded(() => o.workspace(o.since), o.signal, 4000)
    .then(parseWorkspace)
    .catch(() => undefined);
  const agenda = s.agenda
    ? bounded(() => o.agenda(), o.signal, 4000).catch(() => undefined)
    : Promise.resolve(undefined);
  const listing = o.tools
    ? bounded(
        (signal) => o.tools!.list("briefing", signal, { readsOnly: true }),
        o.signal,
        1500,
      ).catch(() => ({ tools: [], unavailable: [] }))
    : Promise.resolve({ tools: [], unavailable: [] });
  const [w, a, list] = await Promise.all([workspace, agenda, listing]);
  const sources: BriefingSource[] = [
    w
      ? source(
          "apps",
          "Open apps",
          "ok",
          `${w.openApps.length} apps; window titles only${w.appsMore ? `; ${w.appsMore} more omitted` : ""}.`,
          w.openApps.join("\n"),
        )
      : source(
          "apps",
          "Open apps",
          "unavailable",
          "The Mac helper did not answer.",
        ),
    !s.notifications
      ? source(
          "notifications",
          "Notifications",
          "off",
          "Enable Read my notifications below.",
        )
      : !w?.accessibility || !w.notificationWatching
        ? source(
            "notifications",
            "Notifications",
            "needs_setup",
            "Needs Accessibility and an active Notification Center banner reader.",
          )
        : source(
            "notifications",
            "Notifications",
            "ok",
            `${w.notifications.length} observed banners since the previous check${w.notificationsMore ? `; ${w.notificationsMore} more omitted` : ""}. Earlier notifications and silent alerts aren't available.`,
            redactCodes(w.notifications.join("\n")),
          ),
    !s.agenda
      ? source(
          "agenda",
          "Calendar and Reminders",
          "off",
          "Enable Use my Calendar and Reminders below.",
        )
      : a
        ? source(
            "agenda",
            "Calendar and Reminders",
            a.access.calendar === "granted" || a.access.reminders === "granted"
              ? "ok"
              : "needs_setup",
            `Calendar: ${a.access.calendar}; Reminders: ${a.access.reminders}.`,
            a.lines.join("\n"),
          )
        : source(
            "agenda",
            "Calendar and Reminders",
            "unavailable",
            "The agenda helper did not answer.",
          ),
  ];
  const clock = o.tools?.clock();
  const automatic = [
    ...(s.tools.apple.calendar && !s.agenda
      ? [
          {
            tool: "apple__calendar_list_events",
            args: { from: "{{today}}", to: "{{tomorrow}}" },
          },
        ]
      : []),
    ...(s.tools.apple.reminders && !s.agenda
      ? [{ tool: "apple__reminders_list", args: {} }]
      : []),
    ...(s.tools.apple.mail
      ? [{ tool: "apple__mail_unread", args: { limit: 10 } }]
      : []),
  ];
  const reads = [
    ...new Map(
      [...automatic, ...s.briefings.reads].map((r) => [r.tool, r]),
    ).values(),
  ];
  const results = await Promise.all(
    reads.map(async (read) => {
      const spec = list.tools.find((t) => t.id === read.tool);
      const title = spec?.title ?? read.tool.split("__")[0];
      if (
        !spec ||
        !o.tools ||
        !clock ||
        spec.tier !== "read" ||
        !spec.trusted ||
        spec.longRunning
      )
        return source(
          read.tool,
          title,
          "unavailable",
          "Enable this read tool and unattended reads in Tools; check its connection and permissions.",
        );
      const appleId = {
        Calendar: "com.apple.iCal",
        Reminders: "com.apple.reminders",
        Mail: "com.apple.mail",
        Notes: "com.apple.Notes",
      }[spec.title];
      if (
        s.protectedApps.some(
          (id) => id.toLowerCase() === (appleId ?? spec.title).toLowerCase(),
        )
      )
        return source(read.tool, title, "off", "This app is protected.");
      try {
        const args = briefingArgs(read.args, o.tools, o.since);
        // These arguments were explicitly saved by the owner, never chosen by
        // app content or a model. Normal credential, privacy and path rules apply.
        const userWords = JSON.stringify(args);
        const prepared = o.tools.prepare(spec, args, { userWords });
        const decision = toolDecision(
          {
            type: "tool_call",
            tool: spec.id,
            args,
            frame_id: "briefing",
            finish: false,
          },
          s,
          false,
          { userWords, clock, tool: { spec, prepared, calls: 0 } },
        );
        if (decision.kind !== "ALLOW")
          return source(
            read.tool,
            title,
            "needs_setup",
            "This query cannot run unattended. Check its arguments and tool permissions.",
          );
        const result = await bounded(
          (signal) => o.tools!.call(spec, args, signal, { userWords }),
          o.signal,
          6000,
        );
        return source(
          read.tool,
          title,
          result.code === "ok" ? "ok" : "error",
          result.code === "ok"
            ? "Read through its app connection."
            : `Read returned ${result.code}.`,
          result.code === "ok" ? (result.lines?.join("\n") ?? result.text) : "",
        );
      } catch {
        return source(
          read.tool,
          title,
          "error",
          "Read failed or timed out; other sources were still checked.",
        );
      }
    }),
  );
  sources.push(...results);
  for (const server of s.tools.servers.filter((r) => r.enabled)) {
    if (!reads.some((r) => r.tool.startsWith(`${server.id}__`)))
      sources.push(
        source(
          server.id,
          server.name,
          "needs_setup",
          "Add a read query for this app in Briefings.",
        ),
      );
  }
  for (const unavailable of list.unavailable) {
    if (!sources.some((r) => r.title === unavailable.title))
      sources.push(
        source(
          `unavailable-${sources.length}`,
          unavailable.title,
          "unavailable",
          unavailable.state,
        ),
      );
  }
  return {
    at,
    since: o.since,
    zone: clock?.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    sources,
  };
}

export function briefingInput(facts: BriefingFacts): string {
  // Count escaped JSON strings too. Cutting the final JSON would turn a
  // busy or hostile source into an invalid model request.
  const fit = (text: string, budget: number) => {
    let part = clean(text, 2400).slice(0, budget);
    while (JSON.stringify(part).length > budget && part.length)
      part = part.slice(0, Math.floor(part.length * 0.8));
    return part;
  };
  const selected = facts.sources
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        Number(b.s.state === "ok") - Number(a.s.state === "ok") || a.i - b.i,
    )
    .slice(0, 40)
    .map(({ s }) => s);
  const sources = selected.map((s) => ({
    id: fit(s.id, 80),
    title: fit(s.title, 40),
    state: s.state,
    detail: fit(s.detail, 100),
    text: "",
  }));
  const data = {
    at: new Date(facts.at).toISOString(),
    since: new Date(facts.since).toISOString(),
    timezone: facts.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    omittedSources: facts.sources.length - selected.length,
    sources,
  };
  const remaining = BRIEFING_INPUT_CHARS - JSON.stringify(data).length;
  const perSource = Math.min(
    2400,
    Math.max(0, Math.floor(remaining / Math.max(1, sources.length)) - 32),
  );
  sources.forEach((s, i) => {
    const text = selected[i].text;
    s.text = fit(text, perSource);
    if (s.text.length < text.length) s.text += "…";
  });
  return JSON.stringify(data);
}
