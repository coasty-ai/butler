import { z } from "zod";
import type { ScreenContext } from "./schema";
import { scanText } from "./sanitize";
const short = z.string().max(300);
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
  })
  .strict();
// Context can contain useful names/addresses. Remove detected credentials while
// preserving ordinary task references; no context is included in donations.
export function cleanScreenContext(value: unknown): ScreenContext | undefined {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const clean = (s: string) => {
    const secrets = scanText(s).filter((f) => f.action === "BLOCK_UPLOAD");
    return secrets.length ? "[Sensitive text omitted]" : s;
  };
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
  };
}
