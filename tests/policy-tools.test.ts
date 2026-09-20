import { describe, expect, it } from "vitest";
import {
  actionSchema,
  defaultSettings,
  type Action,
  type Settings,
  type Surface,
} from "../src/core/schema";
import { evaluate, type PolicyContext } from "../src/core/policy";
import { TOOL_ALLOWED, toolGrounding } from "../src/core/tool-policy";
import { TOOL_LIMITS, TOOL_REFUSALS, type ToolSpec } from "../src/core/tools";
import {
  AGENT,
  CALENDAR_ADD,
  CALENDAR_LIST,
  CLOCK,
  FAKE_HOME,
  FILES_APPEND,
  FILES_READ,
  FILES_REPLACE,
  FS_LIST,
  FS_WRITE,
  GH_SEARCH,
  REMINDER_ADD,
  SCRATCH_DELETE,
  SHELL,
  prepare,
} from "./tool-fakes";

/**
 * The tier × autonomy table of .data/design/mcp-lanes.md §2.3, and the
 * refusals every tool step passes first. Reasons for ALLOW, DENY and RETRY
 * are fixed strings; only a question carries content.
 */
const surface: Surface = {
  appId: "com.apple.Notes",
  pid: 7,
  secureInput: false,
  unknown: false,
};
type Autonomy = Settings["autonomy"];
const MODES: Autonomy[] = ["ask", "task", "flow", "all"];
const settingsFor = (
  autonomy: Autonomy,
  patch: Partial<Settings> = {},
): Settings => ({
  ...structuredClone(defaultSettings),
  privacy: "PRIVATE_BYOM",
  autonomy,
  autonomyAllAcknowledged: autonomy === "all",
  ...patch,
});
const call = (tool: string, args: Record<string, unknown>): Action =>
  actionSchema.parse({ type: "tool_call", frame_id: "f", tool, args });
const context = (
  spec: ToolSpec,
  args: Record<string, unknown>,
  o: { userWords?: string; calls?: number } = {},
): PolicyContext => ({
  // The runner hands prepare the same words policy grounds on.
  tool: {
    spec,
    prepared: prepare(spec, args, { userWords: o.userWords }),
    calls: o.calls ?? 0,
  },
  clock: CLOCK,
  ...(o.userWords !== undefined ? { userWords: o.userWords } : {}),
});
const decide = (
  spec: ToolSpec,
  args: Record<string, unknown>,
  autonomy: Autonomy,
  o: { userWords?: string; calls?: number; settings?: Partial<Settings> } = {},
) =>
  evaluate(
    call(spec.id, args),
    surface,
    settingsFor(autonomy, o.settings),
    false,
    context(spec, args, o),
  );
const kinds = (
  spec: ToolSpec,
  args: Record<string, unknown>,
  o: { userWords?: string } = {},
) => Object.fromEntries(MODES.map((m) => [m, decide(spec, args, m, o).kind]));

const DENTIST = { title: "Dentist", start: "2026-09-19T18:00" };
const DENTIST_WORDS = "add dentist tomorrow at 6 PM to my calendar";

describe("toolDecision: the tier table", () => {
  it("allows a read on a trusted tool in every mode", () => {
    const args = { from: "2026-09-24T00:00", to: "2026-09-24T23:59" };
    expect(kinds(CALENDAR_LIST, args)).toEqual({
      ask: "ALLOW",
      task: "ALLOW",
      flow: "ALLOW",
      all: "ALLOW",
    });
    expect(decide(CALENDAR_LIST, args, "ask").reason).toBe(TOOL_ALLOWED.read);
  });
  it("asks for a read on an untrusted server, except under all", () => {
    const args = { path: "/Users/me/oa-scratch" };
    expect(kinds(FS_LIST, args)).toEqual({
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "CONFIRM",
      all: "ALLOW",
    });
    expect(decide(FS_LIST, args, "task").reason).toBe(
      "Use Filesystem to read with list_directory?",
    );
    expect(decide(FS_LIST, args, "all").reason).toBe(TOOL_ALLOWED.unasked);
    // "all" without the acknowledgement behaves as "flow".
    expect(
      decide(FS_LIST, args, "all", {
        settings: { autonomyAllAcknowledged: false },
      }).kind,
    ).toBe("CONFIRM");
  });
  it("asks as send_to when entities the user never said leave for an open-world server, and that floor survives all", () => {
    const args = { query: "issues from dana.k@proton.me" };
    for (const mode of MODES) {
      const d = decide(GH_SEARCH, args, mode, { userWords: "search github" });
      expect([mode, d.kind]).toEqual([mode, "CONFIRM"]);
      expect(d.reason).toBe("Send dana.k@proton.me to GitHub?");
      expect(d.floor).toBe(true);
    }
    // The same entity in the user's own words is grounded: a trusted read.
    expect(
      decide(GH_SEARCH, args, "ask", {
        userWords: "search github for issues from dana.k@proton.me",
      }),
    ).toEqual({ kind: "ALLOW", reason: TOOL_ALLOWED.read });
    // Without the user's words every entity is ungrounded.
    expect(decide(GH_SEARCH, args, "all").kind).toBe("CONFIRM");
    // A write with an ungrounded entity keeps its own question, and under
    // all still asks as send_to rather than running unasked.
    const write = { path: "/tmp/x", content: "call 415 555 0100" };
    expect(
      decide(FS_WRITE, { ...write }, "task", { userWords: "save it" }).reason,
    ).toBe("Use Filesystem to run write_file, with 415 555 0100?");
    const under = decide({ ...FS_WRITE, openWorld: true }, write, "all", {
      userWords: "save it",
    });
    expect(under).toMatchObject({ kind: "CONFIRM", floor: true });
    expect(under.reason).toBe("Send 415 555 0100 to Filesystem?");
  });
  it("runs a grounded additive add under task, flow and all, and asks under ask", () => {
    expect(kinds(CALENDAR_ADD, DENTIST, { userWords: DENTIST_WORDS })).toEqual({
      ask: "CONFIRM",
      task: "ALLOW",
      flow: "ALLOW",
      all: "ALLOW",
    });
    expect(
      decide(CALENDAR_ADD, DENTIST, "task", { userWords: DENTIST_WORDS })
        .reason,
    ).toBe(TOOL_ALLOWED.grounded);
    expect(
      decide(CALENDAR_ADD, DENTIST, "flow", { userWords: DENTIST_WORDS })
        .reason,
    ).toBe(TOOL_ALLOWED.undoable);
    expect(
      decide(CALENDAR_ADD, DENTIST, "ask", { userWords: DENTIST_WORDS }).reason,
    ).toBe("Add Dentist to Calendar, tomorrow, Saturday 19 September, 6 PM?");
  });
  it("asks for an additive add under task when the words do not cover it", () => {
    // Another title, another day, another hour, a rewrite: each asks.
    for (const [args, words] of [
      [{ title: "Dentist visit", start: "2026-09-19T18:00" }, DENTIST_WORDS],
      [{ title: "Dentist", start: "2026-09-20T18:00" }, DENTIST_WORDS],
      [{ title: "Dentist", start: "2026-09-19T17:00" }, DENTIST_WORDS],
      [DENTIST, undefined],
    ] as const) {
      const d = decide(CALENDAR_ADD, { ...args }, "task", {
        ...(words ? { userWords: words } : {}),
      });
      expect(d.kind).toBe("CONFIRM");
      expect(d.reason).toMatch(/^Add .* to Calendar, /);
    }
    // A reminder without a due date is grounded by its title alone.
    expect(
      decide(REMINDER_ADD, { title: "Milk" }, "task", {
        userWords: "add milk to my reminders",
      }).kind,
    ).toBe("ALLOW");
    // An additive tool without an inverse asks like a write.
    expect(
      kinds({ ...CALENDAR_ADD, undoable: false }, DENTIST, {
        userWords: DENTIST_WORDS,
      }),
    ).toEqual({
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "CONFIRM",
      all: "ALLOW",
    });
  });
  it("asks for writes and destructive calls, the Agent included, except under all", () => {
    const table = {
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "CONFIRM",
      all: "ALLOW",
    };
    expect(kinds(FS_WRITE, { path: "/tmp/a", content: "hi" })).toEqual(table);
    expect(kinds(SCRATCH_DELETE, {})).toEqual(table);
    expect(kinds(AGENT, { prompt: "fix the failing test" })).toEqual(table);
    expect(
      decide(FS_WRITE, { path: "/tmp/a", content: "hi" }, "task").reason,
    ).toBe("Use Filesystem to run write_file?");
    expect(decide(SCRATCH_DELETE, {}, "flow").reason).toBe(
      "Use Scratch to run notes_delete_all?",
    );
    expect(
      decide(AGENT, { prompt: "fix the failing test" }, "task").reason,
    ).toBe("Run Claude Code in butler-app?");
    expect(decide(AGENT, { prompt: "fix it" }, "all").reason).toBe(
      TOOL_ALLOWED.unasked,
    );
  });
});

/**
 * The files tool under the same table: a trusted read runs; an append the
 * user's words named by its path runs under task (the path grounds it, the
 * text is the page's, not the words'), flow and all; a write replacing the
 * file runs under task and flow only when the words named the file; a path
 * the tool refuses retries with the fixed sentence before any question.
 */
describe("toolDecision: the files tool", () => {
  const NOTES = "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt";
  const NOTE_WORDS =
    "In Safari, go to 127.0.0.1:47831/benchnote0a1b/report, find the Q3 total near the bottom of the page, and write it on a new line in ~/OpenAssistBench/benchnote0a1b/benchnote0a1b-notes.txt. Save it.";
  const LINE = { path: NOTES, text: "Q3 total 15,888" };
  it("runs a read in every mode, as any trusted read", () => {
    expect(kinds(FILES_READ, { path: NOTES })).toEqual({
      ask: "ALLOW",
      task: "ALLOW",
      flow: "ALLOW",
      all: "ALLOW",
    });
    expect(decide(FILES_READ, { path: NOTES }, "ask").reason).toBe(
      TOOL_ALLOWED.read,
    );
  });
  it("runs an append the words named by its path under task, flow and all, whatever the text says", () => {
    expect(kinds(FILES_APPEND, LINE, { userWords: NOTE_WORDS })).toEqual({
      ask: "CONFIRM",
      task: "ALLOW",
      flow: "ALLOW",
      all: "ALLOW",
    });
    expect(
      decide(FILES_APPEND, LINE, "task", { userWords: NOTE_WORDS }).reason,
    ).toBe(TOOL_ALLOWED.grounded);
    expect(
      decide(FILES_APPEND, LINE, "flow", { userWords: NOTE_WORDS }).reason,
    ).toBe(TOOL_ALLOWED.undoable);
    expect(
      decide(FILES_APPEND, LINE, "ask", { userWords: NOTE_WORDS }).reason,
    ).toBe("Add to benchnote0a1b-notes.txt: Q3 total 15,888?");
    // The text came off the page: three lines the words never said, an
    // amount and an address in them, and the path still grounds the call.
    expect(
      decide(
        FILES_APPEND,
        {
          path: NOTES,
          text: "Crane inspection 09:30\n14 workers on site\nSafety alert: scaffold B, call 415 555 0100, $2,400",
        },
        "task",
        { userWords: NOTE_WORDS },
      ),
    ).toEqual({ kind: "ALLOW", reason: TOOL_ALLOWED.grounded });
    // The absolute form of the same file grounds as its ~/ form.
    expect(
      decide(
        FILES_APPEND,
        { ...LINE, path: `${FAKE_HOME}/${NOTES.slice(2)}` },
        "task",
        { userWords: NOTE_WORDS },
      ).kind,
    ).toBe("ALLOW");
  });
  it("asks for an append to a file the words did not name, except under all", () => {
    for (const words of [
      "write the Q3 total into the notes file",
      "write it into ~/OpenAssistBench/benchnote0a1b/benchnote0a1b-kpi.txt",
      "write it into ~/Documents/benchnote0a1b-notes.txt",
      undefined,
    ]) {
      const d = decide(FILES_APPEND, LINE, "task", {
        ...(words ? { userWords: words } : {}),
      });
      expect([words, d.kind]).toEqual([words, "CONFIRM"]);
      expect(d.reason).toBe("Add to benchnote0a1b-notes.txt: Q3 total 15,888?");
    }
    expect(kinds(FILES_APPEND, LINE, { userWords: "save it" })).toEqual({
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "ALLOW",
      all: "ALLOW",
    });
  });
  it("refuses to erase a file that holds text unless the words ask for it: the fixed retry in every mode, all included, before any question", () => {
    // Probe cycle 20260919-1952: the note tasks say "write <fact> into
    // <path>", the tool then named write_text_file matched the verb, and
    // the header line went with the file (2 of 3 tool-route notes). The
    // rule is the tool's, at prepare; policy retries with the one sentence.
    const table = { path: NOTES, text: "name,price,days\nAcme,120,3" };
    for (const words of [NOTE_WORDS, "fill in the table", undefined])
      for (const mode of MODES) {
        const d = decide(FILES_REPLACE, table, mode, {
          ...(words ? { userWords: words } : {}),
        });
        expect([words, mode, d]).toEqual([
          words,
          mode,
          { kind: "RETRY", reason: TOOL_REFUSALS.would_erase },
        ]);
      }
    expect(TOOL_REFUSALS.would_erase).toMatch(/^No input was sent\./);
    expect(TOOL_REFUSALS.would_erase).toContain("append_text_file");
    // The append on the same file and words is the route it names.
    expect(
      decide(FILES_APPEND, LINE, "task", { userWords: NOTE_WORDS }),
    ).toEqual({ kind: "ALLOW", reason: TOOL_ALLOWED.grounded });
    // A credential in the text is the floor, ahead of the retry.
    for (const mode of MODES)
      expect(
        decide(
          FILES_REPLACE,
          { path: NOTES, text: "api_key=sk-abcdefghijklmnopqrst" },
          mode,
          { userWords: NOTE_WORDS },
        ),
      ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.credential });
  });
  it("runs a replace the words asked for only when they named the file, under task and flow, and always under all", () => {
    const table = { path: NOTES, text: "name,price,days\nAcme,120,3" };
    const REPLACE_WORDS = `Replace what ${NOTES} holds with the price table from the page, then save it.`;
    expect(kinds(FILES_REPLACE, table, { userWords: REPLACE_WORDS })).toEqual({
      ask: "CONFIRM",
      task: "ALLOW",
      flow: "ALLOW",
      all: "ALLOW",
    });
    expect(
      decide(FILES_REPLACE, table, "task", { userWords: REPLACE_WORDS }).reason,
    ).toBe(TOOL_ALLOWED.grounded_write);
    // Words that asked to replace but did not name the file: the question,
    // except under all.
    expect(
      kinds(FILES_REPLACE, table, { userWords: "overwrite the notes file" }),
    ).toEqual({
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "CONFIRM",
      all: "ALLOW",
    });
    expect(
      decide(FILES_REPLACE, table, "task", {
        userWords: "overwrite the notes file",
      }).reason,
    ).toBe(
      "Change benchnote0a1b-notes.txt, replacing what it holds with: name,price,days Acme,120,3?",
    );
    // A file with nothing in it needs no replacing word: the table as before.
    const fresh = {
      path: "~/OpenAssistBench/benchnote0a1b/benchnote0a1b-compare.csv",
      text: "name,price,days\nAcme,120,3",
    };
    expect(
      kinds(FILES_REPLACE, fresh, { userWords: "fill in the table" }),
    ).toEqual({
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "CONFIRM",
      all: "ALLOW",
    });
    expect(
      kinds(FILES_REPLACE, fresh, {
        userWords: `put the table in ${fresh.path}`,
      }).task,
    ).toBe("ALLOW");
    // Without an undo of its own a write asks however the words read; an
    // untrusted or open-world write keeps its question too.
    expect(
      kinds({ ...FILES_REPLACE, undoable: false }, table, {
        userWords: REPLACE_WORDS,
      }),
    ).toEqual({
      ask: "CONFIRM",
      task: "CONFIRM",
      flow: "CONFIRM",
      all: "ALLOW",
    });
    expect(
      kinds({ ...FILES_REPLACE, trusted: false }, table, {
        userWords: REPLACE_WORDS,
      }).task,
    ).toBe("CONFIRM");
    expect(
      kinds({ ...FILES_REPLACE, openWorld: true }, table, {
        userWords: REPLACE_WORDS,
      }).task,
    ).toBe("CONFIRM");

    // The MCP write the words happen to name still asks: not trusted.
    expect(
      decide(FS_WRITE, { path: "/tmp/a", content: "hi" }, "task", {
        userWords: "write hi to /tmp/a",
      }).kind,
    ).toBe("CONFIRM");
  });
  it("retries a refused path with the fixed sentence in every mode, before any question", () => {
    for (const path of [
      "~/.ssh/id_rsa",
      "/etc/hosts",
      "~/Library/Keychains/login.keychain-db",
      "~/Documents/../.ssh/config",
    ])
      for (const mode of MODES) {
        const d = decide(FILES_APPEND, { path, text: "x" }, mode, {
          userWords: `write x into ${path}`,
        });
        expect([path, mode, d]).toEqual([
          path,
          mode,
          { kind: "RETRY", reason: TOOL_REFUSALS.bad_path },
        ]);
      }
    expect(TOOL_REFUSALS.bad_path).toMatch(/^No input was sent\./);
  });
  it("keeps the floors: a credential in the text is denied, the tool budget and the master switch hold", () => {
    for (const mode of MODES)
      expect(
        decide(
          FILES_APPEND,
          { path: NOTES, text: "api_key=sk-abcdefghijklmnopqrst" },
          mode,
          { userWords: NOTE_WORDS },
        ),
      ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.credential });
    expect(
      decide(FILES_APPEND, LINE, "all", { calls: TOOL_LIMITS.callsPerRun }),
    ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.budget });
    expect(
      decide(FILES_APPEND, LINE, "all", {
        settings: { tools: { ...defaultSettings.tools, enabled: false } },
      }),
    ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.privacy });
    // Private local keeps it: nothing leaves the Mac.
    expect(
      decide(FILES_APPEND, LINE, "task", {
        userWords: NOTE_WORDS,
        settings: { privacy: "PRIVATE_LOCAL" },
      }).kind,
    ).toBe("ALLOW");
  });
});

describe("toolDecision: refusals never change with the setting", () => {
  it("retries in a practice run", () => {
    for (const mode of MODES)
      expect(
        evaluate(
          call(CALENDAR_LIST.id, {}),
          surface,
          settingsFor(mode),
          true,
          context(CALENDAR_LIST, {}),
        ),
      ).toEqual({ kind: "RETRY", reason: TOOL_REFUSALS.practice });
  });
  it("retries a tool that is not in the run's list", () => {
    for (const mode of MODES)
      expect(
        evaluate(
          call("apple__nothing", {}),
          surface,
          settingsFor(mode),
          false,
          {
            clock: CLOCK,
          },
        ),
      ).toEqual({ kind: "RETRY", reason: TOOL_REFUSALS.unknown_tool });
  });
  it("denies a denylisted name however it was listed", () => {
    for (const mode of MODES)
      expect(decide(SHELL, { path: "." }, mode)).toEqual({
        kind: "DENY",
        reason: TOOL_REFUSALS.denylisted,
      });
  });
  it("denies a credential in any string leaf or key of the arguments", () => {
    const nested = {
      path: "/tmp/a",
      content: { notes: [{ "api_key=sk-abcdefghijklmnopqrst": "x" }] },
    };
    const leaf = {
      path: "/tmp/a",
      content: "token: eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMe",
    };
    for (const mode of MODES) {
      expect(decide(FS_WRITE, nested, mode)).toEqual({
        kind: "DENY",
        reason: TOOL_REFUSALS.credential,
      });
      expect(decide(FS_WRITE, leaf, mode)).toEqual({
        kind: "DENY",
        reason: TOOL_REFUSALS.credential,
      });
    }
    // Even the user's own words never lift it.
    expect(
      decide(FS_WRITE, leaf, "task", { userWords: `write ${leaf.content}` })
        .kind,
    ).toBe("DENY");
  });
  it("retries invalid arguments with the fixed text", () => {
    expect(decide(CALENDAR_ADD, { start: "2026-09-19T18:00" }, "task")).toEqual(
      {
        kind: "RETRY",
        reason: TOOL_REFUSALS.invalid_args,
      },
    );
    const spec = FS_LIST;
    const prepared = { ok: false as const, problem: "too_large" as const };
    expect(
      evaluate(call(spec.id, {}), surface, settingsFor("all"), false, {
        tool: { spec, prepared, calls: 0 },
        clock: CLOCK,
      }),
    ).toEqual({ kind: "RETRY", reason: TOOL_REFUSALS.too_large });
  });
  it("denies the twenty-first call of a run", () => {
    const args = { from: "2026-09-24T00:00", to: "2026-09-24T23:59" };
    expect(
      decide(CALENDAR_LIST, args, "all", { calls: TOOL_LIMITS.callsPerRun - 1 })
        .kind,
    ).toBe("ALLOW");
    expect(
      decide(CALENDAR_LIST, args, "all", { calls: TOOL_LIMITS.callsPerRun }),
    ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.budget });
  });
  it("denies what the privacy mode forbids, in both modes", () => {
    const local = { privacy: "PRIVATE_LOCAL" as const };
    // A remote server never runs in private local; a local stdio server and
    // the bridge do.
    expect(
      decide(GH_SEARCH, { query: "butler" }, "all", { settings: local }),
    ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.privacy });
    expect(
      decide(FS_LIST, { path: "/tmp" }, "all", { settings: local }).kind,
    ).toBe("ALLOW");
    expect(
      decide({ ...FS_LIST, local: false }, { path: "/tmp" }, "all", {
        settings: local,
      }),
    ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.privacy });
    // BYOM runs them all; the master switch off runs none.
    expect(decide(GH_SEARCH, { query: "butler" }, "all").kind).toBe("ALLOW");
    expect(
      decide(CALENDAR_LIST, { from: "a", to: "b" }, "all", {
        settings: {
          tools: { ...defaultSettings.tools, enabled: false },
        },
      }),
    ).toEqual({ kind: "DENY", reason: TOOL_REFUSALS.privacy });
  });
  it("comes before the tier: a credential is denied even where a read would run", () => {
    expect(
      decide(
        CALENDAR_LIST,
        { from: "2026-09-24", to: "sk-abcdefghijklmnopqrst" },
        "all",
      ).kind,
    ).toBe("DENY");
  });
});

describe("toolGrounding", () => {
  it("skips dates but keeps every other entity", () => {
    // The registry leaves date-typed values out of groundText (measured:
    // ENTITY flags "2026" in "2026-09-19T18:00"); a phone number stays.
    const g = toolGrounding(
      ["Call Dana at 415 555 0100"],
      "remind me to call dana",
      {
        dates: ["2026-09-19T18:00"],
        clock: CLOCK,
      },
    );
    expect(g.ungrounded).toEqual(["415 555 0100"]);
    expect(g.grounded).toBe(false);
    const said = toolGrounding(
      ["Call Dana at 415 555 0100"],
      "remind me to call Dana at 415 555 0100 tomorrow at 6",
      { dates: ["2026-09-19T18:00"], clock: CLOCK },
    );
    expect(said).toEqual({ ungrounded: [], grounded: true });
  });
  it("treats every entity as ungrounded without the user's words", () => {
    expect(
      toolGrounding(["dana.k@proton.me", "plain words"], undefined, {
        dates: [],
        clock: CLOCK,
      }),
    ).toEqual({ ungrounded: ["dana.k@proton.me"], grounded: false });
  });
  it("needs the day and the hour of a date in the words", () => {
    const at = (dates: string[], words: string) =>
      toolGrounding(["Dentist"], words, { dates, clock: CLOCK }).grounded;
    expect(at(["2026-09-19T18:00"], "add dentist tomorrow at 6 pm")).toBe(true);
    expect(at(["2026-09-19T18:00"], "add dentist tomorrow at 6pm")).toBe(true);
    expect(at(["2026-09-19T18:00"], "add dentist tomorrow at 18:00")).toBe(
      true,
    );
    expect(at(["2026-09-19T18:30"], "add dentist tomorrow at 6:30")).toBe(true);
    expect(at(["2026-09-19T18:30"], "add dentist tomorrow at 6")).toBe(false);
    expect(at(["2026-09-19T18:00"], "add dentist saturday at 6")).toBe(true);
    expect(at(["2026-09-24T15:00"], "add dentist thursday at 3")).toBe(true);
    expect(at(["2026-10-15T15:00"], "add dentist thursday at 3")).toBe(false);
    expect(
      at(["2026-09-24T15:00"], "add dentist on the 24th of september at 3"),
    ).toBe(true);
    expect(at(["2026-09-18T12:00"], "add dentist today at noon")).toBe(true);
    expect(at(["2026-09-19T18:00"], "add dentist at 6")).toBe(false);
    expect(at(["2026-09-19T18:00"], "add dentist tomorrow")).toBe(false);
    expect(at(["2026-09-19"], "add dentist tomorrow")).toBe(true);
    expect(at(["not a date"], "add dentist tomorrow")).toBe(false);
  });
  it("needs every content word of the free-text arguments in the words", () => {
    const words = (text: string) =>
      toolGrounding([text], "add the dentist appointment tomorrow at 6", {
        dates: [],
        clock: CLOCK,
      }).grounded;
    expect(words("Dentist appointment")).toBe(true);
    expect(words("Dentist")).toBe(true);
    expect(words("Dentist with Dr Lee")).toBe(false);
    expect(words("")).toBe(true);
  });
});
