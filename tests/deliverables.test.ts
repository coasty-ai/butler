import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERABLE_EXTENSIONS,
  DELIVERABLE_MISSING,
  DeliverableMissingError,
  WRITING_VERBS,
  deliverableChallenge,
  deliverableMissing,
  deliverablePaths,
  sameFacts,
} from "../src/core/deliverables";
import { fileFactsReader } from "../src/storage/files";
import { MODEL_RESULT_CHARS } from "../src/core/runner";
import { MARKET_CATALOGUE } from "../src/gym/bench/catalogue-market";
import { LONG_CATALOGUE } from "../src/gym/bench/catalogue-long";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TOKEN = "abc12345678";
const BENCH = `~/OpenAssistBench/${TOKEN}`;
/** The bench's own fill (graders.ts fillInstruction) with fixed parameters. */
const fill = (instruction: string) =>
  instruction.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name === "benchPath"
      ? BENCH
      : name === "token"
        ? TOKEN
        : name === "site"
          ? "http://127.0.0.1:8765"
          : name === "browser"
            ? "Safari"
            : "x",
  );
const BENCH_FILE = new RegExp(
  `${BENCH.replace(/[/.]/g, "\\$&")}/${TOKEN}-[a-z]+\\.(?:txt|csv)`,
);

/**
 * The tasks whose instruction names a bench file the model need not change:
 * the conditional write (the file may rightly stay as it is), and the two
 * that only read the file. Every other task naming a bench file writes it.
 */
const READ_ONLY = new Set([
  "routine-heartbeat-exception-only",
  "multi-draft-to-reminder",
  "recovery-missing-file",
]);
/** The writer tasks, pinned so a catalogue change is noticed here. */
const MARKET_WRITERS = [
  "cal-next-meeting-prep",
  "code-ci-status-report",
  "dictate-paragraph-punctuation",
  "files-sort-downloads-dry-run",
  "mail-find-fact",
  "memory-link-to-note",
  "memory-log-expense-ledger",
  "msg-group-chat-digest",
  "ops-kpi-snapshot-note",
  "rem-overdue-chase",
  "research-below-fold-fact",
  "research-compare-to-csv",
  "research-paginated-listing",
  "routine-morning-briefing",
  "travel-hotel-shortlist",
];
const LONG_WRITERS = [
  "multi-page-calc-note",
  "recovery-stale-draft",
  "research-compare-note",
  "research-fact-note",
  "research-list-note",
  "text-append-line",
  "text-find-replace",
];

describe("deliverablePaths over the market and long catalogues", () => {
  for (const [name, catalogue, writers] of [
    ["market", MARKET_CATALOGUE, MARKET_WRITERS],
    ["long", LONG_CATALOGUE, LONG_WRITERS],
  ] as const) {
    it(`finds every ${name} task's bench file under a writing instruction and nothing else`, () => {
      const found: string[] = [];
      for (const task of catalogue) {
        const text = fill(task.instruction);
        const named = text.match(BENCH_FILE)?.[0];
        const paths = deliverablePaths(text);
        if (named && !READ_ONLY.has(task.id)) {
          expect(paths, task.id).toEqual([named]);
          found.push(task.id);
        } else {
          // A bare name ("{token}-expenses.csv"), a folder, a conditional
          // or a read-only task names no deliverable.
          expect(paths, task.id).toEqual([]);
        }
      }
      expect(found.sort()).toEqual([...writers].sort());
    });
  }
  it("names the five false dones' files (cycle 20260919-1646-09c5412) for the four tasks that name one", () => {
    const byId = new Map(MARKET_CATALOGUE.map((task) => [task.id, task]));
    for (const [id, file] of [
      ["ops-kpi-snapshot-note", "kpi.txt"],
      ["memory-log-expense-ledger", "ledger.csv"],
      ["mail-find-fact", "notes.txt"],
      ["msg-group-chat-digest", "notes.txt"],
    ])
      expect(deliverablePaths(fill(byId.get(id)!.instruction)), id).toEqual([
        `${BENCH}/${TOKEN}-${file}`,
      ]);
    // The fifth said done with a form never submitted: nothing on disk to
    // read, so the runner leaves it to the model's summary.
    expect(
      deliverablePaths(fill(byId.get("checkin-flight-seat")!.instruction)),
    ).toEqual([]);
  });
});

describe("deliverablePaths: the rule", () => {
  const NOTES = "~/Documents/notes.txt";
  it("takes a ~/ or absolute path with a deliverable extension, once, without the phrase's punctuation", () => {
    expect(deliverablePaths(`Write the total into ${NOTES}.`)).toEqual([NOTES]);
    expect(
      deliverablePaths(`Write the total into ${NOTES}, then save it.`),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths(`Write the total into "${NOTES}" and save.`),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths(`Write the total into (${NOTES}) and save.`),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths("Write the total into /Users/nk/Desktop/NOTES.TXT"),
    ).toEqual(["/Users/nk/Desktop/NOTES.TXT"]);
    expect(
      deliverablePaths(
        `Write the total into ${NOTES}: today's figure. Then add the date to ${NOTES} as well.`,
      ),
    ).toEqual([NOTES]);
    for (const ext of DELIVERABLE_EXTENSIONS)
      expect(deliverablePaths(`Write it into ~/Desktop/out.${ext}`)).toEqual([
        `~/Desktop/out.${ext}`,
      ]);
    expect(deliverablePaths("Write it into ~/Desktop/out.docx")).toEqual([]);
    expect(deliverablePaths("Write it into ~/Desktop/out.txt.bak")).toEqual([]);
  });
  it("never takes a URL, a host, a bare name or an example", () => {
    expect(
      deliverablePaths(
        "Read https://example.com/report.pdf and write the total into Notes.",
      ),
    ).toEqual([]);
    expect(
      deliverablePaths("Open example.com/notes.txt and write the total there."),
    ).toEqual([]);
    expect(
      deliverablePaths("Write the amount into http://127.0.0.1:8765/notes.txt"),
    ).toEqual([]);
    expect(
      deliverablePaths(
        "Add a row to abc-expenses.csv: date, vendor, amount. Save it.",
      ),
    ).toEqual([]);
    expect(
      deliverablePaths(
        "Rename each receipt to date-vendor-amount, like ~/Receipts/2026-03-04-acme-42.txt.",
      ),
    ).toEqual([]);
    expect(deliverablePaths(`Save it under a name such as ${NOTES}`)).toEqual(
      [],
    );
  });
  it("reads 'file' as a verb and the writing nouns as nouns", () => {
    expect(
      deliverablePaths("File the report in Mail and tell me when it is sent."),
    ).toEqual([]);
    expect(
      deliverablePaths(
        "Read the log in ~/Library/Logs/app.txt and tell me the last error.",
      ),
    ).toEqual([]);
    expect(
      deliverablePaths("Read the note in ~/Notes/today.txt to me."),
    ).toEqual([]);
    expect(deliverablePaths("What does ~/Documents/notes.txt say?")).toEqual(
      [],
    );
    expect(
      deliverablePaths(
        "Open ~/Documents/budget.txt in TextEdit and tell me the total on its last line.",
      ),
    ).toEqual([]);
  });
  it("wants the path as the destination of an imperative writing verb in its own clause", () => {
    for (const verb of WRITING_VERBS)
      expect(deliverablePaths(`${verb} the total in ${NOTES}`), verb).toEqual([
        NOTES,
      ]);
    expect(
      deliverablePaths(`Read the page and write the total into ${NOTES}`),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths(
        `First write a plan into ${NOTES} saying where each file will go`,
      ),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths(`Log an expense in ${NOTES}: today, taxi, 12 dollars.`),
    ).toEqual([NOTES]);
    expect(deliverablePaths(`Fill in ${NOTES} with one row each`)).toEqual([
      NOTES,
    ]);
    expect(deliverablePaths(`Save it as ${NOTES}`)).toEqual([NOTES]);
    expect(
      deliverablePaths(`Type this at the end of ${NOTES}: see you Thursday`),
    ).toEqual([NOTES]);
    // The path as the verb's source, not its destination.
    expect(
      deliverablePaths(
        "Put ~/Desktop/report.pdf in the email to Sam and send it.",
      ),
    ).toEqual([]);
    expect(
      deliverablePaths("Add ~/Desktop/data.csv to the Numbers sheet."),
    ).toEqual([]);
    // A writing verb in another clause, about something else.
    expect(
      deliverablePaths(
        `Open the file ${NOTES}, then add a reminder in Reminders with the text of its TODO line.`,
      ),
    ).toEqual([]);
    expect(
      deliverablePaths(
        `Open ${NOTES} and put that meeting in Calendar as an event.`,
      ),
    ).toEqual([]);
    // Two files: the one written, not the one read.
    expect(
      deliverablePaths(
        "Read ~/Documents/a.txt and write the total into ~/Documents/b.txt, then save.",
      ),
    ).toEqual(["~/Documents/b.txt"]);
    expect(
      deliverablePaths("Rename ~/Documents/a.txt to ~/Documents/b.txt"),
    ).toEqual(["~/Documents/b.txt"]);
  });
  it("takes the one file a task opens when the task says to save after it", () => {
    expect(
      deliverablePaths(
        `Then open the file ${NOTES} in TextEdit, write that number on a new line, and save it.`,
      ),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths(
        `Open ${NOTES} in TextEdit and type this at the end: Thanks for the notes. Then save.`,
      ),
    ).toEqual([NOTES]);
    expect(
      deliverablePaths(
        `Open ${NOTES} in TextEdit and replace every occurrence of ACME with Zeta, then save.`,
      ),
    ).toEqual([NOTES]);
    // No save, no write: the file was only read.
    expect(
      deliverablePaths(
        `Open ${NOTES} in TextEdit and read me the second line.`,
      ),
    ).toEqual([]);
    // Two files opened and one save: the rule cannot tell which, so neither.
    expect(
      deliverablePaths(
        "Open ~/Documents/a.txt and ~/Documents/b.txt in TextEdit and save the one that changed.",
      ),
    ).toEqual([]);
  });
  it("names nothing for a task with a conditional sentence: its file may rightly stay as it is", () => {
    expect(
      deliverablePaths(
        "In Safari, check the status page at http://127.0.0.1:8765/status. If anything is down, write which service in ~/OpenAssistBench/abc/abc-alerts.txt and save it. If everything is fine, leave that file alone.",
      ),
    ).toEqual([]);
    expect(
      deliverablePaths(
        `Write the total into ${NOTES} and save. Unless it is zero, in which case do nothing.`,
      ),
    ).toEqual([]);
    expect(
      deliverablePaths(
        `When the build finishes, write the result into ${NOTES} and save.`,
      ),
    ).toEqual([]);
    expect(
      deliverablePaths(
        `Only if the page loads, write the total into ${NOTES}.`,
      ),
    ).toEqual([]);
    // "if" inside a sentence is not a conditional opening.
    expect(
      deliverablePaths(
        `Write the total into ${NOTES} even if it is zero, and save.`,
      ),
    ).toEqual([NOTES]);
  });
  it("names nothing for a form or a submission: nothing on disk to read", () => {
    expect(
      deliverablePaths("Check in for my flight and pick a window seat."),
    ).toEqual([]);
    expect(
      deliverablePaths("Submit the expense form and send the receipt to Sam."),
    ).toEqual([]);
  });
});

describe("the runner's lines and facts", () => {
  const before = { exists: true, size: 120, mtimeMs: 1_700_000_000_000 };
  const path = "~/OpenAssistBench/abc12345678/abc12345678-ledger.csv";
  it("compares existence, then size and modification time", () => {
    expect(sameFacts(before, { ...before })).toBe(true);
    expect(sameFacts(before, { ...before, size: 121 })).toBe(false);
    expect(sameFacts(before, { ...before, mtimeMs: before.mtimeMs + 1 })).toBe(
      false,
    );
    expect(sameFacts(before, { exists: false, size: 0, mtimeMs: 0 })).toBe(
      false,
    );
    expect(
      sameFacts(
        { exists: false, size: 0, mtimeMs: 0 },
        { exists: false, size: 0, mtimeMs: 0 },
      ),
    ).toBe(true);
    expect(sameFacts({ exists: false, size: 0, mtimeMs: 0 }, before)).toBe(
      false,
    );
  });
  it("tells the model the fact, the two routes and what a done must name, within the history bound", () => {
    const line = deliverableChallenge([{ path, before }]);
    expect(line).toContain("Not accepted yet");
    expect(line).toContain(path);
    expect(line).toContain("same size and modification time");
    expect(line).toContain("has not changed since the run began");
    expect(line).toContain("say fail");
    expect(line).toContain(
      "names what in the file or on screen shows the objective met",
    );
    expect(line).toContain("fails the run");
    expect(line).not.toContain("request_user");
    expect(line.length).toBeLessThan(MODEL_RESULT_CHARS);
    const absent = deliverableChallenge([
      { path, before: { exists: false, size: 0, mtimeMs: 0 } },
    ]);
    expect(absent).toContain("it still does not exist");
    const two = deliverableChallenge([
      { path, before },
      { path: "~/Documents/b.txt", before },
    ]);
    expect(two).toContain("they have the same size");
    expect(two).toContain("~/Documents/b.txt");
    // A long list is cut, and the line still fits.
    const many = deliverableChallenge(
      Array.from({ length: 12 }, (_, i) => ({
        path: `~/Documents/folder-${i}/a-long-file-name-${i}.txt`,
        before,
      })),
    );
    expect(many.length).toBeLessThan(MODEL_RESULT_CHARS);
    expect(many).toContain("…");
  });
  it("fails the run with the fact in the user's own words and a code, never the file's contents", () => {
    expect(deliverableMissing([{ path, before }])).toBe(
      `Not done: ${path} has not changed since the run began.`,
    );
    expect(
      deliverableMissing([
        { path, before },
        { path: "~/Documents/b.txt", before },
      ]),
    ).toContain("have not changed");
    const error = new DeliverableMissingError([{ path, before }]);
    expect(error.code).toBe(DELIVERABLE_MISSING);
    expect(error.name).toBe("DeliverableMissingError");
    expect(error.message).toBe(deliverableMissing([{ path, before }]));
    expect(error.unchanged).toEqual([{ path, before }]);
  });
});

describe("fileFactsReader (src/storage/files.ts)", () => {
  const withHome = async (body: (home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), "butler-deliverables-"));
    try {
      await body(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  it("answers existence, size and time for a path under the home, ~ or absolute, and a missing file as a fact", () =>
    withHome(async (home) => {
      const read = fileFactsReader(home);
      expect(await read("~/notes.txt")).toEqual({
        exists: false,
        size: 0,
        mtimeMs: 0,
      });
      mkdirSync(join(home, "OpenAssistBench/abc"), { recursive: true });
      writeFileSync(
        join(home, "OpenAssistBench/abc/abc-notes.txt"),
        "Notes abc\n",
      );
      const facts = await read("~/OpenAssistBench/abc/abc-notes.txt");
      expect(facts).toMatchObject({ exists: true, size: 10 });
      expect(typeof facts?.mtimeMs).toBe("number");
      expect(
        await read(join(home, "OpenAssistBench/abc/abc-notes.txt")),
      ).toEqual(facts);
      // A file under a path that is a file, not a folder, is missing too.
      expect(await read("~/OpenAssistBench/abc/abc-notes.txt/x.txt")).toEqual({
        exists: false,
        size: 0,
        mtimeMs: 0,
      });
      // A change shows.
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(
        join(home, "OpenAssistBench/abc/abc-notes.txt"),
        "Notes abc\n12.50\n",
      );
      const after = await read("~/OpenAssistBench/abc/abc-notes.txt");
      expect(after?.size).toBe(16);
      expect(sameFacts(facts!, after!)).toBe(false);
    }));
  it("declines a path outside the home, the home itself, one climbing out of it, and a non-path", () =>
    withHome(async (home) => {
      const read = fileFactsReader(home);
      expect(await read(join(tmpdir(), "elsewhere.txt"))).toBeNull();
      expect(await read("/etc/hosts.txt")).toBeNull();
      expect(await read("~/")).toBeNull();
      expect(await read("~")).toBeNull();
      expect(await read("~/../outside.txt")).toBeNull();
      expect(await read(`${home}/../outside.txt`)).toBeNull();
      expect(await read("")).toBeNull();
      expect(await read(undefined as unknown as string)).toBeNull();
      // A relative path is resolved from the process's directory, not the home.
      expect(await read("notes.txt")).toBeNull();
    }));
  it("only stats: the module reads no contents and writes nothing", () => {
    const source = readFileSync(join(root, "src/storage/files.ts"), "utf8");
    expect(source).toContain('import { stat } from "node:fs/promises";');
    expect(source).not.toMatch(
      /readFile|createReadStream|open\(|writeFile|unlink|rm\(|rename\(|mkdir/,
    );
  });
});

describe("the wiring", () => {
  it("hands the reader to the runner from the app and both harness scripts, under the home folder", () => {
    const main = readFileSync(join(root, "electron/main.ts"), "utf8");
    expect(main).toContain(
      'import { fileFactsReader } from "../src/storage/files";',
    );
    expect(main).toContain(
      'deliverables: fileFactsReader(app.getPath("home")),',
    );
    for (const script of ["scripts/bench.mjs", "scripts/harness-cycle.mjs"]) {
      const source = readFileSync(join(root, script), "utf8");
      expect(source, script).toContain(
        'const { fileFactsReader } = await import("../src/storage/files.ts");',
      );
      expect(source, script).toContain(
        "deliverables: fileFactsReader(homedir()),",
      );
    }
    const attempt = readFileSync(
      join(root, "src/gym/bench/attempt.ts"),
      "utf8",
    );
    expect(attempt).toContain(
      "...(deps.deliverables ? { deliverables: deps.deliverables } : {}),",
    );
  });
  it("tells the model, once in the system prompt, what a done summary names and that an unchanged file is not accepted", () => {
    const http = readFileSync(join(root, "src/providers/http.ts"), "utf8");
    // One sentence, kept short: the cached instruction has a budget
    // (tests/trim.test.ts) and every step pays for it.
    const sentence =
      "A done summary names what on screen or in the named file shows the objective met; a done with that file unchanged since the run began is not accepted.";
    expect(http.split(sentence)).toHaveLength(2);
    expect(sentence.length).toBeLessThan(160);
  });
});
