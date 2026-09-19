import { describe, expect, it } from "vitest";
import { LONG_CATALOGUE } from "../src/gym/bench/catalogue-long";
import { MARKET_CATALOGUE } from "../src/gym/bench/catalogue-market";
import { BROWSER_APPS, FINDER, TEXTEDIT } from "../src/gym/bench/graders";
import { remainingLeftovers } from "../src/gym/bench/sweep";
import {
  CLOSE_DOCUMENT_SCRIPT,
  CLOSE_FINDER_WINDOW_SCRIPT,
  CLOSE_UNTITLED_SCRIPT,
  FIELD,
  RECORD,
  STRAY_DOCUMENT,
  WINDOW_LEFTOVERS,
  attemptWindows,
  closeBenchWindows,
  describeWindowSweep,
  dialogScript,
  documentKey,
  documentsScript,
  expandHome,
  finderWindowsScript,
  homeRelative,
  parseCount,
  parseDocuments,
  parseFinderWindows,
  parseTitles,
  readWindowSnapshot,
  snapshotApps,
  strayDocuments,
  strayDocumentsLine,
  titlesScript,
  underBenchRoot,
  withWindowFields,
  type FinderWindow,
  type OpenDocument,
  type WindowSnapshot,
} from "../src/gym/bench/windows";

const HOME = "/Users/someone";
const BENCH = `${HOME}/OpenAssistBench`;
const ICLOUD = `${HOME}/Library/Mobile Documents/com~apple~TextEdit/Documents`;
const TOKEN = "benchnote1a2b";
const NOTES = `${BENCH}/${TOKEN}/${TOKEN}-notes.txt`;

/** One record as the scripts print it. */
const rec = (...fields: string[]) => fields.join(FIELD) + RECORD;
/** A whole answer as osascript prints it: records, then the newline it adds. */
const answer = (...records: string[]) => records.join("") + "\n";

/**
 * A desktop the scripts run against: window titles by bundle id, TextEdit's
 * documents, the Finder's windows and how many sheets TextEdit shows. The
 * close scripts change it as TextEdit and the Finder would, and every call
 * is kept in order so a test can say what was sent and with which argument.
 */
function desktop(state: {
  titles?: Record<string, string[]>;
  documents?: OpenDocument[];
  finder?: FinderWindow[];
  dialogs?: number;
  textEditRunning?: boolean;
  /** Scripts that get no answer (a timeout) or an error line. */
  broken?: ("finder" | "dialog" | "documents" | "close")[];
  refused?: ("finder" | "titles")[];
}) {
  const calls: string[][] = [];
  const documents = [...(state.documents ?? [])];
  const finder = [...(state.finder ?? [])];
  const running = state.textEditRunning ?? true;
  const broken = new Set(state.broken ?? []);
  const refused = new Set(state.refused ?? []);
  const REFUSAL =
    "execution error: Not authorized to send Apple events to Finder. (-1743)\n";
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    expect(command).toBe("osascript");
    expect(args[0]).toBe("-e");
    const script = args[1];
    const argv = args.slice(2);
    if (script === finderWindowsScript()) {
      if (broken.has("finder")) return undefined;
      if (refused.has("finder")) return REFUSAL;
      return answer(...finder.map((w) => rec(String(w.id), w.target ?? "")));
    }
    if (script === documentsScript()) {
      if (broken.has("documents")) return undefined;
      if (!running) return "\n";
      return answer(
        ...documents.map((d) =>
          rec(d.name, d.path ?? "", d.modified ? "1" : "0"),
        ),
      );
    }
    if (script.includes("count of sheets")) {
      if (broken.has("dialog")) return undefined;
      return `${state.dialogs ?? 0}\n`;
    }
    if (script.includes('tell application "System Events"')) {
      if (refused.has("titles")) return REFUSAL;
      const id = /bundle identifier is "([^"]+)"/.exec(script)![1];
      const titles = state.titles?.[id];
      return titles ? answer(...titles.map((t) => rec(t))) : "\n";
    }
    if (script === CLOSE_FINDER_WINDOW_SCRIPT) {
      if (broken.has("close")) return undefined;
      const at = finder.findIndex((w) => String(w.id) === argv[0]);
      if (at < 0) return "absent\n";
      finder.splice(at, 1);
      return "closed\n";
    }
    if (script === CLOSE_DOCUMENT_SCRIPT || script === CLOSE_UNTITLED_SCRIPT) {
      if (broken.has("close")) return undefined;
      if (!running) return "absent\n";
      const at = documents.findIndex((d) =>
        script === CLOSE_DOCUMENT_SCRIPT
          ? d.path === argv[0]
          : d.path === undefined && d.name === argv[0],
      );
      if (at < 0) return "absent\n";
      if (documents[at].modified) return "modified\n";
      documents.splice(at, 1);
      return "closed\n";
    }
    throw new Error(`unexpected script:\n${script}`);
  };
  return { run, calls, documents, finder };
}

const closes = (calls: string[][]) =>
  calls
    .filter(
      (call) =>
        call[2] === CLOSE_DOCUMENT_SCRIPT ||
        call[2] === CLOSE_UNTITLED_SCRIPT ||
        call[2] === CLOSE_FINDER_WINDOW_SCRIPT,
    )
    .map((call) => [
      call[2] === CLOSE_FINDER_WINDOW_SCRIPT
        ? "finder"
        : call[2] === CLOSE_DOCUMENT_SCRIPT
          ? "document"
          : "untitled",
      call[3],
    ]);

describe("windows: the scripts", () => {
  const every = [
    titlesScript(TEXTEDIT),
    dialogScript(TEXTEDIT),
    documentsScript(),
    finderWindowsScript(),
    CLOSE_DOCUMENT_SCRIPT,
    CLOSE_UNTITLED_SCRIPT,
    CLOSE_FINDER_WINDOW_SCRIPT,
  ];

  it("never type, click, launch, save, quit or delete anything", () => {
    for (const script of every) {
      expect(script).not.toMatch(
        /keystroke|key code|\bclick\b|do shell script|\bquit\b|\bdelete\b|empty|\bmove\b|\bsave\b|\bmake\b|\bactivate\b|\blaunch\b|\bopen\b/,
      );
      // Closing is the one verb, and only ever without saving.
      if (script.includes("close d")) expect(script).toContain("saving no");
    }
    // A `tell` to an application that is not running would start it: every
    // script that talks to TextEdit checks first, and the Finder is always
    // running. System Events is asked by bundle id, as the preflight does.
    expect(documentsScript()).toMatch(
      /^if not \(application "TextEdit" is running\) then return ""/,
    );
    expect(CLOSE_DOCUMENT_SCRIPT).toContain(
      'if not (application "TextEdit" is running) then return "absent"',
    );
    expect(CLOSE_UNTITLED_SCRIPT).toContain(
      'if not (application "TextEdit" is running) then return "absent"',
    );
    expect(titlesScript(TEXTEDIT)).toContain(
      `bundle identifier is "${TEXTEDIT}"`,
    );
    expect(titlesScript(TEXTEDIT)).not.toContain('tell application "TextEdit"');
    expect(() => titlesScript('x" & (do shell script "id")')).toThrow();
    expect(() => dialogScript("bad id")).toThrow();
  });

  it("read the facts the rules need and take their argument through argv, never by interpolation", () => {
    expect(documentsScript()).toContain("path of d");
    expect(documentsScript()).toContain("modified of d");
    expect(finderWindowsScript()).toContain(
      "POSIX path of (target of w as alias)",
    );
    expect(finderWindowsScript()).toContain("id of w");
    expect(dialogScript(TEXTEDIT)).toContain("count of sheets of w");
    expect(dialogScript(TEXTEDIT)).toContain("AXDialog");
    // The close scripts check `modified` again themselves, right before
    // closing, and answer one of three words.
    for (const script of [CLOSE_DOCUMENT_SCRIPT, CLOSE_UNTITLED_SCRIPT]) {
      expect(script).toMatch(/^on run argv/);
      expect(script).toMatch(/set [pn] to item 1 of argv/);
      expect(script).toContain('if modified of d then return "modified"');
      expect(script).toContain('return "closed"');
      expect(script).toContain('return "absent"');
      expect(script).not.toMatch(/\$\{/);
    }
    expect(CLOSE_UNTITLED_SCRIPT).toContain("q is missing value");
    expect(CLOSE_DOCUMENT_SCRIPT).toContain("q is not missing value");
    expect(CLOSE_FINDER_WINDOW_SCRIPT).toContain("close Finder window id i");
    expect(CLOSE_FINDER_WINDOW_SCRIPT).toContain(
      'if not (exists Finder window id i) then return "absent"',
    );
  });
});

describe("windows: reading the answers", () => {
  it("parses titles, documents, Finder windows and a count, and says it cannot for anything else", () => {
    expect(parseTitles(answer(rec("Untitled"), rec("")))).toEqual([
      "Untitled",
      "",
    ]);
    expect(parseTitles("")).toEqual([]);
    expect(parseTitles("\n")).toEqual([]);
    expect(parseTitles(undefined)).toBeUndefined();
    expect(
      parseTitles(
        "execution error: Not authorized to send Apple events to System Events. (-1743)",
      ),
    ).toBeUndefined();
    // A cut answer (no separator after the last record) is not an answer.
    expect(parseTitles(`a${RECORD}b`)).toBeUndefined();

    expect(
      parseDocuments(
        answer(
          rec("Untitled", "", "1"),
          rec(`${TOKEN}-notes.txt`, NOTES, "0"),
          rec("Untitled.rtf", `${ICLOUD}/Untitled.rtf`, "0"),
        ),
      ),
    ).toEqual([
      { name: "Untitled", modified: true },
      { name: `${TOKEN}-notes.txt`, path: NOTES, modified: false },
      { name: "Untitled.rtf", path: `${ICLOUD}/Untitled.rtf`, modified: false },
    ]);
    expect(parseDocuments("\n")).toEqual([]);
    expect(parseDocuments(answer(rec("a", "b")))).toBeUndefined();
    expect(parseDocuments(answer(rec("a", "b", "yes")))).toBeUndefined();
    expect(parseDocuments(undefined)).toBeUndefined();

    expect(parseFinderWindows(answer(rec("12", BENCH), rec("13", "")))).toEqual(
      [{ id: 12, target: BENCH }, { id: 13 }],
    );
    expect(parseFinderWindows(answer(rec("x", BENCH)))).toBeUndefined();
    expect(parseFinderWindows(answer(rec("1")))).toBeUndefined();
    expect(parseFinderWindows("\n")).toEqual([]);

    expect(parseCount("0\n")).toBe(0);
    expect(parseCount("2")).toBe(2);
    expect(parseCount("execution error: ...")).toBeUndefined();
    expect(parseCount(undefined)).toBeUndefined();
    expect(parseCount("")).toBeUndefined();
  });

  it("tells a path under the bench folder from one beside it, and writes paths home-relative", () => {
    expect(underBenchRoot(BENCH, HOME)).toBe(true);
    expect(underBenchRoot(`${BENCH}/${TOKEN}`, HOME)).toBe(true);
    expect(underBenchRoot(NOTES, HOME)).toBe(true);
    expect(underBenchRoot(`~/OpenAssistBench/${TOKEN}`, HOME)).toBe(true);
    expect(underBenchRoot(`${HOME}/OpenAssistBenchX/a.txt`, HOME)).toBe(false);
    expect(underBenchRoot(`${BENCH}/../Documents/a.txt`, HOME)).toBe(false);
    expect(underBenchRoot(`${ICLOUD}/Untitled.rtf`, HOME)).toBe(false);
    expect(underBenchRoot("/Volumes/Other/OpenAssistBench/a", HOME)).toBe(
      false,
    );
    expect(homeRelative(`${ICLOUD}/Untitled.rtf`, HOME)).toBe(
      "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled.rtf",
    );
    expect(homeRelative(HOME, HOME)).toBe("~");
    expect(homeRelative(`${HOME}x/a`, HOME)).toBe(`${HOME}x/a`);
    expect(homeRelative("/Volumes/Other/a.txt", HOME)).toBe(
      "/Volumes/Other/a.txt",
    );
    expect(expandHome("~/Documents/a.txt", HOME)).toBe(
      `${HOME}/Documents/a.txt`,
    );
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("/Volumes/Other/a.txt", HOME)).toBe(
      "/Volumes/Other/a.txt",
    );
  });
});

describe("windows: what an attempt leaves", () => {
  const byId = (id: string) =>
    [...LONG_CATALOGUE, ...MARKET_CATALOGUE].find((task) => task.id === id)!;

  it("watches the Finder, the task's applications and the browser the harness chose, never another browser", () => {
    const text = byId("text-append-line");
    expect(snapshotApps(text)).toEqual([FINDER, TEXTEDIT]);
    const web = byId("browser-form-submit-local");
    expect(web.apps.some((id) => BROWSER_APPS.includes(id))).toBe(true);
    expect(snapshotApps(web)).toEqual([FINDER]);
    expect(snapshotApps(web, "com.apple.Safari")).toEqual([
      FINDER,
      "com.apple.Safari",
    ]);
    // Once each, whatever the task lists twice over.
    expect(snapshotApps({ apps: [FINDER, TEXTEDIT, TEXTEDIT] })).toEqual([
      FINDER,
      TEXTEDIT,
    ]);
    for (const task of [...LONG_CATALOGUE, ...MARKET_CATALOGUE]) {
      const watched = snapshotApps(task);
      expect(watched[0], task.id).toBe(FINDER);
      if (task.apps.includes(TEXTEDIT))
        expect(watched, task.id).toContain(TEXTEDIT);
      expect(
        watched.some((id) => BROWSER_APPS.includes(id)),
        task.id,
      ).toBe(false);
    }
  });

  it("snapshots titles per application and TextEdit's documents only while TextEdit runs", async () => {
    const d = desktop({
      titles: { [FINDER]: ["OpenAssistBench"], [TEXTEDIT]: ["Untitled"] },
      documents: [{ name: "Untitled", modified: false }],
    });
    const snapshot = await readWindowSnapshot(
      d.run,
      [FINDER, TEXTEDIT],
      new Set([TEXTEDIT]),
    );
    expect(snapshot).toEqual({
      titles: { [FINDER]: ["OpenAssistBench"], [TEXTEDIT]: ["Untitled"] },
      documents: [{ name: "Untitled", modified: false }],
    });
    expect(d.calls.map((call) => call[2])).toEqual([
      titlesScript(FINDER),
      titlesScript(TEXTEDIT),
      documentsScript(),
    ]);
    // ps says TextEdit is not running: not asked (an Apple Event would start it).
    d.calls.length = 0;
    const quiet = await readWindowSnapshot(
      d.run,
      [FINDER, TEXTEDIT],
      new Set(),
    );
    expect(quiet.documents).toBeUndefined();
    expect(d.calls).toHaveLength(2);
    // TextEdit not among the task's applications: not asked either.
    d.calls.length = 0;
    const other = await readWindowSnapshot(
      d.run,
      [FINDER],
      new Set([TEXTEDIT]),
    );
    expect(other.documents).toBeUndefined();
    expect(d.calls).toHaveLength(1);
    // ps unknown: asked, since the script itself refuses to launch.
    d.calls.length = 0;
    expect((await readWindowSnapshot(d.run, [TEXTEDIT])).documents).toEqual([
      { name: "Untitled", modified: false },
    ]);
    // A refused query is undefined, not an empty desktop.
    const refused = desktop({ refused: ["titles"] });
    expect((await readWindowSnapshot(refused.run, [FINDER])).titles).toEqual({
      [FINDER]: undefined,
    });
  });

  it("attributes to the attempt what is open after it and was not before, as a multiset, and nothing it could not read", () => {
    const before: WindowSnapshot = {
      titles: {
        [FINDER]: ["OpenAssistBench"],
        [TEXTEDIT]: ["Untitled", "plan.txt"],
        "com.apple.iCal": undefined,
      },
      documents: [
        { name: "Untitled", modified: false },
        {
          name: "plan.txt",
          path: `${HOME}/Documents/plan.txt`,
          modified: true,
        },
      ],
    };
    const after: WindowSnapshot = {
      titles: {
        [FINDER]: ["OpenAssistBench", `${TOKEN}`],
        // A second Untitled, the token document; plan.txt closed meanwhile.
        [TEXTEDIT]: ["Untitled", "Untitled", `${TOKEN}-notes.txt`],
        "com.apple.iCal": ["Calendar"],
      },
      documents: [
        { name: "Untitled", modified: false },
        { name: "Untitled 2", modified: false },
        { name: `${TOKEN}-notes.txt`, path: NOTES, modified: false },
        {
          name: "Untitled.rtf",
          path: `${ICLOUD}/Untitled.rtf`,
          modified: false,
        },
      ],
    };
    const left = attemptWindows(before, after);
    expect(left.windows).toEqual({ [FINDER]: 1, [TEXTEDIT]: 2 });
    expect(left.documents).toEqual([
      { name: "Untitled 2", modified: false },
      { name: `${TOKEN}-notes.txt`, path: NOTES, modified: false },
      { name: "Untitled.rtf", path: `${ICLOUD}/Untitled.rtf`, modified: false },
    ]);
    // Either reading missing: nothing is attributed on a partial view.
    expect(attemptWindows({ titles: {} }, after).documents).toEqual([]);
    expect(
      attemptWindows(before, { titles: { [TEXTEDIT]: undefined } }).windows,
    ).toEqual({});
    expect(documentKey({ name: "Untitled" })).toBe("name:Untitled");
    expect(documentKey({ name: "x", path: NOTES })).toBe(`path:${NOTES}`);
  });

  it("puts counts and the stray paths on the row, home-relative, and never a title", () => {
    const left = attemptWindows(
      { titles: { [TEXTEDIT]: [] }, documents: [] },
      {
        titles: { [TEXTEDIT]: ["Untitled.rtf", "Untitled copy.rtf"] },
        documents: [
          {
            name: "Untitled copy.rtf",
            path: `${ICLOUD}/Untitled copy.rtf`,
            modified: false,
          },
          {
            name: "Untitled.rtf",
            path: `${ICLOUD}/Untitled.rtf`,
            modified: false,
          },
          { name: `${TOKEN}-notes.txt`, path: NOTES, modified: false },
          { name: "Untitled 2", modified: true },
        ],
      },
    );
    expect(strayDocuments(left.documents, HOME)).toEqual([
      "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled copy.rtf",
      "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled.rtf",
    ]);
    const base: { leftovers?: string[]; taskId: string } = {
      leftovers: ["LEFTOVER_FILES"],
      taskId: "t",
    };
    const row = withWindowFields(base, left, HOME);
    expect(row).toEqual({
      taskId: "t",
      leftovers: ["LEFTOVER_FILES", STRAY_DOCUMENT],
      strayDocuments: [
        "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled copy.rtf",
        "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled.rtf",
      ],
      leftoverWindows: { [TEXTEDIT]: 2 },
    });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain("Untitled 2");
    expect(JSON.stringify(row)).not.toContain(HOME);
    // Nothing left: the row is unchanged, no empty fields added.
    const bare: { leftovers?: string[]; taskId: string } = { taskId: "t" };
    expect(
      withWindowFields(bare, { windows: {}, documents: [] }, HOME),
    ).toEqual({ taskId: "t" });
    expect(strayDocumentsLine([row, {}, row])).toBe(
      "Documents saved outside ~/OpenAssistBench, which the harness never deletes: ~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled copy.rtf, ~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled.rtf. Check each and delete it yourself.",
    );
    expect(strayDocumentsLine([{}])).toBeUndefined();
  });
});

describe("windows: the final sweep", () => {
  const open = () => ({
    finder: [
      { id: 1, target: BENCH },
      { id: 2, target: `${BENCH}/${TOKEN}` },
      { id: 3, target: `${HOME}/Documents` },
      { id: 4 },
    ] as FinderWindow[],
    documents: [
      // Under the bench folder, saved: the window is the file.
      { name: `${TOKEN}-notes.txt`, path: NOTES, modified: false },
      // Under the bench folder with unsaved changes: never.
      {
        name: `${TOKEN}-draft.txt`,
        path: `${BENCH}/${TOKEN}/${TOKEN}-draft.txt`,
        modified: true,
      },
      // Saved by an attempt of this process into iCloud, unmodified.
      { name: "Untitled.rtf", path: `${ICLOUD}/Untitled.rtf`, modified: false },
      // Saved by an earlier night's attempt: on its row as a path.
      {
        name: "Untitled copy.rtf",
        path: `${ICLOUD}/Untitled copy.rtf`,
        modified: false,
      },
      // The person's: nobody's here.
      { name: "plan.txt", path: `${HOME}/Documents/plan.txt`, modified: false },
      // An empty Untitled an attempt opened and never typed into.
      { name: "Untitled 2", modified: false },
      // An Untitled an attempt typed into and never saved.
      { name: "Untitled 3", modified: true },
    ] as OpenDocument[],
  });
  const attempts: OpenDocument[] = [
    { name: "Untitled.rtf", path: `${ICLOUD}/Untitled.rtf`, modified: false },
    { name: "Untitled 2", modified: false },
    { name: "Untitled 3", modified: false },
  ];
  const paths = [
    "~/Library/Mobile Documents/com~apple~TextEdit/Documents/Untitled copy.rtf",
  ];

  it("closes what holds nothing and only that, one Apple Event each, with the path as an argument", async () => {
    const d = desktop(open());
    const sweep = await closeBenchWindows({
      run: d.run,
      home: HOME,
      documents: attempts,
      paths,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep).toEqual({
      closedDocuments: 4,
      closedFinderWindows: 2,
      modifiedDocuments: 2,
      otherDocuments: 1,
      dialog: false,
      unread: [],
      leftovers: [WINDOW_LEFTOVERS.modified],
    });
    expect(closes(d.calls)).toEqual([
      ["finder", "1"],
      ["finder", "2"],
      ["document", NOTES],
      ["document", `${ICLOUD}/Untitled.rtf`],
      ["document", `${ICLOUD}/Untitled copy.rtf`],
      ["untitled", "Untitled 2"],
    ]);
    // What stays: the person's window and folder, the modified documents.
    expect(d.finder.map((w) => w.id)).toEqual([3, 4]);
    expect(d.documents.map((doc) => doc.name)).toEqual([
      `${TOKEN}-draft.txt`,
      "plan.txt",
      "Untitled 3",
    ]);
    // No path is ever written into a script.
    for (const call of d.calls) expect(call[2]).not.toContain(HOME);
    // The dialog check comes before any TextEdit document is touched.
    const order = d.calls.map((call) => call[2]);
    expect(order.indexOf(dialogScript(TEXTEDIT))).toBeLessThan(
      order.indexOf(documentsScript()),
    );
    expect(describeWindowSweep(sweep)).toBe(
      "Closed 4 TextEdit document(s) and 2 Finder window(s) the attempts left on ~/OpenAssistBench. 2 document(s) with unsaved changes stay open: save or discard them yourself. 1 other TextEdit document(s) stay open; they are not the benchmark's to close, and a task listing TextEdit is skipped while they are.",
    );
    // What stands after the sweep, beside the rows' own codes: a modified
    // document; a stray document's path is no sweep's to clear.
    expect(
      remainingLeftovers(
        [{ leftovers: [STRAY_DOCUMENT, "LEFTOVER_STRAY_FILE"] }],
        [],
        sweep,
      ),
    ).toEqual([WINDOW_LEFTOVERS.modified, STRAY_DOCUMENT]);
    expect(remainingLeftovers([{ leftovers: [STRAY_DOCUMENT] }], [])).toEqual([
      STRAY_DOCUMENT,
    ]);
  });

  it("closes a bench document and Finder windows with no attempt record at all (--cleanup-only)", async () => {
    const d = desktop(open());
    const sweep = await closeBenchWindows({
      run: d.run,
      home: HOME,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep.closedDocuments).toBe(1);
    expect(sweep.closedFinderWindows).toBe(2);
    expect(sweep.modifiedDocuments).toBe(1);
    // The iCloud documents, plan.txt and the Untitleds are nobody's here:
    // untouched.
    expect(sweep.otherDocuments).toBe(5);
    expect(closes(d.calls)).toEqual([
      ["finder", "1"],
      ["finder", "2"],
      ["document", NOTES],
    ]);
  });

  it("clicks nothing with a dialog up, asks TextEdit nothing while it is not running, and reports what did not answer", async () => {
    const dialog = desktop({ ...open(), dialogs: 1 });
    let sweep = await closeBenchWindows({
      run: dialog.run,
      home: HOME,
      documents: attempts,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep.dialog).toBe(true);
    expect(sweep.closedDocuments).toBe(0);
    expect(sweep.closedFinderWindows).toBe(2);
    expect(sweep.leftovers).toEqual([WINDOW_LEFTOVERS.dialog]);
    expect(dialog.calls.map((call) => call[2])).not.toContain(
      documentsScript(),
    );
    expect(closes(dialog.calls).every(([kind]) => kind === "finder")).toBe(
      true,
    );
    expect(describeWindowSweep(sweep)).toContain(
      "A dialog is up in TextEdit: nothing there was clicked or closed; dismiss it yourself.",
    );

    const quiet = desktop({ ...open(), textEditRunning: false });
    sweep = await closeBenchWindows({
      run: quiet.run,
      home: HOME,
      documents: attempts,
      running: new Set(),
    });
    expect(sweep.closedFinderWindows).toBe(2);
    expect(sweep.closedDocuments).toBe(0);
    expect(sweep.leftovers).toEqual([]);
    for (const call of quiet.calls)
      expect(call[2]).not.toContain('tell application "TextEdit"');
    expect(quiet.calls.map((call) => call[2])).not.toContain(
      dialogScript(TEXTEDIT),
    );

    const refused = desktop({ ...open(), refused: ["finder"] });
    sweep = await closeBenchWindows({
      run: refused.run,
      home: HOME,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep.unread).toEqual([FINDER]);
    expect(sweep.closedFinderWindows).toBe(0);
    expect(sweep.closedDocuments).toBe(1);
    // The bench draft with unsaved changes stands as before.
    expect(sweep.leftovers).toEqual([
      WINDOW_LEFTOVERS.modified,
      WINDOW_LEFTOVERS.unverified,
    ]);
    expect(describeWindowSweep(sweep)).toContain(
      `${FINDER} did not answer (no Automation consent from this terminal, or a hung query): nothing there was closed.`,
    );

    const hung = desktop({ ...open(), broken: ["dialog"] });
    sweep = await closeBenchWindows({
      run: hung.run,
      home: HOME,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep.unread).toEqual([TEXTEDIT]);
    expect(sweep.closedDocuments).toBe(0);
    expect(hung.calls.map((call) => call[2])).not.toContain(documentsScript());

    const noAnswer = desktop({ ...open(), broken: ["close"] });
    sweep = await closeBenchWindows({
      run: noAnswer.run,
      home: HOME,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep.closedDocuments).toBe(0);
    expect(sweep.closedFinderWindows).toBe(0);
    expect(sweep.unread).toEqual([FINDER, TEXTEDIT]);
    expect(sweep.leftovers).toEqual([
      WINDOW_LEFTOVERS.modified,
      WINDOW_LEFTOVERS.unverified,
    ]);
  });

  it("re-checks modified in the close itself: a document typed into since the listing stays", async () => {
    // The listing says unmodified; by the close TextEdit says otherwise.
    const d = desktop({
      documents: [{ name: `${TOKEN}-notes.txt`, path: NOTES, modified: false }],
    });
    d.documents[0].modified = true;
    const sweep = await closeBenchWindows({
      run: d.run,
      home: HOME,
      running: new Set([TEXTEDIT]),
    });
    expect(sweep.closedDocuments).toBe(0);
    expect(sweep.modifiedDocuments).toBe(1);
    expect(d.documents).toHaveLength(1);
  });
});
