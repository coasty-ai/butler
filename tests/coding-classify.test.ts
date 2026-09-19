import { describe, expect, it } from "vitest";
import {
  QUESTION_MAX,
  SUMMARY_MAX,
  classifyPane,
  readStreamLine,
} from "../src/coding/classify";
import {
  applyReading,
  markSent,
  markStatus,
  watchState,
  type Delegation,
} from "../src/coding/state";

// Pane text as the two CLIs draw it, authored here from their prompt shapes;
// a live run tunes the anchors. Nothing runs a CLI.
const claude = {
  welcome: `
╭───────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                         │
│                                                   │
│   /help for help, /status for your current setup  │
│                                                   │
│   cwd: /Users/nkov/open-assist                    │
╰───────────────────────────────────────────────────╯

 Tips for getting started:
 Run /init to create a CLAUDE.md file with instructions for Claude

╭───────────────────────────────────────────────────╮
│ > Try "fix lint errors"                           │
╰───────────────────────────────────────────────────╯
  ? for shortcuts
`,
  trust: `
╭──────────────────────────────────────────────────────────────╮
│ Do you trust the files in this folder?                       │
│                                                              │
│ /Users/nkov/open-assist                                      │
│                                                              │
│ Claude Code may read files in this folder. Reading untrusted │
│ files may lead Claude Code to behave in unexpected ways.     │
│                                                              │
│ With your permission Claude Code may execute files in this   │
│ folder. Executing untrusted code is unsafe.                  │
│                                                              │
│ https://docs.claude.com/s/claude-code-security               │
│                                                              │
│ ❯ 1. Yes, proceed                                            │
│   2. No, exit                                                │
╰──────────────────────────────────────────────────────────────╯
   Enter to confirm · Esc to exit
`,
  working: `
> fix the failing test in tests/foo.test.ts

⏺ I'll look at the failing test first.

⏺ Bash(npm test -- tests/foo.test.ts)
  ⎿  Running…

✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)

╭───────────────────────────────────────────────────╮
│ >                                                 │
╰───────────────────────────────────────────────────╯
  ? for shortcuts
`,
  spinnerOnly: `
> fix the failing test

⏺ Let me look at the tests…

· Pondering…

╭───╮
│ > │
╰───╯
  ? for shortcuts
`,
  permission: `
> fix the failing test in tests/foo.test.ts

⏺ I'll run the suite to see the failure.

⏺ Bash(npm test -- tests/foo.test.ts)

╭──────────────────────────────────────────────────────────────────────────╮
│ Bash command                                                             │
│                                                                          │
│   npm test -- tests/foo.test.ts                                          │
│   Run the failing test file                                              │
│                                                                          │
│ Do you want to proceed?                                                  │
│ ❯ 1. Yes                                                                 │
│   2. Yes, and don't ask again for npm commands in /Users/nkov/open-assist│
│   3. No, and tell Claude what to do differently (esc)                    │
╰──────────────────────────────────────────────────────────────────────────╯
`,
  edit: `
⏺ Update(tests/foo.test.ts)

╭──────────────────────────────────────────────────────────────╮
│ Edit file                                                    │
│ tests/foo.test.ts                                            │
│   - expect(label).toBe("Save draft")                         │
│   + expect(label).toBe("Save")                               │
│ Do you want to make this edit to foo.test.ts?                │
│   1. Yes                                                     │
│ ❯ 2. Yes, allow all edits during this session (shift+tab)    │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
`,
  question: `
> add a dark mode to the settings page

⏺ I found two settings pages: src/ui/settings.tsx and src/ui/main.tsx. Which one
  should get the dark mode toggle?

╭───────────────────────────────────────────────────╮
│ >                                                 │
╰───────────────────────────────────────────────────╯
  ? for shortcuts
`,
  choice: `
> add a dark mode to the settings page

⏺ Which approach do you prefer?

 ❯ 1. CSS variables with a prefers-color-scheme media query
   2. A theme context with a toggle in Settings
   3. Type something.

   Enter to select · Tab to write
`,
  finished: `
> fix the failing test in tests/foo.test.ts

⏺ I'll look at the failing test first.

⏺ Bash(npm test -- tests/foo.test.ts)
  ⎿  1 failed, 12 passed

⏺ Update(tests/foo.test.ts)
  ⎿  Updated tests/foo.test.ts with 1 addition and 1 removal

⏺ Fixed the failing test: the assertion expected the old label Save draft,
  and the button now reads Save. All 13 tests pass.

╭───────────────────────────────────────────────────╮
│ >                                                 │
╰───────────────────────────────────────────────────╯
  ? for shortcuts
`,
  listInSummary: `
> summarize the changes

⏺ Two changes landed:
  1. The label test now expects Save.
  2. The fixture gained a dark-mode row.

╭───╮
│ > │
╰───╯
  ? for shortcuts
`,
  error: `
> fix the failing test

⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

╭───╮
│ > │
╰───╯
  ? for shortcuts
`,
  interrupted: `
> fix the failing test

⏺ Bash(npm test)
  ⎿  Interrupted · What should Claude do instead?

╭───╮
│ > │
╰───╯
  ? for shortcuts
`,
};
const codex = {
  welcome: `
╭──────────────────────────────╮
│ >_ OpenAI Codex (v0.153.4)   │
│ model: gpt-5-codex           │
│ directory: ~/open-assist     │
╰──────────────────────────────╯

  To get started, describe a task or try one of these commands:
  /init - create an AGENTS.md file with instructions for Codex
  /status - show current session configuration

› Ask Codex to do anything
  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit
`,
  working: `
› fix the failing test in tests/foo.test.ts

• Explored
  └ Read tests/foo.test.ts

• Working (8s • esc to interrupt)

› Ask Codex to do anything
  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit
`,
  approval: `
› fix the failing test

• Explored
  └ Read tests/foo.test.ts

Codex wants to run the following command:
  npm test -- tests/foo.test.ts

Allow command?
› 1. Yes (y)
  2. Yes, and don't ask again for this session (a)
  3. No, and tell Codex what to do differently (n)
`,
  finished: `
› fix the failing test

• Explored
  └ Read tests/foo.test.ts

• Edited tests/foo.test.ts (+1 -1)

• Ran npm test -- tests/foo.test.ts
  └ 13 passed

codex
Fixed the failing test by updating the expected label to Save. All 13 tests pass.

› Ask Codex to do anything
  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit
`,
  question: `
› add a dark mode

codex
Should the toggle live in the settings page or in the menu bar?

› Ask Codex to do anything
  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit
`,
  error: `
› fix the failing test

Error: stream disconnected before completion: error sending request

› Ask Codex to do anything
  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit
`,
};

describe("pane classifier: Claude Code", () => {
  it("reads a fresh session as idle at its prompt", () => {
    expect(classifyPane("claude-code", claude.welcome).status).toBe("finished");
    // Through the reducer a starting session's welcome text is idle, not a result.
    const t = applyReading(
      fresh("claude-code"),
      classifyPane("claude-code", claude.welcome),
      1000,
    );
    expect(t.next.status).toBe("idle");
    expect(t.next.summary).toBeUndefined();
  });
  it("relays the trust question with its keys", () => {
    const r = classifyPane("claude-code", claude.trust);
    expect(r.status).toBe("asks_yes_no");
    expect(r.question).toBe("Do you trust the files in this folder?");
    expect(r.keys).toEqual({ yes: "1", no: "Escape" });
  });
  it("sees work in progress by the spinner, not by an ellipsis in a sentence", () => {
    expect(classifyPane("claude-code", claude.working).status).toBe("working");
    expect(classifyPane("claude-code", claude.spinnerOnly).status).toBe(
      "working",
    );
    const sentence = claude.spinnerOnly.replace("· Pondering…\n", "");
    expect(classifyPane("claude-code", sentence).status).toBe("finished");
  });
  it("quotes a permission question verbatim and names the plain yes and the escape", () => {
    const r = classifyPane("claude-code", claude.permission);
    expect(r.status).toBe("asks_yes_no");
    expect(r.question).toBe(
      "Bash command — npm test -- tests/foo.test.ts — Run the failing test file — Do you want to proceed?",
    );
    expect(r.keys).toEqual({ yes: "1", no: "Escape" });
  });
  it("presses the plain yes even when the session-wide one is highlighted", () => {
    const r = classifyPane("claude-code", claude.edit);
    expect(r.status).toBe("asks_yes_no");
    expect(r.question).toContain(
      "Do you want to make this edit to foo.test.ts?",
    );
    expect(r.keys).toEqual({ yes: "1", no: "Escape" });
  });
  it("hears a question in words as one to answer in words", () => {
    const r = classifyPane("claude-code", claude.question);
    expect(r.status).toBe("asks_text");
    expect(r.question).toBe(
      "I found two settings pages: src/ui/settings.tsx and src/ui/main.tsx. Which one should get the dark mode toggle?",
    );
  });
  it("reads a highlighted choice as a question with its options", () => {
    const r = classifyPane("claude-code", claude.choice);
    expect(r.status).toBe("asks_text");
    expect(r.question).toContain("Which approach do you prefer?");
    expect(r.question).toContain(
      "2. A theme context with a toggle in Settings",
    );
  });
  it("takes the last thing said before the prompt as the summary", () => {
    const r = classifyPane("claude-code", claude.finished);
    expect(r.status).toBe("finished");
    expect(r.summary).toBe(
      "Fixed the failing test: the assertion expected the old label Save draft, and the button now reads Save. All 13 tests pass.",
    );
  });
  it("does not mistake a numbered list in the summary for a prompt", () => {
    const r = classifyPane("claude-code", claude.listInSummary);
    expect(r.status).toBe("finished");
    expect(r.summary).toContain("Two changes landed");
  });
  it("reads an API error and an interruption", () => {
    const e = classifyPane("claude-code", claude.error);
    expect(e.status).toBe("error");
    expect(e.summary).toContain("API Error: 529");
    expect(classifyPane("claude-code", claude.interrupted).status).toBe("idle");
  });
  it("reads nothing into an empty or unreadable pane", () => {
    expect(classifyPane("claude-code", "")).toEqual({ status: "unknown" });
    expect(classifyPane("claude-code", "loading\n").status).toBe("unknown");
  });
  it("bounds the question and the summary", () => {
    const long = `> x\n\n⏺ ${"word ".repeat(300)}\n\n│ > │\n  ? for shortcuts\n`;
    expect(
      classifyPane("claude-code", long).summary!.length,
    ).toBeLessThanOrEqual(SUMMARY_MAX);
    const question = `> x\n\n⏺ ${"why ".repeat(100)}?\n\n│ > │\n  ? for shortcuts\n`;
    expect(
      classifyPane("claude-code", question).question!.length,
    ).toBeLessThanOrEqual(QUESTION_MAX);
  });
});

describe("pane classifier: Codex", () => {
  it("reads a fresh session as ready", () => {
    const t = applyReading(
      fresh("codex"),
      classifyPane("codex", codex.welcome),
      1000,
    );
    expect(t.next.status).toBe("idle");
  });
  it("sees work in progress", () => {
    expect(classifyPane("codex", codex.working).status).toBe("working");
  });
  it("quotes an approval question and takes the letters it names", () => {
    const r = classifyPane("codex", codex.approval);
    expect(r.status).toBe("asks_yes_no");
    expect(r.question).toBe(
      "Codex wants to run the following command: — npm test -- tests/foo.test.ts — Allow command?",
    );
    expect(r.keys).toEqual({ yes: "y", no: "n" });
  });
  it("takes the message after the activity lines as the summary", () => {
    const r = classifyPane("codex", codex.finished);
    expect(r.status).toBe("finished");
    expect(r.summary).toBe(
      "Fixed the failing test by updating the expected label to Save. All 13 tests pass.",
    );
  });
  it("hears a question in words, and an error", () => {
    const q = classifyPane("codex", codex.question);
    expect(q.status).toBe("asks_text");
    expect(q.question).toBe(
      "Should the toggle live in the settings page or in the menu bar?",
    );
    expect(classifyPane("codex", codex.error).status).toBe("error");
  });
});

describe("stream classifier", () => {
  const claudeStream = [
    `{"type":"system","subtype":"init","cwd":"/Users/nkov/open-assist","session_id":"5f0c-1","tools":["Bash","Edit"],"model":"claude","permissionMode":"default"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll look at the failing test."}]},"session_id":"5f0c-1"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm test"}}]},"session_id":"5f0c-1"}`,
    `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Claude requested permissions to use Bash, but you haven't granted it yet.","is_error":true}]},"session_id":"5f0c-1"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I need permission to run the tests. Please run npm test yourself or grant Bash access."}]}}`,
    `{"type":"result","subtype":"success","is_error":false,"duration_ms":12345,"num_turns":3,"result":"I need permission to run the tests. Please run npm test yourself or grant Bash access.","session_id":"5f0c-1","total_cost_usd":0.01}`,
  ];
  it("reads Claude Code's stream: init, words, a refused permission, the result", () => {
    const readings = claudeStream.map((line) =>
      readStreamLine("claude-code", line),
    );
    expect(readings[0]).toEqual({ status: "working", resumeId: "5f0c-1" });
    expect(readings[1]).toEqual({
      status: "working",
      summary: "I'll look at the failing test.",
    });
    expect(readings[2]).toEqual({ status: "working" });
    expect(readings[3]!.status).toBe("asks_yes_no");
    expect(readings[3]!.question).toContain(
      "requested permissions to use Bash",
    );
    expect(readings[5]).toMatchObject({
      status: "finished",
      resumeId: "5f0c-1",
    });
    expect(readings[5]!.summary).toContain("I need permission");
  });
  it("reads Claude Code's question tool and a failed result", () => {
    const ask = readStreamLine(
      "claude-code",
      `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Which page?","options":[{"label":"settings"},{"label":"main"}]}]}}]}}`,
    );
    expect(ask).toEqual({
      status: "asks_text",
      question: "Which page? settings main",
    });
    expect(
      readStreamLine(
        "claude-code",
        `{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["Reached max turns"]}`,
      ),
    ).toEqual({ status: "error", summary: "Reached max turns" });
  });
  const codexStream = [
    `{"type":"thread.started","thread_id":"0199-abc"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Looking at the test"}}`,
    `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"in_progress"}}`,
    `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"13 passed","exit_code":0,"status":"completed"}}`,
    `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Fixed the failing test; all 13 pass."}}`,
    `{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`,
  ];
  it("reads Codex's stream: the thread id, the message, the turn's end", () => {
    const readings = codexStream.map((line) => readStreamLine("codex", line));
    expect(readings[0]).toEqual({ status: "working", resumeId: "0199-abc" });
    expect(readings[2]).toEqual({ status: "working" });
    expect(readings[5]).toEqual({
      status: "working",
      summary: "Fixed the failing test; all 13 pass.",
    });
    expect(readings[6]).toEqual({ status: "finished" });
    expect(
      readStreamLine(
        "codex",
        `{"type":"turn.failed","error":{"message":"rate limit"}}`,
      ),
    ).toEqual({ status: "error", summary: "rate limit" });
  });
  it("ignores lines that are not events", () => {
    expect(readStreamLine("codex", "not json")).toBeUndefined();
    expect(readStreamLine("claude-code", "[1,2]")).toBeUndefined();
    expect(
      readStreamLine("claude-code", `{"type":"rate_limit_event"}`),
    ).toBeUndefined();
  });
  it("keeps the last words as the summary when the turn ends without them", () => {
    let d = markSent(fresh("codex"), 1000, "fix it");
    for (const line of codexStream) {
      const r = readStreamLine("codex", line);
      if (r) d = applyReading(d, r, 2000).next;
    }
    expect(d.status).toBe("finished");
    expect(d.summary).toBe("Fixed the failing test; all 13 pass.");
    expect(d.resumeId).toBe("0199-abc");
  });
});

describe("delegation state", () => {
  it("moves through a session: prompt, task, question, work, result", () => {
    let d = fresh("claude-code");
    let t = applyReading(d, classifyPane("claude-code", claude.welcome), 1000);
    expect(t.next.status).toBe("idle");
    expect(t.changed).toBe(true);
    d = markSent(t.next, 2000, "fix the failing test");
    expect(d.status).toBe("working");
    expect(d.seq).toBe(2);
    t = applyReading(d, classifyPane("claude-code", claude.working), 3000);
    expect(t.changed).toBe(false);
    t = applyReading(d, classifyPane("claude-code", claude.permission), 4000);
    expect(t.changed).toBe(true);
    expect(t.next.status).toBe("asks_yes_no");
    expect(t.next.keys).toEqual({ yes: "1", no: "Escape" });
    // The same prompt again is not news.
    expect(
      applyReading(t.next, classifyPane("claude-code", claude.permission), 5000)
        .changed,
    ).toBe(false);
    d = markStatus(t.next, "working", 6000);
    expect(d.question).toBeUndefined();
    t = applyReading(d, classifyPane("claude-code", claude.finished), 9000);
    expect(t.next.status).toBe("finished");
    expect(t.next.summary).toContain("All 13 tests pass");
    expect(t.next.since).toBe(9000);
    // Read again a second later: nothing new.
    expect(
      applyReading(t.next, classifyPane("claude-code", claude.finished), 10000)
        .changed,
    ).toBe(false);
  });
  it("speaks the reporter's watch vocabulary", () => {
    expect(watchState("asks_yes_no")).toBe("needs_permission");
    expect(watchState("finished")).toBe("done");
    expect(watchState("working")).toBe("working");
    expect(watchState("error")).toBe("error");
  });
});

function fresh(agent: "claude-code" | "codex"): Delegation {
  return {
    id: "c1",
    agent,
    dir: "/Users/nkov/open-assist",
    task: "fix the failing test",
    transport: "tmux",
    session: `butler-${agent === "codex" ? "codex" : "claude"}-open-assist`,
    status: "starting",
    startedAt: 0,
    since: 0,
    lastChangeAt: 0,
    pending: [],
    seq: 0,
  };
}
