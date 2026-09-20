import { z } from "zod";
import type { ScreenContext } from "./schema";
import { redactSecrets } from "./sanitize";
import { normalizeLabel, normalizeRole } from "./labels";
// Truncate rather than reject: a single long title or label must not drop the
// whole context, and cleaning is applied twice (controller and provider).
const bounded = (limit: number) =>
  z.string().transform((value) => value.slice(0, limit));
const short = bounded(300);
const contextSchema = z
  .object({
    appName: short,
    windowTitle: short,
    // A count, never titles: 0 is an application open with no window.
    windowCount: z.number().int().min(0).max(99).optional(),
    documentName: short.optional(),
    selectedText: z.string().max(2000).optional(),
    browserAddress: z.string().max(2000).optional(),
    launcher: z
      .object({ query: short, selectedResult: short.optional() })
      .strict()
      .optional(),
    visibleText: z.string().max(4200).optional(),
    // The page-text walk's stop and its counts (native/macos/WebText.swift).
    visibleTextTruncated: z.enum(["time", "nodes", "chars"]).optional(),
    visibleTextNodes: z.number().int().min(0).max(100000).optional(),
    visibleTextMs: z.number().int().min(0).max(600000).optional(),
    recentWindows: z
      .array(z.object({ appName: short, title: short }).strict())
      .max(12)
      .optional(),
    recentFiles: z.array(short).max(8).optional(),
    recentTasks: z
      .array(z.object({ task: z.string().max(500), status: short }).strict())
      .max(3)
      .optional(),
    controls: z
      .array(
        z
          .object({
            role: z.string().max(40),
            label: bounded(80).optional(),
            x: z.number().finite().min(0).max(1),
            y: z.number().finite().min(0).max(1),
            enabled: z.boolean().optional(),
          })
          .strict(),
      )
      .max(60)
      .optional(),
    // How much of its interface the frontmost application publishes, and its
    // menus: the application's own list of what it can do, and the only route
    // left when it publishes nothing else (docs/THREAT_MODEL.md).
    accessibility: z.enum(["none", "partial", "full"]).optional(),
    menus: z.array(bounded(400)).max(12).optional(),
    screenText: bounded(3200).optional(),
    // The rest of the workspace: what else is open, and what has arrived.
    openApps: z.array(bounded(300)).max(14).optional(),
    notifications: z.array(bounded(300)).max(12).optional(),
    // Why a run started after a detached watch woke the model (increment
    // 5A): fixed codes plus the panel's last text, bounded like screenText.
    watch: z
      .object({
        cause: bounded(40),
        agent: bounded(40).optional(),
        state: bounded(40),
        minutes: z.number().int().min(0).max(100000),
        lastChangeMinutes: z.number().int().min(0).max(100000),
        steps: z.array(bounded(120)).max(5).optional(),
        panelText: bounded(1500).optional(),
      })
      .strict()
      .optional(),
    // A bound run's window (design §2.3): the flags the helper reports, which
    // the instruction's background paragraph explains (src/providers/http.ts).
    background: z
      .object({
        appName: short,
        title: short,
        covered: z.boolean(),
        staleRisk: z.boolean(),
        minimized: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
// Context can contain useful names/addresses. Remove only the detected
// credential spans so surrounding labels and titles stay useful to the model;
// no context is included in donations.
export function cleanScreenContext(value: unknown): ScreenContext | undefined {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const clean = (s: string) => redactSecrets(s);
  const c = parsed.data;
  return {
    appName: clean(c.appName),
    windowTitle: clean(c.windowTitle),
    ...(c.windowCount !== undefined && { windowCount: c.windowCount }),
    ...(c.documentName !== undefined && {
      documentName: clean(c.documentName),
    }),
    ...(c.selectedText !== undefined && {
      selectedText: clean(c.selectedText),
    }),
    ...(c.browserAddress !== undefined && {
      browserAddress: clean(c.browserAddress),
    }),
    ...(c.launcher && {
      launcher: {
        query: clean(c.launcher.query),
        ...(c.launcher.selectedResult !== undefined && {
          selectedResult: clean(c.launcher.selectedResult),
        }),
      },
    }),
    ...(c.visibleText !== undefined && { visibleText: clean(c.visibleText) }),
    ...(c.visibleTextTruncated !== undefined && {
      visibleTextTruncated: c.visibleTextTruncated,
    }),
    ...(c.visibleTextNodes !== undefined && {
      visibleTextNodes: c.visibleTextNodes,
    }),
    ...(c.visibleTextMs !== undefined && { visibleTextMs: c.visibleTextMs }),
    recentWindows: c.recentWindows?.map((w) => ({
      appName: clean(w.appName),
      title: clean(w.title),
    })),
    recentFiles: c.recentFiles?.map(clean),
    recentTasks: c.recentTasks?.map((t) => ({
      task: clean(t.task),
      status: t.status,
    })),
    ...(c.controls && {
      controls: c.controls.map((control) => ({
        ...control,
        ...(control.label !== undefined && {
          label: clean(control.label).slice(0, 80),
        }),
      })),
    }),
    ...(c.accessibility !== undefined && { accessibility: c.accessibility }),
    ...(c.menus && {
      menus: c.menus.map((line) => clean(line).slice(0, 400)),
    }),
    ...(c.screenText && { screenText: clean(c.screenText).slice(0, 3200) }),
    ...(c.openApps && {
      openApps: c.openApps.map((line) => clean(line).slice(0, 300)),
    }),
    ...(c.notifications && {
      notifications: c.notifications.map((line) => clean(line).slice(0, 300)),
    }),
    ...(c.watch && {
      watch: {
        cause: c.watch.cause,
        ...(c.watch.agent !== undefined && { agent: c.watch.agent }),
        state: c.watch.state,
        minutes: c.watch.minutes,
        lastChangeMinutes: c.watch.lastChangeMinutes,
        ...(c.watch.steps && {
          steps: c.watch.steps.map((line) => clean(line).slice(0, 120)),
        }),
        ...(c.watch.panelText !== undefined && {
          panelText: clean(c.watch.panelText).slice(0, 1500),
        }),
      },
    }),
    ...(c.background && {
      background: {
        appName: clean(c.background.appName),
        title: clean(c.background.title),
        covered: c.background.covered,
        staleRisk: c.background.staleRisk,
        minimized: c.background.minimized,
      },
    }),
  };
}
/**
 * Unlabeled controls the model still needs: typed text lands in them, and
 * click_control cannot name them, so their position is all it has.
 */
const textEntryRoles = new Set([
  "textfield",
  "textarea",
  "searchfield",
  "combobox",
]);
/**
 * The model's copy of a cleaned context, without what it already has under
 * another key (live 2026-09-19: 6.7-6.9k input tokens a step to open Notes).
 * Recognized screen lines that the accessibility text, the window title or a
 * control label already carry go; so do unnamed controls outside the
 * text-entry roles (nothing can target them by name) and a second control
 * with the same role and name (click_control resolves the name against the
 * screen; the first entry keeps its position). Windows that context.openApps
 * already lists leave recentWindows, and the page-text walk's counts
 * (visibleTextNodes, visibleTextMs) are diagnostics the model has no use for;
 * its stop code stays beside the marker line. Only the provider calls this:
 * the runner resolves named targets and replays against the full control list.
 */
export function trimScreenContext(
  screen: ScreenContext | undefined,
): ScreenContext | undefined {
  if (!screen) return screen;
  const named = new Set<string>();
  const controls = screen.controls?.filter((control) => {
    const role = normalizeRole(control.role);
    const label = normalizeLabel(control.label ?? "");
    if (!label) return textEntryRoles.has(role);
    const key = `${role}|${label}`;
    if (named.has(key)) return false;
    named.add(key);
    return true;
  });
  const shown = new Set<string>();
  for (const line of [
    screen.appName,
    screen.windowTitle,
    screen.documentName ?? "",
    ...(screen.visibleText ?? "").split("\n"),
    ...(controls ?? []).map((control) => control.label ?? ""),
  ]) {
    const key = normalizeLabel(line);
    if (key) shown.add(key);
  }
  const screenText = screen.screenText
    ?.split("\n")
    .filter((line) => {
      const key = normalizeLabel(line);
      if (!key || shown.has(key)) return false;
      shown.add(key);
      return true;
    })
    .join("\n");
  const openApps = screen.openApps ?? [];
  const recentWindows = screen.recentWindows?.filter(
    (window) =>
      !openApps.some(
        (line) =>
          line.startsWith(window.appName) && line.includes(window.title),
      ),
  );
  const {
    controls: _controls,
    screenText: _screenText,
    recentWindows: _recentWindows,
    visibleTextNodes: _visibleTextNodes,
    visibleTextMs: _visibleTextMs,
    ...rest
  } = screen;
  return {
    ...rest,
    ...(controls && { controls }),
    ...(recentWindows && recentWindows.length > 0 && { recentWindows }),
    ...(screenText && { screenText }),
  };
}
