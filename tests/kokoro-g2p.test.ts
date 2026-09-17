import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { trimSilence, toInt16 } from "../src/voice/kokoro/audio";
import { BartG2P, parseSafetensors } from "../src/voice/kokoro/bart";
import {
  KokoroG2P,
  OVERRIDES,
  US_PHONEMES,
  applyStress,
  type Lexicon,
} from "../src/voice/kokoro/g2p";
import {
  cardinal,
  normalizeText,
  ordinal,
  splitSentences,
  year,
} from "../src/voice/kokoro/normalize";
import {
  KOKORO_MAX_TOKENS,
  KOKORO_STYLE_DIM,
  inputIds,
  parseTokenizerVocab,
  splitPhonemes,
  styleFor,
  styleOffset,
  tokenize,
} from "../src/voice/kokoro/tokens";

const fixtures = fileURLToPath(new URL("./fixtures/kokoro/", import.meta.url));
/** The misaki us_gold entries these sentences touch (Apache-2.0, rev fba1236). */
const gold: Lexicon = JSON.parse(
  readFileSync(join(fixtures, "us_gold_subset.json"), "utf8"),
);
const vocab = parseTokenizerVocab(
  readFileSync(join(fixtures, "tokenizer.json"), "utf8"),
);
/** Stands in for the BART network on the few names outside the lexicon. */
const names: Record<string, string> = {
  Nitish: "nˈIɾɪʃ",
  Patel: "pˈæɾᵊl",
  Kovuru: "kˈOvəɹˌu",
};
const stub = (word: string) => names[word] ?? null;

describe("Kokoro normalization", () => {
  it.each([
    ["Meet at 3:30 PM.", "Meet at three thirty PM."],
    ["It starts at 9am.", "It starts at nine AM."],
    ["Leave at 15:05", "Leave at fifteen oh five"],
    ["Wake me at 7:00", "Wake me at seven o'clock"],
    ["Call at 10 a.m.", "Call at ten AM."],
    [
      "The call is at 9 p.m. Tomorrow works too.",
      "The call is at nine PM. Tomorrow works too.",
    ],
  ])("reads times: %s", (input, spoken) => {
    expect(normalizeText(input)).toBe(spoken);
  });

  it.each([
    ["It costs $12.50.", "It costs twelve dollars and fifty cents."],
    ["That's $1.", "That's one dollar."],
    ["Only $0.99 today", "Only ninety-nine cents today"],
    ["Raised $1.5 million", "Raised one point five million dollars"],
    ["Pay $1,200 now", "Pay one thousand two hundred dollars now"],
    [
      "About £3.50 or €20",
      "About three pounds and fifty pence or twenty euros",
    ],
  ])("reads money: %s", (input, spoken) => {
    expect(normalizeText(input)).toBe(spoken);
  });

  it.each([
    ["Battery at 45%", "Battery at forty-five percent"],
    ["Up 4.5% today", "Up four point five percent today"],
    ["100% done", "one hundred percent done"],
  ])("reads percents: %s", (input, spoken) => {
    expect(normalizeText(input)).toBe(spoken);
  });

  it("reads ordinals, years, units and digit runs", () => {
    expect(
      normalizeText("The 1st, 2nd, 3rd, 4th, 11th, 12th, 21st and 112th."),
    ).toBe(
      "The first, second, third, fourth, eleventh, twelfth, twenty-first and one hundred twelfth.",
    );
    expect(normalizeText("In 2026, 1999 and 2005.")).toBe(
      "In twenty twenty-six, nineteen ninety-nine and two thousand five.",
    );
    expect(normalizeText("It is 62°F and 1 min away.")).toBe(
      "It is sixty-two degrees Fahrenheit and one minute away.",
    );
    expect(normalizeText("Code 0123, M2, version 1.2.3.")).toBe(
      "Code zero one two three, M two, version one point two point three.",
    );
    expect(ordinal(22)).toBe("twenty-second");
    expect(cardinal(-1_000_005)).toBe("minus one million five");
    expect(year(1905)).toBe("nineteen oh five");
  });

  it("expands abbreviations", () => {
    expect(
      normalizeText(
        "Dr. Smith and Mr. Jones live on Main St. near St. Mark's, e.g. downtown, etc.",
      ),
    ).toBe(
      "Doctor Smith and Mister Jones live on Main Street near Saint Mark's, for example downtown, et cetera.",
    );
    expect(normalizeText("Apples vs. oranges, approx. 5 min away.")).toBe(
      "Apples versus oranges, approximately five minutes away.",
    );
  });

  it("reduces links to their host and never reads paths or queries", () => {
    expect(
      normalizeText("Open https://www.youtube.com/watch?v=abc123 now."),
    ).toBe("Open youtube dot com now.");
    expect(
      normalizeText("See www.apple.com/iphone/ and github.com/openai/foo."),
    ).toBe("See apple dot com and github dot com.");
    expect(normalizeText("Mail john_doe@example.co.uk")).toBe(
      "Mail john underscore doe at example dot co dot uk",
    );
    expect(normalizeText("Saved report.pdf")).toBe("Saved report dot P D F");
  });

  it("strips markup and folds accents", () => {
    expect(normalizeText("**Bold** and `code`")).toBe("Bold and code");
    expect(normalizeText("Café naïve")).toBe("Cafe naive");
  });

  it("splits sentences without breaking initialisms", () => {
    expect(
      splitSentences(
        normalizeText("Done. Your YouTube video is playing on loop."),
      ),
    ).toEqual(["Done.", "Your YouTube video is playing on loop."]);
    expect(splitSentences("The U.S. team won. Next!\nThanks")).toEqual([
      "The U.S. team won.",
      "Next!",
      "Thanks",
    ]);
    expect(splitSentences("Hi. ... Bye.")).toEqual(["Hi. ...", "Bye."]);
    expect(splitSentences(" … ")).toEqual([]);
  });
});

describe("Kokoro G2P (misaki us_gold port)", () => {
  const g2p = new KokoroG2P({ gold, fallback: stub });

  // Phonemes the spike produced for its four benchmark sentences (0 ASR errors).
  it.each([
    ["Sure, opening Calculator.", "ʃˈʊɹ, ˈOpᵊnɪŋ kˈælkjəlˌATəɹ."],
    [
      "I found three files named budget. Which one should I open?",
      "ˌI fˈWnd θɹˈi fˈIlz nˈAmd bˈʌʤət. wˌɪʧ wˈʌn ʃˌʊd ˌI ˈOpᵊn?",
    ],
    [
      "Should I send the email to Alex Johnson at 3:30 PM?",
      "ʃˌʊd ˌI sˈɛnd ði ˈimˌAl tʊ ˈælɪks ʤˈɑnsᵊn æt θɹˈi θˈɜɹTi pˌiˈɛm?",
    ],
    [
      "Done. Your YouTube video is playing on loop.",
      "dˈʌn. jˌʊɹ jˈutˌub vˈɪdiO ɪz plˈAɪŋ ˌɔn lˈup.",
    ],
    [
      "Your meeting with Dr. Patel starts at 10:15 AM on March 3rd.",
      "jˌʊɹ mˈiTɪŋ wɪð dˈɑktəɹ pˈæTᵊl stˈɑɹts æt tˈɛn fˌɪftˈin ˌAˈɛm ˌɔn mˈɑɹʧ θˈɜɹd.",
    ],
    [
      "I found 12 results, and 3 of them are PDFs.",
      "ˌI fˈWnd twˈɛlv ɹəzˈʌlts, ænd θɹˈi ʌv ðˌɛm ɑɹ pˌidˌiˈɛfs.",
    ],
    [
      "The file budget-2026.xlsx is 4.5 MB, and it costs $19.99 to upgrade.",
      "ðə fˈIl bˈʌʤət twˈɛnti twˈɛnti sˈɪks dˈɑt ˈɛks ˈɛl ˈɛs ˈɛks ɪz fˈɔɹ pˈYnt fˈIv mˈɛɡəbˌIts, ænd ɪt kˈɔsts nˌIntˈin dˈɑləɹz ænd nˈIndi nˈIn sˈɛnts tʊ ˈʌpɡɹˌAd.",
    ],
  ])("matches the spike: %s", (text, phonemes) => {
    expect(g2p.phonemize(text).phonemes).toBe(phonemes);
  });

  it("applies the a/an/the/to/used context rules and dotted initialisms", () => {
    expect(
      g2p.phonemize(
        "I used to live in the city. The apple is on the table, an hour ago.",
      ).phonemes,
    ).toBe(
      "ˌI jˈust tə lˈIv ɪn ðə sˈɪTi. ði ˈæpᵊl ɪz ˌɔn ðə tˈAbᵊl, ɐn ˈWəɹ əɡˈO.",
    );
    expect(g2p.phonemize("The U.S. team won, and it's done.").phonemes).toBe(
      "ðə jˌuˈɛs tˈim wˈʌn, ænd ɪts dˈʌn.",
    );
  });

  it("reads app and product names from the override lexicon", () => {
    expect(
      g2p.phonemize(
        "Open WhatsApp, Safari, Chrome, Slack, Notion, GitHub and ChatGPT on my iPhone running macOS.",
      ).phonemes,
    ).toBe(
      "ˈOpᵊn wˈʌtsˌæp, səfˈɑɹi, kɹˈOm, slˈæk, nˈOʃən, ɡˈɪthˌʌb ænd ʧˈæt ʤˌipˌitˈi ˌɔn mI ˈIfˌOn ɹˈʌnɪŋ mˌæk ˌOˈɛs.",
    );
    expect(
      g2p.phonemize("Opening Spotify and Xcode for Nitish Kovuru.").phonemes,
    ).toBe("ˈOpᵊnɪŋ spˈɑTəfˌI ænd ˈɛkskˌOd fɔɹ nˈITɪʃ kˈOvəɹˌu.");
    // Every casing of an override resolves; "Assist" is never spelled out.
    expect(g2p.phonemize("YOUTUBE youtube").phonemes).toBe("jˈutˌub jˈutˌub");
    expect(g2p.phonemize("Close it? I closed Safari.").phonemes).toBe(
      "klˈOz ɪt? ˌI klˈOzd səfˈɑɹi.",
    );
    expect(g2p.phonemize("Open Assist can assist you.").phonemes).toBe(
      "ˈOpᵊn əsˈɪst kæn əsˈɪst ju.",
    );
    for (const [word, ps] of Object.entries(OVERRIDES)) {
      for (const c of ps.replaceAll(" ", ""))
        expect(US_PHONEMES.has(c), `${word}: ${c}`).toBe(true);
      expect(tokenize(ps, vocab).dropped, word).toBe(0);
    }
  });

  it("without overrides, camelCase names merge subtokens like misaki", () => {
    const plain = new KokoroG2P({ gold, fallback: stub, overrides: {} });
    expect(plain.phonemize("Opening WhatsApp and ChatGPT.").phonemes).toBe(
      "ˈOpᵊnɪŋ wˌʌtsˈæp ænd ʧˌætʤˌipˌitˈi.",
    );
  });

  it("uses the fallback only for unknown words, caches it, and spells as a last resort", () => {
    const fallback = vi.fn(stub);
    const guessing = new KokoroG2P({ gold, fallback });
    const first = guessing.phonemize("Nitish, Nitish and PDF.");
    expect(first.words.map((w) => [w.text, w.source])).toEqual([
      ["Nitish", "fallback"],
      ["Nitish", "fallback"],
      ["and", "lexicon"],
      ["PDF", "lexicon"],
    ]);
    expect(fallback.mock.calls.map(([word]) => word)).toEqual(["Nitish"]);
    const letters = { ...gold, K: "kˈA", V: "vˈi", R: "ˈɑɹ" };
    const none = new KokoroG2P({ gold: letters });
    expect(none.phonemize("Kovuru").words[0]).toEqual({
      text: "Kovuru",
      phonemes: "kˌAˌOvˌijˌuˌɑɹjˈu",
      source: "spelled",
    });
    expect(new KokoroG2P({ gold: {} }).phonemize("zq").words[0].source).toBe(
      "unknown",
    );
  });

  it("is not confused by Object.prototype keys", () => {
    expect(() => g2p.phonemize("constructor toString")).not.toThrow();
  });

  it("applies misaki stress rules", () => {
    expect(applyStress("ˈOpᵊn", -1)).toBe("ˌOpᵊn");
    expect(applyStress("Opᵊn", 2)).toBe("ˈOpᵊn");
    expect(applyStress("ˌI", 2)).toBe("ˈI");
    expect(applyStress("ˈælɪks", -2)).toBe("ælɪks");
  });
});

describe("Kokoro tokens", () => {
  it("maps phonemes to the tokenizer.json ids and drops unknown symbols", () => {
    expect(tokenize("ʃˈʊɹ, ˈOpᵊnɪŋ kˈælkjəlˌATəɹ.", vocab)).toEqual({
      ids: [
        131, 156, 135, 123, 3, 16, 156, 31, 58, 42, 56, 102, 112, 16, 53, 156,
        72, 54, 53, 52, 83, 54, 157, 24, 36, 83, 123, 4,
      ],
      dropped: 0,
    });
    expect(tokenize("d❓ʌn$", vocab)).toEqual({
      ids: [46, 138, 56],
      dropped: 2,
    });
    expect([...inputIds([46, 138])]).toEqual([0n, 46n, 138n, 0n]);
    expect(() => inputIds(new Array(KOKORO_MAX_TOKENS + 1).fill(4))).toThrow();
  });

  it("rejects a tokenizer without the pad token", () => {
    expect(() => parseTokenizerVocab({ model: { vocab: { a: 1 } } })).toThrow();
    expect(() => parseTokenizerVocab("{}")).toThrow();
  });

  it("splits long phoneme strings at 510 tokens, preferring sentence ends", () => {
    const sentence = "ðə kwˈɪk bɹˈWn fˈɑks ʤˈʌmps ˈOvəɹ ðə lˈAzi dˈɔɡ. "; // 50 tokens
    const text = sentence.repeat(25).trim(); // ~1250 tokens
    const pieces = splitPhonemes(text, vocab);
    expect(pieces.length).toBe(3);
    for (const piece of pieces) {
      expect([...piece].length).toBeLessThanOrEqual(KOKORO_MAX_TOKENS);
      expect(piece.endsWith(".")).toBe(true);
      expect(piece).toBe(piece.trim());
    }
    expect(pieces.join(" ")).toBe(text);

    const commas = "wˈʌn, ".repeat(200).trim();
    for (const piece of splitPhonemes(commas, vocab))
      expect([...piece].length).toBeLessThanOrEqual(KOKORO_MAX_TOKENS);
    const unbroken = "a".repeat(1200);
    expect(splitPhonemes(unbroken, vocab).map((p) => p.length)).toEqual([
      510, 510, 180,
    ]);
    expect(splitPhonemes("ʃˈʊɹ.", vocab)).toEqual(["ʃˈʊɹ."]);
    expect(splitPhonemes("❓ ", vocab)).toEqual([]);
  });

  it("splits sentences longer than ~120 tokens at clause punctuation only", () => {
    const clause = "ˈOpᵊnd ðə kwˈɔɹTəɹli bˈʌʤət ɪn nˈʌmbəɹz"; // 38 tokens
    const long = Array(7).fill(clause).join(", ") + ".";
    const pieces = splitPhonemes(long, vocab);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.join(" ")).toBe(long);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith(",")).toBe(true);
      expect([...piece].length).toBeLessThanOrEqual(120);
    }
    expect(splitPhonemes(long, vocab, KOKORO_MAX_TOKENS, Infinity)).toEqual([
      long,
    ]);
    // No clause break: the sentence stays whole rather than splitting mid-phrase.
    const run = Array(5).fill(clause).join(" ");
    expect(splitPhonemes(run, vocab)).toEqual([run]);
    // A tiny trailing clause is not split off.
    const tail = `${clause} ${clause} ${clause} ${clause}, jˈɛs.`;
    expect(splitPhonemes(tail, vocab)).toEqual([tail]);
  });

  it("picks the style row for the token count", () => {
    const voice = new Float32Array(510 * KOKORO_STYLE_DIM).map((_, i) =>
      Math.floor(i / KOKORO_STYLE_DIM),
    );
    expect(styleOffset(28)).toBe(28 * KOKORO_STYLE_DIM);
    expect(styleOffset(9999)).toBe(509 * KOKORO_STYLE_DIM);
    expect(styleFor(voice, 28)[0]).toBe(28);
    expect(styleFor(voice, 28).length).toBe(KOKORO_STYLE_DIM);
    expect(() => styleFor(new Float32Array(10), 1)).toThrow();
  });
});

describe("Kokoro audio", () => {
  const rate = 24000;
  const clip = (leadMs: number, toneMs: number, trailMs: number) => {
    const lead = (rate * leadMs) / 1000;
    const tone = (rate * toneMs) / 1000;
    const out = new Float32Array(lead + tone + (rate * trailMs) / 1000);
    for (let i = 0; i < tone; i++)
      out[lead + i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
    // Faint noise floor well below the threshold.
    for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = 1e-5;
    return out;
  };

  it("trims leading silence to ~30 ms and trailing to ~150 ms", () => {
    const trimmed = trimSilence(clip(300, 1000, 500), rate);
    expect(trimmed.length).toBeGreaterThanOrEqual((rate * 1170) / 1000);
    expect(trimmed.length).toBeLessThanOrEqual((rate * 1200) / 1000);
    expect(Math.abs(trimmed[0])).toBeLessThan(1e-4);
    const quiet = trimSilence(clip(0, 0, 400), rate);
    expect(quiet.length).toBe(0);
    const tight = trimSilence(clip(0, 200, 0), rate);
    expect(tight.length).toBe((rate * 200) / 1000);
  });

  it("converts to clamped s16", () => {
    expect([...toInt16(Float32Array.of(0, 1, -1, 2, -2, 0.5, NaN))]).toEqual([
      0, 32767, -32767, 32767, -32768, 16384, 0,
    ]);
  });
});

describe("Kokoro BART fallback", () => {
  /** A zero-weight BART whose output is decided by final_logits_bias alone. */
  const tiny = (bias: number[]) => {
    const d = 2;
    const tensors = new Map<string, [number[], number[]]>();
    const put = (name: string, shape: number[], values?: number[]) =>
      tensors.set(name, [
        shape,
        values ?? new Array(shape.reduce((a, b) => a * b, 1)).fill(0),
      ]);
    put("model.shared.weight", [bias.length, d]);
    put("final_logits_bias", [1, bias.length], bias);
    for (const stack of ["encoder", "decoder"]) {
      const layer = `model.${stack}.layers.0`;
      const norms = [
        `model.${stack}.layernorm_embedding`,
        `${layer}.self_attn_layer_norm`,
        `${layer}.final_layer_norm`,
      ];
      const attentions = [`${layer}.self_attn`];
      if (stack === "decoder") {
        norms.push(`${layer}.encoder_attn_layer_norm`);
        attentions.push(`${layer}.encoder_attn`);
      }
      put(`model.${stack}.embed_positions.weight`, [10, d]);
      for (const norm of norms) {
        put(`${norm}.weight`, [d]);
        put(`${norm}.bias`, [d]);
      }
      for (const attention of attentions)
        for (const projection of ["q_proj", "k_proj", "v_proj", "out_proj"]) {
          put(`${attention}.${projection}.weight`, [d, d]);
          put(`${attention}.${projection}.bias`, [d]);
        }
      put(`${layer}.fc1.weight`, [4, d]);
      put(`${layer}.fc1.bias`, [4]);
      put(`${layer}.fc2.weight`, [d, 4]);
      put(`${layer}.fc2.bias`, [d]);
    }
    const header: Record<string, unknown> = {};
    let size = 0;
    for (const [name, [shape, values]] of tensors) {
      header[name] = {
        dtype: "F32",
        shape,
        data_offsets: [size, size + values.length * 4],
      };
      size += values.length * 4;
    }
    const json = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(8 + json.length + size);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(json.length), true);
    bytes.set(json, 8);
    let at = 8 + json.length;
    for (const [, values] of tensors.values()) {
      bytes.set(new Uint8Array(Float32Array.from(values).buffer), at);
      at += values.length * 4;
    }
    return new BartG2P(
      {
        d_model: d,
        max_position_embeddings: 10,
        grapheme_chars: "____abcd",
        phoneme_chars: "____xy",
      },
      parseSafetensors(bytes),
    );
  };

  it("parses safetensors and decodes greedily until EOS or the length cap", () => {
    expect(tiny([0, 0, 5, 0, 0, 0]).predict("ab")).toBe("");
    expect(tiny([0, 0, 0, 0, 0, 5]).predict("ab")).toBe("yyyyyyy");
    expect(tiny([0, 0, 0, 0, 5, 0]).predict("a".repeat(7))).toBeNull();
  });

  it("rejects malformed files and unsupported configs", () => {
    expect(() => parseSafetensors(new Uint8Array(4))).toThrow();
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setBigUint64(0, 100n, true);
    expect(() => parseSafetensors(bad)).toThrow();
    expect(
      () =>
        new BartG2P(
          {
            d_model: 2,
            max_position_embeddings: 10,
            grapheme_chars: "",
            phoneme_chars: "",
            decoder_layers: 2,
          },
          new Map(),
        ),
    ).toThrow();
  });
});

// Full-data parity with the spike. Runs only when KOKORO_DATA_DIR points at a
// downloaded model directory; unit runs never download anything.
const dataDir = process.env.KOKORO_DATA_DIR ?? "";
const storedFile = (suffix: string) => {
  if (!dataDir || !existsSync(dataDir)) return "";
  const name = readdirSync(dataDir).find((n) => n.endsWith(suffix));
  return name ? join(dataDir, name) : "";
};
describe.skipIf(!storedFile("-us_gold.json"))(
  "Kokoro G2P with real data",
  () => {
    it("matches the spike's BART outputs and full-lexicon phonemes", () => {
      const bart = new BartG2P(
        JSON.parse(readFileSync(storedFile("-g2p-bart-config.json"), "utf8")),
        parseSafetensors(readFileSync(storedFile("-g2p-bart.safetensors"))),
      );
      for (const [word, ps] of Object.entries({
        Alex: "ˈælˌɛks",
        Johnson: "ʤˈɑnsᵊn",
        YouTube: "jutˈub",
        Calculator: "kˈælkjəlˌAɾəɹ",
        Xcode: "kˈOd",
        Spotify: "spˈɑɾəfˌI",
        WhatsApp: "wˈʌtsˌæp",
        Nitish: "nˈIɾɪʃ",
        Kovuru: "kˈOvəɹˌu",
        Patel: "pˈæɾᵊl",
      }))
        expect(bart.predict(word), word).toBe(ps);
      const full = new KokoroG2P({
        gold: JSON.parse(readFileSync(storedFile("-us_gold.json"), "utf8")),
        fallback: (word) => bart.predict(word),
        overrides: {},
      });
      expect(
        full.phonemize("Opening Spotify and Xcode for Nitish Kovuru.").phonemes,
      ).toBe("ˈOpᵊnɪŋ spˈɑTəfˌI ænd kˈOd fɔɹ nˈITɪʃ kˈOvəɹˌu.");
    });
  },
);
