import { Buffer } from "node:buffer";
import { redactSecrets } from "../core/sanitize";
import {
  TOOL_LIMITS,
  TOOL_RESULT_TEXT,
  type ToolCode,
  type ToolSpec,
} from "../core/tools";

/**
 * Characters that steer a reader without being seen: Unicode tags
 * (U+E0000–E007F), zero-width spaces and joiners, the word joiner, the BOM,
 * and the bidirectional controls that reorder what is displayed.
 */
const INVISIBLE = /[​-‍⁠﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu;
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}
/**
 * The one bounded, stripped, redacted body the model reads from a result:
 * invisible characters removed, credential spans redacted, whitespace
 * collapsed, cut at TOOL_LIMITS.resultChars (or the tool's own
 * ToolSpec.resultChars: the web tool's page text) with the omitted length
 * named.
 */
export function sanitizeResult(
  raw: string,
  items: number,
  limit: number = TOOL_LIMITS.resultChars,
): { text: string; bytes: number; items: number } {
  const clean = redactSecrets(stripInvisible(raw))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text =
    clean.length > limit
      ? `${clean.slice(0, limit)} [+${clean.length - limit} chars]`
      : clean;
  return { text, bytes: Buffer.byteLength(raw), items };
}
/** Spoken-answer lines from a builtin read: at most 20 lines of 200 characters, stripped and redacted. */
export function resultLines(lines: readonly unknown[]): string[] {
  return lines
    .filter((line): line is string => typeof line === "string")
    .map((line) =>
      redactSecrets(stripInvisible(line)).replace(/\s+/g, " ").trim(),
    )
    .filter(Boolean)
    .slice(0, TOOL_LIMITS.lines)
    .map((line) => line.slice(0, TOOL_LIMITS.lineChars));
}
/**
 * The line the model reads after a call (TOOL_RESULT_TEXT). A verified
 * builtin write reads "ok, verified"; an MCP change adds the reminder to
 * look at the screen or read the store back before finishing.
 */
export function resultText(
  spec: Pick<ToolSpec, "id" | "title" | "tier" | "transport" | "timeoutMs">,
  code: ToolCode,
  o: { body: string; verified?: boolean },
): string {
  const key = code === "ok" && o.verified ? "ok_verified" : code;
  const fields: Record<string, string> = {
    "{id}": spec.id,
    "{title}": spec.title,
    "{seconds}": String(Math.round(spec.timeoutMs / 1000)),
    "{body}": o.body || "(empty)",
  };
  const line = TOOL_RESULT_TEXT[key].replace(
    /\{(?:id|title|seconds|body)\}/g,
    (field) => fields[field],
  );
  return code === "ok" && spec.transport !== "builtin" && spec.tier !== "read"
    ? line + TOOL_RESULT_TEXT.mcp_write_verify
    : line;
}
