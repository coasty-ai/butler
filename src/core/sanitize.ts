export interface Finding {
  category: string;
  start: number;
  end: number;
  action: "REDACT" | "BLOCK_UPLOAD";
}
// Values that follow "password:" in ordinary UI and prose, not secrets.
const commonValues =
  "enabled|disabled|required|optional|none|null|true|false|reset|forgot|change|changed|show|hide|protected|expired|updated|manager|field|hint|strength|policy|monthly|weekly|weak|strong|medium|incorrect|invalid|wrong|below|here";
const detectors: {
  category: string;
  pattern: RegExp;
  block?: boolean;
  accept?: (match: string) => boolean;
}[] = [
  {
    category: "private_key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    block: true,
  },
  {
    category: "api_key",
    pattern:
      /\b(?:sk-[\w-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[\w-]{25,})\b/g,
    block: true,
  },
  {
    // Token-shaped, so "the bearer of this letter" is prose: at least 12 token
    // characters including a digit or token punctuation.
    category: "token",
    pattern: /\bbearer\s+(?=[A-Za-z]*[0-9._~+/-])[A-Za-z0-9._~+/-]{12,}=*/gi,
    block: true,
  },
  {
    category: "token",
    pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/gi,
    block: true,
  },
  {
    category: "secret_assignment",
    // 6+ character values block unless they are a common UI word; 4-5
    // character values block only when they contain a digit or symbol
    // (sentence punctuation does not count), so "Password: Tap" stays prose.
    pattern: new RegExp(
      String.raw`\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?!(?:${commonValues})(?![^\s,;.!?]))(?:(?=[^\s,;]{0,4}[^\s\p{L},;.!?:])[^\s,;]{4,5}(?![^\s,;])|[^\s,;]{6,})`,
      "giu",
    ),
    block: true,
  },
  {
    category: "secret_assignment",
    // Alphanumeric codes must contain a digit, so "OTP = optional" is prose.
    pattern:
      /\b(?:mfa|otp)(?:\s*code)?\s*[:=]\s*(?=[A-Za-z]*\d)[A-Za-z0-9]{4,10}\b/gi,
    block: true,
  },
  { category: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    // No word or hyphen neighbours, so UUID and identifier segments never match.
    category: "phone_or_account",
    pattern: /(?<![\w-])\+?\(?\d[\d ()-]{7,}\d(?!\w|-\w)/g,
    accept: (match) => {
      const digits = match.replace(/\D/g, "").length;
      return digits >= 9 && digits <= 15 && !/\d{4}-\d{2}-\d{2}/.test(match);
    },
  },
  { category: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { category: "url", pattern: /https?:\/\/[^\s<>"']+/gi },
  {
    category: "local_path",
    pattern: /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"']+/g,
  },
];
export function scanText(text: string): Finding[] {
  return detectors
    .flatMap((d) =>
      Array.from(text.matchAll(new RegExp(d.pattern)))
        .filter((m) => !d.accept || d.accept(m[0]))
        .map((m) => ({
          category: d.category,
          start: m.index!,
          end: m.index! + m[0].length,
          action: d.block ? ("BLOCK_UPLOAD" as const) : ("REDACT" as const),
        })),
    )
    .sort((a, b) => a.start - b.start);
}
function replaceSpans(
  text: string,
  findings: Finding[],
  label: (f: Finding) => string,
): string {
  let out = "",
    cursor = 0;
  for (const f of findings) {
    if (f.end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, f.start)) + label(f);
    cursor = f.end;
  }
  return out + text.slice(cursor);
}
export function sanitizeText(text: string): {
  text: string;
  findings: Finding[];
} {
  const findings = scanText(text);
  return {
    text: replaceSpans(text, findings, (f) => `[REDACTED:${f.category}]`),
    findings,
  };
}
/** Replace only credential-like (BLOCK_UPLOAD) spans, keeping the rest. */
export function redactSecrets(
  text: string,
  placeholder = "[Sensitive text omitted]",
): string {
  const secrets = scanText(text).filter((f) => f.action === "BLOCK_UPLOAD");
  return secrets.length ? replaceSpans(text, secrets, () => placeholder) : text;
}
