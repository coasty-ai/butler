import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/voice-phrases.json";
import { evaluate } from "../src/core/policy";
import {
  actionSchema,
  defaultSettings,
  type Surface,
} from "../src/core/schema";
import {
  isWakePhraseOnly,
  cleanTaskText,
  clarifyFragment,
  followUpApprovalAllowed,
  intentKey,
  isControlPhrase,
  isStatusQuestion,
  joinUtterances,
  planVoiceTurn,
  queueRequest,
  startsNewTask,
  utteranceCompleteness,
  voiceIntent,
  type VoiceTurnInput,
  type VoiceTurnRun,
} from "../src/voice/turns";
import { voiceIntent as routerVoiceIntent } from "../src/voice/router";

const intents = [
  "stop",
  "pause",
  "resume",
  "approve",
  "decline",
  "unclear",
  "acknowledge",
  "command",
] as const;

describe("intent normalization", () => {
  it.each([
    ["Um, st stop please", "stop"],
    ["OK, stop.", "stop"],
    ["Wait, wait, stop", "wait stop"],
    ["no notes", "no notes"],
    ["open the open the notes", "open the notes"],
    ["Stop stop stop!", "stop"],
    ["Okay so, hey, continue", "continue"],
    ["all right keep going thank you", "keep going"],
    ["Don’t send", "dont send"],
    ["uh, hmm", ""],
    ["st st stop", "stop"],
    ["S-s-stop", "stop"],
    ["st-st-stop", "stop"],
    ["sto sto stop", "stop"],
    ["St. St. Stop.", "stop"],
    ["o-o-open the notes", "open the notes"],
  ])("intentKey(%s) = %s", (text, key) => expect(intentKey(text)).toBe(key));

  it.each([
    ["st st stop", "stop"],
    ["S-s-stop", "stop"],
    ["st-st-stop", "stop"],
    ["sto sto stop", "stop"],
    ["St. St. Stop.", "stop"],
    ["c-c-cancel", "stop"],
    ["w-w-wait", "pause"],
    ["n-n-no", "decline"],
    ["please hold up", "pause"],
    ["hold up wait", "pause"],
    ["wait hold up", "pause"],
    ["just a sec wait", "pause"],
    ["please just a sec", "pause"],
  ])("routes the stuttered or stacked control %j as %s", (text, kind) => {
    expect(voiceIntent(text).kind).toBe(kind);
    expect(routerVoiceIntent(text).kind).toBe(kind);
  });

  it("never acts on a turn that is only the wake phrase", () => {
    for (const text of [
      "Hey Assist",
      "hey assist.",
      "Hey assistant",
      "Hey sis",
      "Hey Open Assist",
    ]) {
      expect(isWakePhraseOnly(text)).toBe(true);
      expect(
        planVoiceTurn({
          text,
          confidence: 0.96,
          source: "followup",
          window: "answer",
          gateMatches: false,
          now: 0,
          run: { id: "r", status: "paused", actions: 2, held: true, task: "t" },
        }),
      ).toEqual({ kind: "acknowledge" });
    }
    expect(isWakePhraseOnly("Hey Assist open Safari")).toBe(false);
    expect(isWakePhraseOnly("assistant manager contacts")).toBe(false);
  });
  it("stops a stuttered stop even in a continuation window or with a fragment", () => {
    for (const text of ["st st stop", "S-s-stop", "sto sto stop"])
      expect(
        planVoiceTurn({
          text,
          confidence: 0.9,
          source: "followup",
          window: "continuation",
          gateMatches: true,
          now: 0,
          fragment: { text: "Open", until: 1000 },
          run: {
            id: "run-1",
            status: "thinking",
            actions: 0,
            held: false,
            task: "Open Google",
          },
        }),
      ).toEqual({ kind: "stop" });
  });

  it("routes every fixture category, in both routers", () => {
    for (const kind of intents)
      for (const text of fixture[kind]) {
        expect([text, voiceIntent(text).kind]).toEqual([text, kind]);
        expect(routerVoiceIntent(text).kind).toBe(kind);
      }
  });

  it("treats exactly the stop and pause fixtures as control phrases", () => {
    for (const kind of intents)
      for (const text of fixture[kind])
        expect([text, isControlPhrase(text)]).toEqual([
          text,
          kind === "stop" || kind === "pause",
        ]);
  });

  it("never approves on back-channel words and keeps negated stops as commands", () => {
    for (const text of [
      "ok",
      "Okay.",
      "Mm hmm",
      "uh huh",
      "Thanks!",
      "okay cool",
    ])
      expect(voiceIntent(text).kind).toBe("acknowledge");
    expect(voiceIntent("Sure?").kind).toBe("approve");
    expect(voiceIntent("Don't stop until it is ready.").kind).toBe("command");
    expect(voiceIntent("Yeah, no, don't").kind).toBe("unclear");
    expect(voiceIntent("um").kind).toBe("command");
  });
});

describe("task text cleanup", () => {
  it.each([
    ["Open, um, the the notes app", "Open, the notes app"],
    ["open the open the notes app", "open the notes app"],
    ["Open the open the notes app", "Open the notes app"],
    ["st stop the timer", "stop the timer"],
    ["no notes today", "no notes today"],
    ["say bye bye", "say bye bye"],
    ["I I want to to go", "I want to go"],
    ["Email Jane about the, uh, the report.", "Email Jane about the report."],
    ["um uh", ""],
    ["open the n n notes app", "open the notes app"],
    ["open the n-n-notes app", "open the notes app"],
    ["S-s-stop the timer", "Stop the timer"],
    ["re-read the email", "re-read the email"],
    // Filler-looking words next to numbers, in capitals or quoted stay.
    ["Convert 25 mm to inches", "Convert 25 mm to inches"],
    ["Set a timer for um 5 minutes", "Set a timer for um 5 minutes"],
    [
      "Email Ann Anderson about the ER visit",
      "Email Ann Anderson about the ER visit",
    ],
    [
      "Type 'um, I think so' in the reply",
      "Type 'um, I think so' in the reply",
    ],
    ["Type “uh huh, the the end” there", "Type “uh huh, the the end” there"],
    // Only a lowercase fragment of up to three letters before a plain word.
    ["Call Al Alvarez", "Call Al Alvarez"],
    ["Rename the file to ab abc.txt", "Rename the file to ab abc.txt"],
    ["Open the Ama Amazon page", "Open the Ama Amazon page"],
  ])("cleanTaskText(%s) = %s", (text, clean) =>
    expect(cleanTaskText(text)).toBe(clean),
  );
});

describe("utterance completeness", () => {
  it("matches the shared fixture", () => {
    for (const text of fixture.incomplete)
      expect([text, utteranceCompleteness(text)]).toEqual([text, "incomplete"]);
    for (const text of fixture.complete)
      expect([text, utteranceCompleteness(text)]).toEqual([
        text,
        isControlPhrase(text) ? "control" : "complete",
      ]);
  });

  it("recognizes short answers only when an answer is expected", () => {
    expect(utteranceCompleteness("Safari", "answer")).toBe("shortAnswer");
    expect(utteranceCompleteness("yeah", "approval")).toBe("shortAnswer");
    expect(utteranceCompleteness("thank you", "answer")).toBe("shortAnswer");
    expect(utteranceCompleteness("Safari", "command")).toBe("complete");
    expect(utteranceCompleteness("stop", "approval")).toBe("control");
    // Still thinking while answering the model's question.
    expect(utteranceCompleteness("can you", "answer")).toBe("incomplete");
    expect(utteranceCompleteness("the", "answer")).toBe("incomplete");
    expect(utteranceCompleteness("check the calendar for", "answer")).toBe(
      "incomplete",
    );
    expect(utteranceCompleteness("um", "command")).toBe("incomplete");
    expect(utteranceCompleteness("thanks", "command")).toBe("complete");
  });
});

describe("fragment questions", () => {
  it.each([
    ["Open", "Open what?"],
    ["Open…", "Open what?"],
    ["quit", "Quit what?"],
    ["search", "Search for what?"],
    ["search for", "Search for what?"],
    ["look up", "Search for what?"],
    ["go to", "Go where?"],
    ["Email", "Email who?"],
    ["call", "Call who?"],
    ["can you open", "Open what?"],
    ["can you", "I’m listening."],
    ["I want", "I’m listening."],
    ["email John about", "I’m listening."],
    ["open notes and um", "I’m listening."],
    ["check", "I’m listening."],
    ["um", "I’m listening."],
  ])("asks after %s", (text, question) =>
    expect(clarifyFragment(text)).toBe(question),
  );

  it.each([
    "Open Calculator",
    "close that",
    "turn it up",
    "log in",
    "call her",
    "save as",
    "tell me what time it is",
    "what's the weather like",
    "Save",
    "stop",
    "wait",
    "yes",
    "thank you",
    "",
  ])("runs %j without a question", (text) =>
    expect(clarifyFragment(text)).toBeUndefined(),
  );
});

describe("follow-up approvals", () => {
  const surface: Surface = {
    appId: "example",
    pid: 1,
    secureInput: false,
    unknown: false,
  };
  const settings = { ...defaultSettings, protectedDomains: ["bank.example"] };
  const click = { type: "click", x: 0.5, y: 0.5 };
  const button = (targetLabel: string) => ({
    targetRole: "AXButton",
    targetLabel,
  });
  const hotkey = (...keys: string[]) => ({ type: "hotkey", keys });
  // Every CONFIRM question in src/core/policy.ts, produced by policy itself,
  // and whether a follow-up "yes" (no wake phrase) may approve it.
  const cases: [string, Record<string, unknown>, Partial<Surface>, boolean][] =
    [
      ["Send this message?", click, button("Send"), false],
      ["Discard unsaved changes?", click, button("Don't Save"), false],
      ["Replace the existing item?", click, button("Replace"), false],
      ["Change this subscription?", click, button("Subscribe"), false],
      [
        "Change this subscription?",
        click,
        button("Cancel subscription"),
        false,
      ],
      ["Call this contact?", click, button("Call"), false],
      ["Place this order?", click, button("Place order"), false],
      ["Delete this item?", click, button("Delete"), false],
      ["Approve this transaction?", click, button("Pay"), false],
      ["Publish this post?", click, button("Post"), false],
      ["Publish this comment?", click, button("Comment"), false],
      ["Share or upload this item?", click, button("Share"), false],
      [
        "Change these account or security settings?",
        click,
        button("Change password"),
        false,
      ],
      ["Install this software?", click, button("Install"), false],
      ["Send this invitation?", click, button("Invite"), false],
      ["Decline this invitation?", click, button("Decline"), false],
      ["Sign out of this account?", click, button("Sign out"), false],
      ["Restart, shut down or force quit?", click, button("Restart"), false],
      ["Accept or sign this?", click, button("Accept"), false],
      ["Archive this item?", click, button("Archive"), false],
      ["Reset or erase this?", click, button("Reset"), false],
      ["Disable or revoke this?", click, button("Disable"), false],
      ["Save these changes?", click, button("Save"), false],
      ["Submit or authorize this change?", click, button("Submit"), false],
      ["Submit or authorize this change?", click, button("Authorize"), false],
      [
        "This shortcut may send or delete content. Allow it?",
        hotkey("CMD", "ENTER"),
        {},
        false,
      ],
      ["Quit this application?", hotkey("CMD", "Q"), {}, true],
      [
        "Open this item? It may run a program.",
        hotkey("CMD", "O"),
        { appId: "com.apple.finder" },
        false,
      ],
      ["Run or reload in this application?", hotkey("CMD", "R"), {}, false],
      [
        "Type text with line breaks or tabs? Line breaks may send a message and tabs may move focus.",
        { type: "type_text", text: "Hi\nthere" },
        { focusedRole: "AXTextField" },
        false,
      ],
      [
        "Open a protected website?",
        click,
        { targetRole: "AXLink", targetURL: "https://bank.example/login" },
        false,
      ],
      [
        "Open this file? It may run a program.",
        { type: "double_click", x: 0.5, y: 0.5 },
        { targetRole: "AXCell", targetLabel: "build.sh" },
        false,
      ],
      [
        "Change this setting?",
        click,
        { targetRole: "AXCheckBox", targetLabel: "Wi-Fi" },
        false,
      ],
      ["Click “Continue”?", click, button("Continue"), false],
      ["Click “Allow”?", click, button("Allow"), false],
      ["Click “Log in”?", click, button("Log in"), false],
      [
        "Discard the coding agent's changes?",
        click,
        { appId: "com.microsoft.VSCode", ...button("Undo") },
        false,
      ],
      ["Click “Learn more”?", click, button("Learn more"), true],
      ["Click “Next page”?", click, button("Next page"), true],
      [
        "Activate this control? It may submit or change content.",
        { type: "key", key: "ENTER" },
        {},
        false,
      ],
    ];

  it.each(cases)(
    "policy asks %j for %j on %j; follow-up approval allowed: %s",
    (reason, action, over, allowed) => {
      expect(
        evaluate(
          actionSchema.parse({ frame_id: "f", ...action }),
          { ...surface, ...over },
          settings,
          false,
        ),
      ).toEqual({ kind: "CONFIRM", reason });
      expect([reason, followUpApprovalAllowed(reason)]).toEqual([
        reason,
        allowed,
      ]);
    },
  );

  it("enumerates every question policy can ask", () => {
    const source = readFileSync(
      new URL("../src/core/policy.ts", import.meta.url),
      "utf8",
    );
    const questions = [
      ...source.matchAll(/"([A-Z][^"\n]*\?(?: [^"\n]*)?)"/g),
    ].map((m) => m[1]);
    expect(questions.length).toBeGreaterThan(20);
    const covered = new Set(cases.map(([reason]) => reason));
    for (const question of questions)
      expect([question, covered.has(question)]).toEqual([question, true]);
    // The one templated question is covered by the Click “…”? cases.
    expect(source).toContain("`Click “${quote(shown)}”?`");
  });

  it("allows only benign navigation or opening", () => {
    for (const reason of [
      "Open Calculator?",
      "Activate this control?",
      "Click “Read more”?",
      "Click “load more…”?",
    ])
      expect([reason, followUpApprovalAllowed(reason)]).toEqual([reason, true]);
    for (const reason of [
      undefined,
      "",
      "Open this item? It may run a program.",
      "Open the installer?",
      "Click “Learn more” and delete?",
      "Click “Uninstall”?",
      "Continue?",
      "Allow it?",
      "Proceed with the payment?",
    ])
      expect([reason, followUpApprovalAllowed(reason)]).toEqual([
        reason,
        false,
      ]);
  });
});

describe("joining utterances", () => {
  it.each([
    ["Open", "Safari", "Open Safari"],
    ["Open", "open Safari", "open Safari"],
    ["Open…", "um, Safari.", "Open Safari."],
    ["open the notes", "the notes app", "open the notes app"],
    [
      "Open Google and",
      "and check the weather",
      "Open Google and check the weather",
    ],
    [
      "open notes and um",
      "Check the weather",
      "open notes and Check the weather",
    ],
    ["", "open Safari", "open Safari"],
    ["open Safari", "", "open Safari"],
    ["can you", "okay can you open Safari", "okay can you open Safari"],
  ])("joins %j + %j", (first, second, joined) =>
    expect(joinUtterances(first, second)).toBe(joined),
  );

  it.each([
    [
      "Convert 25 mm to inches.",
      "and um then round it",
      "Convert 25 mm to inches and then round it",
    ],
    [
      "Email Ann Anderson about the ER visit",
      "and uh copy Al",
      "Email Ann Anderson about the ER visit and copy Al",
    ],
    ["Call Al Alvarez", "call al alvarez at work", "Call Al Alvarez at work"],
    [
      "Rename the file to ab abc.txt",
      "and then um open it",
      "Rename the file to ab abc.txt and then open it",
    ],
    [
      "Type 'um, I think so' in the reply",
      "and send it",
      "Type 'um, I think so' in the reply and send it",
    ],
    // A continuation that restates every word of the task replaces it.
    ["Open Google", "open Google and check mail", "open Google and check mail"],
    // One that drops a word ("ER", "Al") keeps the task and adds the rest.
    ["Email the ER team", "email the team", "Email the ER team"],
    [
      "Email the ER team",
      "email the team at noon",
      "Email the ER team at noon",
    ],
  ])("keeps the run's task verbatim: %j + %j", (task, spoken, joined) =>
    expect(joinUtterances(task, spoken, { keepFirst: true })).toBe(joined),
  );

  it("caps the joined task", () => {
    const joined = joinUtterances("a".repeat(1500), "b ".repeat(600));
    expect(joined.length).toBeLessThanOrEqual(2000);
  });
});

describe("turn planning", () => {
  const now = 100000;
  const run = (over: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
    id: "run-1",
    status: "thinking",
    actions: 0,
    held: false,
    task: "Open Google",
    ...over,
  });
  const approval = (reason = "Send this message?") =>
    run({ status: "confirming", pendingReason: reason, actions: 2 });
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "",
      confidence: 0.9,
      source: "ptt",
      gateMatches: true,
      now,
      ...over,
    });

  it("lets stop and pause win everywhere, including a continuation window", () => {
    const lastTurn = {
      plan: "start" as const,
      runId: "run-1",
      actionsAtEnd: 0,
      endedAt: now - 500,
    };
    expect(
      plan({
        text: "stop",
        source: "followup",
        window: "continuation",
        run: run(),
        lastTurn,
      }),
    ).toEqual({ kind: "stop" });
    expect(plan({ text: "OK, stop.", run: approval() })).toEqual({
      kind: "stop",
    });
    expect(
      plan({
        text: "wait",
        run: run(),
        fragment: { text: "Open", until: now + 5000 },
      }),
    ).toEqual({ kind: "pause" });
  });

  it("approves by voice only with confidence, a matching gate and a safe category", () => {
    expect(plan({ text: "Yeah", run: approval(), confidence: 0.7 })).toEqual({
      kind: "approve",
    });
    expect(
      plan({
        text: "Yeah",
        source: "followup",
        window: "approval",
        run: approval(),
        confidence: 0.7,
      }),
    ).toEqual({ kind: "needClick", reason: "confidence" });
    expect(
      plan({
        text: "Yeah",
        source: "followup",
        window: "approval",
        run: approval("Quit this application?"),
        confidence: 0.82,
      }),
    ).toEqual({ kind: "approve" });
    // Sending, submitting and replacing need the wake phrase, the shortcut or
    // a click, even with a confident follow-up "yes".
    for (const reason of [
      "Send this message?",
      "Discard unsaved changes?",
      "Replace the existing item?",
      "Disable or revoke this?",
      "Accept or sign this?",
      "Submit or authorize this change?",
      "Activate this control? It may submit or change content.",
    ]) {
      expect(
        plan({
          text: "yes",
          source: "followup",
          window: "approval",
          run: approval(reason),
          confidence: 0.95,
        }),
      ).toEqual({ kind: "needClick", reason: "restricted" });
      expect(plan({ text: "yes", run: approval(reason) })).toEqual({
        kind: "approve",
      });
    }
    expect(
      plan({
        text: "yes",
        source: "followup",
        window: "approval",
        run: approval("Approve this transaction?"),
        confidence: 0.95,
      }),
    ).toEqual({ kind: "needClick", reason: "restricted" });
    // Restricted categories still approve with the wake phrase or shortcut.
    expect(
      plan({
        text: "yes",
        source: "wake",
        run: approval("Approve this transaction?"),
      }),
    ).toEqual({ kind: "approve" });
    expect(plan({ text: "yes", run: approval(), confidence: 0 })).toEqual({
      kind: "needClick",
      reason: "confidence",
    });
    expect(plan({ text: "yes", run: approval(), segments: 2 })).toEqual({
      kind: "needClick",
      reason: "confidence",
    });
    expect(plan({ text: "yes", run: approval(), gateMatches: false })).toEqual({
      kind: "needClick",
      reason: "gate",
    });
    expect(plan({ text: "yes", run: approval(), confidence: 0.5 })).toEqual({
      kind: "needClick",
      reason: "confidence",
    });
    expect(
      plan({
        text: "yes",
        source: "text",
        run: approval(),
        confidence: 1,
        gateMatches: false,
      }),
    ).toEqual({ kind: "approve" });
  });

  it("declines without a gate, and asks again when a no was uncertain", () => {
    expect(
      plan({ text: "No, don't", run: approval(), gateMatches: false }),
    ).toEqual({
      kind: "decline",
    });
    expect(
      plan({
        text: "no",
        source: "followup",
        window: "approval",
        run: approval("Delete this item?"),
        confidence: 0.8,
      }),
    ).toEqual({ kind: "decline" });
    expect(plan({ text: "no", run: approval(), confidence: 0 })).toEqual({
      kind: "confirmAgain",
    });
  });

  it("never resumes on yes or no with nothing pending", () => {
    for (const text of ["yes", "no", "yeah no"])
      expect(
        plan({ text, run: run({ status: "paused", held: true }) }),
      ).toEqual({
        kind: "nothingToApprove",
      });
    expect(plan({ text: "yes" })).toEqual({ kind: "nothingToApprove" });
  });

  it("treats unclear and back-channel answers as no-ops", () => {
    expect(plan({ text: "yes no", run: approval() })).toEqual({
      kind: "confirmAgain",
    });
    expect(plan({ text: "okay", run: approval() })).toEqual({
      kind: "confirmAgain",
    });
    expect(plan({ text: "thank you" })).toEqual({ kind: "acknowledge" });
    expect(
      plan({ text: "thank you", run: run({ status: "completed" }) }),
    ).toEqual({ kind: "acknowledge" });
    expect(
      plan({ text: "cool", run: run({ status: "paused", held: true }) }),
    ).toEqual({
      kind: "acknowledge",
    });
  });

  it("routes continue by run state", () => {
    expect(plan({ text: "continue" })).toEqual({ kind: "nothingRunning" });
    expect(
      plan({ text: "continue", run: run({ status: "completed" }) }),
    ).toEqual({
      kind: "nothingRunning",
    });
    expect(plan({ text: "keep going", run: approval() })).toEqual({
      kind: "confirmAgain",
    });
    expect(plan({ text: "Go on", run: run() })).toEqual({
      kind: "stillWorking",
    });
    expect(
      plan({
        text: "continue please",
        run: run({ status: "paused", held: true }),
      }),
    ).toEqual({
      kind: "resume",
    });
  });

  it("asks about fragments instead of starting a run", () => {
    expect(plan({ text: "Open" })).toEqual({
      kind: "clarify",
      question: "Open what?",
      fragment: "Open",
    });
    expect(plan({ text: "can you", source: "wake", run: run() })).toEqual({
      kind: "clarify",
      question: "I’m listening.",
      fragment: "can you",
    });
    // Typed text is never second-guessed.
    expect(plan({ text: "Open", source: "text" })).toEqual({
      kind: "start",
      text: "Open",
      taskSource: "user_words",
    });
  });

  it("completes a fragment with its answer", () => {
    const fragment = { text: "Open", until: now + 1000 };
    expect(plan({ text: "Safari", fragment })).toEqual({
      kind: "start",
      text: "Open Safari",
      taskSource: "user_words",
    });
    expect(plan({ text: "open Safari", fragment })).toEqual({
      kind: "start",
      text: "open Safari",
      taskSource: "user_words",
    });
    expect(plan({ text: "Safari", fragment, run: run() })).toEqual({
      kind: "revise",
      text: "Open Safari",
    });
    expect(
      plan({ text: "the", source: "followup", window: "answer", fragment }),
    ).toEqual({
      kind: "clarify",
      question: "I’m listening.",
      fragment: "Open the",
    });
    // Expired: the answer routes on its own.
    expect(
      plan({ text: "Safari", fragment: { text: "Open", until: now } }),
    ).toEqual({
      kind: "start",
      text: "Safari",
      taskSource: "user_words",
    });
  });

  it("never joins typed text to a spoken fragment", () => {
    const fragment = { text: "Open", until: now + 1000 };
    expect(plan({ text: "check my email", source: "text", fragment })).toEqual({
      kind: "start",
      text: "check my email",
      taskSource: "user_words",
    });
    expect(
      plan({ text: "check my email", source: "text", fragment, run: run() }),
    ).toEqual({ kind: "revise", text: "check my email" });
    // Typed text that repeats the fragment runs exactly as typed.
    expect(plan({ text: " open Safari ", source: "text", fragment })).toEqual({
      kind: "start",
      text: "open Safari",
      taskSource: "user_words",
    });
    expect(plan({ text: "Safari", source: "text", fragment })).toEqual({
      kind: "start",
      text: "Safari",
      taskSource: "user_words",
    });
    // Speech still completes the fragment.
    expect(plan({ text: "check my email", fragment })).toEqual({
      kind: "start",
      text: "Open check my email",
      taskSource: "user_words",
    });
  });

  it.each([
    "Convert 25 mm to inches",
    "Email Ann Anderson about the ER visit",
    "Call Al Alvarez",
    "Rename the file to ab abc.txt",
    "Type 'um, I think so' in the reply",
    "Open, um, the the notes app",
    "st stop the timer",
  ])("runs typed text exactly as typed: %j", (text) => {
    expect(plan({ text: `  ${text} `, source: "text" })).toEqual({
      kind: "start",
      text,
      taskSource: "user_words",
    });
    expect(plan({ text, source: "text", run: run() })).toEqual({
      kind: "revise",
      text,
    });
  });

  it.each([
    "Convert 25 mm to inches",
    "Email Ann Anderson about the ER visit",
    "Call Al Alvarez",
    "Rename the file to ab abc.txt",
    "Type 'um, I think so' in the reply",
  ])("keeps protected words in spoken text: %j", (text) => {
    expect(plan({ text })).toEqual({
      kind: "start",
      text,
      taskSource: "user_words",
    });
    expect(plan({ text, source: "wake", run: run() })).toEqual({
      kind: "revise",
      text,
    });
  });

  it("merges a continuation into a run that has not acted yet", () => {
    const lastTurn = {
      plan: "start" as const,
      runId: "run-1",
      actionsAtEnd: 0,
      endedAt: now - 2500,
    };
    const base = {
      text: "and check the weather",
      source: "followup" as const,
      window: "continuation" as const,
      lastTurn,
      turnMs: 1500,
    };
    expect(plan({ ...base, run: run() })).toEqual({
      kind: "amendTask",
      text: "Open Google and check the weather",
    });
    // The run's task is never rewritten; only the spoken part is cleaned.
    expect(
      plan({
        ...base,
        text: "and um round it",
        run: run({ task: "Convert 25 mm to inches. Um, exactly." }),
      }),
    ).toEqual({
      kind: "amendTask",
      text: "Convert 25 mm to inches. Um, exactly and round it",
    });
    expect(plan({ ...base, run: run({ actions: 1 }) })).toEqual({
      kind: "revise",
      text: "and check the weather",
    });
    expect(
      plan({ ...base, lastTurn: { ...lastTurn, plan: "revise" }, run: run() }),
    ).toEqual({
      kind: "revise",
      text: "and check the weather",
    });
    expect(plan({ ...base, run: run({ id: "run-2" }) })).toEqual({
      kind: "revise",
      text: "and check the weather",
    });
    // An expired window routes normally.
    expect(
      plan({
        ...base,
        turnMs: 0,
        lastTurn: { ...lastTurn, endedAt: now - 3500 },
        run: run(),
      }),
    ).toEqual({
      kind: "revise",
      text: "and check the weather",
    });
    expect(plan({ ...base, window: "answer", run: run() })).toEqual({
      kind: "revise",
      text: "and check the weather",
    });
  });

  it("treats whole-utterance commands as corrections or new tasks", () => {
    expect(plan({ text: "Stop scrolling and click Save", run: run() })).toEqual(
      {
        kind: "revise",
        text: "Stop scrolling and click Save",
      },
    );
    expect(plan({ text: "open the open the notes app" })).toEqual({
      kind: "start",
      text: "open the notes app",
      taskSource: "user_words",
    });
    expect(plan({ text: "um uh", source: "text" })).toEqual({
      kind: "acknowledge",
    });
    expect(plan({ text: "   ", source: "text" })).toEqual({
      kind: "acknowledge",
    });
  });
});

// Live: "Jump to Spotify and play after hours" was stuck and handed back; the
// user then said "Go to Notes and write a note for me", which was merged into
// the Spotify run as a correction, so the run bounced between the two apps.
describe("a new request while a run is stalled", () => {
  const stuck = {
    id: "r1",
    status: "paused",
    actions: 6,
    held: true,
    stalled: true,
    task: "Jump to Spotify and play after hours by the Weeknd please",
  };
  const plan = (text: string, run = stuck) =>
    planVoiceTurn({
      text,
      source: "wake",
      now: 1000,
      run,
      confidence: 0.95,
      gateMatches: false,
    });
  it("starts the unrelated request instead of correcting the stuck run", () => {
    expect(plan("Go to Notes and write a note for me")).toEqual({
      kind: "replace",
      text: expect.stringMatching(/notes/i),
    });
    expect(plan("Open Slack and message Prateek").kind).toBe("replace");
  });
  it("keeps hints and corrections as corrections", () => {
    expect(plan("search for after hours").kind).toBe("revise");
    expect(plan("open Spotify instead").kind).toBe("revise");
    expect(plan("actually play Blinding Lights").kind).toBe("revise");
    expect(plan("use the search box").kind).toBe("revise");
  });
  // Live: "Go to YouTube and play a safety video" said instead of answering
  // Spotify's approval was merged into the Spotify run.
  it("starts an unrelated request said instead of answering an approval", () => {
    const confirming = {
      ...stuck,
      status: "confirming",
      pendingReason: "Activate this control? It may submit or change content.",
    };
    expect(plan("Go to YouTube and play a safety video", confirming).kind).toBe(
      "replace",
    );
    expect(plan("yes", confirming).kind).not.toBe("replace");
    expect(plan("play after hours instead", confirming).kind).toBe("revise");
  });
  it("never replaces a run that asked a question or is still working", () => {
    expect(
      plan("Go to Notes and write a note for me", { ...stuck, stalled: false })
        .kind,
    ).toBe("revise");
    expect(
      plan("Go to Notes and write a note for me", {
        ...stuck,
        status: "executing",
        held: false,
        stalled: false,
      }).kind,
    ).toBe("revise");
  });
  it("tells requests from hints by subject", () => {
    expect(startsNewTask("Go to Notes and write a note", stuck.task)).toBe(
      true,
    );
    expect(startsNewTask("play after hours", stuck.task)).toBe(false);
    expect(startsNewTask("open it", stuck.task)).toBe(false);
    expect(startsNewTask("no, open Notes", stuck.task)).toBe(false);
    expect(startsNewTask("can you check my email", stuck.task)).toBe(true);
  });
});

describe("status questions", () => {
  const now = 100000;
  const run = (over: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
    id: "run-1",
    status: "executing",
    actions: 3,
    held: false,
    task: "Email Dana the deck",
    ...over,
  });
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "",
      confidence: 0.9,
      source: "wake",
      gateMatches: true,
      now,
      ...over,
    });

  it.each([
    "how's it going?",
    "How is it going",
    "hows it coming along",
    "how's that going?",
    "How far along are you?",
    "what's the status?",
    "status update",
    "Status",
    "update?",
    "any news?",
    "progress",
    "where are you at?",
    "where are we at",
    "what are you doing?",
    "What are you up to?",
    "what are you working on",
    "what's happening?",
    "what's going on",
    "are you done yet?",
    "Are you finished?",
    "are you stuck?",
    "done yet?",
    "what are you stuck on?",
    "how much longer?",
    "you still working?",
    "are you still working on it",
    "Okay, how's it going, please?",
    "how are we doing",
  ])("isStatusQuestion matches %j", (text) => {
    expect(isStatusQuestion(text)).toBe(true);
  });

  it.each([
    "status of my order please check",
    "check the status of my order",
    "update the spreadsheet",
    "what are you doing tonight",
    "open Safari",
    "how's it going with the report? send it",
    "yes",
    "stop",
    "continue",
  ])("isStatusQuestion rejects %j", (text) => {
    expect(isStatusQuestion(text)).toBe(false);
  });

  it("answers a status question with or without a run, from every source", () => {
    for (const source of [
      "ptt",
      "wake",
      "followup",
      "text",
      "message",
      "remote",
    ] as const) {
      expect(plan({ text: "how's it going?", source, run: run() })).toEqual({
        kind: "status",
      });
      expect(plan({ text: "status", source })).toEqual({ kind: "status" });
      // Live: "how's it going?" used to become a correction to the run.
      expect(
        plan({ text: "how's it going?", source, run: run() }).kind,
      ).not.toBe("revise");
    }
    // Even while an approval is pending: the question is answered, and the
    // approval re-asked by the conversation layer.
    expect(
      plan({
        text: "how's it going?",
        run: run({ status: "confirming", pendingReason: "Send this?" }),
      }),
    ).toEqual({ kind: "status" });
    expect(
      plan({
        text: "how's it going",
        run: run({ status: "paused", held: true, stalled: true }),
      }),
    ).toEqual({ kind: "status" });
  });

  it("never outranks a control or an approval answer", () => {
    const pending = run({ status: "confirming", pendingReason: "Send this?" });
    expect(plan({ text: "stop", run: pending })).toEqual({ kind: "stop" });
    expect(plan({ text: "wait", run: pending })).toEqual({ kind: "pause" });
    expect(plan({ text: "yes", run: pending })).toEqual({ kind: "approve" });
    expect(plan({ text: "no", run: pending })).toEqual({ kind: "decline" });
    expect(plan({ text: "continue", run: run({ held: true }) })).toEqual({
      kind: "resume",
    });
    expect(plan({ text: "okay", run: run() })).toEqual({ kind: "acknowledge" });
  });
});

describe("queue requests", () => {
  const now = 100000;
  const run = (over: Partial<VoiceTurnRun> = {}): VoiceTurnRun => ({
    id: "run-1",
    status: "executing",
    actions: 3,
    held: false,
    task: "Email Dana the deck",
    ...over,
  });
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "",
      confidence: 0.9,
      source: "wake",
      gateMatches: true,
      now,
      ...over,
    });

  it.each([
    ["after that, check my email", "check my email"],
    ["After that check my email", "check my email"],
    ["and after that, open Notes", "open Notes"],
    ["then after this one, open Notes", "open Notes"],
    ["after you're done, text Dana", "text Dana"],
    ["when you’re done, text Dana", "text Dana"],
    ["once that's done open Notes", "open Notes"],
    ["check my email when you're done", "check my email"],
    ["open Notes after that.", "open Notes"],
    ["open Notes, after this", "open Notes"],
    ["when you're done with that, open Notes", "open Notes"],
    ["after you're done with this, text Dana", "text Dana"],
    // Minus the queueing words only; speech is cleaned afterwards.
    ["after that please open Notes", "please open Notes"],
    ["after that, let me know", "let me know"],
  ])("queueRequest(%j) = %j", (text, rest) => {
    expect(queueRequest(text)).toBe(rest);
  });

  it.each([
    "after that",
    "after that, um",
    "open the notes app",
    "check my email after lunch",
    "when you're done",
    "",
    // Times, not queue requests: the words after the lead are the user's
    // whole request and must reach the run untouched.
    "after this call, text Dana I'm running late",
    "after that meeting, send Dana the notes",
    "After this song, play some jazz",
    "after that meeting send Dana the notes",
    // Control words are never tasks to queue.
    "after that, stop",
    "after that, yes",
    "stop after that",
  ])("queueRequest(%j) is not a queue request", (text) => {
    expect(queueRequest(text)).toBeUndefined();
  });

  it("keeps a time phrase whole, with or without a run", () => {
    expect(
      plan({ text: "after this call, text Dana I'm running late" }),
    ).toEqual({
      kind: "start",
      text: "after this call, text Dana I'm running late",
      taskSource: "user_words",
    });
    expect(
      plan({ text: "after this call, text Dana I'm running late", run: run() }),
    ).toEqual({
      kind: "revise",
      text: "after this call, text Dana I'm running late",
    });
  });

  it("is checked before a continuation is merged into the task", () => {
    // Right after "open Notes", still in the continuation window and before
    // the run acted: a queue request queues instead of amending the task.
    expect(
      plan({
        text: "after that, check my email",
        source: "followup",
        window: "continuation",
        turnMs: 1500,
        lastTurn: {
          plan: "start",
          runId: "run-1",
          actionsAtEnd: 0,
          endedAt: now - 1000,
        },
        run: run({ status: "thinking", actions: 0, task: "open Notes" }),
      }),
    ).toEqual({ kind: "queue", text: "check my email" });
  });

  it("queues behind an active run and starts right away without one", () => {
    expect(plan({ text: "after that, check my email", run: run() })).toEqual({
      kind: "queue",
      text: "check my email",
    });
    // Spoken text is cleaned; typed and texted text is kept as written.
    expect(
      plan({ text: "after that, um, check the the weather", run: run() }),
    ).toEqual({ kind: "queue", text: "check the weather" });
    expect(
      plan({
        text: "After that, check my email ",
        source: "message",
        run: run(),
      }),
    ).toEqual({ kind: "queue", text: "check my email" });
    // A paused or stalled run is still the current one.
    expect(
      plan({
        text: "after that, open Notes",
        run: run({ status: "paused", held: true, stalled: true }),
      }),
    ).toEqual({ kind: "queue", text: "open Notes" });
    expect(plan({ text: "after that, check my email" })).toEqual({
      kind: "start",
      text: "check my email",
      taskSource: "user_words",
    });
  });

  it("asks about a queue request that is only a fragment, then queues the answer", () => {
    expect(plan({ text: "after that, open", run: run() })).toEqual({
      kind: "clarify",
      question: "Open what?",
      fragment: "after that, open",
    });
    expect(
      plan({
        text: "Safari",
        run: run(),
        fragment: { text: "after that, open", until: now + 1000 },
      }),
    ).toEqual({ kind: "queue", text: "open Safari" });
    // Typed fragments are never second-guessed.
    expect(
      plan({ text: "after that, open", source: "text", run: run() }),
    ).toEqual({ kind: "queue", text: "open" });
  });

  it("marks speech heard unclearly as unsure words", () => {
    expect(plan({ text: "open Safari", confidence: 0.5 })).toEqual({
      kind: "start",
      text: "open Safari",
      taskSource: "user_words_unsure",
    });
    expect(plan({ text: "open Safari", confidence: 0.65 })).toEqual({
      kind: "start",
      text: "open Safari",
      taskSource: "user_words",
    });
    expect(
      plan({ text: "open Safari", source: "text", confidence: 0 }),
    ).toEqual({ kind: "start", text: "open Safari", taskSource: "user_words" });
  });
});

describe("texted and remote sources", () => {
  const now = 100000;
  const approval = (reason = "Open Safari?"): VoiceTurnRun => ({
    id: "run-1",
    status: "confirming",
    actions: 2,
    held: false,
    pendingReason: reason,
    task: "Open Google",
  });
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "",
      confidence: 1,
      source: "message",
      gateMatches: true,
      now,
      ...over,
    });

  it("never approves: a yes needs the Mac", () => {
    for (const source of ["message", "remote"] as const)
      for (const text of ["yes", "Yes, go ahead", "approve", "do it", "sure"])
        for (const gateMatches of [true, false])
          expect(plan({ text, source, gateMatches, run: approval() })).toEqual({
            kind: "needClick",
            reason: "channel",
          });
    // The same words typed at the Mac still approve.
    expect(plan({ text: "yes", source: "text", run: approval() })).toEqual({
      kind: "approve",
    });
  });

  it("declines only the gate that was relayed", () => {
    for (const source of ["message", "remote"] as const) {
      expect(plan({ text: "no", source, run: approval() })).toEqual({
        kind: "decline",
      });
      expect(
        plan({ text: "no", source, gateMatches: false, run: approval() }),
      ).toEqual({ kind: "confirmAgain" });
      expect(plan({ text: "no", source })).toEqual({
        kind: "nothingToApprove",
      });
    }
  });

  it("stop and pause win, and status is answered", () => {
    for (const source of ["message", "remote"] as const) {
      expect(plan({ text: "please stop", source, run: approval() })).toEqual({
        kind: "stop",
      });
      expect(plan({ text: "hold on", source, run: approval() })).toEqual({
        kind: "pause",
      });
      expect(plan({ text: "status", source, run: approval() })).toEqual({
        kind: "status",
      });
    }
  });

  it("never clarifies or joins fragments; the text runs as written", () => {
    for (const source of ["message", "remote"] as const) {
      expect(plan({ text: " open ", source })).toEqual({
        kind: "start",
        text: "open",
        taskSource: "user_words",
      });
      expect(
        plan({
          text: "check my email",
          source,
          fragment: { text: "Open", until: now + 1000 },
        }),
      ).toEqual({
        kind: "start",
        text: "check my email",
        taskSource: "user_words",
      });
      // "Hey assist" is only stripped from speech.
      expect(plan({ text: "hey assist", source }).kind).toBe("start");
    }
  });
});

describe("proposals", () => {
  const now = 100000;
  const proposal = { id: "p1", text: "Send Dana the Q3 deck", until: now + 1 };
  const approval = (): VoiceTurnRun => ({
    id: "run-1",
    status: "confirming",
    actions: 2,
    held: false,
    pendingReason: "Open Safari?",
    task: "Open Google",
  });
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "yes",
      confidence: 0.9,
      source: "wake",
      gateMatches: true,
      now,
      ...over,
    });

  it("a yes accepts a live proposal as the assistant's wording", () => {
    for (const source of ["ptt", "wake", "text", "message", "remote"] as const)
      expect(plan({ source, proposal })).toEqual({
        kind: "start",
        text: proposal.text,
        taskSource: "proposal",
      });
    expect(plan({ text: "go ahead", proposal })).toEqual({
      kind: "start",
      text: proposal.text,
      taskSource: "proposal",
    });
  });

  it("needs to be heard as clearly as an approval", () => {
    // The offer may repeat words the user never said, so a doubtful "yes"
    // is asked again rather than starting the task.
    for (const confidence of [0, 0.3, 0.64])
      expect(plan({ proposal, confidence })).toEqual({ kind: "confirmAgain" });
    expect(plan({ proposal, confidence: 0.65 })).toMatchObject({
      kind: "start",
    });
    expect(plan({ proposal, confidence: 0.9, segments: 2 })).toEqual({
      kind: "confirmAgain",
    });
    expect(plan({ proposal, source: "followup", confidence: 0.74 })).toEqual({
      kind: "confirmAgain",
    });
    expect(
      plan({ proposal, source: "followup", confidence: 0.75 }),
    ).toMatchObject({ kind: "start" });
    // Typed and texted words carry no hearing doubt.
    for (const source of ["text", "message", "remote"] as const)
      expect(plan({ proposal, source, confidence: 0 })).toMatchObject({
        kind: "start",
      });
    // A "no" needs no confidence: it starts nothing either way.
    expect(plan({ text: "no", proposal, confidence: 0 })).toEqual({
      kind: "acknowledge",
    });
  });

  it("waits its turn behind a live run, never correcting it", () => {
    // Executing, paused by the user, or in takeover: the offer is queued
    // with the assistant's provenance, and the run is left as it was.
    const runs: VoiceTurnRun[] = [
      { id: "run-1", status: "executing", actions: 3, held: false, task: "T" },
      { id: "run-1", status: "paused", actions: 3, held: true, task: "T" },
      { id: "run-1", status: "takeover", actions: 3, held: true, task: "T" },
    ];
    for (const run of runs) {
      for (const source of ["ptt", "wake", "text", "message"] as const)
        expect(plan({ proposal, run, source })).toEqual({
          kind: "queue",
          text: proposal.text,
          taskSource: "proposal",
        });
      expect(plan({ text: "no", proposal, run })).toEqual({
        kind: "acknowledge",
      });
      expect(plan({ proposal, run, confidence: 0.3 })).toEqual({
        kind: "confirmAgain",
      });
    }
    // A finished run is no run.
    expect(
      plan({ proposal, run: { ...runs[0], status: "completed" } }),
    ).toMatchObject({ kind: "start" });
  });

  it("lapses: an expired or empty proposal is nothing to approve", () => {
    expect(plan({ proposal: { ...proposal, until: now } })).toEqual({
      kind: "nothingToApprove",
    });
    expect(plan({ proposal: { ...proposal, text: "  " } })).toEqual({
      kind: "nothingToApprove",
    });
    expect(plan({ text: "no", proposal })).toEqual({ kind: "acknowledge" });
  });

  it("is never accepted while an approval is pending", () => {
    expect(plan({ proposal, run: approval() })).toEqual({ kind: "approve" });
    expect(plan({ proposal, run: approval(), source: "message" })).toEqual({
      kind: "needClick",
      reason: "channel",
    });
    expect(plan({ text: "no", proposal, run: approval() })).toEqual({
      kind: "decline",
    });
  });
});

describe("routing order property", () => {
  const now = 100000;
  const texts = [
    ...fixture.approve,
    ...fixture.decline,
    ...fixture.resume,
    ...fixture.acknowledge,
    ...fixture.unclear,
    "yes",
    "yes yes",
    "approve it",
    "confirm",
    "go ahead and send it",
    "yes send it",
    "click yes",
    "how's it going?",
    "after that, approve it",
    "open Safari",
    "yes, open Safari",
    "hey assist yes",
    "um yes",
    "y-y-yes",
  ];
  const reasons = [
    "Open Safari?",
    "Send this message?",
    "Quit this application?",
    "Click “Learn more”?",
    "Delete this item?",
  ];
  const runs: (VoiceTurnRun | undefined)[] = [
    undefined,
    { id: "r", status: "executing", actions: 1, held: false, task: "Open X" },
    { id: "r", status: "paused", actions: 1, held: true, task: "Open X" },
    { id: "r", status: "takeover", actions: 1, held: true, task: "Open X" },
    ...reasons.map((pendingReason) => ({
      id: "r",
      status: "confirming",
      actions: 1,
      held: false,
      pendingReason,
      task: "Open X",
    })),
    ...reasons.map((pendingReason) => ({
      id: "r",
      status: "confirming",
      actions: 1,
      held: false,
      pendingReason,
      pendingKind: "relay_other" as const,
      task: "Open X",
    })),
  ];
  const proposals = [
    undefined,
    { id: "p", text: "Send the deck", until: now + 1000 },
  ];
  const fragments = [undefined, { text: "Open", until: now + 1000 }];

  it("no message or remote input ever yields approve", () => {
    let cases = 0;
    for (const source of ["message", "remote"] as const)
      for (const text of texts)
        for (const run of runs)
          for (const gateMatches of [true, false])
            for (const confidence of [0, 0.5, 1])
              for (const proposal of proposals)
                for (const fragment of fragments)
                  for (const segments of [1, 2]) {
                    const plan = planVoiceTurn({
                      text,
                      source,
                      run,
                      gateMatches,
                      confidence,
                      proposal,
                      fragment,
                      segments,
                      now,
                    });
                    cases++;
                    expect([source, text, plan.kind]).not.toEqual([
                      source,
                      text,
                      "approve",
                    ]);
                    // Nor anything the Mac would treat as an approval click.
                    if (plan.kind === "needClick")
                      expect(plan.reason).toBe("channel");
                  }
    expect(cases).toBeGreaterThan(10000);
    // The property is about the channel: the same words spoken at the Mac,
    // with confidence and a matching gate, do approve.
    expect(
      planVoiceTurn({
        text: "yes",
        source: "ptt",
        run: runs[4],
        gateMatches: true,
        confidence: 1,
        now,
      }),
    ).toEqual({ kind: "approve" });
  });
});
