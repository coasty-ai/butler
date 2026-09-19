/**
 * Text normalization for the on-device Kokoro voice. Turns times, money,
 * percents, ordinals, years, units, abbreviations, links, emails and file
 * names into plain words the lexicon G2P can read, then splits the result
 * into sentences so the first one can be synthesized first.
 *
 * Pure: no I/O, no Electron, no onnxruntime. Ported from this project's
 * Kokoro spike (kokoro-onnx-node/src/normalize.mjs).
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const SCALES: ReadonlyArray<readonly [number, string]> = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

/** 1234 -> "one thousand two hundred thirty-four". */
export function cardinal(value: number): string {
  if (!Number.isFinite(value)) return "";
  const n = Math.floor(Math.abs(value));
  if (value < 0 && n > 0) return `minus ${cardinal(n)}`;
  if (n < 20) return ONES[n];
  if (n < 100)
    return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000)
    return (
      `${ONES[Math.floor(n / 100)]} hundred` +
      (n % 100 ? ` ${cardinal(n % 100)}` : "")
    );
  for (const [scale, name] of SCALES) {
    if (n >= scale)
      return (
        `${cardinal(Math.floor(n / scale))} ${name}` +
        (n % scale ? ` ${cardinal(n % scale)}` : "")
      );
  }
  return String(n);
}

const ORDINAL_IRREGULAR: Readonly<Record<string, string>> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** 21 -> "twenty-first". */
export function ordinal(value: number): string {
  const words = cardinal(value);
  const match = words.match(/^(.*?)([a-z]+)$/);
  if (!match) return words;
  const [, head, last] = match;
  const word =
    ORDINAL_IRREGULAR[last] ??
    (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return head + word;
}

/** 2026 -> "twenty twenty-six", 1905 -> "nineteen oh five". */
export function year(value: number): string {
  const n = Math.floor(value);
  if (n >= 2000 && n < 2010)
    return n === 2000 ? "two thousand" : `two thousand ${ONES[n % 10]}`;
  if (n % 1000 === 0) return cardinal(n);
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) return `${cardinal(high)} hundred`;
  if (low < 10) return `${cardinal(high)} oh ${ONES[low]}`;
  return `${cardinal(high)} ${cardinal(low)}`;
}

const digits = (value: string) =>
  [...value].map((d) => ONES[Number(d)]).join(" ");

const MONTHS: Readonly<Record<string, string>> = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Sept: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
};

const ABBREVIATIONS: ReadonlyArray<
  readonly [RegExp, string | ((match: string, ...groups: string[]) => string)]
> = [
  [/\bDr\.(?=\s+[A-Z])/g, "Doctor"],
  [/\bMr\./g, "Mister"],
  [/\bMrs\./g, "Missus"],
  [/\bMs\./g, "Miz"],
  [/\bProf\./g, "Professor"],
  [/\bJr\./g, "Junior"],
  [/\bSr\./g, "Senior"],
  [/\bSt\.(?=\s+[A-Z])/g, "Saint"],
  [/\bSt\./g, "Street"],
  [/\bAve\./g, "Avenue"],
  [/\bRd\./g, "Road"],
  [/\bMt\./g, "Mount"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\betc\.(?=\s*$)/gi, "et cetera."],
  [/\betc\./gi, "et cetera"],
  [/\be\.g\.(?=[\s,])/gi, "for example"],
  [/\bi\.e\.(?=[\s,])/gi, "that is"],
  [/\bapprox\./gi, "approximately"],
  [/\bNo\.(?=\s*\d)/g, "number"],
  [
    /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.(?=\s*\d)/g,
    (_match, month) => MONTHS[month],
  ],
  // "a.m." that ends a sentence keeps its period.
  [/(?<=\d\s?)(?:a\.m\.|A\.M\.)(?=\s*$|\s+[A-Z])/g, "AM."],
  [/(?<=\d\s?)(?:p\.m\.|P\.M\.)(?=\s*$|\s+[A-Z])/g, "PM."],
  [/(?<=\d\s?)(?:a\.m\.|am|AM|A\.M\.)(?=[\s.,!?;:)]|$)/g, "AM"],
  [/(?<=\d\s?)(?:p\.m\.|pm|PM|P\.M\.)(?=[\s.,!?;:)]|$)/g, "PM"],
];

const UNITS: Readonly<Record<string, readonly [string, string]>> = {
  KB: ["kilobyte", "kilobytes"],
  MB: ["megabyte", "megabytes"],
  GB: ["gigabyte", "gigabytes"],
  TB: ["terabyte", "terabytes"],
  kb: ["kilobyte", "kilobytes"],
  mb: ["megabyte", "megabytes"],
  gb: ["gigabyte", "gigabytes"],
  km: ["kilometer", "kilometers"],
  kg: ["kilogram", "kilograms"],
  mph: ["mile per hour", "miles per hour"],
  min: ["minute", "minutes"],
  mins: ["minute", "minutes"],
  sec: ["second", "seconds"],
  secs: ["second", "seconds"],
  hr: ["hour", "hours"],
  hrs: ["hour", "hours"],
  ms: ["millisecond", "milliseconds"],
  "°F": ["degree Fahrenheit", "degrees Fahrenheit"],
  "°C": ["degree Celsius", "degrees Celsius"],
};
const TLDS = "com|org|net|io|ai|dev|app|edu|gov|co|uk|us|me|tv";
const EXTENSIONS: Readonly<Record<string, string>> = {
  pdf: "P D F",
  doc: "doc",
  docx: "doc X",
  xls: "X L S",
  xlsx: "X L S X",
  ppt: "P P T",
  pptx: "P P T X",
  txt: "text",
  csv: "C S V",
  png: "P N G",
  jpg: "J peg",
  jpeg: "J peg",
  gif: "gif",
  zip: "zip",
  md: "markdown",
  json: "Jason",
  mp3: "M P three",
  mp4: "M P four",
  mov: "M O V",
  key: "keynote",
  pages: "pages",
};
const CURRENCIES: Readonly<
  Record<string, readonly [string, string, string, string]>
> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
  "€": ["euro", "euros", "cent", "cents"],
};
const SCALE_WORDS: Readonly<Record<string, string>> = {
  thousand: "thousand",
  k: "thousand",
  K: "thousand",
  million: "million",
  M: "million",
  billion: "billion",
  B: "billion",
  bn: "billion",
  trillion: "trillion",
};
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

const spokenDots = (value: string) => value.replace(/\./g, " dot ");

/** Reads a link as its host: "https://www.youtube.com/watch?v=1" -> "youtube dot com". */
function spokenHost(link: string): string {
  const trail = link.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  const bare = trail ? link.slice(0, -trail.length) : link;
  let host = "";
  try {
    host = new URL(/^https?:\/\//i.test(bare) ? bare : `http://${bare}`)
      .hostname;
  } catch {}
  host = host.replace(/^www\./i, "");
  return (host ? spokenDots(host) : "a link") + trail;
}

function decimalWords(whole: string, fraction: string): string {
  return `${cardinal(Number(whole))} point ${digits(fraction)}`;
}

function moneyWords(symbol: string, whole: string, fraction?: string): string {
  const [one, many, centOne, centMany] = CURRENCIES[symbol];
  const units = Number(whole.replace(/,/g, ""));
  const cents = fraction ? Number(fraction.padEnd(2, "0")) : 0;
  const parts: string[] = [];
  if (units || !cents)
    parts.push(`${cardinal(units)} ${units === 1 ? one : many}`);
  if (cents)
    parts.push(`${cardinal(cents)} ${cents === 1 ? centOne : centMany}`);
  return parts.join(" and ");
}

/** Normalizes one reply for speech. Idempotent on already-normalized text. */
export function normalizeText(input: string): string {
  let t = String(input ?? "")
    .normalize("NFKC")
    // Fold accents so "café" reads as "cafe" instead of dropping the letter.
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\.{3,}/g, "…")
    .replace(/\s+[-–]\s+/g, " — ");

  // Links are read as their host only; paths and queries are never spoken.
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s"']+/gi, spokenHost);
  t = t.replace(
    /\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g,
    (_m, user: string, host: string) =>
      `${user.replace(/\./g, " dot ").replace(/_/g, " underscore ")} at ${spokenDots(host)}`,
  );
  // Markdown and code punctuation is never read aloud.
  t = t.replace(/[_*`~^|<>{}[\]\\]+/g, " ");
  for (const [pattern, replacement] of ABBREVIATIONS)
    t = t.replace(pattern, replacement as string);
  t = t.replace(
    new RegExp(
      `\\b((?:[a-z0-9-]+\\.)+(?:${TLDS}))\\b(?:\\/[^\\s]*[^\\s.,;:!?)])?`,
      "gi",
    ),
    (_m, host: string) => spokenDots(host.replace(/^www\./i, "")),
  );
  t = t.replace(/\b([\w-]+)\.([A-Za-z0-9]{2,5})\b/g, (match, base, ext) => {
    const spoken = EXTENSIONS[String(ext).toLowerCase()];
    return spoken ? `${base} dot ${spoken}` : match;
  });

  // Times: 3:30 PM, 15:05, 9:00 AM.
  t = t.replace(
    /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*(AM|PM))?(?=\W|$)/g,
    (_m, h: string, mm: string, meridiem?: string) => {
      const hour = cardinal(Number(h));
      const minute = Number(mm);
      const words =
        minute === 0
          ? meridiem
            ? hour
            : `${hour} o'clock`
          : minute < 10
            ? `${hour} oh ${ONES[minute]}`
            : `${hour} ${cardinal(minute)}`;
      return meridiem ? `${words} ${meridiem}` : words;
    },
  );
  t = t.replace(
    /\b(\d{1,2})\s*(AM|PM)\b/g,
    (_m, h: string, meridiem: string) => `${cardinal(Number(h))} ${meridiem}`,
  );

  // Money: "$1.5 million", "$12.50", "£3", "€0.99".
  t = t.replace(
    /([$£€])(\d+)(?:\.(\d+))?\s?(thousand|million|billion|trillion|bn|[kKMB])\b/g,
    (_m, symbol: string, whole: string, fraction: string | undefined, scale) =>
      `${fraction ? decimalWords(whole, fraction) : cardinal(Number(whole))} ${SCALE_WORDS[scale]} ${CURRENCIES[symbol][1]}`,
  );
  t = t.replace(
    /([$£€])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g,
    (_m, symbol: string, whole: string, fraction?: string) =>
      moneyWords(symbol, whole, fraction),
  );
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, (_m, n: string) => `${n} percent`);
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n: string) =>
    ordinal(Number(n)),
  );
  t = t.replace(
    /(\d+(?:\.\d+)?)\s?(KB|MB|GB|TB|kb|mb|gb|km|kg|mph|mins?|secs?|hrs?|ms|°F|°C)\b/g,
    (_m, n: string, unit: string) =>
      `${n} ${UNITS[unit][Number(n) === 1 ? 0 : 1]}`,
  );
  t = t.replace(/(\d)\s?°(?![FC])/g, "$1 degrees");
  // Numeric ranges with an en dash, and negative numbers.
  t = t.replace(/(\d)\s?–\s?(\d)/g, "$1 to $2");
  t = t.replace(/(^|[\s(])[-−](\d)/g, "$1minus $2");
  // Letters glued to digits ("M2", "iPhone15") are read as separate words.
  t = t.replace(/(\p{L})(?=\d)/gu, "$1 ").replace(/(\d)(?=\p{L})/gu, "$1 ");
  // Versions (1.2.3), then decimals.
  t = t.replace(/\b\d+(?:\.\d+){2,}\b/g, (m) =>
    m
      .split(".")
      .map((part) => cardinal(Number(part)))
      .join(" point "),
  );
  t = t.replace(/\b(\d+)\.(\d+)\b/g, (_m, a: string, b: string) =>
    decimalWords(a, b),
  );
  // Years: standalone 1100-2099.
  t = t.replace(/(?<![\d.]|\d,)\b(1[1-9]\d\d|20\d\d)\b(?![\d]|[,.]\d)/g, (m) =>
    year(Number(m)),
  );
  // Grouped and plain integers; codes and long runs read digit by digit.
  t = t.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) =>
    cardinal(Number(m.replace(/,/g, ""))),
  );
  t = t.replace(/\b\d+\b/g, (m) =>
    m.length > 9 || (m.length > 1 && m[0] === "0")
      ? digits(m)
      : cardinal(Number(m)),
  );

  t = t
    .replace(/\s?&\s?/g, " and ")
    .replace(/\s\+\s/g, " plus ")
    .replace(/\s=\s/g, " equals ")
    .replace(/#(?=\w)/g, "number ")
    .replace(/(\w)\/(\w)/g, "$1 slash $2")
    .replace(/@/g, " at ");
  return t
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

const INITIALISM_END = /(?:^|[\s(])(?:[A-Za-z]\.){2,}$/;

/**
 * Splits normalized text into sentences (on . ! ? … and line breaks) so the
 * first one can be synthesized and played first. Fragments without letters
 * or digits are merged into the previous sentence.
 */
export function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split(/\n+/)) {
    const boundary = /[.!?…]+["”’)\]]*(?=\s+)/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(line))) {
      const end = match.index + match[0].length;
      if (INITIALISM_END.test(line.slice(start, end))) continue;
      pieces.push(line.slice(start, end));
      start = end;
    }
    pieces.push(line.slice(start));
  }
  const sentences: string[] = [];
  for (const raw of pieces) {
    const piece = raw.trim();
    if (!piece) continue;
    if (!/[\p{L}\p{N}]/u.test(piece) && sentences.length)
      sentences[sentences.length - 1] += ` ${piece}`;
    else sentences.push(piece);
  }
  return sentences.filter((s) => /[\p{L}\p{N}]/u.test(s));
}
