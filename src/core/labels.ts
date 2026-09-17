/**
 * Control label and role rules shared by learning (src/memory/learn.ts) and
 * replay resolution (src/core/runner.ts). Keep them in one place: a mismatch
 * makes learned skills silently stop matching.
 */

/** Native grounded control names are cut to this many UTF-16 code units. */
export const CONTROL_LABEL_LIMIT = 80;

/**
 * Roles the native grounded-control and web-area walks report in
 * frame.context.controls (normalized). A pointer step whose target role is not
 * here can never resolve on replay, so such a skill is hint-only.
 */
export const REPLAYABLE_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "textfield",
  "textarea",
  "combobox",
  "checkbox",
  "radiobutton",
  "popupbutton",
  "menubutton",
  "tab",
]);

/** Trim, lowercase, collapse whitespace and strip a trailing ellipsis. */
export function normalizeLabel(label: string): string {
  return label
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(…|\.\.\.)$/, "")
    .trim();
}

/** Accessibility role without the AX prefix, lowercase ("AXButton" → "button"). */
export function normalizeRole(role: string): string {
  return role.trim().replace(/^AX/, "").toLowerCase();
}

/** First `limit` UTF-16 code units, never splitting a surrogate pair (like native utf16Prefix). */
export function utf16Prefix(
  value: string,
  limit = CONTROL_LABEL_LIMIT,
): string {
  if (value.length <= limit) return value;
  let end = limit;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * Whether a live grounded control label matches a learned label. Equal after
 * normalization, or, when the live label was cut at the native limit, the
 * learned label starts with it.
 */
export function labelMatches(learned: string, live: string): boolean {
  const a = normalizeLabel(learned);
  const b = normalizeLabel(live);
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    live.trim().length >= CONTROL_LABEL_LIMIT - 4 &&
    b.length >= 40 &&
    a.startsWith(b)
  );
}
