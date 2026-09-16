import { z } from "zod";
import type { Frame, JournalEvent, Run } from "../core/schema";
import { sanitizeText } from "../core/sanitize";
export const consentVersion = "2026-09-alpha-1";
export const reviewSchema = z
  .object({
    runId: z.string().uuid(),
    level: z.enum(["statistics", "trajectory"]),
    excludedFrames: z.array(z.string().max(100)).max(1000),
    excludedEvents: z.array(z.string().uuid()).max(1000),
    affirmative: z.literal(true),
  })
  .strict();
export type Review = z.infer<typeof reviewSchema>;
export interface Bundle {
  version: 1;
  run_ref: string;
  level: "statistics" | "trajectory";
  statistics: Record<string, number | boolean | null | string>;
  task?: string;
  corrections?: { text: string; after_action: number }[];
  steps?: Record<string, unknown>[];
  frames?: { id: string; image: string; sha256: string }[];
  scan: { redactions: number; native_frames_excluded: number };
}
export function prepareBundle(
  run: Run,
  events: JournalEvent[],
  frames: Frame[],
  review: Omit<Review, "affirmative">,
): Bundle {
  if (review.runId !== run.id) throw new Error("Run mismatch");
  if (!["completed", "failed", "cancelled"].includes(run.status))
    throw new Error("Finish the run before reviewing.");
  const bundle: Bundle = {
    version: 1,
    run_ref: run.id,
    level: review.level,
    statistics: {
      provider: [
        "tutorial",
        "ollama",
        "anthropic",
        "openai",
        "google",
        "compatible",
      ].includes(run.provider)
        ? run.provider
        : "compatible",
      actions: run.actions,
      frames: run.frames,
      input_tokens: run.usage.inputTokens,
      output_tokens: run.usage.outputTokens,
      estimated_cost: run.usage.cost,
      success: run.outcome ?? null,
      synthetic: run.synthetic,
    },
    scan: {
      redactions: 0,
      native_frames_excluded: frames.filter((f) => !f.synthetic).length,
    },
  };
  if (review.level === "statistics") return bundle;
  const task = sanitizeText(run.task);
  bundle.task = task.text;
  bundle.scan.redactions += task.findings.length;
  bundle.corrections = (run.corrections ?? []).map((c) => {
    const result = sanitizeText(c.text);
    bundle.scan.redactions += result.findings.length;
    return { text: result.text, after_action: c.after_action };
  });
  bundle.steps = events
    .filter(
      (e) =>
        e.type === "ActionExecuted" &&
        !review.excludedEvents.includes(e.event_id),
    )
    .map((e) => {
      const a = e.data.action as Record<string, unknown>;
      const result: Record<string, unknown> = { type: a.type };
      for (const [k, v] of Object.entries(a)) {
        if (k === "frame_id") continue;
        if (typeof v === "string") {
          const s = sanitizeText(v);
          result[k] = s.text;
          bundle.scan.redactions += s.findings.length;
        } else result[k] = v;
      }
      return result;
    });
  // Until validated OCR/visual review ships, real screenshots cannot enter bundles.
  bundle.frames = frames
    .filter(
      (f) =>
        run.synthetic && f.synthetic && !review.excludedFrames.includes(f.id),
    )
    .map((f) => ({ id: f.id, image: f.image, sha256: f.sha256 }));
  return bundle;
}
