import { z } from "zod";
import type { ScreenContext } from "./schema";
import { redactSecrets } from "./sanitize";
// Truncate rather than reject: a single long title or label must not drop the
// whole context, and cleaning is applied twice (controller and provider).
const bounded = (limit: number) =>
  z.string().transform((value) => value.slice(0, limit));
const short = bounded(300);
const contextSchema = z
  .object({
    appName: short,
    windowTitle: short,
    documentName: short.optional(),
    selectedText: z.string().max(2000).optional(),
    browserAddress: z.string().max(2000).optional(),
    launcher: z
      .object({ query: short, selectedResult: short.optional() })
      .strict()
      .optional(),
    visibleText: z.string().max(4200).optional(),
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
    // Blind-surface reporting: how much of its interface the frontmost
    // application publishes, and its top-level menu titles when it publishes
    // nothing else (docs/THREAT_MODEL.md).
    accessibility: z.enum(["none", "partial", "full"]).optional(),
    menuBar: z.array(bounded(40)).max(12).optional(),
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
    ...(c.menuBar && {
      menuBar: c.menuBar.map((title) => clean(title).slice(0, 40)),
    }),
  };
}
