/**
 * English grapheme-to-phoneme conversion for Kokoro v1.0 without any GPL code.
 *
 * A TypeScript port of the lexicon half of hexgrad/misaki `en.py` (Apache-2.0):
 * capitalization stress, -s/-ed/-ing stemming, camelCase subtokens and the
 * a/an/the/to/in/I/am/used special cases. There is no spaCy tagger, so
 * homographs use the dictionary DEFAULT. Words the lexicon cannot read go to
 * an injected fallback (misaki's own BART network, see ./bart.ts).
 *
 * Only misaki's us_gold dictionary is used. us_silver was generated with
 * espeak-ng (misaki issue #51), a licensing gray area, and gold-only coverage
 * matched gold+silver on the spike's test sentences.
 *
 * Pure: the caller passes the parsed dictionary; no I/O happens here.
 */
import { normalizeText } from "./normalize";

export type LexiconEntry = string | { readonly [tag: string]: string | null };
export type Lexicon = Readonly<Record<string, LexiconEntry>>;
/** Returns misaki-style phonemes for an unknown word, or null. */
export type G2PFallback = (word: string) => string | null | undefined;
export type WordSource = "lexicon" | "fallback" | "spelled" | "unknown";

export interface G2POptions {
  /** misaki us_gold.json, parsed. */
  gold: Lexicon;
  /** Extra entries that win over the dictionary. Defaults to {@link OVERRIDES}. */
  overrides?: Readonly<Record<string, string>>;
  fallback?: G2PFallback;
}

export interface G2PWord {
  text: string;
  phonemes: string;
  source: WordSource;
}

export interface G2PResult {
  normalized: string;
  phonemes: string;
  words: G2PWord[];
}

/**
 * Product and app names the assistant says often, in misaki US phonemes
 * (before the Kokoro v1.0 flap rewrite). "Open Assist" itself is never spoken,
 * but "Assist" is pinned so it can never be spelled out.
 */
export const OVERRIDES: Readonly<Record<string, string>> = {
  YouTube: "jˈutˌub",
  Xcode: "ˈɛkskˌOd",
  Safari: "səfˈɑɹi",
  Chrome: "kɹˈOm",
  WhatsApp: "wˈʌtsˌæp",
  Spotify: "spˈɑɾəfˌI",
  Slack: "slˈæk",
  Notion: "nˈOʃən",
  GitHub: "ɡˈɪthˌʌb",
  ChatGPT: "ʧˈæt ʤˌipˌitˈi",
  macOS: "mˌæk ˌOˈɛs",
  iPhone: "ˈIfˌOn",
  iPad: "ˈIpˌæd",
  iCloud: "ˈIklˌWd",
  FaceTime: "fˈAstˌIm",
  Gmail: "ʤˈimˌAl",
  Figma: "fˈɪɡmə",
  Assist: "əsˈɪst",
  // Without a POS tagger misaki picks the adjective ("klohs"); an assistant
  // that drives apps nearly always means the verb (close, closed, closing).
  close: "klˈOz",
};

const PRIMARY = "ˈ";
const SECONDARY = "ˌ";
const STRESSES = "ˌˈ";
const VOWELS = new Set("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ");
const CONSONANTS = new Set("bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ");
const DIPHTHONGS = new Set("AIOQWYʤʧ");
const NON_QUOTE_PUNCTUATION = new Set(";:,.!?—…");
const SUBTOKEN_JUNK = new Set("',-._‘’/");
const US_TAUS = new Set("AIOWYiuæɑəɛɪɹʊʌ");
const SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["%", "percent"],
  ["&", "and"],
  ["+", "plus"],
  ["@", "at"],
]);
/** misaki's US phoneme inventory (plus ɐ); every override must stay inside it. */
export const US_PHONEMES = new Set(
  "AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔɐ",
);
// misaki subtokenizer: WhatsApp -> Whats|App, ChatGPT -> Chat|GPT.
const SUBTOKEN =
  /^['‘’]+|\p{Lu}(?=\p{Lu}\p{Ll})|(?:^-)?(?:\d?[,.]?\d)+|[-_]+|['‘’]{2,}|\p{L}*?(?:['‘’]\p{L})*?\p{Ll}(?=\p{Lu})|\p{L}+(?:['‘’]\p{L})*|[^-_\p{L}'‘’\d]|['‘’]+$/gu;
const ALPHA = /^[A-Za-z]+$/;
const FALLBACK_CACHE = 256;

type Found = readonly [string | null, number | null];
const NONE: Found = [null, null];

interface Context {
  /** null: a pause follows; true/false: the next word starts with a vowel. */
  futureVowel: boolean | null;
  futureTo: boolean;
  nextIsWord: boolean;
}

export function applyStress(
  ps: string | null,
  stress: number | null,
): string | null {
  if (ps == null || stress == null) return ps;
  const restress = (value: string) => {
    const chars = [...value];
    const placed = chars.map((char, i): [number, string] => {
      if (!STRESSES.includes(char)) return [i, char];
      const vowel = chars.findIndex((c, j) => j >= i && VOWELS.has(c));
      return [vowel < 0 ? i : vowel - 0.5, char];
    });
    return placed
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .map(([, char]) => char)
      .join("");
  };
  const stressed = [...STRESSES].some((s) => ps.includes(s));
  const voiced = [...ps].some((c) => VOWELS.has(c));
  if (stress < -1) return ps.replaceAll(PRIMARY, "").replaceAll(SECONDARY, "");
  if (
    stress === -1 ||
    ((stress === 0 || stress === -0.5) && ps.includes(PRIMARY))
  )
    return ps.replaceAll(SECONDARY, "").replaceAll(PRIMARY, SECONDARY);
  if ((stress === 0 || stress === 0.5 || stress === 1) && !stressed)
    return voiced ? restress(SECONDARY + ps) : ps;
  if (stress >= 1 && !ps.includes(PRIMARY) && ps.includes(SECONDARY))
    return ps.replaceAll(SECONDARY, PRIMARY);
  if (stress > 1 && !stressed) return voiced ? restress(PRIMARY + ps) : ps;
  return ps;
}

const capitalize = (word: string) =>
  word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** misaki Lexicon.grow_dictionary: adds Capitalized and lowercase twins. */
export function growDictionary(lexicon: Lexicon): Map<string, LexiconEntry> {
  const grown = new Map<string, LexiconEntry>();
  for (const [key, value] of Object.entries(lexicon)) {
    if (key.length < 2) continue;
    if (key === key.toLowerCase()) {
      if (key !== capitalize(key)) grown.set(capitalize(key), value);
    } else if (key === capitalize(key)) grown.set(key.toLowerCase(), value);
  }
  for (const [key, value] of Object.entries(lexicon)) grown.set(key, value);
  return grown;
}

const stressWeight = (ps: string) =>
  [...ps].reduce((sum, c) => sum + (DIPHTHONGS.has(c) ? 2 : 1), 0);

function firstSound(ps: string, fallback: boolean | null): boolean | null {
  for (const c of ps) {
    if (NON_QUOTE_PUNCTUATION.has(c)) return null;
    if (VOWELS.has(c)) return true;
    if (CONSONANTS.has(c)) return false;
  }
  return fallback;
}

interface Token {
  text: string;
  kind: "word" | "punct";
  space: string;
  phonemes: string;
}

export class KokoroG2P {
  private readonly gold: Map<string, LexiconEntry>;
  private readonly fallback?: G2PFallback;
  private readonly cache = new Map<string, string | null>();

  constructor(options: G2POptions) {
    this.gold = growDictionary(options.gold);
    for (const [word, ps] of Object.entries(options.overrides ?? OVERRIDES)) {
      this.gold.set(word, ps);
      this.gold.set(word.toLowerCase(), ps);
    }
    this.fallback = options.fallback;
  }

  /** Normalizes (unless told not to) and converts text to Kokoro phonemes. */
  phonemize(text: string, options: { normalize?: boolean } = {}): G2PResult {
    const normalized =
      options.normalize === false ? String(text ?? "") : normalizeText(text);
    const tokens: Token[] = [];
    const pattern =
      /((?:[A-Za-z]\.){2,}|[A-Za-z][A-Za-z']*(?:-[A-Za-z']+)*)|([;:,.!?—…"“”()])|(\s+)|(.)/gsu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized))) {
      const last = tokens[tokens.length - 1];
      if (match[1])
        tokens.push({ text: match[1], kind: "word", space: "", phonemes: "" });
      else if (match[2])
        tokens.push({ text: match[2], kind: "punct", space: "", phonemes: "" });
      else if (last) last.space = " "; // whitespace or an unreadable symbol
    }

    const words: G2PWord[] = [];
    let futureVowel: boolean | null = null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i];
      if (token.kind === "punct") {
        token.phonemes = token.text;
        if (NON_QUOTE_PUNCTUATION.has(token.text)) futureVowel = null;
        continue;
      }
      const next = tokens[i + 1];
      const ctx: Context = {
        futureVowel,
        futureTo: next?.kind === "word" && /^to$/i.test(next.text),
        nextIsWord: next?.kind === "word",
      };
      const resolved = this.word(token.text, ctx);
      token.phonemes = resolved.map((w) => w.phonemes).join(" ");
      words.unshift(...resolved);
      futureVowel = firstSound(token.phonemes, futureVowel);
    }
    const phonemes = tokens
      .map((t) => t.phonemes + t.space)
      .join("")
      .replace(/ {2,}/g, " ")
      .trim()
      // Kokoro v1.0 (misaki version != 2.0): flap -> T, glottal stop -> t.
      .replaceAll("ɾ", "T")
      .replaceAll("ʔ", "t");
    return { normalized, phonemes, words };
  }

  /** One orthographic word: whole word, hyphen parts, subtokens, fallback. */
  private word(text: string, ctx: Context): G2PWord[] {
    const whole = this.getWord(text, ctx)[0];
    if (whole != null) return [{ text, phonemes: whole, source: "lexicon" }];
    const parts = text.split("-").filter(Boolean);
    if (parts.length > 1) {
      const out: G2PWord[] = [];
      let next = ctx;
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = this.word(parts[i], next);
        out.unshift(...part);
        next = {
          futureVowel: firstSound(
            part.map((w) => w.phonemes).join(""),
            next.futureVowel,
          ),
          futureTo: false,
          nextIsWord: true,
        };
      }
      return out;
    }
    const subtokens = this.subtokens(text, ctx);
    if (subtokens != null)
      return [{ text, phonemes: subtokens, source: "lexicon" }];
    const guess = this.guess(text);
    if (guess) return [{ text, phonemes: guess, source: "fallback" }];
    const spelled = this.nnp(text.replace(/[^A-Za-z]/g, ""))[0];
    if (spelled) return [{ text, phonemes: spelled, source: "spelled" }];
    return [{ text, phonemes: "", source: "unknown" }];
  }

  private guess(word: string): string | null {
    if (!this.fallback) return null;
    if (this.cache.has(word)) return this.cache.get(word) ?? null;
    let ps: string | null = null;
    try {
      ps = this.fallback(word) || this.fallback(word.toLowerCase()) || null;
    } catch {
      ps = null;
    }
    if (this.cache.size >= FALLBACK_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(word, ps);
    return ps;
  }

  /** misaki G2P.__call__ list branch: greedy longest-suffix subtoken merging. */
  private subtokens(word: string, ctx: Context): string | null {
    const subs = word.match(SUBTOKEN) ?? [];
    if (subs.length < 2) return null;
    const ps: Array<string | null> = subs.map(() => null);
    let left = 0;
    let right = subs.length;
    let context = ctx;
    while (left < right) {
      const found = this.getWord(subs.slice(left, right).join(""), context)[0];
      if (found != null) {
        ps[left] = found;
        for (let k = left + 1; k < right; k++) ps[k] = "";
        context = {
          ...context,
          futureVowel: firstSound(found, context.futureVowel),
        };
        right = left;
        left = 0;
      } else if (left + 1 < right) {
        left++;
      } else {
        right--;
        if ([...subs[right]].every((c) => SUBTOKEN_JUNK.has(c))) ps[right] = "";
        else return null;
        left = 0;
      }
    }
    return resolveSubtokens(
      subs,
      ps.map((p) => p ?? ""),
    );
  }

  private nnp(word: string): Found {
    const letters = [...word].filter((c) => /[A-Za-z]/.test(c));
    if (!letters.length) return NONE;
    const parts = letters.map((c) => this.gold.get(c.toUpperCase()));
    if (parts.some((p) => typeof p !== "string")) return NONE;
    const ps = applyStress(parts.join(""), 0) ?? "";
    const at = ps.lastIndexOf(SECONDARY);
    return [at < 0 ? ps : ps.slice(0, at) + PRIMARY + ps.slice(at + 1), 3];
  }

  private isKnown(word: string): boolean {
    if (this.gold.has(word) || SYMBOLS.has(word)) return true;
    if (!ALPHA.test(word)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && this.gold.has(word.toLowerCase()))
      return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  private lookup(
    word: string,
    stress: number | null,
    ctx: Context | null,
  ): Found {
    if (word === word.toUpperCase() && !this.gold.has(word))
      word = word.toLowerCase();
    let entry: LexiconEntry | null | undefined = this.gold.get(word);
    if (entry && typeof entry === "object")
      entry =
        ctx && ctx.futureVowel === null && "None" in entry
          ? entry.None
          : entry.DEFAULT;
    if (entry == null) return this.nnp(word);
    return [applyStress(entry, stress), 4];
  }

  private specialCase(
    word: string,
    stress: number | null,
    ctx: Context,
  ): Found {
    const symbol = SYMBOLS.get(word);
    if (symbol) return this.lookup(symbol, null, ctx);
    const inner = word.replace(/^\.+|\.+$/g, "");
    if (
      inner.includes(".") &&
      ALPHA.test(word.replaceAll(".", "")) &&
      Math.max(...word.split(".").map((s) => s.length)) < 3
    )
      return this.nnp(word);
    if (word === "a") return ["ɐ", 4];
    if (word === "A") return [ctx.nextIsWord ? "ɐ" : "ˈA", 4];
    if (word === "AM") return this.nnp(word);
    if (word === "am" || word === "Am") {
      const gold = this.gold.get("am");
      return [
        ctx.futureVowel === null || word !== "am" || (stress ?? 0) > 0
          ? typeof gold === "string"
            ? gold
            : "æm"
          : "ɐm",
        4,
      ];
    }
    if (word === "an" || word === "An") return ["ɐn", 4];
    if (word === "I") return [`${SECONDARY}I`, 4];
    if (word === "to" || word === "To") {
      const gold = this.gold.get("to");
      return [
        ctx.futureVowel === null
          ? typeof gold === "string"
            ? gold
            : "tu"
          : ctx.futureVowel
            ? "tʊ"
            : "tə",
        4,
      ];
    }
    if (word === "in" || word === "In")
      return [(ctx.futureVowel === null ? PRIMARY : "") + "ɪn", 4];
    if (word === "the" || word === "The")
      return [ctx.futureVowel === true ? "ði" : "ðə", 4];
    if (/^vs\.?$/i.test(word)) return this.lookup("versus", null, ctx);
    if (/^used$/i.test(word)) {
      const used = this.gold.get("used");
      if (used && typeof used === "object")
        return [(ctx.futureTo ? used.VBD : null) ?? used.DEFAULT, 4];
    }
    return NONE;
  }

  private ending(
    stem: string | null,
    suffix: "s" | "ed" | "ing",
  ): string | null {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if (suffix === "s") {
      if ("ptkfθ".includes(last)) return stem + "s";
      if ("szʃʒʧʤ".includes(last)) return stem + "ᵻz";
      return stem + "z";
    }
    if (suffix === "ed") {
      if ("pkfθʃsʧ".includes(last)) return stem + "t";
      if (last === "d") return stem + "ᵻd";
      if (last !== "t") return stem + "d";
      if (stem.length < 2) return stem + "ɪd";
      if (US_TAUS.has(stem[stem.length - 2])) return stem.slice(0, -1) + "ɾᵻd";
      return stem + "ᵻd";
    }
    if (stem.length > 1 && last === "t" && US_TAUS.has(stem[stem.length - 2]))
      return stem.slice(0, -1) + "ɾɪŋ";
    return stem + "ɪŋ";
  }

  private stemS(word: string, stress: number | null, ctx: Context): Found {
    if (word.length < 3 || !word.endsWith("s")) return NONE;
    let stem: string;
    if (!word.endsWith("ss") && this.isKnown(word.slice(0, -1)))
      stem = word.slice(0, -1);
    else if (
      (word.endsWith("'s") ||
        (word.length > 4 && word.endsWith("es") && !word.endsWith("ies"))) &&
      this.isKnown(word.slice(0, -2))
    )
      stem = word.slice(0, -2);
    else if (
      word.length > 4 &&
      word.endsWith("ies") &&
      this.isKnown(word.slice(0, -3) + "y")
    )
      stem = word.slice(0, -3) + "y";
    else return NONE;
    const [ps, rating] = this.lookup(stem, stress, ctx);
    return [this.ending(ps, "s"), rating];
  }

  private stemEd(word: string, stress: number | null, ctx: Context): Found {
    if (word.length < 4 || !word.endsWith("d")) return NONE;
    let stem: string;
    if (!word.endsWith("dd") && this.isKnown(word.slice(0, -1)))
      stem = word.slice(0, -1);
    else if (
      word.length > 4 &&
      word.endsWith("ed") &&
      !word.endsWith("eed") &&
      this.isKnown(word.slice(0, -2))
    )
      stem = word.slice(0, -2);
    else return NONE;
    const [ps, rating] = this.lookup(stem, stress, ctx);
    return [this.ending(ps, "ed"), rating];
  }

  private stemIng(word: string, stress: number | null, ctx: Context): Found {
    if (word.length < 5 || !word.endsWith("ing")) return NONE;
    let stem: string;
    if (word.length > 5 && this.isKnown(word.slice(0, -3)))
      stem = word.slice(0, -3);
    else if (this.isKnown(word.slice(0, -3) + "e"))
      stem = word.slice(0, -3) + "e";
    else if (
      word.length > 5 &&
      /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) &&
      this.isKnown(word.slice(0, -4))
    )
      stem = word.slice(0, -4);
    else return NONE;
    const [ps, rating] = this.lookup(stem, stress, ctx);
    return [this.ending(ps, "ing"), rating];
  }

  /** misaki Lexicon.get_word, called with the capitalization stress. */
  private getWord(word: string, ctx: Context): Found {
    const stress =
      word === word.toLowerCase()
        ? null
        : word === word.toUpperCase()
          ? 2
          : 0.5;
    const special = this.specialCase(word, stress, ctx);
    if (special[0] != null) return special;
    const lower = word.toLowerCase();
    if (
      word.length > 1 &&
      ALPHA.test(word.replaceAll("'", "")) &&
      word !== lower &&
      !this.gold.has(word) &&
      (word === word.toUpperCase() ||
        word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.gold.has(lower) ||
        this.stemS(lower, stress, ctx)[0] != null ||
        this.stemEd(lower, stress, ctx)[0] != null ||
        this.stemIng(lower, stress, ctx)[0] != null)
    )
      word = lower;
    if (this.isKnown(word)) return this.lookup(word, stress, ctx);
    if (word.endsWith("s'") && this.isKnown(word.slice(0, -2) + "'s"))
      return this.lookup(word.slice(0, -2) + "'s", stress, ctx);
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1)))
      return this.lookup(word.slice(0, -1), stress, ctx);
    for (const found of [
      this.stemS(word, stress, ctx),
      this.stemEd(word, stress, ctx),
    ])
      if (found[0] != null) return found;
    const ing = this.stemIng(word, stress ?? 0.5, ctx);
    return ing[0] != null ? ing : NONE;
  }
}

/** misaki G2P.resolve_tokens: joins subtokens and demotes competing stresses. */
function resolveSubtokens(texts: string[], ps: string[]): string {
  const joined = texts.join("");
  const classes = new Set(
    [...joined]
      .filter((c) => !SUBTOKEN_JUNK.has(c))
      .map((c) => (/\p{L}/u.test(c) ? 0 : /\d/.test(c) ? 1 : 2)),
  );
  const spaced = /[\s/]/.test(joined) || classes.size > 1;
  if (spaced) return ps.filter(Boolean).join(" ");
  const indices = ps
    .map((p, i) => [p.includes(PRIMARY) ? 1 : 0, stressWeight(p), i] as const)
    .filter(([, , i]) => ps[i]);
  if (indices.length === 2 && texts[indices[0][2]].length === 1) {
    const i = indices[1][2];
    ps[i] = applyStress(ps[i], -0.5) ?? ps[i];
  } else if (
    indices.length >= 2 &&
    indices.reduce((sum, [primary]) => sum + primary, 0) >
      Math.floor((indices.length + 1) / 2)
  ) {
    const demote = [...indices]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
      .slice(0, Math.floor(indices.length / 2));
    for (const [, , i] of demote) ps[i] = applyStress(ps[i], -0.5) ?? ps[i];
  }
  return ps.join("");
}
