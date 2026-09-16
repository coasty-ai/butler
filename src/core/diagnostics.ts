export type DiagnosticSink = (
  event: string,
  data?: Record<string, unknown>,
) => void;

// Diagnostics must never interfere with cancellation, input or task execution.
export function trace(
  sink: DiagnosticSink | undefined,
  event: string,
  data: Record<string, unknown> = {},
) {
  try {
    sink?.(event, data);
  } catch {}
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { error: "Unknown error" };
  const e = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const result: Record<string, unknown> = {
    name: typeof e.name === "string" ? e.name : "Error",
    error: typeof e.message === "string" ? e.message : "Unknown error",
  };
  if (typeof e.code === "string") result.code = e.code;
  if (e.cause && typeof e.cause === "object" && e.cause !== error) {
    const cause = e.cause as { code?: unknown; message?: unknown };
    result.cause = { code: cause.code, error: cause.message };
  }
  return result;
}
