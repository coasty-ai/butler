export interface Finding {
  category: string;
  start: number;
  end: number;
  action: "REDACT" | "BLOCK_UPLOAD";
}
const detectors: { category: string; pattern: RegExp; block?: boolean }[] = [
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
    category: "token",
    pattern: /\b(?:Bearer\s+[\w.\-~+/]+=*|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gi,
    block: true,
  },
  {
    category: "secret_assignment",
    pattern:
      /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|mfa|otp)\s*[:=]\s*[^\s,;]+/gi,
    block: true,
  },
  { category: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    category: "phone_or_account",
    pattern: /(?<!\w)\+?\d[\d ()-]{7,}\d(?!\w)/g,
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
      Array.from(text.matchAll(new RegExp(d.pattern))).map((m) => ({
        category: d.category,
        start: m.index!,
        end: m.index! + m[0].length,
        action: d.block ? ("BLOCK_UPLOAD" as const) : ("REDACT" as const),
      })),
    )
    .sort((a, b) => a.start - b.start);
}
export function sanitizeText(text: string): {
  text: string;
  findings: Finding[];
} {
  const findings = scanText(text);
  let out = "",
    cursor = 0;
  for (const f of findings) {
    if (f.end <= cursor) continue;
    out +=
      text.slice(cursor, Math.max(cursor, f.start)) +
      `[REDACTED:${f.category}]`;
    cursor = f.end;
  }
  return { text: out + text.slice(cursor), findings };
}
