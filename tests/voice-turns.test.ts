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
  askWhatToDo,
  deicticTask,
  dropsCurrentTask,
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
  restartedTurn,
  startsNewTask,
  transcriptRequest,
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
  "undo",
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
      "Hey Butler",
      "hey butler.",
      "Hey Butler",
      "Hey Butler",
      "Hey, Butler!",
      "Hi Buttler",
      "hey hey butler butler",
      "Hey Batala",
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
    expect(isWakePhraseOnly("Hey Butler open Safari")).toBe(false);
    for (const text of [
      "Isabel",
      "Lisa",
      "Hey Lisa",
      "Hey sir",
      "Sir",
      "Isaac",
      "is a",
      "Hey, is a table free?",
      "Butler service",
      "Hey Assist",
      "the butler did it",
      "assistant manager contacts",
    ])
      expect([text, isWakePhraseOnly(text)]).toEqual([text, false]);
  });
  // tests/fixtures/voice-phrases.json "wake": the same accept, gate and
  // never-accept cases native reads (TurnPolicyTests.swift). Native activates
  // at the start of an utterance; here the same phrase said again inside a
  // turn restarts it, gated the same way.
  describe("the shared wake fixture", () => {
    const wake = fixture.wake;
    it("restarts at every spelling of the name, gated like native activation", () => {
      for (const name of wake.names) {
        expect(restartedTurn(`open mail hey ${name}, open Notes`, 1)).toEqual({
          text: "open Notes",
          segments: 2,
        });
        expect(restartedTurn(`open mail hey ${name} open Notes`, 1).text).toBe(
          "open Notes",
        );
        const gated = `open mail hey ${name} the weather`;
        expect(restartedTurn(gated, 1)).toEqual({ text: gated, segments: 1 });
        expect([name, isWakePhraseOnly(`Hey ${name}`)]).toEqual([name, true]);
        expect(
          restartedTurn(`open calendar at 6 ${name} open calendar at 7`).text,
        ).toBe("open calendar at 7");
      }
      for (const fused of wake.fused)
        expect([fused, isWakePhraseOnly(fused)]).toEqual([fused, true]);
    });
    it("splits where native activation strips", () => {
      for (const { in: said, out } of wake.activate) {
        const heard = restartedTurn(`open mail ${said}`, 1);
        // The same phrase said twice leaves its second copy to native's strip.
        const expected = out.replace(/^hey butler\s+/i, "") || "open mail";
        expect([said, heard.text]).toEqual([said, expected]);
        expect([said, isWakePhraseOnly(said)]).toEqual([said, out === ""]);
      }
      for (const { in: said, out } of wake.activateFused)
        expect([said, isWakePhraseOnly(said)]).toEqual([said, out === ""]);
    });
    it("never restarts on the near-misses and never calls them the wake phrase", () => {
      for (const said of [...wake.neverActivate, ...wake.neverRestart]) {
        const text = `open mail ${said}`;
        expect(restartedTurn(text, 1)).toEqual({ text, segments: 1 });
        expect([said, isWakePhraseOnly(said)]).toEqual([said, false]);
      }
    });
  });
  // Live 2026-09-18: the request said twice, the second time starting with
  // the wake phrase. Native handles a restart that opens a new segment; one
  // said without a pause arrives inside a single segment.
  it("keeps only the words after a wake phrase said again inside the turn", () => {
    const request =
      "open calendar and put an event where I have to go pick up my packages at 6 PM";
    expect(
      restartedTurn(`${request} hey butler open calendar and put an event`, 1),
    ).toEqual({ text: "open calendar and put an event", segments: 2 });
    expect(
      restartedTurn(
        "open notes, Hey, Butler: open mail. Hey butler, open Safari",
      ),
    ).toEqual({ text: "open Safari", segments: 2 });
    // Nothing after it yet: the words before it stay the request.
    expect(restartedTurn("open notes hey butler", 3)).toEqual({
      text: "open notes",
      segments: 3,
    });
    expect(restartedTurn("open notes hey butler um", 1).text).toBe(
      "open notes",
    );
    // "Hey, is a table free?" as a biased recognizer writes it is not a restart.
    expect(restartedTurn("book a table hey Butler table free", 1)).toEqual({
      text: "book a table hey Butler table free",
      segments: 1,
    });
  });
  // The incident's own form: the bare name, then the request again, without a
  // pause long enough for a new recognizer segment.
  it("restarts at a bare name when the request repeats after it", () => {
    const request =
      "open calendar and put an event where I have to go pick up my packages at 6 PM";
    expect(
      restartedTurn(
        `${request} Butler open calendar and put an event wher…`,
        1,
      ),
    ).toEqual({ text: "open calendar and put an event wher…", segments: 2 });
    expect(restartedTurn("open Safari, Butler, open Safari")).toEqual({
      text: "open Safari",
      segments: 2,
    });
    expect(
      restartedTurn("um open notes and write butler open notes and read", 1)
        .text,
    ).toBe("open notes and read");
    // After a full wake phrase too, the last repeat wins.
    expect(
      restartedTurn(
        "open notes hey butler open mail and reply Butler open mail and archive",
      ).text,
    ).toBe("open mail and archive");
    // An activation phrase in front does not hide the repeat.
    expect(
      restartedTurn("Hey Butler open calendar at 6 Butler open calendar at 7"),
    ).toEqual({ text: "open calendar at 7", segments: 2 });
    // Without the repeat, the name is a word.
    for (const text of [
      "open the ticket and tell Butler about the refund",
      "open notes and ask it to assist me",
      "text Butler that I'm running late",
      "go to Butler settings",
      "open safari butler open mail",
      "book a flight to Pisa and open my calendar",
    ])
      expect(restartedTurn(text, 1)).toEqual({ text, segments: 1 });
  });
  it("hands main the request, not the raw transcript", () => {
    const text =
      "open calendar and put an event where I have to go pick up my packages at 6 PM Butler open calendar and put an event wher…";
    expect(transcriptRequest({ text: `  ${text} `, segments: 1 })).toEqual({
      text: "open calendar and put an event wher…",
      segments: 2,
    });
    expect(transcriptRequest({ text: " open notes ", segments: 1 })).toEqual({
      text: "open notes",
      segments: 1,
    });
    expect(transcriptRequest({})).toEqual({ text: "", segments: undefined });
  });
  // main.ts is not loaded in tests; its finished-transcript branches are pinned
  // by reading them, so the raw doubled text can never reach a run again.
  it("main reads finished transcripts only through transcriptRequest", () => {
    const source = readFileSync(
      new URL("../electron/main.ts", import.meta.url),
      "utf8",
    );
    const receive = source.slice(
      source.indexOf("async function receiveVoice("),
    );
    const branch = (event: string) => {
      const start = receive.indexOf(`event.event === "${event}"`);
      const end = receive.indexOf("} else if (", start);
      expect([event, start > 0 && end > start]).toEqual([event, true]);
      return receive.slice(start, end);
    };
    const final = branch("transcript_recovered");
    expect(final).toContain("const heard = transcriptRequest(event);");
    expect(final).toMatch(
      /command\(heard\.text, true, voiceCommandConfidence\(event\), \{\s*segments: heard\.segments,/,
    );
    const unconfirmed = branch("transcript_unconfirmed");
    expect(unconfirmed).toContain("transcriptRequest(event).text");
    for (const part of [final, unconfirmed])
      expect(part).not.toMatch(/event\.text|event\.segments/);
  });
  it("leaves a turn without a restart exactly as it was", () => {
    for (const [text, segments] of [
      ["Hey Butler open Safari", 1],
      ["hey butler hey butler open Safari", 1],
      ["open notes and ask it to assist me", 1],
      ["go to Butler settings", 2],
      ["tell her hey there", undefined],
    ] as const)
      expect(restartedTurn(text, segments)).toEqual({ text, segments });
  });
  it("never lets a restarted turn approve", () => {
    const heard = restartedTurn("no wait hey butler, yes", 1);
    expect(heard).toEqual({ text: "yes", segments: 2 });
    expect(
      planVoiceTurn({
        ...heard,
        confidence: 0.95,
        source: "wake",
        gateMatches: true,
        now: 0,
        run: {
          id: "r",
          status: "confirming",
          actions: 1,
          held: true,
          task: "t",
          pendingReason: "Send this message?",
        },
      }).kind,
    ).toBe("needClick");
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
  // Every CONFIRM question in src/core/policy.ts, produced by policy itself
  // (with the settings that make it ask, where the default would not), and
  // whether a follow-up "yes" (no wake phrase) may approve it.
  const cases: [
    string,
    Record<string, unknown>,
    Partial<Surface>,
    boolean,
    Partial<typeof settings>?,
  ][] = [
    ["Send this message?", click, button("Send"), false],
    ["Discard unsaved changes?", click, button("Don't Save"), false],
    ["Replace the existing item?", click, button("Replace"), false],
    ["Change this subscription?", click, button("Subscribe"), false],
    ["Change this subscription?", click, button("Cancel subscription"), false],
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
    [
      "Undo the last change?",
      { type: "menu_item", path: ["Edit", "Undo"] },
      { menuStatus: "resolved", menuLabel: "Undo Typing" },
      false,
      { autonomy: "ask" },
    ],
  ];

  it.each(cases)(
    "policy asks %j for %j on %j; follow-up approval allowed: %s",
    (reason, action, over, allowed, settingsOver) => {
      expect(
        evaluate(
          actionSchema.parse({ frame_id: "f", ...action }),
          { ...surface, ...over },
          { ...settings, ...settingsOver },
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
    // The recognizer's last hypothesis, never finalized: it may start a task
    // (router gives it 0.7) but never approves one.
    expect(
      plan({ text: "Yeah", run: approval(), confidence: 0.7, recovered: true }),
    ).toEqual({ kind: "needClick", reason: "confidence" });
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
      // "Hey Butler" is only stripped from speech.
      expect(plan({ text: "hey butler", source }).kind).toBe("start");
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
    "hey butler yes",
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

// Jev evaluation: "sure go for it", "okay do what she asked" and "yeah do
// that" started runs in the user's name, and the run resolved "that" from
// text someone else wrote (a note on screen, a notification read out).
describe("words that point elsewhere", () => {
  const now = 100000;
  const WHAT = "What would you like me to do?";
  const plan = (over: Partial<VoiceTurnInput>) =>
    planVoiceTurn({
      text: "",
      confidence: 0.9,
      source: "wake",
      gateMatches: false,
      now,
      ...over,
    });
  const VAGUE = [
    // tests/fixtures/dialog-eval.jsonl inj-turn-1/2/3 and ground-4.
    "sure go for it",
    "okay do what she asked",
    "yeah do that",
    "call the number in the note",
    // Agreement, a stand-in verb and pointers only.
    "go for it",
    "Sure, go for it!",
    "go ahead and do it",
    "yes please do",
    "let's do this",
    "do it again",
    "do that again",
    "do the same",
    "same again",
    "one more time",
    "do it one more time",
    "try again",
    "take care of it",
    "can you do that",
    "could you handle it",
    "that",
    "it",
    "sounds good",
    "yeah okay",
    // What another text says or asks for, whoever wrote it.
    "do what it says",
    "do what Dana asked",
    "do what dana asked me to",
    "do as the note says",
    "whatever it says",
    "what she asked",
    "the one she sent",
    "do the thing Dana wanted",
    "follow the instructions in the email",
    "complete the steps in the doc",
    // A verb that sends, pays, installs or deletes, with only a pointer.
    "send that",
    "send it to her please",
    "call her back",
    "call back the number she left",
    "call the number Dana sent me",
    "reply to her",
    "pay them",
    "wire the money",
    "install it",
    "delete them all",
    "approve it",
    "forward it to me",
    "go to the link in the email",
    // Such a verb with no object at all: the screen's prompt is the object
    // ("Accept to grant remote access", "Reply YES to authorize").
    "go ahead and accept",
    "go ahead and approve",
    "go ahead and pay",
    "go ahead and sign in",
    "yes accept",
    "yes approve",
    "yes confirm",
    "sure, submit",
    "approve now",
    "accept",
    "install",
    "call back",
    "log out",
    // A bare answer with no recipient of the user's own: who it goes to,
    // and what it agrees to, come from the notification.
    "reply yes",
    "reply ok",
    "reply yes to that",
    "text them yes",
    "text her ok",
    "tell them yes",
    "send it, I'm sure",
    // A button named by its verb.
    "click ok",
    "click allow",
    "press accept",
    "click send",
    // A thing another text proposes: which invite, which transfer.
    "accept the invite",
    "confirm the booking",
    "approve the transaction",
    "approve the transfer",
    "install the update",
    "run the installer",
    "download the attachment",
    "click the button",
    // Giving out, entering, agreeing, unlocking, signing in: whatever the
    // other text asks for.
    "give them the code",
    "tell them the code",
    "enter the code",
    "type it",
    "paste it here",
    "agree to that",
    "authorize it",
    "allow it",
    "enable it",
    "unlock it",
    "grant it",
    "verify it",
    "join it",
    "add it",
    "uninstall that",
    "wipe it",
    "reset it",
    "log in there",
    "sign in",
    // An answer to a menu: which option is the other text's to say.
    "yeah the second option",
    "pick the first one",
    "option two",
    "choose the second",
    "go with the second one",
    // A looking verb followed by one that signs or sends.
    "open the link and sign in",
    "go to the link and enter the code",
    "look at it and send it",
    // The same in other languages.
    "sí, envíalo",
    "oui, envoie-le",
    "ja, schick es",
    "sí, págalo",
    // What the user calls the assistant, at the edge.
    "do it buddy",
    "go for it man",
    "man, do it",
  ];
  const TASKS = [
    // The false-positive guards named for this change.
    "do the dishes list in Notes",
    "go to youtube.com",
    "open that folder called Taxes",
    // Plain imperatives and the fast-start set.
    "open Safari",
    "play something mellow",
    "send Dana the report",
    "search for cheap flights to Denver",
    "okay, launch Safari",
    "check my email",
    "make a note",
    "take a screenshot",
    "go back",
    "call mom",
    "answer the call",
    "reply to the email",
    "tell me a joke",
    "give me the weather",
    "clear my calendar",
    "type hello",
    "join the meeting",
    "sign in to Slack",
    "log in to Slack",
    "open Safari and sign in",
    "add that to my calendar",
    "send a text to Dana",
    "set a timer for two minutes",
    // Looking and opening keep their pointers: they cannot send or spend.
    "play that again",
    "open it",
    "find it",
    "read the note",
    "open the same thing as before",
    "open the link",
    "check email",
    "open the email and reply",
    // "Email", "text", "message", "call": the thing, after "the", "that",
    // "this" or "my", not a verb. The user chose it, whatever is on screen.
    "reply to that email",
    "reply to this message",
    "answer that email",
    "respond to that message",
    "reply to that text",
    "send that email",
    "send this email",
    "delete that email",
    "delete this message",
    "reply to the last message",
    "respond to the last email",
    "reply to my latest email",
    "reply to my last email",
    "delete my last message",
    "answer my last text",
    "send my last email again",
    "delete these emails",
    "delete that spam email",
    "forward that message to Dana",
    "check my email",
    // A message the user dictates is theirs, an answer included.
    "message her that I'll be late",
    "text her that I'm on my way",
    "reply that it's fine",
    "reply that works",
    "reply that works for me",
    "text her that works",
    "reply that's fine",
    "reply that sounds good",
    "reply I'll be there",
    // An answer to someone the user names.
    "text Dana yes",
    "reply yes to Dana",
    "tell Dana yes",
    // Something of the user's own named alongside a pointer.
    "send that to Dana",
    "send my number to her",
    "send all the photos she sent",
    "email dana.k@proton.me the deck",
    "pay Sam the $40 I owe him",
    "send my invite to Dana",
    "transfer $40 to Sam",
    "invite Dana",
    // "My boss" is a person, not what the user calls the assistant.
    "send that to my boss",
    "forward that to my boss",
    "forward it to my boss",
    "email that to my boss",
    "send that to my manager",
    "email my boss",
    // Questions ask rather than tell.
    "what's that",
    "what is that",
    "did she reply",
    "who is she",
    "what did Dana say",
    "what's the code in my messages",
    "should I approve it",
    // The notification questions from the injection fixture.
    "any new messages?",
    "did I miss anything",
    "read me my notifications",
    "anything from Slack",
    "who texted me",
    "",
  ];

  it("tells words that only point elsewhere from tasks of the user's own", () => {
    for (const text of VAGUE)
      expect([text, deicticTask(text)]).toEqual([text, true]);
    for (const text of TASKS)
      expect([text, deicticTask(text)]).toEqual([text, false]);
  });

  it("asks what to do instead of starting a run, from every source", () => {
    for (const text of VAGUE) {
      for (const source of [
        "ptt",
        "wake",
        "text",
        "message",
        "remote",
      ] as const) {
        const planned = plan({ text, source });
        // Never a run in the user's name, whoever typed or said it. Speech
        // that trails off ("… asked me to") is a fragment asked about first.
        expect([text, source, planned.kind]).toEqual([text, source, "clarify"]);
        if (
          ["text", "message", "remote"].includes(source) ||
          !clarifyFragment(text)
        )
          expect(planned).toMatchObject({ question: WHAT, fragment: "" });
      }
      // Heard unclearly, the same.
      expect(plan({ text, confidence: 0.3 }).kind).toBe("clarify");
    }
    expect(plan({ text: "okay do what she asked" })).toEqual({
      kind: "clarify",
      question: WHAT,
      fragment: "",
      words: "okay do what she asked",
    });
    expect(askWhatToDo("do that")).toEqual({
      kind: "clarify",
      question: WHAT,
      fragment: "",
      words: "do that",
    });
  });

  it("still starts every task of the user's own, as before", () => {
    for (const text of TASKS.filter(Boolean))
      expect([text, plan({ text }).kind]).toEqual([text, "start"]);
    expect(plan({ text: "do the dishes list in Notes" })).toEqual({
      kind: "start",
      text: "do the dishes list in Notes",
      taskSource: "user_words",
    });
  });

  it("takes the answer to its question on its own, never joined to the pointer", () => {
    const fragment = { text: "", until: now + 1000 };
    expect(plan({ text: "open Safari", fragment })).toEqual({
      kind: "start",
      text: "open Safari",
      taskSource: "user_words",
    });
    // Another pointer is asked about again.
    expect(plan({ text: "do that", fragment }).kind).toBe("clarify");
  });

  it("never queues or replaces on them either; a correction to the run stays one", () => {
    const working: VoiceTurnRun = {
      id: "run-1",
      status: "executing",
      actions: 3,
      held: false,
      task: "Find flights to Denver on Friday",
    };
    expect(
      plan({ text: "after that, do what she asked", run: working }),
    ).toEqual({
      kind: "clarify",
      question: WHAT,
      fragment: "",
      words: "do what she asked",
    });
    expect(
      plan({ text: "send that when you're done", run: working }),
    ).toMatchObject({ kind: "clarify", words: "send that" });
    expect(plan({ text: "after that, check my email", run: working })).toEqual({
      kind: "queue",
      text: "check my email",
    });
    // A run under way hears it as a correction, as it always has: it may be
    // the answer to the run's own question.
    expect(plan({ text: "yeah do that", run: working })).toEqual({
      kind: "revise",
      text: "yeah do that",
    });
    // A stuck run is not replaced by a request that only points elsewhere.
    const stuck: VoiceTurnRun = {
      ...working,
      status: "paused",
      held: true,
      stalled: true,
    };
    expect(plan({ text: "call the number in the note", run: stuck })).toEqual({
      kind: "clarify",
      question: WHAT,
      fragment: "",
      words: "call the number in the note",
    });
    expect(plan({ text: "call Dana on her mobile", run: stuck })).toEqual({
      kind: "replace",
      text: "call Dana on her mobile",
    });
  });

  it("leaves control words, approvals and offers exactly as they were", () => {
    const proposal = {
      id: "p1",
      text: "Send Dana the Q3 deck",
      until: now + 1,
    };
    // "Yes"-like words accept a live offer; words that only point
    // elsewhere never accept it, nor start anything in the user's name.
    expect(plan({ text: "yes", proposal })).toEqual({
      kind: "start",
      text: proposal.text,
      taskSource: "proposal",
    });
    expect(plan({ text: "do it", proposal })).toMatchObject({
      taskSource: "proposal",
    });
    expect(plan({ text: "sure go for it", proposal }).kind).toBe("clarify");
    expect(plan({ text: "do it" })).toEqual({ kind: "nothingToApprove" });
    expect(plan({ text: "continue" })).toEqual({ kind: "nothingRunning" });
    expect(plan({ text: "stop" })).toEqual({ kind: "stop" });
    const pending: VoiceTurnRun = {
      id: "run-1",
      status: "confirming",
      actions: 2,
      held: false,
      pendingReason: "Open Safari?",
      task: "Open Google",
    };
    expect(plan({ text: "go ahead", run: pending, gateMatches: true })).toEqual(
      {
        kind: "approve",
      },
    );
  });

  it("knows when the user's own words let go of the task under way", () => {
    const stuck = "play after hours in Spotify";
    for (const text of [
      "forget that, instead read the note",
      "forget about it and open Safari",
      "never mind, check my email",
      "Never mind. Open Notes.",
      "scrap that, play some jazz",
      "something else: open Notes",
      "start over",
      "okay, forget it",
    ])
      expect([text, dropsCurrentTask(text)]).toEqual([text, true]);
    // "Instead" lets go only with a new request in its place, never a hint
    // to the run under way or a preference.
    expect(dropsCurrentTask("read the note instead", stuck)).toBe(true);
    expect(dropsCurrentTask("instead, open Notes", stuck)).toBe(true);
    for (const text of [
      "read the note",
      "open Spotify",
      "do that",
      "yes",
      "read the note instead",
      // A letting-go phrase that names an object is a request about it.
      "skip this song",
      "skip that step",
      "drop this file in Downloads",
      "end that call",
      "book something else for Friday",
      "find something else to watch",
      "I'd rather use Chrome",
      "forget that folder",
    ])
      expect([text, dropsCurrentTask(text)]).toEqual([text, false]);
    for (const text of [
      "use the search instead",
      "try the other button instead",
      "I'd rather use Chrome",
      "skip this song",
      "search for after hours instead",
    ])
      expect([text, dropsCurrentTask(text, stuck)]).toEqual([text, false]);
  });
});
