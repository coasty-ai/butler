import { describe, expect, it } from "vitest";
import fixture from "./fixtures/voice-phrases.json";
import {
  ACK_KINDS,
  APPROVAL_SUFFIX,
  PHRASES,
  allAssistantPhrases,
  approvalSuffix,
  pickPhrase,
  type PhraseKind,
  type PhraseMemory,
} from "../src/voice/phrases";
import {
  splitSentences,
  adaptContinueHint,
  speakableApproval,
  speakableQuestion,
  speakableSummary,
  speakableText,
} from "../src/voice/speakable";
import { voiceIntent } from "../src/voice/turns";
import { actionSchema } from "../src/core/schema";

const actionable = new Set(["stop", "pause", "resume", "approve", "decline"]);
/** The native wake pattern, current and widened. */
const wake =
  /^\s*(?:hey|hay|hi|his|a)[\s,]+(?:open\s+)?(?:assist|a\s?sis|sis|cyst)/i;

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkSafe(text: string | undefined) {
  if (text === undefined) return;
  expect(text).not.toMatch(/assist/i);
  expect(text).not.toMatch(wake);
  for (const sentence of text.split(/(?<=[.!?])\s+/))
    expect([sentence, actionable.has(voiceIntent(sentence).kind)]).toEqual([
      sentence,
      false,
    ]);
}

describe("phrase inventory", () => {
  it("has variants for every kind and never repeats one consecutively", () => {
    const random = seeded(42);
    for (const kind of Object.keys(PHRASES) as PhraseKind[]) {
      expect(PHRASES[kind].length).toBeGreaterThan(0);
      const memory: PhraseMemory = {};
      let previous = "";
      for (let i = 0; i < 200; i++) {
        const phrase = pickPhrase(kind, memory, random);
        expect(PHRASES[kind]).toContain(phrase);
        if (PHRASES[kind].length > 1) expect(phrase).not.toBe(previous);
        previous = phrase;
      }
    }
  });

  it("uses every variant and survives a broken random source", () => {
    const memory: PhraseMemory = {};
    const seen = new Set<string>();
    const random = seeded(7);
    for (let i = 0; i < 100; i++)
      seen.add(pickPhrase("ackStart", memory, random));
    expect(seen.size).toBe(PHRASES.ackStart.length);
    for (const r of [NaN, 1, -1, Infinity])
      expect(PHRASES.doneGeneric).toContain(
        pickPhrase("doneGeneric", memory, () => r),
      );
  });

  it("keeps acknowledgements to four words and everything short", () => {
    for (const kind of ACK_KINDS)
      for (const phrase of PHRASES[kind])
        expect([phrase, phrase.split(/\s+/).length <= 4]).toEqual([
          phrase,
          true,
        ]);
    for (const phrase of allAssistantPhrases())
      expect(phrase.length).toBeLessThanOrEqual(60);
  });

  it("never says a control, approval or decline phrase or the wake word", () => {
    for (const phrase of allAssistantPhrases()) checkSafe(phrase);
  });

  it("is mirrored exactly in the shared fixture", () => {
    expect([...fixture.assistantPhrases].sort()).toEqual(
      [...allAssistantPhrases()].sort(),
    );
  });

  it("adds the approval suffix once, by mode", () => {
    const base = {
      first: true,
      handsFree: true,
      followUp: true,
      restricted: false,
    };
    expect(approvalSuffix(base)).toBe(APPROVAL_SUFFIX.handsFree);
    expect(approvalSuffix({ ...base, restricted: true })).toBe(
      APPROVAL_SUFFIX.restricted,
    );
    expect(approvalSuffix({ ...base, followUp: false })).toBe("");
    expect(approvalSuffix({ ...base, handsFree: false })).toBe("");
    expect(approvalSuffix({ ...base, first: false })).toBe("");
  });
});

describe('sentence splitting (live: "The Y.C." cut-off)', () => {
  it("keeps initialisms and abbreviations inside a sentence", () => {
    expect(
      speakableSummary(
        "The Y.C. Daytona deal is now up to $200,000 in free Daytona credits.",
      ),
    ).toBe(
      "The Y.C. Daytona deal is now up to $200,000 in free Daytona credits.",
    );
    expect(
      splitSentences("Dr. Lee called. The U.S. office is closed."),
    ).toEqual(["Dr. Lee called.", "The U.S. office is closed."]);
    expect(splitSentences("Done! Anything else? e.g. more tabs.")).toEqual([
      "Done!",
      "Anything else?",
      "e.g. more tabs.",
    ]);
  });
});

describe("speakable text", () => {
  it("reduces links to the site and paths to the name", () => {
    expect(
      speakableSummary(
        "Opened https://www.example.com/reports/q3?id=42. Then saved it.",
      ),
    ).toBe("Opened example.com.");
    expect(
      speakableText("Saved to /Users/jane/Documents/Taxes/report.pdf."),
    ).toBe("Saved to report.pdf.");
    expect(speakableText("Look in ~/Desktop/ for it.")).toBe(
      "Look in Desktop for it.",
    );
    expect(speakableText("Visit docs.example.org/guide/start now.")).toBe(
      "Visit docs.example.org now.",
    );
    expect(speakableText("It works 24/7 and/or daily.")).toBe(
      "It works 24/7 and/or daily.",
    );
  });

  it.each([
    [
      "Opened file:///Users/nitish/Documents/taxes-2025.pdf",
      "Opened taxes-2025.pdf",
    ],
    ["Opened file:///Users/me/My%20Taxes.pdf.", "Opened My Taxes.pdf."],
    ["Visit example.com:8080/admin/panel now.", "Visit example.com now."],
    ["example.com:8080/admin/panel", "example.com"],
    ["Server example.com:8080 is up.", "Server example.com is up."],
    ["See localhost:3000/api/keys.", "See localhost."],
    ["localhost:3000/api/keys", "localhost"],
    ["Router at 192.168.1.10:8080/admin.", "Router at 192.168.1.10."],
    ["Opened https://[::1]:8080/keys", "Opened a link"],
    [
      "Fetched ftp://files.example.com/pub/data.zip.",
      "Fetched files.example.com.",
    ],
    ["Documents/Taxes/2025-return.pdf", "2025-return.pdf"],
    [
      "Saved it to Documents/Taxes/2025-return.pdf.",
      "Saved it to 2025-return.pdf.",
    ],
    ["Created notes/todo.txt for you.", "Created todo.txt for you."],
    ["Built ./dist/app.js", "Built app.js"],
    ["Moved it to Projects/Archive/ today.", "Moved it to Archive today."],
    // Prose with slashes stays.
    ["Due 12/25/2025, yes/no by then.", "Due 12/25/2025, yes/no by then."],
  ])("never reads full links or paths: %j", (text, spoken) => {
    expect(speakableText(text)).toBe(spoken);
    expect(speakableQuestion(text)).toBe(spoken);
  });

  it("never reads typed or quoted content from a summary", () => {
    for (const summary of [
      "Typed my pin is 4821 into Notes",
      'Entered "hunter2" in the field',
      "Pasted the address into the form.",
      "Wrote back to Ann.",
      "Filled in the form with your details.",
      "Renamed the file to ‘Q3 draft’.",
      "Renamed the file to 'Q3 draft'.",
      "Saved the note “Groceries”.",
    ])
      expect([summary, speakableSummary(summary)]).toEqual([
        summary,
        undefined,
      ]);
    expect(speakableSummary("Opened Bob's report.")).toBe(
      "Opened Bob's report.",
    );
    expect(speakableSummary("Checked the weather.")).toBe(
      "Checked the weather.",
    );
  });

  it("returns nothing for credentials or text that is too long", () => {
    expect(
      speakableSummary("Typed password: hunter22x into the form."),
    ).toBeUndefined();
    expect(
      speakableText("Your key is sk-abcdefghijklmnop1234."),
    ).toBeUndefined();
    expect(speakableSummary("a".repeat(121) + ".")).toBeUndefined();
    expect(speakableSummary("")).toBeUndefined();
    expect(speakableSummary(undefined)).toBeUndefined();
  });

  it("keeps the first sentence of a summary and at most two otherwise", () => {
    expect(speakableSummary("Checked the weather. It is sunny. Enjoy.")).toBe(
      "Checked the weather.",
    );
    expect(speakableText("One. Two. Three.")).toBe("One. Two.");
    expect(speakableText(`Short one. ${"b".repeat(140)}.`)).toBe("Short one.");
  });

  it("reads numbers, symbols and quotes naturally", () => {
    expect(speakableText("Called 4155550123 and +1 (415) 555-0199.")).toBe(
      "Called a number and a number.",
    );
    expect(
      speakableText("Hold ⌥ Space — then say “continue”… Don’t worry."),
    ).toBe("Hold Option Space, then say continue. Don’t worry.");
    expect(
      speakableText("Clicked Save (512, 300). Moved to x=0.4, y: 0.2."),
    ).toBe("Clicked Save. Moved to.");
    expect(
      speakableText("Clicked at 50% across, 20% down the selected screen."),
    ).toBe("Clicked.");
  });

  it("never says the wake word or an actionable sentence", () => {
    expect(speakableText("Open Assist opened Notes.")).toBe(
      "This app opened Notes.",
    );
    expect(speakableText("Ask the assistant. Assisted with the form.")).toBe(
      "Ask me. Helped with the form.",
    );
    expect(speakableText("I used Open Assist for assistance.")).toBe(
      "I used this app for help.",
    );
    expect(speakableText("Stop. Checked the mail.")).toBe("Checked the mail.");
    expect(speakableText("Yes.")).toBeUndefined();
    for (const text of [
      "Hey Assist, open Notes.",
      "OpenAssist is ready. Continue?",
      "Say yes. Say no. Wait.",
    ])
      checkSafe(speakableText(text));
  });

  it("speaks approvals from the policy question, never the action details", () => {
    const pending = (input: Record<string, unknown>, reason: string) => ({
      action: actionSchema.parse({ frame_id: "f", ...input }),
      reason,
    });
    const cases = [
      pending(
        { type: "type_text", text: "Meet at 5 secretword" },
        "Send this message?",
      ),
      pending({ type: "click", x: 0.5, y: 0.25 }, "Delete this item?"),
      pending(
        { type: "hotkey", keys: ["CMD", "ENTER"] },
        "This shortcut may send or delete content. Allow it?",
      ),
      pending(
        { type: "open_app", name: "Calculator" },
        "Open this application? 50% sure.",
      ),
    ];
    const spoken = cases.map(speakableApproval);
    expect(spoken).toEqual([
      "Send this message?",
      "Delete this item?",
      "That shortcut might send or delete something. Allow it?",
      // "sure." alone would approve, so that sentence is dropped.
      "Open Calculator?",
    ]);
    for (const text of spoken) {
      expect(text).not.toMatch(/%|secretword|0\.5|0\.25|50|25/);
      checkSafe(text);
    }
  });

  it("speaks model questions up to 160 characters", () => {
    expect(speakableQuestion("What would you like me to search for?")).toBe(
      "What would you like me to search for?",
    );
    expect(speakableQuestion("x".repeat(161) + "?")).toBeUndefined();
  });

  it("adapts continue hints to the voice mode", () => {
    const message =
      "I can’t identify the control. Open the target app or field, then say continue.";
    expect(adaptContinueHint(message, true)).toBe(message);
    expect(adaptContinueHint(message, false)).toBe(
      "I can’t identify the control. Open the target app or field, then hold Option Space and say continue.",
    );
    expect(adaptContinueHint("Say continue to try again.", false)).toBe(
      "Hold Option Space and say continue to try again.",
    );
    expect(adaptContinueHint("Say ‘continue’ when ready.", false)).toBe(
      "Hold Option Space and say ‘continue’ when ready.",
    );
    expect(
      adaptContinueHint("Wait for it to settle, then continue.", false),
    ).toBe("Wait for it to settle, then continue.");
    checkSafe(
      speakableText(adaptContinueHint("Say continue when ready.", false)),
    );
  });
});
