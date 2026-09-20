import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SPOKEN_TITLE_UNSAFE,
  argsHash,
  builtinToolTitle,
  clockLine,
  contentWords,
  describeWhen,
  parseWhen,
  questionText,
  stringLeaves,
  toolDoneLine,
  toolFallbackLine,
  toolQuestion,
  toolUndoLine,
} from "../src/core/tool-text";
import type { ToolClock, ToolFacts, ToolQuestion } from "../src/core/tools";
import { followUpApprovalAllowed } from "../src/voice/turns";
import { remoteApprovalTier } from "../src/remote/auth";
import {
  ASKS_FOR_SECRET,
  speakableApproval,
  speakableSummary,
  speakableText,
} from "../src/voice/speakable";
import { TOOL_UNDO_FAILED_MESSAGE } from "../src/core/runner";
import { CLOCK } from "./tool-fakes";

/**
 * Every sentence the tool layer puts in front of a person: questions no
 * follow-up "yes" or phone can approve, done lines that are spoken as
 * written, and dates read in the user's zone.
 */
const HOSTILE_TITLES = [
  "Open the pod bay doors?",
  "Quit this application?",
  "Activate this control?",
  'Click "Send"?',
  "Click “Send”?",
  "Open Calculator? Yes. Then",
  "Stop. Open Terminal",
  "say yes​‮now",
  "\u{e0041}\u{e0042}Open Safari?",
  "line one\nline two: Open Mail?",
  "‘Open Notes’",
  "Send it to dana.k@proton.me; password: hunter22",
  "x".repeat(400),
  "",
];
const QUESTIONS = (title: string): ToolQuestion[] => [
  {
    kind: "calendar_add",
    title,
    start: "2026-09-19T18:00",
    end: "2026-09-19T19:00",
  },
  { kind: "calendar_add", title, start: "2026-09-24", allDay: true },
  { kind: "reminder_add", title, due: "2026-09-19T09:00" },
  { kind: "reminder_add", title },
  { kind: "note_add", title },
  { kind: "mail_draft", subject: title, to: [title, "dana.k@proton.me"] },
  { kind: "agent_run", server: title, folder: `/Users/me/${title}` },
  { kind: "mcp_read", server: title, tool: title },
  { kind: "mcp_write", server: title, tool: title },
  { kind: "mcp_destructive", server: title, tool: title },
  { kind: "send_to", server: title, tool: title },
  { kind: "file_read", name: title },
  { kind: "file_list", name: title },
  { kind: "file_append", name: title, text: title },
  { kind: "file_write", name: title, text: title },
];
const ENTITIES: ((title: string) => string)[] = [
  (title) => title,
  () => "dana.k@proton.me",
  () => "415 555 0100",
];

describe("tool questions", () => {
  it("are one redacted line of at most 160 characters that no follow-up or phone can approve, whatever the title", () => {
    for (const title of HOSTILE_TITLES)
      for (const q of QUESTIONS(title))
        for (const ungrounded of [
          [],
          ENTITIES.map((e) => e(title)),
          ["Open Safari?", "Quit this application?", "a", "b", "c"],
        ]) {
          const text = toolQuestion(q, ungrounded, CLOCK);
          expect(text.length).toBeLessThanOrEqual(160);
          expect(text).not.toMatch(/[\n\r​‮\u{e0041}]/u);
          expect(text).not.toContain("hunter22");
          expect(text).toMatch(/^(?:Add|Change|Delete|Use|Send|Run) .*\?$/);
          expect(followUpApprovalAllowed(text)).toBe(false);
          expect(remoteApprovalTier({ reason: text })).toBe("never");
        }
  });
  it("read as the plan's examples", () => {
    expect(
      toolQuestion(
        {
          kind: "calendar_add",
          title: "Dentist",
          start: "2026-09-19T18:00",
          end: "2026-09-19T19:00",
        },
        [],
        CLOCK,
      ),
    ).toBe(
      "Add Dentist to Calendar, tomorrow, Saturday 19 September, 6 to 7 PM?",
    );
    expect(
      toolQuestion(
        {
          kind: "calendar_add",
          title: "Offsite",
          start: "2026-09-24",
          allDay: true,
        },
        [],
        CLOCK,
      ),
    ).toBe("Add Offsite to Calendar, Thursday 24 September, all day?");
    expect(
      toolQuestion(
        { kind: "reminder_add", title: "Call Dana", due: "2026-09-19T09:00" },
        [],
        CLOCK,
      ),
    ).toBe(
      "Add Call Dana to Reminders, due tomorrow, Saturday 19 September, 9 AM?",
    );
    expect(
      toolQuestion({ kind: "reminder_add", title: "Milk" }, [], CLOCK),
    ).toBe("Add Milk to Reminders?");
    expect(
      toolQuestion({ kind: "note_add", title: "Groceries" }, [], CLOCK),
    ).toBe("Add a note Groceries to Notes?");
    expect(
      toolQuestion(
        {
          kind: "mail_draft",
          subject: "Weekly update",
          to: ["dana.k@proton.me"],
        },
        [],
        CLOCK,
      ),
    ).toBe("Add a Mail draft to dana.k@proton.me, Weekly update?");
    expect(
      toolQuestion(
        {
          kind: "agent_run",
          server: "Claude Code",
          folder: "/Users/me/butler-app",
        },
        [],
        CLOCK,
      ),
    ).toBe("Run Claude Code in butler-app?");
    expect(
      toolQuestion(
        { kind: "mcp_read", server: "Filesystem", tool: "list_directory" },
        [],
        CLOCK,
      ),
    ).toBe("Use Filesystem to read with list_directory?");
    expect(
      toolQuestion(
        { kind: "mcp_write", server: "Filesystem", tool: "write_file" },
        ["dana.k@proton.me"],
        CLOCK,
      ),
    ).toBe("Use Filesystem to run write_file, with dana.k@proton.me?");
    expect(
      toolQuestion(
        {
          kind: "mcp_destructive",
          server: "Scratch",
          tool: "notes_delete_all",
        },
        ["a@b.co", "415 555 0100", "https://x.y/z", "@bob", "$40"],
        CLOCK,
      ),
    ).toBe(
      "Use Scratch to run notes_delete_all, with a@b.co, 415 555 0100, https://x.y/z and 2 more?",
    );
    expect(
      toolQuestion(
        { kind: "send_to", server: "GitHub", tool: "search" },
        ["dana.k@proton.me"],
        CLOCK,
      ),
    ).toBe("Send dana.k@proton.me to GitHub?");
    // The spoken form reads the range with "to", never a dash.
    const spoken = speakableApproval({
      action: {
        type: "tool_call",
        tool: "apple__x",
        args: {},
        finish: false,
        frame_id: "f",
      },
      reason:
        "Add Dentist to Calendar, tomorrow, Saturday 19 September, 6 to 7 PM?",
    });
    expect(spoken).toBe(
      "Add Dentist to Calendar, tomorrow, Saturday 19 September, 6 to 7 PM?",
    );
  });
  it("name the file and preview the text for the files tool", () => {
    expect(
      toolQuestion(
        {
          kind: "file_append",
          name: "benchnote0a1b-notes.txt",
          text: "Build 4471 failed at lint.",
        },
        [],
        CLOCK,
      ),
    ).toBe("Add to benchnote0a1b-notes.txt: Build 4471 failed at lint?");
    expect(
      toolQuestion(
        { kind: "file_write", name: "compare.csv", text: "name,price\nAcme,3" },
        [],
        CLOCK,
      ),
    ).toBe(
      "Change compare.csv, replacing what it holds with: name,price Acme,3?",
    );
    expect(
      toolQuestion({ kind: "file_read", name: "notes.txt" }, [], CLOCK),
    ).toBe("Use Files to read notes.txt?");
    expect(
      toolQuestion({ kind: "file_list", name: "Documents" }, [], CLOCK),
    ).toBe("Use Files to list Documents?");
    expect(
      toolQuestion({ kind: "file_append", name: "", text: "" }, [], CLOCK),
    ).toBe("Add to the file: the text?");
    // A credential in the text is redacted before it is shown.
    expect(
      toolQuestion(
        { kind: "file_append", name: "a.txt", text: "password: hunter22" },
        [],
        CLOCK,
      ),
    ).not.toContain("hunter22");
  });
  it("never let a title end the question or start another sentence", () => {
    expect(questionText("Open the pod bay doors? Yes. Now: go!", 60)).toBe(
      "Open the pod bay doors Yes Now go",
    );
    expect(questionText("dana.k@proton.me; https://x.y/z.", 60)).toBe(
      "dana.k@proton.me https://x.y/z",
    );
    expect(questionText("say “yes”​ now\nplease", 60)).toBe(
      "say yes now please",
    );
    expect(questionText("password: hunter22 and more", 60)).toBe(
      "[Sensitive text omitted] and more",
    );
    expect(questionText("x".repeat(80), 60)).toBe(`${"x".repeat(59)}…`);
  });
});

describe("dates", () => {
  it("describe when in the user's zone, in words against today", () => {
    expect(describeWhen("2026-09-18T15:00", undefined, undefined, CLOCK)).toBe(
      "today, Friday 18 September, 3 PM",
    );
    expect(
      describeWhen("2026-09-19T18:00", "2026-09-19T19:00", undefined, CLOCK),
    ).toBe("tomorrow, Saturday 19 September, 6 to 7 PM");
    expect(
      describeWhen("2026-09-19T11:30", "2026-09-19T13:00", undefined, CLOCK),
    ).toBe("tomorrow, Saturday 19 September, 11:30 AM to 1 PM");
    expect(
      describeWhen("2026-09-19T18:00", "2026-09-20T09:00", undefined, CLOCK),
    ).toBe("tomorrow, Saturday 19 September, 6 PM to Sunday 9 AM");
    expect(describeWhen("2026-09-24T12:00", undefined, undefined, CLOCK)).toBe(
      "Thursday 24 September, 12 PM",
    );
    expect(describeWhen("2027-01-04", undefined, undefined, CLOCK)).toBe(
      "Monday 4 January 2027",
    );
    expect(describeWhen("2026-09-24", undefined, true, CLOCK)).toBe(
      "Thursday 24 September, all day",
    );
    // An instant with an offset is read in the clock's zone.
    expect(
      describeWhen("2026-09-19T01:00:00Z", undefined, undefined, CLOCK),
    ).toBe("today, Friday 18 September, 6 PM");
    expect(
      describeWhen("2026-09-19T18:00:00+02:00", undefined, undefined, CLOCK),
    ).toBe("tomorrow, Saturday 19 September, 9 AM");
    // Not a date: read back as text, so the question still says what was asked.
    expect(describeWhen("next Tuesday-ish?", undefined, undefined, CLOCK)).toBe(
      "next Tuesday-ish",
    );
    expect(describeWhen("", undefined, undefined, CLOCK)).toBe(
      "at the time given",
    );
  });
  it("follow the clock's zone, not the process's", () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ["Pacific/Auckland", "UTC", "America/New_York"]) {
        process.env.TZ = zone;
        // 5:50 PM on Friday in Los Angeles is already Saturday in Auckland.
        expect(
          describeWhen("2026-09-19T18:00", undefined, undefined, CLOCK),
        ).toBe("tomorrow, Saturday 19 September, 6 PM");
        expect(
          describeWhen("2026-09-19T18:00", undefined, undefined, {
            now: CLOCK.now,
            zone: "Pacific/Auckland",
          }),
        ).toBe("today, Saturday 19 September, 6 PM");
        expect(clockLine(CLOCK)).toBe(
          "Friday 18 September 2026, 5:50 PM (America/Los_Angeles); today's date is 2026-09-18",
        );
        expect(clockLine({ now: CLOCK.now, zone: "Europe/Berlin" })).toBe(
          "Saturday 19 September 2026, 2:50 AM (Europe/Berlin); today's date is 2026-09-19",
        );
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
  it("parse the local forms the tools take and nothing looser", () => {
    expect(parseWhen("2026-09-19", CLOCK)).toEqual({ y: 2026, m: 9, d: 19 });
    expect(parseWhen("2026-09-19T18:05", CLOCK)).toEqual({
      y: 2026,
      m: 9,
      d: 19,
      h: 18,
      mi: 5,
    });
    expect(parseWhen("2026-09-19 18:05:30", CLOCK)).toMatchObject({
      h: 18,
      mi: 5,
    });
    expect(parseWhen("2026-13-19", CLOCK)).toBeUndefined();
    expect(parseWhen("2026-09-19T25:00", CLOCK)).toBeUndefined();
    expect(parseWhen("tomorrow", CLOCK)).toBeUndefined();
    expect(parseWhen("1758240000000", CLOCK)).toBeUndefined();
    const unknownZone: ToolClock = { now: CLOCK.now, zone: "Mars/Olympus" };
    expect(clockLine(unknownZone)).toContain("(Mars/Olympus)");
  });
});

describe("the done line", () => {
  const event = (
    title: string,
    over: Partial<Extract<ToolFacts, { kind: "event" }>> = {},
  ): ToolFacts => ({
    kind: "event",
    title,
    start: "2026-09-19T18:00",
    end: "2026-09-19T19:00",
    allDay: false,
    calendar: "Home",
    ...over,
  });
  it("is spoken as written, with the title only when the user said it", () => {
    expect(
      toolDoneLine(
        event("Dentist"),
        CLOCK,
        "add dentist tomorrow at 6 PM to my calendar",
      ),
    ).toBe("Added Dentist to Calendar for tomorrow, Saturday, at 6 PM.");
    expect(toolDoneLine(event("Dentist"), CLOCK, undefined)).toBe(
      "Added the event to Calendar for tomorrow, Saturday, at 6 PM.",
    );
    expect(toolDoneLine(event("Dentist"), CLOCK, "book the appointment")).toBe(
      "Added the event to Calendar for tomorrow, Saturday, at 6 PM.",
    );
    expect(
      toolDoneLine(
        event("Offsite", {
          start: "2026-09-24",
          end: "2026-09-24",
          allDay: true,
        }),
        CLOCK,
        "add offsite thursday",
      ),
    ).toBe("Added Offsite to Calendar for Thursday, all day.");
    expect(
      toolDoneLine(
        event("Standup", { start: "2026-09-18T09:00" }),
        CLOCK,
        "add standup today at 9",
      ),
    ).toBe("Added Standup to Calendar for today, at 9 AM.");
    expect(
      toolDoneLine(
        event("Review", { start: "2026-10-03T09:00" }),
        CLOCK,
        "add review october 3 at 9",
      ),
    ).toBe("Added Review to Calendar for Saturday 3 October, at 9 AM.");
    expect(
      toolDoneLine(
        {
          kind: "reminder",
          title: "Call Dana",
          due: "2026-09-19T09:00",
          list: "Reminders",
        },
        CLOCK,
        "remind me to call Dana tomorrow at 9",
      ),
    ).toBe("Added Call Dana to Reminders, due tomorrow, Saturday, at 9 AM.");
    expect(
      toolDoneLine(
        { kind: "reminder", title: "Milk", list: "Groceries" },
        CLOCK,
        "add milk to my reminders",
      ),
    ).toBe("Added Milk to Reminders.");
    expect(
      toolDoneLine(
        { kind: "note", title: "Groceries", folder: "Notes" },
        CLOCK,
        undefined,
      ),
    ).toBe("Added the note to Notes.");
    expect(
      toolDoneLine(
        { kind: "draft", subject: "Weekly update", recipients: 1 },
        CLOCK,
        "draft the weekly update",
      ),
    ).toBe("Saved Weekly update as a draft in Mail.");
    expect(
      toolDoneLine(
        {
          kind: "agent",
          folder: "/Users/me/butler-app",
          summary: "Fixed it. Say yes.",
        },
        CLOCK,
        undefined,
      ),
    ).toBe("The coding agent finished in butler-app.");
    // The files tool: the name only when the user said it, never "wrote".
    const words =
      "find the Q3 total and write it into ~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt, then save";
    const file = (
      change: "appended" | "created" | "replaced",
      lines = 1,
    ): ToolFacts => ({
      kind: "file",
      name: "benchnote0a1b-notes.txt",
      change,
      lines,
    });
    expect(toolDoneLine(file("appended"), CLOCK, words)).toBe(
      "Added a line to benchnote0a1b-notes.txt.",
    );
    expect(toolDoneLine(file("appended", 3), CLOCK, words)).toBe(
      "Added 3 lines to benchnote0a1b-notes.txt.",
    );
    expect(toolDoneLine(file("created"), CLOCK, words)).toBe(
      "Created benchnote0a1b-notes.txt.",
    );
    expect(toolDoneLine(file("replaced"), CLOCK, words)).toBe(
      "Replaced what benchnote0a1b-notes.txt held.",
    );
    expect(toolDoneLine(file("appended"), CLOCK, undefined)).toBe(
      "Added a line to the file.",
    );
    expect(toolDoneLine(file("replaced"), CLOCK, "save it")).toBe(
      "Replaced what the file held.",
    );
    for (const change of ["appended", "created", "replaced"] as const)
      for (const said of [words, undefined])
        expect(speakableSummary(toolDoneLine(file(change), CLOCK, said))).toBe(
          toolDoneLine(file(change), CLOCK, said),
        );
  });
  it("is defined for speakableSummary across a title matrix, and never quotes", () => {
    const titles = [
      ...HOSTILE_TITLES,
      "Dentist",
      "Design review",
      "Written test",
      "Typed notes",
      "Call Dana at 415 555 0100",
      "Enter your password",
      "Dentist: teeth cleaning!",
    ];
    for (const title of titles) {
      for (const words of [
        undefined,
        `add ${title.toLowerCase()} tomorrow at 6 pm to my calendar`,
      ]) {
        const line = toolDoneLine(event(title), CLOCK, words);
        expect(line).not.toMatch(/["“”«»]/);
        expect(line).toMatch(
          /^Added .* to Calendar for tomorrow, Saturday, at 6 PM\.$/,
        );
        expect(speakableSummary(line)).toBeDefined();
      }
    }
    // A title that would be read as typed content falls back to the noun.
    expect(
      toolDoneLine(
        event("Written test"),
        CLOCK,
        "add written test tomorrow at 6 pm",
      ),
    ).toBe("Added the event to Calendar for tomorrow, Saturday, at 6 PM.");
  });
  it("keeps SPOKEN_TITLE_UNSAFE in step with the voice filters", () => {
    // speakableSummary refuses typed or quoted content and anything that
    // asks for a credential; the mirror keeps such a title out of the done
    // line so the line is still spoken. Change them together.
    const source = readFileSync(
      new URL("../src/voice/speakable.ts", import.meta.url),
      "utf8",
    );
    const typed = /const TYPED_CONTENT =\s*\/(.*)\/i;/.exec(source)?.[1];
    const quoted = /const QUOTED_CONTENT =\s*\/(.*)\/u;/.exec(source)?.[1];
    expect(typed).toBeTruthy();
    expect(quoted).toBeTruthy();
    expect(SPOKEN_TITLE_UNSAFE.source).toBe(
      `${typed}|${quoted}|${ASKS_FOR_SECRET.source}`,
    );
    expect(SPOKEN_TITLE_UNSAFE.flags).toBe("iu");
  });
});

describe("undo, fallback and helpers", () => {
  it("word the undo and fallback lines so they can be spoken", () => {
    expect(
      toolUndoLine({
        kind: "event",
        title: "x",
        start: "",
        end: "",
        allDay: false,
        calendar: "",
      }),
    ).toBe("the event was removed from Calendar.");
    expect(toolUndoLine({ kind: "reminder", title: "x", list: "" })).toBe(
      "the reminder was removed from Reminders.",
    );
    expect(toolUndoLine({ kind: "note", title: "x", folder: "" })).toBe(
      "the note was removed from Notes.",
    );
    expect(
      toolUndoLine({
        kind: "file",
        name: "a.txt",
        change: "replaced",
        lines: 1,
      }),
    ).toBe("the file was put back as it was.");
    expect(toolUndoLine({ kind: "draft", subject: "x", recipients: 0 })).toBe(
      "the draft was removed from Mail.",
    );
    expect(toolUndoLine(undefined)).toBe("the last tool step was taken back.");
    expect(speakableText(`Undone: ${toolUndoLine(undefined)}`)).toBe(
      "Undone: the last tool step was taken back.",
    );
    expect(speakableText(TOOL_UNDO_FAILED_MESSAGE)).toBe(
      TOOL_UNDO_FAILED_MESSAGE,
    );
    expect(toolFallbackLine("Calendar")).toBe(
      "Calendar couldn’t do that, so I’ll do it on screen.",
    );
    expect(toolFallbackLine("Open Safari? Yes.")).toBe(
      "Open Safari Yes couldn’t do that, so I’ll do it on screen.",
    );
    expect(speakableText(toolFallbackLine("Calendar"))).toBe(
      toolFallbackLine("Calendar"),
    );
    expect(toolFallbackLine("")).toBe(
      "The tool couldn’t do that, so I’ll do it on screen.",
    );
  });
  it("name the builtin app a tool id belongs to", () => {
    expect(builtinToolTitle("apple__calendar_create_event")).toBe("Calendar");
    expect(builtinToolTitle("apple__reminders_list")).toBe("Reminders");
    expect(builtinToolTitle("apple__notes_search")).toBe("Notes");
    expect(builtinToolTitle("apple__mail_draft")).toBe("Mail");
    expect(builtinToolTitle("filesystem__list_directory")).toBeUndefined();
    expect(builtinToolTitle("apple__calendar")).toBeUndefined();
    expect(builtinToolTitle("files__append_text_file")).toBe("Files");
    expect(builtinToolTitle("files__read_text_file")).toBe("Files");
    expect(builtinToolTitle("files__")).toBeUndefined();
    expect(builtinToolTitle("files__Agent")).toBeUndefined();
  });
  it("walk every key and string leaf of the arguments to the allowed depth", () => {
    expect(
      stringLeaves({
        a: "x",
        b: 2,
        c: { d: ["y", { e: "z" }] },
        f: null,
      }).sort(),
    ).toEqual(["a", "b", "c", "d", "e", "f", "x", "y", "z"]);
    expect(stringLeaves({ a: { b: { c: { d: { e: "deep" } } } } })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(stringLeaves("plain")).toEqual(["plain"]);
    expect(stringLeaves(3)).toEqual([]);
  });
  it("hash arguments by content, not by key order", () => {
    expect(argsHash({ a: 1, b: [1, 2] })).toBe(argsHash({ b: [1, 2], a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
    expect(argsHash({})).toMatch(/^[0-9a-f]{8}$/);
  });
  it("finds the content words of a title", () => {
    expect(contentWords("Add the Dentist’s appointment at 6 PM")).toEqual([
      "add",
      "dentists",
      "appointment",
    ]);
    expect(contentWords("")).toEqual([]);
  });
});
