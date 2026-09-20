import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  APPROVAL_CODES,
  approvalCode,
  type ApprovalCode,
} from "../src/core/approval-codes";
import { PROTECTED_SITE_QUESTION, UNDO_QUESTION } from "../src/core/policy";
import { toolQuestion } from "../src/core/tool-text";
import type { ToolClock, ToolQuestion } from "../src/core/tools";

/**
 * The reason → code table the bench ledger and the diagnostics stream use
 * to say what the policy asked without its text. The policy's questions are
 * read from its source here, so a CONFIRM site added without a code fails
 * this suite rather than landing in a cycle's report as OTHER.
 */

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const policySource = read("src/core/policy.ts");
const toolTextSource = read("src/core/tool-text.ts");

/** The index of the brace closing the object literal that starts before `from`. */
function objectEnd(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i;
  }
  return source.length;
}

/**
 * Every question policy.ts can put in a CONFIRM decision: the fixed strings
 * at its CONFIRM sites, the templates around a label or an application
 * (each `${…}` stands in as "Label"), the named constants and every return
 * of consequentialReason. Also how many CONFIRM sites were read, so a
 * refactor that empties the scan is a failure, not a pass.
 */
function confirmQuestions(source: string): {
  questions: string[];
  sites: number;
} {
  const questions = new Set<string>();
  const named: Record<string, string> = {
    UNDO_QUESTION,
    PROTECTED_SITE_QUESTION,
  };
  const consequential =
    /function consequentialReason\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  const consequentialReturns = [
    ...consequential.matchAll(/return "([^"\n]*\?)";/g),
  ].map((m) => m[1]);
  let at = 0;
  let sites = 0;
  while ((at = source.indexOf('kind: "CONFIRM"', at)) !== -1) {
    sites++;
    const block = source.slice(at, objectEnd(source, at));
    at += 1;
    for (const m of block.matchAll(/"([^"\n]*\?[^"\n]*)"/g))
      questions.add(m[1]);
    for (const m of block.matchAll(/`([^`]*)`/g))
      if (m[1].includes("?"))
        questions.add(m[1].replace(/\$\{[^}]*\}/g, "Label"));
    for (const [name, text] of Object.entries(named))
      if (block.includes(name)) questions.add(text);
    if (block.includes("consequentialReason("))
      for (const text of consequentialReturns) questions.add(text);
  }
  return { questions: [...questions], sites };
}

const clock: ToolClock = { now: new Date("2026-09-19T10:00:00Z"), zone: "UTC" };
const toolCases: [ToolQuestion, ApprovalCode][] = [
  [
    { kind: "calendar_add", title: "Dentist", start: "2026-09-20T18:00:00Z" },
    "TOOL_CALENDAR_ADD",
  ],
  [
    {
      kind: "calendar_add",
      title: "Offsite",
      start: "2026-09-21",
      end: "2026-09-22",
      allDay: true,
      calendar: "Work",
    },
    "TOOL_CALENDAR_ADD",
  ],
  [
    { kind: "reminder_add", title: "Call mum", due: "2026-09-20T18:00:00Z" },
    "TOOL_REMINDER_ADD",
  ],
  [{ kind: "reminder_add", title: "Call mum" }, "TOOL_REMINDER_ADD"],
  [{ kind: "note_add", title: "Ideas", folder: "Notes" }, "TOOL_NOTE_ADD"],
  [
    { kind: "mail_draft", subject: "Hello", to: ["a@example.com"] },
    "TOOL_MAIL_DRAFT",
  ],
  [
    { kind: "agent_run", server: "Claude Code", folder: "/Users/me/project" },
    "TOOL_AGENT_RUN",
  ],
  [
    { kind: "mcp_read", server: "GitHub", tool: "list_issues" },
    "TOOL_MCP_READ",
  ],
  [
    { kind: "mcp_write", server: "GitHub", tool: "create_issue" },
    "TOOL_MCP_WRITE",
  ],
  [
    { kind: "mcp_destructive", server: "GitHub", tool: "delete_repo" },
    "TOOL_MCP_WRITE",
  ],
  [{ kind: "send_to", server: "GitHub", tool: "search" }, "TOOL_SEND_TO"],
  [{ kind: "file_read", name: "notes.txt" }, "TOOL_FILE_READ"],
  [{ kind: "file_list", name: "Documents" }, "TOOL_FILE_READ"],
  [
    { kind: "file_append", name: "notes.txt", text: "Q3 total: 15,888" },
    "TOOL_FILE_APPEND",
  ],
  [
    { kind: "file_write", name: "compare.csv", text: "name,price" },
    "TOOL_FILE_WRITE",
  ],
];

describe("approval codes", () => {
  it("maps every question the policy can ask, read from its CONFIRM sites, to a code other than OTHER", () => {
    const { questions, sites } = confirmQuestions(policySource);
    // policy.ts has 18 CONFIRM sites and about 39 distinct questions today;
    // a scan that finds far fewer has stopped reading the file.
    expect(sites).toBeGreaterThanOrEqual(15);
    expect(questions.length).toBeGreaterThanOrEqual(35);
    for (const question of questions)
      expect(approvalCode(question), question).not.toBe("OTHER");
    // The fixed strings a reader of the ledger will look for first.
    expect(questions).toContain("Save these changes?");
    expect(questions).toContain("Place this order?");
    expect(questions).toContain("Quit this application?");
    expect(questions).toContain(UNDO_QUESTION);
    expect(questions).toContain(PROTECTED_SITE_QUESTION);
  });

  it("names the shape, never the label or the application", () => {
    expect(approvalCode("Save these changes?")).toBe("SAVE_CHANGES");
    expect(approvalCode("Place this order?")).toBe("PLACE_ORDER");
    expect(approvalCode("Submit or authorize this change?")).toBe(
      "SUBMIT_AUTHORIZE",
    );
    expect(approvalCode("Replace the existing item?")).toBe("REPLACE_ITEM");
    expect(approvalCode(UNDO_QUESTION)).toBe("UNDO");
    expect(approvalCode(PROTECTED_SITE_QUESTION)).toBe("PROTECTED_SITE");
    expect(approvalCode("Quit this application?")).toBe("QUIT_APP");
    expect(approvalCode("Run or reload in this application?")).toBe(
      "RUN_RELOAD",
    );
    expect(
      approvalCode("Activate this control? It may submit or change content."),
    ).toBe("ACTIVATE_CONTROL");
    expect(approvalCode("Change this setting?")).toBe("CHANGE_SETTING");
    expect(approvalCode("Click “Sign in”?")).toBe("CLICK_CONTROL");
    expect(approvalCode("Click “Confirm reservation”?")).toBe("CLICK_CONTROL");
    // A control labelled with a question of its own is still a click.
    expect(approvalCode("Click “Send this message?”?")).toBe("CLICK_CONTROL");
    expect(approvalCode("Click “SECRETWORD ~/Documents/plan.txt”?")).toBe(
      "CLICK_CONTROL",
    );
    expect(
      approvalCode(
        "Open the folder “SECRETWORD” in Visual Studio Code? An editor can run a project's own tasks when it opens its folder.",
      ),
    ).toBe("OPEN_FOLDER");
    expect(
      approvalCode(
        "Run the top match for “SECRETWORD” in Visual Studio Code? It may not be exactly that command.",
      ),
    ).toBe("PALETTE_COMMAND");
    expect(
      approvalCode("Type here in Slack? I can’t see its text fields."),
    ).toBe("TYPE_BLIND");
    for (const verb of ["Click", "Right-click", "Double-click"])
      expect(
        approvalCode(`${verb} here in Slack? I can’t see its controls.`),
      ).toBe("CLICK_BLIND");
    expect(approvalCode("Open this item? It may run a program.")).toBe(
      "OPEN_ITEM",
    );
    expect(approvalCode("Open this file? It may run a program.")).toBe(
      "OPEN_FILE",
    );
  });

  it("is exact: a drifted or unknown question is OTHER, and the codes are code-shaped", () => {
    expect(approvalCode("")).toBe("OTHER");
    expect(approvalCode("Save these changes? ")).toBe("OTHER");
    expect(approvalCode("save these changes?")).toBe("OTHER");
    expect(approvalCode("Delete everything?")).toBe("OTHER");
    expect(approvalCode("Click here")).toBe("OTHER");
    expect(new Set(APPROVAL_CODES).size).toBe(APPROVAL_CODES.length);
    expect(APPROVAL_CODES).toContain("OTHER");
    for (const code of APPROVAL_CODES)
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    // A key of Object.prototype is not a question.
    expect(approvalCode("constructor")).toBe("OTHER");
    expect(approvalCode("__proto__")).toBe("OTHER");
  });

  it("maps every kind of tool question, with and without entities the user never said", () => {
    const kinds = new Set(
      [
        ...(
          /export function toolQuestion\([\s\S]*?\n\}/.exec(
            toolTextSource,
          )?.[0] ?? ""
        ).matchAll(/case "(\w+)":/g),
      ].map((m) => m[1]),
    );
    // Every case of the renderer's switch has a question here.
    expect(kinds.size).toBeGreaterThanOrEqual(8);
    expect(new Set(toolCases.map(([q]) => q.kind))).toEqual(kinds);
    for (const [question, code] of toolCases) {
      const plain = toolQuestion(question, [], clock);
      expect(approvalCode(plain), plain).toBe(code);
      const withEntities = toolQuestion(question, ["Dentist", "Monday"], clock);
      expect(approvalCode(withEntities), withEntities).toBe(code);
    }
    // A screen question is never taken for a tool's, whatever it starts with.
    expect(approvalCode("Send this message?")).toBe("SEND_MESSAGE");
    expect(approvalCode("Send this invitation?")).toBe("SEND_INVITATION");
    expect(approvalCode("Run or reload in this application?")).toBe(
      "RUN_RELOAD",
    );
  });
});
