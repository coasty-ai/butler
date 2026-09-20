import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATALOGUE, CATEGORIES, benchToken } from "../src/gym/bench/catalogue";
import {
  BENCH_CONTAINER,
  COMPRESS_FILES,
  DRAFTS,
  DRAFT_TEXT,
  LONG_CATALOGUE,
  LONG_CATEGORIES,
  MEETING_TEXT,
  MEMO_TEXT,
  NOTES_HEADER,
  OLD_DRAFT_TEXT,
  README_TEXT,
  REPLACE_APPROVALS,
  REPORT_TEXT,
  SAVE_APPROVALS,
  SETTINGS_GENERAL_URL,
  SORT_DATA,
  SORT_TEXT,
  SUBMIT_APPROVALS,
  TODO_TEXT,
  budgets,
  dayBoundary,
  marked,
  onAbout,
  withoutMarker,
} from "../src/gym/bench/catalogue-long";
import {
  catalogueFor,
  categoriesFor,
  selectSuite,
} from "../src/gym/bench/suites";
import {
  CUSTOMER_POOL,
  FIXTURE_HEADERS,
  ITEM_POOL,
  PAGE_STYLE,
  PLAN_NAMES,
  TEAM_POOL,
  createFixtureStore,
  drawAbout,
  drawOrders,
  drawPlans,
  drawPrices,
  drawSheet,
  drawTeam,
  fixtureHandle,
  isSideRequest,
  pages,
  parseForm,
  routeOf,
  type FixtureStore,
} from "../src/gym/bench/fixtures";
import {
  AGENDA_BINARY,
  MUSIC_READER_ENV,
  agendaKinds,
  benchDirFor,
  createReaders,
  madeSince,
  musicScript,
  olderEntries,
  parseAgendaFind,
  parseAgendaSetup,
  parseMusic,
  quarantineFor,
  readFiles,
  sha256,
  strayAction,
  writeInside,
  type Exec,
  type PathFacts,
} from "../src/gym/bench/readers";
import {
  BROWSER_APPS,
  BROWSER_PARAM,
  CALCULATOR,
  CALENDAR,
  FINDER,
  FIXTURE_PORT,
  MUSIC,
  REMINDERS,
  FILE_WRITE_TOOLS,
  SETTINGS,
  SUB_CHECK,
  TEXTEDIT,
  TOKEN_RE,
  approvesPrompt,
  daysFrom,
  fillInstruction,
  gradeTask,
  namesBrowser,
} from "../src/gym/bench/graders";
import { honesty } from "../src/gym/bench/report";
import type {
  AgendaEvidence,
  AgendaItem,
  AttemptContext,
  BenchTask,
  Evidence,
  FixtureHandle,
  JournalStep,
  PrepareContext,
  RunJournal,
  TakeoverSource,
} from "../src/gym/bench/types";
import {
  actionSchema,
  defaultSettings,
  type ScreenContext,
} from "../src/core/schema";
import { evaluate } from "../src/core/policy";
import { TOOL_ALLOWED } from "../src/core/tool-policy";
import {
  createFilesProvider,
  fileToolSpec,
  homePath,
} from "../src/tools/providers/files";
import { CLOCK } from "./tool-fakes";

/*
 * The long-horizon suite: catalogue invariants (design §8), every grader on
 * synthetic end states built through the real prepare() and the real files
 * reader, the fixture pages and server, the readers and cleanup. Nothing here
 * touches the desktop, a provider, EventKit or the user's folders: every file
 * lives under a temp folder in the OS temp directory, the agenda helper and
 * Spotlight are fakes, and the only socket is a loopback one on a free port.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFARI = "com.apple.Safari";

/* ------------------------------------------------------------- fixtures */

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "butler-bench-long-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Local noon on a Friday: far from midnight, so "tomorrow" is stable. */
const NOW = new Date(2026, 8, 18, 12, 0, 0);
/** A local wall-clock time `days` after NOW, as the helper would print it. */
const at = (days: number, hour: number) => {
  const day = daysFrom(NOW, days);
  day.setHours(hour, 0, 0, 0);
  return day.toISOString();
};

const sources = (
  over: Partial<Record<TakeoverSource, number>> = {},
): Record<TakeoverSource, number> => ({
  manual_input: 0,
  request_user: 0,
  policy: 0,
  surface: 0,
  handoff: 0,
  ...over,
});
const journal = (over: Partial<RunJournal> = {}): RunJournal => ({
  status: "completed",
  settled: true,
  actions: 12,
  steps: [],
  approvals: 0,
  approvalsDeclined: 0,
  retries: 0,
  takeovers: 0,
  takeoverSources: sources(),
  manualTakeover: false,
  modelFailed: false,
  loops: 0,
  noProgress: 0,
  failures: {},
  endingCode: "COMPLETED",
  cost: 0.1,
  seconds: 60,
  modelCalls: 12,
  ...over,
});
const step = (
  type: string,
  appId?: string,
  over: Partial<JournalStep> = {},
): JournalStep => ({ type, appId, ...over });
const context = (over: Partial<ScreenContext> = {}): ScreenContext => ({
  appName: "App",
  windowTitle: "Window",
  ...over,
});

/** What textutil and unzip would say, keyed by absolute path. */
const rtfText = new Map<string, string>();
const zipListing = new Map<string, string>();
const fileExec: Exec = async (file, args) => {
  if (file === "textutil") return rtfText.get(args[3]) ?? "";
  if (file === "unzip") return zipListing.get(args[1]) ?? "";
  throw new Error(`unexpected ${file}`);
};

interface Attempt {
  task: BenchTask;
  token: string;
  home: string;
  benchDir: string;
  parameters: Record<string, string>;
  store: FixtureStore;
  fixture: FixtureHandle;
  added: AgendaItem[];
  opened: { target: string; app?: string }[];
  written: string[];
}

/** Runs a task's real prepare() the way the harness does, in a temp home. */
async function prepareRaw(
  task: BenchTask,
  options: {
    /** false: no agenda; an object: that agenda (agendaFor's answer). */
    agenda?: boolean | PrepareContext["agenda"];
    fixture?: boolean;
    now?: Date;
  } = {},
): Promise<{ attempt: Attempt; parameters: Record<string, string> | null }> {
  const home = tempHome();
  const token = benchToken();
  const benchDir = benchDirFor(home, token);
  mkdirSync(benchDir, { recursive: true });
  const store = createFixtureStore(FIXTURE_PORT);
  const fixture = fixtureHandle(store, FIXTURE_PORT);
  const added: AgendaItem[] = [];
  const opened: { target: string; app?: string }[] = [];
  const written: string[] = [];
  const prepareContext: PrepareContext = {
    index: async () => ({}),
    token: () => token,
    benchDir,
    benchPath: `~/OpenAssistBench/${token}`,
    write: async (relative, content) => {
      writeInside(benchDir, relative, content);
      written.push(relative);
    },
    agenda:
      options.agenda === false
        ? undefined
        : typeof options.agenda === "object"
          ? options.agenda
          : { add: async (item) => void added.push(item) },
    fixture:
      options.fixture === false
        ? undefined
        : {
            url: fixture.url,
            register: (registered) => fixture.register(token, registered),
          },
    openWithLaunchServices: async (target, app) =>
      void opened.push(app ? { target, app } : { target }),
    now: () => options.now ?? NOW,
  };
  const parameters = task.prepare
    ? await task.prepare(prepareContext)
    : { token };
  return {
    attempt: {
      task,
      token,
      home,
      benchDir,
      parameters: parameters ?? {},
      store,
      fixture,
      added,
      opened,
      written,
    },
    parameters,
  };
}
async function prepare(task: BenchTask): Promise<Attempt> {
  const { attempt, parameters } = await prepareRaw(task);
  if (!parameters) throw new Error(`${task.id} skipped at noon`);
  return attempt;
}

const files = (a: Attempt) => readFiles(a.benchDir, fileExec);
const inBench = (a: Attempt, relative: string) => join(a.benchDir, relative);
/** A fixture file named with the attempt's marker, as prepare() writes it. */
const own = (a: Attempt, name: string) => inBench(a, marked(a.token, name));
const get = (
  a: Attempt,
  key: string,
  headers: Record<string, string> = { accept: "text/html" },
) =>
  a.store.respond({
    method: "GET",
    url: key ? `/${a.token}/${key}` : `/${a.token}`,
    headers,
  });
const post = (a: Attempt, key: string, body: string) =>
  a.store.respond({
    method: "POST",
    url: `/${a.token}/${key}`,
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
const browserAt = (a: Attempt, title: string, path: string) => ({
  appId: SAFARI,
  context: context({
    appName: "Safari",
    windowTitle: `${title} · ${a.token}`,
    browserAddress: `127.0.0.1:${FIXTURE_PORT}/${a.token}${path}`,
  }),
});
const agenda = (items: AgendaItem[]): AgendaEvidence => ({
  access: { calendar: "granted", reminders: "granted" },
  items,
});
const event = (
  title: string,
  start: string,
  end: string,
  over: Partial<AgendaItem> = {},
): AgendaItem => ({
  kind: "event",
  title,
  start,
  end,
  allDay: false,
  calendar: BENCH_CONTAINER,
  ...over,
});
const reminder = (
  title: string,
  due: string,
  over: Partial<AgendaItem> = {},
): AgendaItem => ({
  kind: "reminder",
  title,
  due,
  completed: false,
  calendar: BENCH_CONTAINER,
  ...over,
});
const evidenceOf = (
  a: Attempt,
  over: Partial<Evidence> = {},
  run: Partial<RunJournal> = {},
): Evidence => ({ journal: journal(run), parameters: a.parameters, ...over });

/* ------------------------------------------------------------ scenarios */

/**
 * For every task: an end state a correct run leaves (`pass`) and one a run
 * that claimed done without doing the task leaves (`falseDone`, with one
 * primary check false). Both go through the task's real prepare(), and file
 * end states through the real files reader.
 */
interface Scenario {
  pass: (a: Attempt) => Promise<Evidence>;
  falseDone: (a: Attempt) => Promise<Evidence>;
}

const researchSteps = [
  step("click", SAFARI),
  step("type_text", TEXTEDIT, { textLength: 4 }),
];
const research = (write: (a: Attempt) => string, page: string) => ({
  pass: async (a: Attempt) => {
    appendFileSync(own(a, "notes.txt"), write(a));
    get(a, page);
    return evidenceOf(
      a,
      { files: await files(a), fixture: a.store.read(a.token) },
      { steps: researchSteps },
    );
  },
});

const SCENARIOS: Record<string, Scenario> = {
  "research-fact-note": {
    ...research((a) => `${a.parameters.employees}\n`, "about"),
    falseDone: async (a) => {
      appendFileSync(own(a, "notes.txt"), `${a.parameters.year}\n`);
      get(a, "about");
      return evidenceOf(
        a,
        { files: await files(a), fixture: a.store.read(a.token) },
        { steps: researchSteps },
      );
    },
  },
  "research-compare-note": {
    ...research((a) => `${a.parameters.cheapest}\n`, "plans"),
    falseDone: async (a) => {
      const wrong = a.parameters.others.split(",")[0];
      appendFileSync(own(a, "notes.txt"), `${wrong}\n`);
      get(a, "plans");
      return evidenceOf(
        a,
        { files: await files(a), fixture: a.store.read(a.token) },
        { steps: researchSteps },
      );
    },
  },
  "research-list-note": {
    ...research(
      (a) => a.parameters.engineers.split(",").join("\n") + "\n",
      "team",
    ),
    falseDone: async (a) => {
      const first = a.parameters.engineers.split(",")[0];
      appendFileSync(own(a, "notes.txt"), `${first}\n`);
      get(a, "team");
      return evidenceOf(
        a,
        { files: await files(a), fixture: a.store.read(a.token) },
        { steps: researchSteps },
      );
    },
  },
  "agenda-cal-create-tomorrow": {
    pass: async (a) =>
      evidenceOf(
        a,
        { agenda: agenda([event(a.token, at(1, 15), at(1, 16))]) },
        {
          steps: [step("type_text", CALENDAR, { markers: [a.token] })],
        },
      ),
    falseDone: async (a) =>
      evidenceOf(a, {
        agenda: agenda([event(a.token, at(1, 16), at(1, 17))]),
      }),
  },
  "agenda-cal-move": {
    pass: async (a) =>
      evidenceOf(a, {
        agenda: agenda([event(`${a.token} sync`, at(1, 14), at(1, 15))]),
      }),
    falseDone: async (a) =>
      evidenceOf(a, {
        agenda: agenda([event(`${a.token} sync`, at(1, 10), at(1, 11))]),
      }),
  },
  "agenda-rem-create": {
    pass: async (a) =>
      evidenceOf(a, { agenda: agenda([reminder(a.token, at(1, 0))]) }),
    falseDone: async (a) =>
      evidenceOf(a, { agenda: agenda([reminder(a.token, at(0, 0))]) }),
  },
  "agenda-rem-complete": {
    pass: async (a) =>
      evidenceOf(a, {
        agenda: agenda([
          reminder(`${a.token} water the plants`, at(0, 9), {
            completed: true,
          }),
        ]),
      }),
    falseDone: async (a) =>
      evidenceOf(a, {
        agenda: agenda([reminder(`${a.token} water the plants`, at(0, 9))]),
      }),
  },
  "agenda-rem-two": {
    pass: async (a) =>
      evidenceOf(a, {
        agenda: agenda([
          reminder(`${a.token} book the dentist`, at(1, 0)),
          reminder(`${a.token} renew the parking permit`, at(3, 0)),
        ]),
      }),
    falseDone: async (a) =>
      evidenceOf(a, {
        agenda: agenda([
          reminder(`${a.token} book the dentist`, at(1, 0)),
          reminder(`${a.token} renew the parking permit`, at(2, 0)),
        ]),
      }),
  },
  "files-rename-pattern": {
    pass: async (a) => {
      for (const suffix of DRAFTS)
        renameSync(
          inBench(a, `draft-${suffix}.txt`),
          inBench(a, `${a.token}-${suffix}.txt`),
        );
      return evidenceOf(
        a,
        { files: await files(a) },
        { steps: [step("type_text", FINDER, { markers: [a.token] })] },
      );
    },
    falseDone: async (a) => evidenceOf(a, { files: await files(a) }),
  },
  "files-new-folder-move": {
    pass: async (a) => {
      mkdirSync(inBench(a, `${a.token}-reports`));
      renameSync(
        inBench(a, "report.txt"),
        inBench(a, `${a.token}-reports/report.txt`),
      );
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => {
      mkdirSync(inBench(a, `${a.token}-reports`));
      return evidenceOf(a, { files: await files(a) });
    },
  },
  "files-sort-by-type": {
    pass: async (a) => {
      mkdirSync(inBench(a, "text"));
      mkdirSync(inBench(a, "data"));
      for (const name of SORT_TEXT)
        renameSync(inBench(a, `${name}.txt`), inBench(a, `text/${name}.txt`));
      for (const name of SORT_DATA)
        renameSync(inBench(a, `${name}.csv`), inBench(a, `data/${name}.csv`));
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => {
      mkdirSync(inBench(a, "text"));
      mkdirSync(inBench(a, "data"));
      for (const name of SORT_TEXT)
        renameSync(inBench(a, `${name}.txt`), inBench(a, `text/${name}.txt`));
      return evidenceOf(a, { files: await files(a) });
    },
  },
  "files-compress": {
    pass: async (a) => {
      writeFileSync(inBench(a, "Archive.zip"), "PK");
      zipListing.set(
        inBench(a, "Archive.zip"),
        [...COMPRESS_FILES, "__MACOSX/", "__MACOSX/._invoice.txt"].join("\n"),
      );
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => evidenceOf(a, { files: await files(a) }),
  },
  "text-append-line": {
    pass: async (a) => {
      appendFileSync(own(a, "draft.txt"), `${a.token} approved\n`);
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => evidenceOf(a, { files: await files(a) }),
  },
  "text-new-doc-save": {
    pass: async (a) => {
      const path = inBench(a, `${a.token}.rtf`);
      writeFileSync(path, "{\\rtf1\\ansi shopping}");
      rtfText.set(path, `${a.token} Shopping List\n`);
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => evidenceOf(a, { files: await files(a) }),
  },
  "text-find-replace": {
    pass: async (a) => {
      writeFileSync(own(a, "memo.txt"), MEMO_TEXT.split("ACME").join(a.token));
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => {
      writeFileSync(own(a, "memo.txt"), MEMO_TEXT.replace("ACME", a.token));
      return evidenceOf(a, { files: await files(a) });
    },
  },
  "browser-nav-chain": {
    pass: async (a) => {
      const id = a.parameters.orderId;
      get(a, "");
      get(a, "orders");
      get(a, `orders/${id}`);
      return evidenceOf(a, {
        ...browserAt(a, id, `/orders/${id}`),
        fixture: a.store.read(a.token),
      });
    },
    falseDone: async (a) => {
      get(a, "");
      get(a, "orders");
      return evidenceOf(a, {
        ...browserAt(a, "Orders", "/orders"),
        fixture: a.store.read(a.token),
      });
    },
  },
  "browser-form-submit-local": {
    pass: async (a) => {
      get(a, "contact");
      post(a, "contact", `name=${a.token}&message=hello+from+the+benchmark`);
      get(a, "thanks");
      return evidenceOf(a, {
        ...browserAt(a, "Thanks", "/thanks"),
        fixture: a.store.read(a.token),
      });
    },
    falseDone: async (a) => {
      get(a, "contact");
      return evidenceOf(a, {
        ...browserAt(a, "Contact", "/contact"),
        fixture: a.store.read(a.token),
      });
    },
  },
  "browser-find-in-table": {
    pass: async (a) => {
      const { itemId, itemName } = a.parameters;
      get(a, "prices");
      get(a, `items/${itemId}`);
      return evidenceOf(a, {
        ...browserAt(a, itemName, `/items/${itemId}`),
        fixture: a.store.read(a.token),
      });
    },
    falseDone: async (a) => {
      const listing = get(a, "prices").body;
      const other = [
        ...listing.matchAll(/href="\/[^/]+\/items\/(ITM-\d+)">([^<]+)</g),
      ].find(([, id]) => id !== a.parameters.itemId);
      if (!other) throw new Error("no other item");
      get(a, `items/${other[1]}`);
      return evidenceOf(a, {
        ...browserAt(a, other[2], `/items/${other[1]}`),
        fixture: a.store.read(a.token),
      });
    },
  },
  "media-search-library": {
    pass: async (a) =>
      evidenceOf(
        a,
        {
          appId: MUSIC,
          context: context({
            appName: "Music",
            windowTitle: "Music",
            visibleText: "Jazz | Albums",
          }),
          music: { available: true, player: "paused", playlists: [] },
        },
        { steps: [step("type_text", MUSIC, { textLength: 4 })] },
      ),
    falseDone: async (a) =>
      evidenceOf(
        a,
        {
          appId: MUSIC,
          context: context({
            appName: "Music",
            windowTitle: "Music",
            visibleText: "Jazz | Albums",
          }),
          music: { available: true, player: "playing", playlists: [] },
        },
        { steps: [step("type_text", MUSIC, { textLength: 4 })] },
      ),
  },
  "settings-about": {
    pass: async (a) =>
      evidenceOf(
        a,
        {
          appId: SETTINGS,
          context: context({
            appName: "System Settings",
            windowTitle: "About",
          }),
        },
        { steps: [step("click", SETTINGS)] },
      ),
    falseDone: async (a) =>
      evidenceOf(
        a,
        {
          appId: SETTINGS,
          context: context({
            appName: "System Settings",
            windowTitle: "General",
            visibleText: "About | Software Update | macOS",
          }),
        },
        { steps: [step("click", SETTINGS)] },
      ),
  },
  "settings-search-about": {
    pass: async (a) =>
      evidenceOf(
        a,
        {
          appId: SETTINGS,
          context: context({
            appName: "System Settings",
            windowTitle: "About",
          }),
        },
        {
          steps: [
            step("type_text", SETTINGS, { textLength: 5 }),
            step("click", SETTINGS),
          ],
        },
      ),
    falseDone: async (a) =>
      evidenceOf(
        a,
        {
          appId: SETTINGS,
          context: context({
            appName: "System Settings",
            windowTitle: "General",
          }),
        },
        { steps: [step("type_text", SETTINGS, { textLength: 5 })] },
      ),
  },
  "multi-page-calc-note": {
    pass: async (a) => {
      const { unit, quantity, product } = a.parameters;
      appendFileSync(own(a, "notes.txt"), `${product}\n`);
      get(a, "sheet");
      return evidenceOf(
        a,
        { files: await files(a), fixture: a.store.read(a.token) },
        {
          steps: [
            step("click", SAFARI),
            step("type_text", CALCULATOR, {
              textLength: unit.length + quantity.length + 1,
            }),
            step("type_text", TEXTEDIT, { textLength: product.length }),
          ],
        },
      );
    },
    falseDone: async (a) => {
      const { unit, quantity } = a.parameters;
      appendFileSync(own(a, "notes.txt"), `${unit}\n`);
      get(a, "sheet");
      return evidenceOf(
        a,
        { files: await files(a), fixture: a.store.read(a.token) },
        {
          steps: [
            step("click", SAFARI),
            step("type_text", CALCULATOR, {
              textLength: unit.length + quantity.length + 1,
            }),
            step("type_text", TEXTEDIT, { textLength: unit.length }),
          ],
        },
      );
    },
  },
  "multi-draft-to-reminder": {
    pass: async (a) =>
      evidenceOf(
        a,
        {
          files: await files(a),
          agenda: agenda([reminder(`${a.token} book the dentist`, at(1, 0))]),
        },
        {
          steps: [
            step("open_file", FINDER),
            step("type_text", REMINDERS, { markers: [a.token] }),
          ],
        },
      ),
    falseDone: async (a) =>
      evidenceOf(
        a,
        {
          files: await files(a),
          agenda: agenda([reminder(`${a.token} book the dentist`, at(0, 0))]),
        },
        {
          steps: [
            step("open_file", FINDER),
            step("type_text", REMINDERS, { markers: [a.token] }),
          ],
        },
      ),
  },
  "multi-folder-note-event": {
    pass: async (a) =>
      evidenceOf(
        a,
        {
          files: await files(a),
          agenda: agenda([
            event(`${a.token} planning sync`, at(1, 15), at(1, 16)),
          ]),
        },
        {
          steps: [
            step("open_file", FINDER),
            step("key", TEXTEDIT),
            step("type_text", CALENDAR, { markers: [a.token] }),
          ],
        },
      ),
    falseDone: async (a) =>
      evidenceOf(
        a,
        {
          files: await files(a),
          agenda: agenda([
            event(`${a.token} planning sync`, at(1, 3), at(1, 4)),
          ]),
        },
        {
          steps: [
            step("open_file", FINDER),
            step("key", TEXTEDIT),
            step("type_text", CALENDAR),
          ],
        },
      ),
  },
  "recovery-wrong-folder": {
    pass: async (a) => {
      renameSync(inBench(a, "report.txt"), inBench(a, `${a.token}-report.txt`));
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => {
      renameSync(
        inBench(a, "decoy/report.txt"),
        inBench(a, `decoy/${a.token}-report.txt`),
      );
      return evidenceOf(a, { files: await files(a) });
    },
  },
  "recovery-stale-draft": {
    pass: async (a) => {
      appendFileSync(own(a, "draft.txt"), `${a.token} reviewed\n`);
      return evidenceOf(a, { files: await files(a) });
    },
    falseDone: async (a) => {
      appendFileSync(own(a, "old-draft.txt"), `${a.token} reviewed\n`);
      return evidenceOf(a, { files: await files(a) });
    },
  },
  "recovery-wrong-page": {
    pass: async (a) => {
      get(a, "orders");
      return evidenceOf(
        a,
        {
          appId: CALCULATOR,
          context: context({
            appName: "Calculator",
            windowTitle: "Calculator",
            visibleText: Number(a.parameters.total).toLocaleString("en-US"),
          }),
          fixture: a.store.read(a.token),
        },
        {
          steps: [
            step("click", SAFARI),
            step("type_text", CALCULATOR, {
              textLength: a.parameters.total.length,
            }),
          ],
        },
      );
    },
    falseDone: async (a) => {
      get(a, "orders");
      return evidenceOf(
        a,
        {
          appId: CALCULATOR,
          context: context({
            appName: "Calculator",
            windowTitle: "Calculator",
            visibleText: a.parameters.decoyTotal,
          }),
          fixture: a.store.read(a.token),
        },
        {
          steps: [
            step("type_text", CALCULATOR, {
              textLength: a.parameters.decoyTotal.length,
            }),
          ],
        },
      );
    },
  },
  "recovery-missing-file": {
    pass: async (a) =>
      evidenceOf(
        a,
        { files: await files(a) },
        {
          status: "cancelled",
          endingCode: "STOPPED_AFTER_HANDOFF",
          takeovers: 1,
          takeoverSources: sources({ request_user: 1 }),
          steps: [step("open_file", FINDER)],
        },
      ),
    falseDone: async (a) =>
      evidenceOf(
        a,
        { files: await files(a) },
        {
          steps: [
            step("open_file", FINDER),
            step("type_text", TEXTEDIT, { textLength: 3 }),
          ],
        },
      ),
  },
};

const byId = (id: string): BenchTask => {
  const task = LONG_CATALOGUE.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};
/** Evidence the task declared a reader for, and the field that reader fills. */
const READER_FIELDS = {
  files: "files",
  agenda: "agenda",
  music: "music",
  fixture: "fixture",
} as const;

/* ----------------------------------------------------------- invariants */

describe("long suite catalogue", () => {
  it("has unique ids across both suites", () => {
    const ids = [...CATALOGUE, ...LONG_CATALOGUE].map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LONG_CATALOGUE.length).toBeGreaterThanOrEqual(24);
  });

  it("marks every task long and runnable, in a long category", () => {
    for (const task of LONG_CATALOGUE) {
      expect(task.suite, task.id).toBe("long");
      expect(task.kind, task.id).toBe("run");
      expect(LONG_CATEGORIES, task.id).toContain(task.category);
    }
    for (const task of CATALOGUE) expect(task.suite ?? "smoke").toBe("smoke");
  });

  it("keeps step ranges and budgets within the design's ceilings", () => {
    for (const task of LONG_CATALOGUE) {
      const [low, high] = task.steps ?? [0, 0];
      expect(low, task.id).toBeGreaterThanOrEqual(10);
      expect(high, task.id).toBeLessThanOrEqual(40);
      expect(low, task.id).toBeLessThanOrEqual(high);
      expect(task.maxActions, task.id).toBeGreaterThanOrEqual(high);
      expect(task.maxActions, task.id).toBeLessThanOrEqual(80);
      expect(task.maxSeconds, task.id).toBeLessThanOrEqual(900);
      expect(task.maxCost, task.id).toBeLessThanOrEqual(0.6);
      expect(task.maxCost, task.id).toBeGreaterThan(0);
      expect(task).toMatchObject(budgets(task.steps!));
    }
    // About $9.55 at caps: the critique's "ceiling about $9" for ~26 tasks.
    const ceiling = LONG_CATALOGUE.reduce((sum, task) => sum + task.maxCost, 0);
    expect(ceiling).toBeLessThanOrEqual(10);
  });

  it("never involves Messages or Mail", () => {
    for (const task of LONG_CATALOGUE) {
      for (const app of task.apps)
        expect(app, task.id).not.toMatch(/MobileSMS|iChat|com\.apple\.mail/i);
      expect(task.instruction, task.id).not.toMatch(
        /\b(messages|imessage|mail|email|text message)\b/i,
      );
    }
  });

  it("never asks for anything destructive, costly or sensitive", () => {
    for (const task of LONG_CATALOGUE)
      expect(task.instruction, task.id).not.toMatch(
        /\b(delete|remove|trash|erase|discard|send|pay|purchase|buy|publish|install|password|security|subscribe|sign in|log in)\b/i,
      );
  });

  it("defines completion with primary checks and declares only known readers", () => {
    for (const task of LONG_CATALOGUE) {
      expect(task.primary?.length, task.id).toBeGreaterThan(0);
      for (const reader of task.evidence ?? [])
        expect(Object.keys(READER_FIELDS), task.id).toContain(reader);
    }
  });

  it("names the bench folder in every instruction that works on files", () => {
    for (const task of LONG_CATALOGUE)
      if (task.evidence?.includes("files"))
        expect(task.instruction, task.id).toContain("{benchPath}");
  });

  it("expects a hand-off only in recovery", () => {
    for (const task of LONG_CATALOGUE)
      if (task.expectsHandoff) expect(task.category, task.id).toBe("recovery");
    expect(LONG_CATALOGUE.some((task) => task.expectsHandoff)).toBe(true);
  });

  it("approves exactly the critique's allow-lists and nothing destructive", () => {
    const saves = new Set([
      "research-fact-note",
      "research-compare-note",
      "research-list-note",
      "text-append-line",
      "text-new-doc-save",
      "multi-page-calc-note",
      "recovery-stale-draft",
    ]);
    for (const task of LONG_CATALOGUE) {
      const expected = saves.has(task.id)
        ? SAVE_APPROVALS
        : task.id === "text-find-replace"
          ? REPLACE_APPROVALS
          : task.id === "browser-form-submit-local"
            ? SUBMIT_APPROVALS
            : [];
      expect(task.approve, task.id).toEqual(expected);
      for (const reason of task.approve ?? [])
        expect(approvesPrompt(task, reason, true), reason).toBe(true);
    }
    expect(SAVE_APPROVALS).toEqual(["Save these changes?"]);
    expect(REPLACE_APPROVALS).toEqual([
      "Save these changes?",
      "Replace the existing item?",
    ]);
    expect(SUBMIT_APPROVALS).toEqual(["Submit or authorize this change?"]);
  });

  it("approves Replace only where the Find bar needs it, never on a save", () => {
    // The policy asks "Replace the existing item?" for the Save panel's
    // overwrite confirmation too, and the reason cannot tell the two apart:
    // allowed on a save task, it would overwrite a document of the user's.
    const replace = "Replace the existing item?";
    const allowed = LONG_CATALOGUE.filter((task) =>
      approvesPrompt(task, replace, true),
    ).map((task) => task.id);
    expect(allowed).toEqual(["text-find-replace"]);
    for (const task of LONG_CATALOGUE)
      if (
        task.approve?.includes("Save these changes?") &&
        task.id !== "text-find-replace"
      )
        expect(task.approve, task.id).toEqual(["Save these changes?"]);
  });

  it("names every note file by a ~/ path the files tool accepts, and the default mode lets the append run on the task's own words", async () => {
    // The tool route for FACT_NOT_NOTED (cycle 20260919-1646): the model
    // reads the fact off the page and calls files__append_text_file with the
    // path the instruction names. Policy grounds the call on that path
    // alone, so under the default "task" mode it runs with no question and
    // the write is the save; a path the tool would refuse never gets here.
    const spec = fileToolSpec("append_text_file");
    const provider = createFilesProvider({ home: "/Users/me" });
    await provider.start();
    const surface = {
      appId: "com.apple.Safari",
      pid: 1,
      secureInput: false,
      unknown: false,
    };
    let noted = 0;
    for (const task of LONG_CATALOGUE) {
      if (
        !/\{benchPath\}\/\{token\}-[a-z]+\.(?:txt|csv)\b/.test(task.instruction)
      )
        continue;
      const a = await prepare(task);
      const words = fillInstruction(task.instruction, {
        ...a.parameters,
        [BROWSER_PARAM]: "Safari",
      });
      for (const [raw] of words.matchAll(/~\/\S+\.(?:txt|csv)\b/g)) {
        noted++;
        const path = raw.replace(/[.,;:]+$/, "");
        expect(
          homePath(path, "/Users/me"),
          `${task.id}: ${path}`,
        ).toMatchObject({ relative: path });
        const args = { path, text: "What the page said: 15,888 and Acme" };
        const prepared = provider.prepare(spec, args);
        expect(prepared.ok, `${task.id}: ${path}`).toBe(true);
        const decision = evaluate(
          actionSchema.parse({
            type: "tool_call",
            frame_id: "f",
            tool: spec.id,
            args,
          }),
          surface,
          structuredClone(defaultSettings),
          false,
          {
            tool: { spec, prepared, calls: 0 },
            clock: CLOCK,
            userWords: words,
          },
        );
        expect(decision, `${task.id}: ${path}`).toEqual({
          kind: "ALLOW",
          reason: TOOL_ALLOWED.grounded,
        });
      }
    }
    expect(noted).toBeGreaterThanOrEqual(3);
    await provider.close();
  });

  it("names every file a TextEdit or research instruction opens with the attempt's token", () => {
    // A generic name (budget.txt, notes.txt) lets a search, Open Recent or the
    // Open panel land on the user's own document of that name.
    let named = 0;
    for (const task of LONG_CATALOGUE) {
      if (!task.apps.includes(TEXTEDIT) && task.category !== "research-note")
        continue;
      for (const [file] of task.instruction.matchAll(
        /[^\s,]+\.(?:txt|rtf|md|csv)\b/g,
      )) {
        named++;
        const name = file.split("/").pop()!;
        expect(name.startsWith("{token}-"), `${task.id}: ${file}`).toBe(true);
      }
    }
    expect(named).toBeGreaterThanOrEqual(10);
  });

  it("fills every placeholder from prepare(), with the attempt's own token, and {browser} from the harness", async () => {
    for (const task of LONG_CATALOGUE) {
      const a = await prepare(task);
      expect(a.parameters.token, task.id).toBe(a.token);
      for (const [, name] of task.instruction.matchAll(/\{(\w+)\}/g))
        if (name !== BROWSER_PARAM)
          expect(Object.keys(a.parameters), `${task.id} {${name}}`).toContain(
            name,
          );
      // The browser is the harness's choice, not prepare()'s.
      expect(Object.keys(a.parameters), task.id).not.toContain(BROWSER_PARAM);
      expect(
        fillInstruction(task.instruction, {
          ...a.parameters,
          [BROWSER_PARAM]: "Safari",
        }),
      ).not.toMatch(/[{}]/);
    }
  });

  it("names the harness's browser in every task that lists one, once, and in no other", () => {
    // The chooser picks the browser that is not the person's and the
    // graders hold the run to it; an instruction that said "the browser"
    // would leave the choice to the model, which took the person's Chrome
    // (426 of 488 browser steps in cycle 20260919-0501-cf9f04c).
    for (const task of LONG_CATALOGUE) {
      const lists = task.apps.some((id) => BROWSER_APPS.includes(id));
      expect(namesBrowser(task), task.id).toBe(lists);
      expect(task.instruction.match(/\{browser\}/g)?.length ?? 0, task.id).toBe(
        lists ? 1 : 0,
      );
      expect(task.instruction, task.id).not.toMatch(
        /\bthe browser\b|Safari|Chrome/,
      );
    }
  });

  it("declares a reader for everything its prepare() sets up", async () => {
    for (const task of LONG_CATALOGUE) {
      const a = await prepare(task);
      const readers = task.evidence ?? [];
      if (a.written.length) expect(readers, task.id).toContain("files");
      if (a.store.tokens().includes(a.token))
        expect(readers, task.id).toContain("fixture");
      if (a.added.length) expect(readers, task.id).toContain("agenda");
    }
  });

  it("names the benchmark's own calendar or list whenever the model creates an agenda item", async () => {
    for (const task of LONG_CATALOGUE) {
      if (!task.evidence?.includes("agenda")) continue;
      const a = await prepare(task);
      // Tasks that edit an item prepare() added find it where it already is.
      if (!a.added.length)
        expect(task.instruction, task.id).toContain(BENCH_CONTAINER);
      for (const item of a.added) {
        expect(item.title.split(" ")[0], task.id).toBe(a.token);
        if (item.kind === "event")
          expect(Date.parse(item.end!)).toBeGreaterThan(
            Date.parse(item.start!),
          );
      }
    }
  });

  it("opens nothing outside the attempt's own folder, pages or the General settings pane", async () => {
    for (const task of LONG_CATALOGUE) {
      const a = await prepare(task);
      for (const { target } of a.opened)
        expect(
          target === a.benchDir ||
            target.startsWith(a.benchDir + "/") ||
            target.startsWith(`${a.fixture.url}/${a.token}/`) ||
            target === SETTINGS_GENERAL_URL,
          `${task.id} opened ${target}`,
        ).toBe(true);
    }
  });
});

describe("long suite wrong starts and neutral starts", () => {
  it("opens the bench folder in the Finder before every Finder task (S6)", async () => {
    for (const id of [
      "files-rename-pattern",
      "files-new-folder-move",
      "files-sort-by-type",
      "files-compress",
      "multi-folder-note-event",
    ]) {
      const a = await prepare(byId(id));
      expect(a.opened, id).toEqual([{ target: a.benchDir }]);
      expect(byId(id).instruction, id).toContain("open in the Finder");
    }
  });

  it("puts the wrong thing in front for the recovery tasks", async () => {
    const folder = await prepare(byId("recovery-wrong-folder"));
    expect(folder.opened).toEqual([{ target: `${folder.benchDir}/decoy` }]);
    const draft = await prepare(byId("recovery-stale-draft"));
    expect(draft.opened).toEqual([
      { target: own(draft, "old-draft.txt"), app: "TextEdit" },
    ]);
    const page = await prepare(byId("recovery-wrong-page"));
    expect(page.opened).toEqual([
      { target: `${page.fixture.url}/${page.token}/decoy` },
    ]);
  });

  it("starts System Settings on General, so About is never left over from the last attempt", async () => {
    for (const id of ["settings-about", "settings-search-about"]) {
      const a = await prepare(byId(id));
      expect(a.opened, id).toEqual([{ target: SETTINGS_GENERAL_URL }]);
    }
  });
});

describe("long suite graders", () => {
  it("has a pass and a false-done scenario for every task", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      LONG_CATALOGUE.map((task) => task.id).sort(),
    );
  });

  for (const task of LONG_CATALOGUE) {
    const scenario = SCENARIOS[task.id];
    if (!scenario) continue;

    it(`${task.id}: a correct end state passes with full credit`, async () => {
      const a = await prepare(task);
      const grade = gradeTask(task, await scenario.pass(a));
      expect(grade.status, JSON.stringify(grade)).toBe("passed");
      expect(grade.partial).toBe(1);
      for (const name of task.primary ?? [])
        expect(grade.checks[name]).toBe(true);
    });

    it(`${task.id}: done over the wrong end state is a false done`, async () => {
      const a = await prepare(task);
      const evidence = await scenario.falseDone(a);
      expect(evidence.journal.status).toBe("completed");
      const grade = gradeTask(task, evidence);
      expect(grade.status, JSON.stringify(grade)).toBe("failed");
      expect(
        (task.primary ?? []).some((name) => grade.checks[name] === false),
        JSON.stringify(grade.checks),
      ).toBe(true);
      expect(grade.partial ?? 1).toBeLessThan(1);
      // A fixed code named for the check, never the fallback or content.
      expect(grade.reason).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(grade.reason).not.toBe("FAILED");
      expect(grade.reason).not.toContain(a.token.toUpperCase());
      const verdict = honesty("completed", grade, task);
      expect(verdict.falseDone).toBe(true);
      expect(verdict.falseDonePrimary).toBe(true);
    });

    it(`${task.id}: without its reader the grade is unknown, never passed`, async () => {
      const a = await prepare(task);
      const full = await scenario.pass(a);
      const readers = task.evidence ?? [];
      for (const reader of readers) {
        const partial = { ...full };
        delete partial[READER_FIELDS[reader]];
        expect(gradeTask(task, partial).status, reader).toBe("unknown");
      }
      if (readers.includes("music")) {
        const unavailable = {
          ...full,
          music: {
            available: false,
            player: "unknown" as const,
            playlists: [],
          },
        };
        expect(gradeTask(task, unavailable).status).toBe("unknown");
      }
      if (readers.includes("agenda")) {
        const denied = {
          ...full,
          agenda: {
            ...full.agenda!,
            access: { calendar: "notDetermined", reminders: "notDetermined" },
          },
        };
        expect(gradeTask(task, denied).status).toBe("unknown");
      }
      if (!readers.length) {
        expect(gradeTask(task, { ...full, context: undefined }).status).toBe(
          "unknown",
        );
        expect(gradeTask(task, { ...full, appId: undefined }).status).toBe(
          "unknown",
        );
      }
      // A grader that finds the end state by the token cannot say anything
      // without it either. (Music and System Settings are read by what is on
      // screen, not by name.)
      if (readers.some((reader) => reader !== "music"))
        expect(gradeTask(task, { ...full, parameters: {} }).status).toBe(
          "unknown",
        );
    });

    it(`${task.id}: real input during the run makes it unknown`, async () => {
      const a = await prepare(task);
      const evidence = await scenario.pass(a);
      const touched = {
        ...evidence,
        journal: {
          ...evidence.journal,
          manualTakeover: true,
          takeoverSources: sources({ manual_input: 1 }),
        },
      };
      expect(gradeTask(task, touched)).toMatchObject({
        status: "unknown",
        reason: "MANUAL_TAKEOVER",
      });
    });
  }

  it("fails an agenda item written anywhere but the benchmark's local container", async () => {
    const task = byId("agenda-cal-create-tomorrow");
    const a = await prepare(task);
    for (const calendar of ["Home", "OpenAssistBench (synced)"]) {
      const grade = gradeTask(
        task,
        evidenceOf(a, {
          agenda: agenda([event(a.token, at(1, 15), at(1, 16), { calendar })]),
        }),
      );
      expect(grade).toMatchObject({
        status: "failed",
        reason: "WRONG_CALENDAR",
      });
    }
  });

  it("still grades the fixture log when the browser is not in front", async () => {
    const finder = {
      appId: FINDER,
      context: context({ appName: "Finder", windowTitle: "Downloads" }),
    };
    // A done that never submitted, with the Finder left in front, is a
    // primary false done with partial credit, not a grade with no checks.
    const form = byId("browser-form-submit-local");
    const idle = await prepare(form);
    get(idle, "contact");
    const unsent = gradeTask(
      form,
      evidenceOf(idle, { ...finder, fixture: idle.store.read(idle.token) }),
    );
    expect(unsent).toMatchObject({
      status: "failed",
      reason: "NOT_FRONTMOST",
      partial: 0,
    });
    expect(unsent.checks.submitted).toBe(false);
    expect(honesty("completed", unsent, form).falseDonePrimary).toBe(true);
    // The form was submitted, then the model wandered off: the log says so.
    const sent = await prepare(form);
    post(sent, "contact", `name=${sent.token}&message=hello`);
    const wandered = gradeTask(
      form,
      evidenceOf(sent, { ...finder, fixture: sent.store.read(sent.token) }),
    );
    expect(wandered.checks.submitted).toBe(true);
    expect(wandered.partial).toBe(0.25);
    for (const id of ["browser-nav-chain", "browser-find-in-table"]) {
      const task = byId(id);
      const a = await prepare(task);
      const grade = gradeTask(
        task,
        evidenceOf(a, { ...finder, fixture: a.store.read(a.token) }),
      );
      expect(grade.status, id).toBe("failed");
      expect(grade.partial, id).toBeDefined();
      expect(honesty("completed", grade, task).falseDonePrimary, id).toBe(true);
    }
  });

  it("accepts an honest give-up on the missing file, and only an honest one (G2)", async () => {
    const task = byId("recovery-missing-file");
    const a = await prepare(task);
    const withRun = async (run: Partial<RunJournal>) =>
      gradeTask(
        task,
        evidenceOf(
          a,
          { files: await files(a) },
          {
            steps: [step("open_file", FINDER)],
            ...run,
          },
        ),
      );
    expect(
      (await withRun({ status: "failed", modelFailed: true })).status,
    ).toBe("passed");
    // A policy or protected-surface hand-off says nothing about the file, and
    // neither does the runner's hand-off after three unidentified targets:
    // the retried actions never ran, so nothing shows the file was missing.
    for (const source of ["policy", "surface", "handoff"] as const)
      expect(
        await withRun({
          status: "cancelled",
          takeovers: 1,
          takeoverSources: sources({ [source]: 1 }),
          steps: [step("open_app", undefined)],
        }),
        source,
      ).toMatchObject({ status: "failed", reason: "NO_HANDOFF" });
    // Looking for the file the way the instruction implies (File > Open, Go
    // to Folder, typing the path) and then asking is the honest path: the
    // journal's mutating steps are recorded, the end state decides.
    const searched = await withRun({
      status: "cancelled",
      takeovers: 1,
      takeoverSources: sources({ request_user: 1 }),
      steps: [
        step("menu_item", TEXTEDIT, { menuLeaf: "open…" }),
        step("hotkey", TEXTEDIT),
        step("type_text", TEXTEDIT, { textLength: 30 }),
      ],
    });
    expect(searched).toMatchObject({ status: "passed", partial: 1 });
    expect(searched.checks.noMutation).toBe(false);
    const handedOff = await withRun({
      status: "cancelled",
      takeovers: 1,
      takeoverSources: sources({ request_user: 1 }),
    });
    expect(handedOff.status).toBe("passed");
    expect(honesty("cancelled", handedOff, task).undersold).toBe(false);
    // What it must not do is change or add anything.
    writeFileSync(own(a, "readme.txt"), "edited");
    expect(
      await withRun({
        status: "cancelled",
        takeovers: 1,
        takeoverSources: sources({ request_user: 1 }),
      }),
    ).toMatchObject({ status: "failed", reason: "FILE_CHANGED" });
  });

  it("does not pass System Settings left on About by an earlier attempt", async () => {
    const task = byId("settings-about");
    const a = await prepare(task);
    const grade = gradeTask(
      task,
      evidenceOf(
        a,
        {
          appId: SETTINGS,
          context: context({
            appName: "System Settings",
            windowTitle: "About",
          }),
        },
        { steps: [step("open_app", undefined)] },
      ),
    );
    expect(grade).toMatchObject({ status: "failed", reason: "NOT_NAVIGATED" });
  });

  it("reads the About pane from text only when the title is not a pane name", () => {
    const aboutText = "about | macos sequoia | serial number | chip";
    const at = (windowTitle: string) =>
      ({
        journal: journal(),
        parameters: {},
        context: context({ windowTitle }),
      }) as Evidence;
    expect(onAbout(at("About"), "")).toBe(true);
    expect(onAbout(at("General"), aboutText)).toBe(false);
    expect(onAbout(at("System Settings"), aboutText)).toBe(true);
    expect(onAbout(at(""), aboutText)).toBe(true);
    // The General pane lists About and can mention macOS; that is not About.
    expect(
      onAbout(at("System Settings"), "about | software update | macos"),
    ).toBe(false);
  });

  it("does not pass a Music search left on screen by an earlier attempt", async () => {
    const task = byId("media-search-library");
    const a = await prepare(task);
    const grade = gradeTask(
      task,
      evidenceOf(a, {
        appId: MUSIC,
        context: context({
          appName: "Music",
          windowTitle: "Music",
          visibleText: "Jazz | Albums",
        }),
        music: { available: true, player: "stopped", playlists: [] },
      }),
    );
    expect(grade).toMatchObject({
      status: "failed",
      reason: "SEARCH_NOT_TYPED",
    });
  });

  it("does not pass a Calculator total left from an earlier attempt", async () => {
    const task = byId("recovery-wrong-page");
    const a = await prepare(task);
    get(a, "orders");
    const grade = gradeTask(
      task,
      evidenceOf(a, {
        appId: CALCULATOR,
        context: context({
          appName: "Calculator",
          windowTitle: "Calculator",
          visibleText: a.parameters.total,
        }),
        fixture: a.store.read(a.token),
      }),
    );
    expect(grade).toMatchObject({ status: "failed", reason: "NOT_ENTERED" });
  });

  it("does not read the token's digits as the number a research note needs", () => {
    expect(
      withoutMarker("research notes for benchnote4a12\n412", "benchnote4a12"),
    ).toBe("research notes for  \n412");
    expect(withoutMarker("benchnote4a12", "")).toBe("benchnote4a12");
  });
});

describe("long suite agenda preparation", () => {
  const agendaTasks = LONG_CATALOGUE.filter((task) =>
    task.evidence?.includes("agenda"),
  );

  it("skips every agenda task when the agenda helper is unavailable", async () => {
    expect(agendaTasks.length).toBeGreaterThanOrEqual(5);
    for (const task of agendaTasks) {
      const { attempt, parameters } = await prepareRaw(task, { agenda: false });
      expect(parameters, task.id).toBeNull();
      // Nothing was set up for a run that will not happen.
      expect(attempt.written, task.id).toEqual([]);
      expect(attempt.opened, task.id).toEqual([]);
    }
  });

  it("skips agenda tasks within an hour of midnight, when tomorrow could move", async () => {
    for (const now of [
      new Date(2026, 8, 18, 23, 30),
      new Date(2026, 8, 19, 0, 30),
    ])
      for (const task of agendaTasks)
        expect(
          (await prepareRaw(task, { now })).parameters,
          task.id,
        ).toBeNull();
    expect(dayBoundary(new Date(2026, 8, 18, 22, 59))).toBe(false);
    expect(dayBoundary(new Date(2026, 8, 18, 1, 0))).toBe(false);
    expect(dayBoundary(new Date(2026, 8, 18, 0, 59))).toBe(true);
    expect(dayBoundary(new Date(2026, 8, 18, 23, 0))).toBe(true);
  });

  it("skips fixture tasks when no fixture server is running", async () => {
    for (const task of LONG_CATALOGUE.filter((task) =>
      task.evidence?.includes("fixture"),
    ))
      expect(
        (await prepareRaw(task, { fixture: false })).parameters,
        task.id,
      ).toBeNull();
  });

  it("writes the fixtures the graders compare against", async () => {
    const draft = await prepare(byId("text-append-line"));
    expect(readFileSync(own(draft, "draft.txt"), "utf8")).toBe(DRAFT_TEXT);
    const stale = await prepare(byId("recovery-stale-draft"));
    expect(stale.parameters.oldSha).toBe(sha256(OLD_DRAFT_TEXT));
    expect(readFileSync(own(stale, "old-draft.txt"), "utf8")).toBe(
      OLD_DRAFT_TEXT,
    );
    const missing = await prepare(byId("recovery-missing-file"));
    expect(existsSync(own(missing, "budget.txt"))).toBe(false);
    expect(readFileSync(own(missing, "readme.txt"), "utf8")).toBe(README_TEXT);
    const todo = await prepare(byId("multi-draft-to-reminder"));
    expect(readFileSync(own(todo, "todo.txt"), "utf8")).toBe(
      TODO_TEXT(todo.token),
    );
    const meeting = await prepare(byId("multi-folder-note-event"));
    expect(meeting.parameters.meetingSha).toBe(
      createHash("sha256").update(MEETING_TEXT).digest("hex"),
    );
    const note = await prepare(byId("research-fact-note"));
    expect(readFileSync(own(note, "notes.txt"), "utf8")).toBe(
      NOTES_HEADER(note.token),
    );
    const moved = await prepare(byId("files-new-folder-move"));
    expect(moved.parameters.reportSha).toBe(sha256(REPORT_TEXT));
  });
});

/* -------------------------------------------------------------- policy */

/** The policy's own consequential-label pattern, read from its source. */
function consequentialPattern(): RegExp {
  const source = readFileSync(join(root, "src/core/policy.ts"), "utf8");
  const match = source.match(/const consequential =\s*\n?\s*\/(.+)\/;\n/);
  if (!match) throw new Error("policy.ts no longer defines `consequential`");
  return new RegExp(match[1]);
}

describe("long suite names against the policy", () => {
  it("parses the policy's pattern", () => {
    const pattern = consequentialPattern();
    expect(pattern.test("delete")).toBe(true);
    expect(pattern.test("benchnote0a1b-archive")).toBe(true);
    expect(pattern.test("orders")).toBe(false);
  });

  it("puts no consequential word on a page title, heading, link, header or label", async () => {
    const pattern = consequentialPattern();
    let crawled = 0;
    for (const task of LONG_CATALOGUE.filter((task) =>
      task.evidence?.includes("fixture"),
    )) {
      // Every page the task really registers, found by following its links
      // from the entry points the instructions and wrong starts name.
      const a = await prepare(task);
      const queue = [
        "",
        "orders",
        "decoy",
        "prices",
        "sheet",
        "about",
        "plans",
        "team",
        "contact",
        "thanks",
      ];
      const seen = new Set<string>();
      while (queue.length) {
        const key = queue.shift()!;
        if (seen.has(key)) continue;
        seen.add(key);
        const reply = get(a, key);
        if (reply.status !== 200) continue;
        crawled++;
        for (const [, next] of reply.body.matchAll(
          new RegExp(`href="/${a.token}/?([^"]*)"`, "g"),
        )) {
          // Every link on a page the task serves leads somewhere.
          expect(get(a, next).status, `${task.id}: ${key} -> ${next}`).toBe(
            200,
          );
          queue.push(next);
        }
        for (const [, , text] of reply.body.matchAll(
          /<(title|h1|a|th|td|label|button)\b[^>]*>([^<]*)</g,
        ))
          // The form's Submit is the one prompt its task approves.
          if (!(task.id === "browser-form-submit-local" && text === "Submit"))
            expect(
              pattern.test(text.toLowerCase()),
              `${task.id}: ${text}`,
            ).toBe(false);
      }
    }
    // 30 pages today; fewer means a link stopped resolving.
    expect(crawled).toBeGreaterThanOrEqual(30);
  });

  it("names nothing the model clicks in the Finder with a consequential word", async () => {
    const pattern = consequentialPattern();
    for (const task of LONG_CATALOGUE.filter((task) =>
      task.apps.includes(FINDER),
    )) {
      const a = await prepare(task);
      // What prepare() wrote, and what the instruction asks the model to name.
      const asked = fillInstruction(task.instruction, a.parameters)
        .split(/[\s,]+/)
        .filter((word) => word.includes(a.token) && !word.includes("/"));
      for (const name of [
        ...a.written.flatMap((path) => path.split("/")),
        ...asked,
      ])
        expect(pattern.test(name.toLowerCase()), `${task.id} ${name}`).toBe(
          false,
        );
    }
  });
});

/* ------------------------------------------------------------ fixtures */

/** A small deterministic generator (mulberry32) so draws are repeatable. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fixture page generators", () => {
  it("draws the same pages from the same seed", () => {
    expect(drawOrders(seeded(3))).toEqual(drawOrders(seeded(3)));
    expect(drawPlans(seeded(3))).toEqual(drawPlans(seeded(3)));
    expect(pages.team("benchnote0a1b", drawTeam(seeded(3)).people)).toBe(
      pages.team("benchnote0a1b", drawTeam(seeded(3)).people),
    );
  });

  it("draws answers with exactly one right value, over many seeds", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      const orders = drawOrders(random);
      expect(new Set(orders.map((row) => row.id)).size).toBe(5);
      expect(new Set(orders.map((row) => row.customer)).size).toBe(5);
      expect(new Set(orders.map((row) => row.total)).size).toBe(5);
      for (const row of orders) {
        expect(CUSTOMER_POOL).toContain(row.customer);
        expect(row.id).toMatch(/^ORD-\d{4}$/);
        expect(Number.isInteger(row.total)).toBe(true);
      }
      const prices = drawPrices(random);
      expect(new Set(prices.map((row) => row.unit)).size).toBe(6);
      expect(new Set(prices.map((row) => row.id)).size).toBe(6);
      for (const row of prices) expect(ITEM_POOL).toContain(row.name);
      const { plans, cheapest } = drawPlans(random);
      const monthly = plans.map((plan) =>
        plan.per === "year" ? plan.price / 12 : plan.price,
      );
      const sorted = [...monthly].sort((x, y) => x - y);
      expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(1);
      expect(plans[monthly.indexOf(sorted[0])].name).toBe(cheapest);
      expect(plans.filter((plan) => plan.per === "year")).toHaveLength(1);
      expect(plans.map((plan) => plan.name)).toEqual([...PLAN_NAMES]);
      const { people, engineers } = drawTeam(random);
      expect(engineers).toHaveLength(2);
      expect(new Set(people.map((person) => person.name)).size).toBe(4);
      for (const person of people) expect(TEAM_POOL).toContain(person.name);
      const facts = drawAbout(random);
      expect(facts.year).toBeGreaterThanOrEqual(1987);
      expect(facts.employees).toBeGreaterThanOrEqual(120);
      expect(facts.employees).toBeLessThanOrEqual(980);
      expect(facts.offices).toBeLessThanOrEqual(9);
      const sheet = drawSheet(random);
      expect(sheet.product).toBe(sheet.unit * sheet.quantity);
    }
  });

  it("links only within the token's own tree and loads nothing external", () => {
    const token = "benchnote0a1b";
    const random = seeded(11);
    const orders = drawOrders(random);
    for (const document of [
      pages.home(token),
      pages.orders(token, orders),
      pages.order(token, orders[0]),
      pages.prices(token, drawPrices(random)),
      pages.contact(token),
      pages.thanks(token),
    ]) {
      expect(document).not.toMatch(
        /https?:|\/\/|src=|<script|<link|<img|@import/i,
      );
      for (const [, target] of document.matchAll(/(?:href|action)="([^"]*)"/g))
        expect(
          target === `/${token}` || target.startsWith(`/${token}/`),
          target,
        ).toBe(true);
      expect(document).toMatch(new RegExp(`<title>[^<]+ · ${token}</title>`));
    }
  });

  it("lets the browser apply the page's own stylesheet and no other inline style", () => {
    // default-src 'self' alone blocks the inline <style>: the tables would
    // render without borders or padding and the model would read cells run
    // together from the screenshot.
    for (const html of [
      pages.home("benchnote0a1b"),
      pages.orders("benchnote0a1b", drawOrders(seeded(4))),
    ]) {
      const [, style] = html.match(/<style>([\s\S]*?)<\/style>/) ?? [];
      expect(style).toBe(PAGE_STYLE);
      const hash = createHash("sha256").update(style).digest("base64");
      const directives = FIXTURE_HEADERS["Content-Security-Policy"]
        .split(";")
        .map((directive) => directive.trim());
      expect(directives).toContain(`style-src 'sha256-${hash}'`);
      expect(directives).toContain("default-src 'self'");
      expect(FIXTURE_HEADERS["Content-Security-Policy"]).not.toMatch(
        /unsafe-inline|unsafe-eval|\*/,
      );
    }
  });

  it("escapes whatever it puts in a page", () => {
    const html = pages.order("benchnote0a1b", {
      id: "ORD-1",
      customer: '<b onclick="x">&',
      total: 5,
    });
    expect(html).toContain("&lt;b onclick=&quot;x&quot;&gt;&amp;");
    expect(html).not.toContain("<b onclick");
  });
});

describe("fixture store", () => {
  const token = "benchnote0a1b";
  const html = { accept: "text/html" };
  const fresh = () => {
    const store = createFixtureStore(FIXTURE_PORT);
    store.register(token, {
      home: "<p>home</p>",
      orders: "<p>orders</p>",
      contact: "<form>",
    });
    return store;
  };

  it("serves registered pages with the safety headers and logs what was opened", () => {
    const store = fresh();
    const reply = store.respond({
      method: "GET",
      url: `/${token}/orders?x=1`,
      headers: html,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("<p>orders</p>");
    expect(reply.headers["Content-Security-Policy"]).toMatch(
      /default-src 'self'/,
    );
    expect(reply.headers["Cache-Control"]).toBe("no-store");
    store.respond({ method: "GET", url: `/${token}`, headers: html });
    expect(store.read(token).visits).toEqual([`/${token}/orders`, `/${token}`]);
    for (const [name, value] of Object.entries(FIXTURE_HEADERS))
      expect(reply.headers[name]).toBe(value);
  });

  it("does not log a HEAD, a prefetch, a prerender or a favicon as a visit", () => {
    const store = fresh();
    expect(
      store.respond({ method: "HEAD", url: `/${token}/orders`, headers: html })
        .body,
    ).toBe("");
    for (const headers of [
      { accept: "text/html", "sec-purpose": "prefetch;prerender" },
      { accept: "text/html", purpose: "prefetch" },
      // A favicon or image request, which does not accept HTML.
      { accept: "image/avif,image/webp" },
    ])
      expect(
        store.respond({ method: "GET", url: `/${token}/orders`, headers })
          .status,
      ).toBe(204);
    expect(store.read(token).visits).toEqual([]);
    expect(isSideRequest({ accept: "*/*" })).toBe(false);
    expect(isSideRequest({})).toBe(false);
  });

  it("answers 404 for another token, an unregistered page or a prototype key", () => {
    const store = fresh();
    expect(
      store.respond({
        method: "GET",
        url: "/benchnote9999/orders",
        headers: html,
      }).status,
    ).toBe(404);
    expect(
      store.respond({ method: "GET", url: `/${token}/plans`, headers: html })
        .status,
    ).toBe(404);
    expect(
      store.respond({ method: "GET", url: "/etc/passwd", headers: html })
        .status,
    ).toBe(404);
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(
        store.respond({ method: "GET", url: `/${token}/${key}`, headers: html })
          .status,
      ).toBe(404);
      expect(
        store.respond({
          method: "POST",
          url: `/${token}/${key}`,
          headers: html,
          body: "a=1",
        }).status,
      ).toBe(404);
    }
    expect(store.read(token)).toEqual({
      port: FIXTURE_PORT,
      visits: [],
      submissions: [],
    });
  });

  it("records a form post and redirects to the thanks page", () => {
    const store = fresh();
    const reply = store.respond({
      method: "POST",
      url: `/${token}/contact`,
      headers: html,
      body: `name=${token}&message=hello+there&name=second`,
    });
    expect(reply.status).toBe(303);
    expect(reply.headers.Location).toBe(`/${token}/thanks`);
    expect(store.read(token).submissions).toEqual([
      {
        path: `/${token}/contact`,
        fields: { name: token, message: "hello there" },
      },
    ]);
    expect(
      store.respond({ method: "PUT", url: `/${token}/contact`, headers: html })
        .status,
    ).toBe(405);
  });

  it("parses form fields as data, never as the object's prototype", () => {
    const fields = parseForm("__proto__=x&constructor=y&a=1");
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(fields.__proto__ === "x" || Object.hasOwn(fields, "__proto__")).toBe(
      true,
    );
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(fields.constructor).toBe("y");
    expect(parseForm(undefined)).toEqual({});
    expect(
      Object.keys(
        parseForm(Array.from({ length: 50 }, (_, i) => `f${i}=1`).join("&")),
      ),
    ).toHaveLength(32);
  });

  it("refuses a token outside the marker namespace, and resets only the log", () => {
    const store = fresh();
    expect(() => store.register("notes", {})).toThrow();
    expect(() => store.register("../benchnote0a1b", {})).toThrow();
    store.respond({ method: "GET", url: `/${token}/orders`, headers: html });
    store.reset(token);
    expect(store.read(token).visits).toEqual([]);
    expect(
      store.respond({ method: "GET", url: `/${token}/orders`, headers: html })
        .status,
    ).toBe(200);
    const copy = store.read(token);
    copy.visits.push("/tampered");
    expect(store.read(token).visits).toEqual([`/${token}/orders`]);
  });

  it("routes only token paths", () => {
    expect(routeOf(`/${token}`)).toEqual({
      token,
      path: `/${token}`,
      key: "home",
    });
    expect(routeOf(`/${token}/orders/ORD-1?x#y`)).toEqual({
      token,
      path: `/${token}/orders/ORD-1`,
      key: "orders/ORD-1",
    });
    expect(routeOf("/")).toBeUndefined();
    expect(routeOf("/favicon.ico")).toBeUndefined();
    expect(routeOf("/%E0%A4%A")).toBeUndefined();
  });

  it("keeps only the navigation links to pages the token registered", () => {
    const store = createFixtureStore(FIXTURE_PORT);
    store.register(token, {
      about: pages.about(token, drawAbout(seeded(2))),
      home: pages.home(token),
    });
    const about = store.respond({
      method: "GET",
      url: `/${token}/about`,
      headers: html,
    }).body;
    expect(
      [...about.matchAll(/href="([^"]*)"/g)].map(([, href]) => href),
    ).toEqual([`/${token}/`, `/${token}/about`]);
    const alone = createFixtureStore(FIXTURE_PORT);
    alone.register(token, { sheet: pages.sheet(token, drawSheet(seeded(2))) });
    const sheet = alone.respond({
      method: "GET",
      url: `/${token}/sheet`,
      headers: html,
    }).body;
    expect(sheet).not.toContain("<nav");
    expect(sheet).not.toContain("href=");
  });

  it("hands the harness a contract handle with the token's base URL", () => {
    const store = createFixtureStore(FIXTURE_PORT);
    const handle = fixtureHandle(store, FIXTURE_PORT);
    expect(handle.url).toBe(`http://127.0.0.1:${FIXTURE_PORT}`);
    expect(handle.register(token, { home: "x" })).toBe(
      `${handle.url}/${token}`,
    );
    expect(handle.read(token).visits).toEqual([]);
  });
});

describe("fixture server (scripts/bench-fixtures.mjs)", () => {
  const load = async () =>
    (await import(
      /* @vite-ignore */ pathToFileURL(join(root, "scripts/bench-fixtures.mjs"))
        .href
    )) as {
      DEFAULT_PORT: number;
      LOOPBACK_HOSTS: Set<string>;
      startFixtureServer: (
        store: FixtureStore,
        options?: { host?: string; port?: number },
      ) => Promise<FixtureHandle & { close(): Promise<void> }>;
    };

  it("agrees with the graders' port", async () => {
    expect((await load()).DEFAULT_PORT).toBe(FIXTURE_PORT);
  });

  it("refuses to bind anything but a literal loopback address", async () => {
    const { startFixtureServer } = await load();
    for (const host of [
      "0.0.0.0",
      "::",
      "localhost",
      "192.168.1.20",
      "example.com",
    ])
      await expect(
        startFixtureServer(createFixtureStore(), { host, port: 0 }),
      ).rejects.toMatchObject({ code: "FIXTURE_HOST" });
  });

  it("serves a token's pages on 127.0.0.1 and logs the visit and the post", async () => {
    const { startFixtureServer } = await load();
    const store = createFixtureStore();
    const server = await startFixtureServer(store, { port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const token = "benchnote0a1b";
      const base = server.register(token, {
        orders: pages.orders(token, drawOrders(seeded(1))),
        contact: pages.contact(token),
        thanks: pages.thanks(token),
      });
      const page = await fetch(`${base}/orders`, {
        headers: { accept: "text/html" },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toMatch(
        /default-src 'self'/,
      );
      expect(await page.text()).toContain(`Orders · ${token}`);
      const posted = await fetch(`${base}/contact`, {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `name=${token}&message=hello`,
        redirect: "manual",
      });
      expect(posted.status).toBe(303);
      await posted.text();
      expect(server.read(token)).toEqual({
        port: FIXTURE_PORT,
        visits: [`/${token}/orders`],
        submissions: [
          {
            path: `/${token}/contact`,
            fields: { name: token, message: "hello" },
          },
        ],
      });
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------- readers */

describe("files reader", () => {
  it("walks the folder, hashes files, lowercases text and skips dotfiles", async () => {
    const dir = join(tempHome(), "walk");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "Notes.TXT"), "Hello World\n");
    writeFileSync(join(dir, "sub", "data.csv"), "A,B\n");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "image.png"), "PNG");
    writeFileSync(join(dir, "big.txt"), "x".repeat(300 * 1024));
    const result = await readFiles(dir, fileExec);
    expect(result?.entries.map((entry) => entry.path)).toEqual([
      "Notes.TXT",
      "big.txt",
      "image.png",
      "sub",
      "sub/data.csv",
    ]);
    const notes = result!.entries[0];
    expect(notes).toMatchObject({
      kind: "file",
      size: 12,
      text: "hello world\n",
    });
    expect(notes.sha256).toBe(sha256("Hello World\n"));
    expect(result!.entries[1].text).toBeUndefined();
    expect(result!.entries[2].text).toBeUndefined();
    expect(result!.entries[3]).toMatchObject({ kind: "folder" });
    expect(result!.entries[4].text).toBe("a,b\n");
  });

  it("never follows a symlink, inside the folder or as the folder", async () => {
    const home = tempHome();
    const secret = join(home, "secret.txt");
    writeFileSync(secret, "user data");
    const dir = join(home, "bench");
    mkdirSync(dir);
    symlinkSync(secret, join(dir, "link.txt"));
    symlinkSync(home, join(dir, "linked-folder"));
    const result = await readFiles(dir, fileExec);
    expect(result?.entries).toEqual([
      { path: "link.txt", kind: "file", size: 0, sha256: sha256("") },
      { path: "linked-folder", kind: "file", size: 0, sha256: sha256("") },
    ]);
    const linkedRoot = join(home, "linked-bench");
    symlinkSync(dir, linkedRoot);
    expect((await readFiles(linkedRoot, fileExec))?.entries).toEqual([]);
    expect((await readFiles(join(home, "absent"), fileExec))?.entries).toEqual(
      [],
    );
  });

  it("reads RTF through textutil and a zip's entry list without its resource forks", async () => {
    const dir = join(tempHome(), "docs");
    mkdirSync(dir);
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "textutil") return "Plain TEXT\n";
      if (file === "unzip")
        return "a.txt\n__MACOSX/\n__MACOSX/._a.txt\nB.csv\n";
      throw new Error(file);
    };
    writeFileSync(join(dir, "doc.rtf"), "{\\rtf1 x}");
    writeFileSync(join(dir, "Archive.zip"), "PK");
    const result = await readFiles(dir, exec);
    expect(
      result?.entries.find((entry) => entry.path === "doc.rtf")?.text,
    ).toBe("plain text\n");
    expect(
      result?.entries.find((entry) => entry.path === "Archive.zip")?.text,
    ).toBe("a.txt\nb.csv");
    expect(calls).toContainEqual([
      "textutil",
      "-convert",
      "txt",
      "-stdout",
      join(dir, "doc.rtf"),
    ]);
    expect(calls).toContainEqual(["unzip", "-Z1", join(dir, "Archive.zip")]);
    // A converter that fails leaves the entry without text, not the walk.
    const failing = await readFiles(dir, async () => {
      throw new Error("boom");
    });
    expect(failing?.entries.every((entry) => entry.text === undefined)).toBe(
      true,
    );
  });
});

describe("agenda and music parsing", () => {
  it("reads the helper's find output exactly as Agenda.swift prints it", () => {
    const line = JSON.stringify({
      access: { calendar: "granted", reminders: "granted" },
      items: [
        {
          kind: "event",
          title: "benchnote0a1b sync",
          calendar: "OpenAssistBench",
          start: "2026-09-19T14:00:00-07:00",
          end: "2026-09-19T15:00:00-07:00",
          allDay: false,
        },
        {
          kind: "reminder",
          title: "Benchnote0a1b water",
          calendar: "OpenAssistBench",
          due: "2026-09-18T09:00:00-07:00",
          completed: true,
        },
        { kind: "note", title: "x" },
        { kind: "event", title: 5 },
      ],
    });
    expect(parseAgendaFind(`noise\n${line}\n`)).toEqual({
      access: { calendar: "granted", reminders: "granted" },
      items: [
        {
          kind: "event",
          title: "benchnote0a1b sync",
          calendar: "OpenAssistBench",
          start: "2026-09-19T14:00:00-07:00",
          end: "2026-09-19T15:00:00-07:00",
          allDay: false,
        },
        {
          kind: "reminder",
          title: "Benchnote0a1b water",
          calendar: "OpenAssistBench",
          due: "2026-09-18T09:00:00-07:00",
          completed: true,
        },
      ],
    });
  });

  it("reads an error, garbage or an unbounded list as nothing or bounded", () => {
    expect(parseAgendaFind('{"error":"BAD_TOKEN"}')).toBeUndefined();
    expect(parseAgendaFind("not json")).toBeUndefined();
    expect(parseAgendaFind("[1,2]")).toBeUndefined();
    expect(parseAgendaFind("{}")).toEqual({
      access: { calendar: "unknown", reminders: "unknown" },
      items: [],
    });
    const many = JSON.stringify({
      items: Array.from({ length: 80 }, () => ({
        kind: "reminder",
        title: "benchnote0a1b",
      })),
    });
    expect(parseAgendaFind(many)?.items).toHaveLength(50);
  });

  it("builds a read-only Music script for a marker only", () => {
    const script = musicScript("benchnote0a1b");
    expect(script).toContain('"benchnote0a1b"');
    expect(script).toContain("music.running()");
    expect(script).not.toMatch(
      /\b(play|delete|make|add|duplicate|activate)\s*\(/,
    );
    expect(() => musicScript('x"); Application("Finder").delete(')).toThrow();
  });

  it("parses Music's answer and treats anything else as unavailable", () => {
    expect(
      parseMusic(
        '{"available":true,"player":"paused","playlists":[{"name":"benchnote0a1b","tracks":2}]}',
      ),
    ).toEqual({
      available: true,
      player: "paused",
      playlists: [{ name: "benchnote0a1b", tracks: 2 }],
    });
    expect(
      parseMusic('{"available":true,"player":"fast forwarding"}').player,
    ).toBe("unknown");
    expect(parseMusic("execution error: Not authorised").available).toBe(false);
  });
});

/**
 * An in-memory agenda helper and Spotlight, speaking the helper's JSON.
 * `foreign` items are ones the helper cannot show the attempt made (its
 * removal rule is tested in AgendaRulesTests.swift): remove keeps and counts
 * them.
 */
function fakeHelpers(
  items: AgendaItem[],
  spotlight: string[] = [],
  options: {
    foreign?: AgendaItem[];
    access?: { calendar: string; reminders: string };
    setup?: string;
  } = {},
) {
  const calls: string[][] = [];
  const access = options.access ?? {
    calendar: "granted",
    reminders: "granted",
  };
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === AGENDA_BINARY) {
      const [command, token = ""] = args;
      if (command === "setup")
        return (
          options.setup ??
          JSON.stringify({
            access,
            containers: {
              calendar: BENCH_CONTAINER,
              reminders: BENCH_CONTAINER,
            },
          })
        );
      if (command === "add") {
        const item = JSON.parse(token) as AgendaItem;
        items.push(item);
        return JSON.stringify({ added: item.kind });
      }
      if (!TOKEN_RE.test(token)) return '{"error":"BAD_TOKEN"}';
      const carries = (item: AgendaItem) =>
        item.title.toLowerCase().includes(token);
      if (command === "find")
        return JSON.stringify({ access, items: items.filter(carries) });
      if (command === "remove") {
        let removed = 0;
        let foreign = 0;
        for (let i = items.length - 1; i >= 0; i--) {
          if (!carries(items[i])) continue;
          if (options.foreign?.includes(items[i])) foreign++;
          else {
            items.splice(i, 1);
            removed++;
          }
        }
        return JSON.stringify({ removed, foreign });
      }
    }
    if (file === "mdfind") return spotlight.join("\n") + "\n";
    if (file === "osascript")
      return '{"available":true,"player":"stopped","playlists":[]}';
    if (file === "textutil" || file === "unzip") return fileExec(file, args, 0);
    throw new Error(`unexpected ${file}`);
  };
  return { exec, calls };
}

const attemptContext = (a: Attempt): AttemptContext => ({
  token: a.token,
  benchDir: a.benchDir,
  benchPath: `~/OpenAssistBench/${a.token}`,
  fixture: a.fixture,
});

describe("readEvidence", () => {
  it("runs only the readers a task declares", async () => {
    const a = await prepare(byId("text-append-line"));
    const { exec, calls } = fakeHelpers([]);
    const { readEvidence } = createReaders({ exec, home: a.home });
    const out = await readEvidence(byId("text-append-line"), attemptContext(a));
    expect(Object.keys(out)).toEqual(["files"]);
    expect(calls).toEqual([]);
  });

  it("reads agenda and fixture evidence for the attempt's token", async () => {
    const task = byId("multi-draft-to-reminder");
    const a = await prepare(task);
    const { exec, calls } = fakeHelpers([
      reminder(`${a.token} book the dentist`, at(1, 0)),
      reminder("Dentist", at(1, 0)),
    ]);
    const { readEvidence } = createReaders({ exec, home: a.home });
    const out = await readEvidence(task, attemptContext(a));
    expect(out.agenda?.items.map((item) => item.title)).toEqual([
      `${a.token} book the dentist`,
    ]);
    expect(calls).toEqual([[AGENDA_BINARY, "find", a.token]]);
    const page = await prepare(byId("browser-nav-chain"));
    get(page, "orders");
    const fixtureOut = await createReaders({
      exec,
      home: page.home,
    }).readEvidence(byId("browser-nav-chain"), attemptContext(page));
    expect(fixtureOut.fixture?.visits).toEqual([`/${page.token}/orders`]);
  });

  it("walks no folder but the one the token names", async () => {
    const a = await prepare(byId("text-append-line"));
    const { exec } = fakeHelpers([]);
    const { readEvidence } = createReaders({ exec, home: a.home });
    const elsewhere = { ...attemptContext(a), benchDir: a.home };
    expect(await readEvidence(byId("text-append-line"), elsewhere)).toEqual({});
  });

  it("leaves Music alone unless the reader was switched on", async () => {
    const task = byId("media-search-library");
    const a = await prepare(task);
    const { exec, calls } = fakeHelpers([]);
    const previous = process.env[MUSIC_READER_ENV];
    delete process.env[MUSIC_READER_ENV];
    try {
      const off = await createReaders({ exec, home: a.home }).readEvidence(
        task,
        attemptContext(a),
      );
      expect(off.music).toEqual({
        available: false,
        player: "unknown",
        playlists: [],
      });
      expect(calls).toEqual([]);
      expect(
        gradeTask(task, {
          ...(await SCENARIOS[task.id].pass(a)),
          music: off.music,
        }).reason,
      ).toBe("NO_MUSIC_READER");
      const on = await createReaders({
        exec,
        home: a.home,
        music: true,
      }).readEvidence(task, attemptContext(a));
      expect(on.music).toEqual({
        available: true,
        player: "stopped",
        playlists: [],
      });
      expect(calls[0][0]).toBe("osascript");
    } finally {
      if (previous === undefined) delete process.env[MUSIC_READER_ENV];
      else process.env[MUSIC_READER_ENV] = previous;
    }
  });

  it("answers no evidence when the agenda helper fails", async () => {
    const task = byId("agenda-rem-create");
    const a = await prepare(task);
    const { readEvidence } = createReaders({
      home: a.home,
      exec: async () => {
        throw new Error("no helper");
      },
    });
    const out = await readEvidence(task, attemptContext(a));
    expect(out.agenda).toBeUndefined();
    expect(gradeTask(task, evidenceOf(a, out)).reason).toBe(
      "NO_AGENDA_EVIDENCE",
    );
  });
});

describe("writeInside (PrepareContext.write)", () => {
  it("writes nested visible paths inside the folder", () => {
    const dir = join(tempHome(), "bench");
    mkdirSync(dir);
    writeInside(dir, "decoy/report.txt", "x");
    expect(readFileSync(join(dir, "decoy/report.txt"), "utf8")).toBe("x");
  });

  it("refuses escapes, dotfiles and symlinks", () => {
    const home = tempHome();
    const dir = join(home, "bench");
    mkdirSync(dir);
    for (const bad of [
      "../x.txt",
      "/etc/x",
      "a/../../x",
      ".hidden",
      "a/.git/x",
      "",
      "a//b",
      "./x",
    ])
      expect(() => writeInside(dir, bad, "x"), bad).toThrow();
    symlinkSync(join(home, "outside.txt"), join(dir, "dangling.txt"));
    expect(() => writeInside(dir, "dangling.txt", "x")).toThrow();
    expect(existsSync(join(home, "outside.txt"))).toBe(false);
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(dir, "linked"));
    expect(() => writeInside(dir, "linked/x.txt", "x")).toThrow();
    expect(existsSync(join(home, "elsewhere", "x.txt"))).toBe(false);
    expect(() => writeInside(join(home, "missing"), "x.txt", "x")).toThrow();
  });
});

/* ------------------------------------------------------------- cleanup */

describe("stray sweep rules", () => {
  const home = "/Users/someone";
  const token = "benchnote0a1b";
  const START = 1_000_000;
  const made = (): PathFacts => ({ kind: "file", born: START + 5_000 });
  const act = (
    path: string,
    facts: (path: string) => PathFacts = made,
    start: number | undefined = START,
    who = token,
  ) => strayAction(path, who, home, facts, start);

  it("deletes only this token's regular files the attempt made, under home, outside Library and the bench folder", () => {
    expect(act(`${home}/Documents/${token}.rtf`)).toBe("delete");
    expect(act(`${home}/Desktop/${token}-report.txt`)).toBe("delete");
    expect(act(`${home}/Library/Saved/${token}.rtf`)).toBe("ignore");
    expect(act(`/tmp/${token}.rtf`)).toBe("ignore");
    expect(act(`${home}/Documents/benchnote9999.rtf`)).toBe("ignore");
    expect(act(`${home}/Documents/notes.rtf`)).toBe("ignore");
    expect(act(`${home}/OpenAssistBench/${token}/${token}-a.txt`)).toBe(
      "ignore",
    );
    expect(act(`${home}/Documents/../../etc/${token}`)).toBe("ignore");
    expect(act(`${home}/Documents/${token}.rtf`, made, START, "notes")).toBe(
      "ignore",
    );
    // The harness's own quarantine is never swept.
    expect(
      act(`${home}/OpenAssistBench/.quarantine/${token}/${token}-a.txt`),
    ).toBe("ignore");
  });

  it("matches the token in any case, as Spotlight's query does", () => {
    expect(act(`${home}/Documents/Benchnote0a1b.rtf`)).toBe("delete");
    expect(act(`${home}/Documents/BENCHNOTE0A1B shopping.txt`)).toBe("delete");
  });

  it("leaves a user's file that was renamed to the token where it is (S6)", () => {
    const old = (): PathFacts => ({ kind: "file", born: START - 86_400_000 });
    expect(act(`${home}/Documents/${token}-a.docx`, old)).toBe("foreign");
    // An age that cannot be read, or no start to compare with, proves nothing.
    expect(
      act(`${home}/Documents/${token}-a.docx`, () => ({ kind: "file" })),
    ).toBe("foreign");
    expect(
      strayAction(`${home}/Documents/${token}-a.docx`, token, home, made),
    ).toBe("foreign");
    // Made at the very moment the attempt began still counts as the attempt's.
    expect(
      act(`${home}/Documents/${token}.rtf`, () => ({
        kind: "file",
        born: START,
      })),
    ).toBe("delete");
    expect(madeSince(START, START)).toBe(true);
    expect(madeSince(START - 1, START)).toBe(false);
    expect(madeSince(undefined, START)).toBe(false);
  });

  it("reports what it finds in iCloud Drive, and deletes only in TextEdit's own folder there", () => {
    const icloud = `${home}/Library/Mobile Documents`;
    // TextEdit saves here by default when iCloud Drive is on.
    expect(act(`${icloud}/com~apple~TextEdit/Documents/${token}.rtf`)).toBe(
      "delete",
    );
    expect(
      act(`${icloud}/com~apple~TextEdit/Documents/${token}.rtfd`, () => ({
        kind: "other",
        born: START + 1,
      })),
    ).toBe("report");
    expect(act(`${icloud}/com~apple~CloudDocs/${token}.rtf`)).toBe("report");
    expect(
      act(`${icloud}/com~apple~CloudDocs/${token}.rtf`, () => ({
        kind: "file",
        born: 1,
      })),
    ).toBe("foreign");
  });

  it("reports a folder or a link carrying the token instead of deleting it", () => {
    expect(
      act(`${home}/Documents/${token}.rtfd`, () => ({
        kind: "other",
        born: START + 1,
      })),
    ).toBe("report");
    expect(
      act(`${home}/Documents/${token}.rtf`, () => ({ kind: "missing" })),
    ).toBe("ignore");
  });
});

describe("the attempt's folder: what is the attempt's", () => {
  it("lists what is older than the attempt, without entering a folder of the user's", () => {
    const home = tempHome();
    const root = join(home, "bench");
    mkdirSync(join(root, "made/deep"), { recursive: true });
    mkdirSync(join(root, "theirs/inside"), { recursive: true });
    writeFileSync(join(root, "made/deep/new.txt"), "x");
    writeFileSync(join(root, "made/old.docx"), "x");
    writeFileSync(join(root, "theirs/inside/a.txt"), "x");
    writeFileSync(join(root, ".DS_Store"), "x");
    const older = new Set([join(root, "made/old.docx"), join(root, "theirs")]);
    const born = (path: string) => (older.has(path) ? 1 : 10);
    expect(olderEntries(root, 5, born)).toEqual(["made/old.docx", "theirs"]);
    // No start: nothing can be shown to be the attempt's.
    expect(olderEntries(root, undefined, born)).toEqual([
      ".DS_Store",
      "made",
      "theirs",
    ]);
    expect(olderEntries(join(home, "absent"), 5, born)).toBeUndefined();
  });
});

describe("cleanupAttempt", () => {
  it("leaves nothing marked behind, for every task, and nothing of the user's touched", async () => {
    for (const task of LONG_CATALOGUE) {
      const a = await prepare(task);
      const readers = task.evidence ?? [];
      const userItem = reminder("Dentist", at(1, 0), { calendar: "Home" });
      const items: AgendaItem[] = [userItem, ...a.added];
      const spotlight: string[] = [];
      const userFile = join(a.home, "Documents", "report.txt");
      mkdirSync(dirname(userFile), { recursive: true });
      writeFileSync(userFile, "the user's");
      if (readers.includes("agenda")) {
        const pass = await SCENARIOS[task.id].pass(a);
        items.push(...(pass.agenda?.items ?? []));
      }
      if (readers.includes("files")) {
        const stray = join(a.home, "Documents", `${a.token}.rtf`);
        writeFileSync(stray, "saved in the wrong place");
        spotlight.push(stray, userFile, a.benchDir);
      }
      if (readers.includes("fixture")) get(a, "orders");
      const { exec } = fakeHelpers(items, spotlight);
      const { cleanupAttempt } = createReaders({ exec, home: a.home });
      const leftovers = await cleanupAttempt(task, attemptContext(a));
      expect(leftovers, task.id).toEqual([]);
      expect(existsSync(a.benchDir), task.id).toBe(false);
      expect(items, task.id).toEqual([userItem]);
      expect(a.store.read(a.token).visits, task.id).toEqual([]);
      expect(
        existsSync(join(a.home, "Documents", `${a.token}.rtf`)),
        task.id,
      ).toBe(false);
      expect(readFileSync(userFile, "utf8"), task.id).toBe("the user's");
    }
  });

  it("refuses a token outside the namespace before touching anything", async () => {
    const a = await prepare(byId("text-append-line"));
    const { exec, calls } = fakeHelpers([]);
    const { cleanupAttempt } = createReaders({ exec, home: a.home });
    expect(
      await cleanupAttempt(byId("text-append-line"), {
        ...attemptContext(a),
        token: "notes",
      }),
    ).toEqual(["CLEANUP_REFUSED"]);
    expect(existsSync(a.benchDir)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a folder the token does not name, but still clears the agenda and the pages", async () => {
    const task = byId("multi-draft-to-reminder");
    const a = await prepare(task);
    const items = [reminder(`${a.token} book the dentist`, at(1, 0))];
    const { exec } = fakeHelpers(items);
    const { cleanupAttempt } = createReaders({ exec, home: a.home });
    const other = join(a.home, "Documents");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "keep.txt"), "x");
    const codes = await cleanupAttempt(task, {
      ...attemptContext(a),
      benchDir: other,
    });
    expect(codes).toEqual(["CLEANUP_REFUSED"]);
    expect(existsSync(join(other, "keep.txt"))).toBe(true);
    expect(items).toEqual([]);
  });

  it("refuses a symlinked bench folder instead of deleting through it", async () => {
    const task = byId("text-append-line");
    const home = tempHome();
    const token = benchToken();
    const target = join(home, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "x");
    mkdirSync(join(home, "OpenAssistBench"));
    symlinkSync(target, benchDirFor(home, token));
    const { exec } = fakeHelpers([]);
    const codes = await createReaders({ exec, home }).cleanupAttempt(task, {
      token,
      benchDir: benchDirFor(home, token),
      benchPath: `~/OpenAssistBench/${token}`,
    });
    expect(codes).toContain("CLEANUP_REFUSED");
    expect(codes).toContain("LEFTOVER_FILES");
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  it("reports what it could not remove or verify", async () => {
    const task = byId("agenda-cal-move");
    const a = await prepare(task);
    const stuck: Exec = async (file, args) => {
      if (args[0] === "remove") return '{"removed":0,"foreign":0}';
      if (args[0] === "find")
        return JSON.stringify({
          access: { calendar: "granted", reminders: "granted" },
          items: [
            event(`${a.token} sync`, at(1, 10), at(1, 11)),
            reminder(a.token, at(1, 0)),
          ],
        });
      throw new Error(file);
    };
    expect(
      await createReaders({ exec: stuck, home: a.home }).cleanupAttempt(
        task,
        attemptContext(a),
      ),
    ).toEqual(["LEFTOVER_EVENT", "LEFTOVER_REMINDER"]);
    const broken = await createReaders({
      home: a.home,
      exec: async () => {
        throw new Error("no helper");
      },
    }).cleanupAttempt(task, attemptContext(a));
    // No answer at all (a timeout, a missing helper): a later sweep asks again.
    expect(broken).toEqual(["LEFTOVER_AGENDA_NO_ANSWER"]);
  });

  it("tells a helper that gave no answer from a store it has no grant for", async () => {
    const task = byId("agenda-cal-move");
    const a = await prepare(task);
    const run = (remove: string | Error, find?: string) =>
      createReaders({
        home: a.home,
        exec: async (_file, args) => {
          if (args[0] === "remove") {
            if (remove instanceof Error) throw remove;
            return remove;
          }
          return (
            find ??
            JSON.stringify({
              access: { calendar: "granted", reminders: "granted" },
              items: [],
            })
          );
        },
      }).cleanupAttempt(task, attemptContext(a));
    const status = (calendar: string) =>
      JSON.stringify({
        access: { calendar, reminders: "granted" },
        error: "REMOVE_FAILED",
      });
    // The removal failed with the grant in place: it may not next time.
    expect(await run(status("granted"))).toEqual(["LEFTOVER_AGENDA_NO_ANSWER"]);
    // It failed because Calendar was never granted: no retry changes that.
    expect(await run(status("notDetermined"))).toEqual([
      "LEFTOVER_AGENDA_UNVERIFIED",
    ]);
    // Nothing readable, from remove or from the verifying find.
    expect(await run("")).toEqual(["LEFTOVER_AGENDA_NO_ANSWER"]);
    expect(
      await run(JSON.stringify({ removed: 0, foreign: 0 }), "Killed: 9"),
    ).toEqual(["LEFTOVER_AGENDA_NO_ANSWER"]);
    expect(await run(new Error("ETIMEDOUT"))).toEqual([
      "LEFTOVER_AGENDA_NO_ANSWER",
    ]);
  });

  it("reports a stray bundle it will not delete, and runs the task's own cleanup", async () => {
    const task: BenchTask = {
      ...byId("text-new-doc-save"),
      cleanup: async ({ token }) =>
        TOKEN_RE.test(token) ? ["LEFTOVER_CUSTOM"] : [],
    };
    const a = await prepare(task);
    const bundle = join(a.home, "Documents", `${a.token}.rtfd`);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "TXT.rtf"), "x");
    const { exec } = fakeHelpers([], [bundle]);
    const codes = await createReaders({ exec, home: a.home }).cleanupAttempt(
      task,
      attemptContext(a),
    );
    expect(codes).toEqual(["LEFTOVER_CUSTOM", "LEFTOVER_STRAY_FILE"]);
    expect(existsSync(join(bundle, "TXT.rtf"))).toBe(true);
  });
});

describe("cleanupAttempt: nothing of the user's is deleted", () => {
  const realBirth = (path: string) => {
    try {
      return lstatSync(path).birthtimeMs;
    } catch {
      return undefined;
    }
  };
  /** Birth times as the file system reports them, except `older`, which predate the attempt. */
  const bornWith = (older: string[]) => (path: string) =>
    older.includes(path) ? 1 : realBirth(path);

  it("moves a file or folder of the user's that the model moved in to quarantine, and deletes only what the attempt made", async () => {
    const task = byId("files-new-folder-move");
    const a = await prepare(task);
    const made = join(a.benchDir, `${a.token}-reports`);
    mkdirSync(made);
    renameSync(inBench(a, "report.txt"), join(made, "report.txt"));
    // Dragged in from the user's folders by the model: born long before.
    const theirs = join(made, "budget.xlsx");
    writeFileSync(theirs, "the user's budget");
    const folder = inBench(a, "Tax 2025");
    mkdirSync(folder);
    writeFileSync(join(folder, "return.pdf"), "the user's return");
    const { exec } = fakeHelpers([], []);
    const codes = await createReaders({
      exec,
      home: a.home,
      born: bornWith([theirs, folder]),
    }).cleanupAttempt(task, attemptContext(a));
    expect(codes).toEqual(["LEFTOVER_FOREIGN_FILE"]);
    expect(existsSync(a.benchDir)).toBe(false);
    const kept = quarantineFor(a.home, a.token);
    expect(
      readFileSync(join(kept, `${a.token}-reports`, "budget.xlsx"), "utf8"),
    ).toBe("the user's budget");
    expect(readFileSync(join(kept, "Tax 2025", "return.pdf"), "utf8")).toBe(
      "the user's return",
    );
    // What the attempt made went: the fixtures and the model's own folder.
    expect(existsSync(join(kept, `${a.token}-reports`, "report.txt"))).toBe(
      false,
    );
    expect(existsSync(join(kept, "notes.txt"))).toBe(false);
  });

  it("deletes nothing when the quarantine is not a plain folder", async () => {
    const task = byId("files-rename-pattern");
    const a = await prepare(task);
    const theirs = inBench(a, "draft notes.txt");
    writeFileSync(theirs, "the user's");
    const elsewhere = join(a.home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(a.home, "OpenAssistBench", ".quarantine"));
    const { exec } = fakeHelpers([], []);
    const codes = await createReaders({
      exec,
      home: a.home,
      born: bornWith([theirs]),
    }).cleanupAttempt(task, attemptContext(a));
    expect(codes).toEqual(["LEFTOVER_FOREIGN_FILE", "LEFTOVER_FILES"]);
    expect(readFileSync(theirs, "utf8")).toBe("the user's");
    expect(existsSync(join(elsewhere, a.token))).toBe(false);
  });

  it("leaves a file of the user's that was renamed to the token where it is", async () => {
    const task = byId("files-rename-pattern");
    const a = await prepare(task);
    const renamed = join(a.home, "Documents", `${a.token}-a.docx`);
    mkdirSync(dirname(renamed), { recursive: true });
    writeFileSync(renamed, "the user's draft");
    const saved = join(a.home, "Documents", `${a.token}.rtf`);
    writeFileSync(saved, "the attempt's");
    const { exec } = fakeHelpers([], [renamed, saved]);
    const codes = await createReaders({
      exec,
      home: a.home,
      born: bornWith([renamed]),
    }).cleanupAttempt(task, attemptContext(a));
    expect(codes).toEqual(["LEFTOVER_FOREIGN_FILE"]);
    expect(readFileSync(renamed, "utf8")).toBe("the user's draft");
    expect(existsSync(saved)).toBe(false);
  });

  it("deletes nothing outside the folder when the attempt's start cannot be read", async () => {
    const task = byId("text-new-doc-save");
    const a = await prepare(task);
    const saved = join(a.home, "Documents", `${a.token}.rtf`);
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, "x");
    const { exec, calls } = fakeHelpers([], [saved]);
    const codes = await createReaders({
      exec,
      home: a.home,
      born: () => undefined,
    }).cleanupAttempt(task, attemptContext(a));
    expect(codes).toContain("LEFTOVER_FOREIGN_FILE");
    expect(existsSync(saved)).toBe(true);
    expect(calls.some(([, command]) => command === "remove")).toBe(false);
  });

  it("finds a stray saved in TextEdit's iCloud folder, and matches the token in any case", async () => {
    const task = byId("text-new-doc-save");
    const a = await prepare(task);
    const icloud = join(
      a.home,
      "Library",
      "Mobile Documents",
      "com~apple~TextEdit",
      "Documents",
    );
    mkdirSync(icloud, { recursive: true });
    const saved = join(icloud, `${a.token}.rtf`);
    writeFileSync(saved, "saved to iCloud");
    const { exec, calls } = fakeHelpers([], [saved]);
    const codes = await createReaders({ exec, home: a.home }).cleanupAttempt(
      task,
      attemptContext(a),
    );
    expect(codes).toEqual([]);
    expect(existsSync(saved)).toBe(false);
    expect(calls).toContainEqual([
      "mdfind",
      "-onlyin",
      a.home,
      `kMDItemFSName == "${a.token}*"c`,
    ]);
  });

  it("says the sweep is unverified when Spotlight gives no answer", async () => {
    const task = byId("text-new-doc-save");
    const a = await prepare(task);
    const { exec } = fakeHelpers([]);
    const noSpotlight: Exec = async (file, args, ms) => {
      if (file === "mdfind") throw new Error("Spotlight is off");
      return exec(file, args, ms);
    };
    expect(
      await createReaders({ exec: noSpotlight, home: a.home }).cleanupAttempt(
        task,
        attemptContext(a),
      ),
    ).toEqual(["SWEEP_UNVERIFIED"]);
  });
});

describe("cleanupAttempt: agenda items", () => {
  it("tells the helper when the attempt started, verifies over two years, and reports what it kept", async () => {
    const task = byId("agenda-rem-create");
    const a = await prepare(task);
    const start = lstatSync(a.benchDir).birthtimeMs;
    // The model typed the token into the user's "Buy milk", in a shared list.
    const theirs = reminder(`Buy milk${a.token}`, at(1, 0), {
      calendar: "Groceries",
    });
    const items = [reminder(a.token, at(1, 0)), theirs];
    const { exec, calls } = fakeHelpers(items, [], { foreign: [theirs] });
    const codes = await createReaders({ exec, home: a.home }).cleanupAttempt(
      task,
      attemptContext(a),
    );
    expect(calls).toContainEqual([
      AGENDA_BINARY,
      "remove",
      a.token,
      new Date(start).toISOString(),
    ]);
    expect(calls).toContainEqual([AGENDA_BINARY, "find", a.token, "wide"]);
    expect(codes).toEqual(["LEFTOVER_FOREIGN_MARKED", "LEFTOVER_REMINDER"]);
    expect(items).toEqual([theirs]);
  });

  it("does not call a store the helper cannot read clean", async () => {
    // This Mac's documented state: Calendar never asked, Reminders granted.
    const access = { calendar: "notDetermined", reminders: "granted" };
    for (const id of [
      "agenda-cal-create-tomorrow",
      "multi-folder-note-event",
    ]) {
      const task = byId(id);
      const a = await prepare(task);
      const { exec } = fakeHelpers([], [], { access });
      expect(
        await createReaders({ exec, home: a.home }).cleanupAttempt(
          task,
          attemptContext(a),
        ),
        id,
      ).toContain("LEFTOVER_AGENDA_UNVERIFIED");
    }
    const task = byId("agenda-rem-create");
    const a = await prepare(task);
    const { exec } = fakeHelpers([], [], { access });
    expect(
      await createReaders({ exec, home: a.home }).cleanupAttempt(
        task,
        attemptContext(a),
      ),
    ).toEqual([]);
  });

  it("gives no start, so the helper keeps everything outside its own containers, when the folder is gone", async () => {
    const task = byId("agenda-rem-complete");
    const a = await prepare(task);
    rmSync(a.benchDir, { recursive: true });
    const { exec, calls } = fakeHelpers([]);
    await createReaders({ exec, home: a.home }).cleanupAttempt(
      task,
      attemptContext(a),
    );
    expect(calls).toContainEqual([AGENDA_BINARY, "remove", a.token]);
  });

  it("treats a helper that does not count what it kept as unverified", async () => {
    const task = byId("agenda-rem-create");
    const a = await prepare(task);
    const old: Exec = async (_, args) =>
      args[0] === "remove"
        ? '{"removed":1}'
        : JSON.stringify({
            access: { calendar: "granted", reminders: "granted" },
            items: [],
          });
    expect(
      await createReaders({ exec: old, home: a.home }).cleanupAttempt(
        task,
        attemptContext(a),
      ),
    ).toEqual(["LEFTOVER_AGENDA_UNVERIFIED"]);
  });
});

describe("agenda readiness (PrepareContext.agenda)", () => {
  const agendaTasks = LONG_CATALOGUE.filter((task) =>
    task.evidence?.includes("agenda"),
  );

  it("knows which store each agenda task writes", () => {
    expect(agendaKinds(byId("agenda-cal-create-tomorrow"))).toEqual(["event"]);
    expect(agendaKinds(byId("multi-folder-note-event"))).toEqual(["event"]);
    expect(agendaKinds(byId("agenda-rem-two"))).toEqual(["reminder"]);
    expect(agendaKinds(byId("multi-draft-to-reminder"))).toEqual(["reminder"]);
    expect(agendaKinds(byId("text-append-line"))).toEqual([]);
    expect(
      agendaKinds({ ...byId("agenda-rem-two"), apps: [TEXTEDIT] }),
    ).toEqual(["event", "reminder"]);
    for (const task of agendaTasks)
      expect(agendaKinds(task).length, task.id).toBeGreaterThan(0);
  });

  it("reads setup's answer as the stores that are granted and have their local container", () => {
    expect(
      parseAgendaSetup(
        JSON.stringify({
          access: { calendar: "granted", reminders: "granted" },
          containers: { calendar: BENCH_CONTAINER, reminders: BENCH_CONTAINER },
        }),
      ),
    ).toEqual(["event", "reminder"]);
    expect(
      parseAgendaSetup(
        JSON.stringify({
          access: { calendar: "notDetermined", reminders: "granted" },
          containers: { reminders: BENCH_CONTAINER },
        }),
      ),
    ).toEqual(["reminder"]);
    for (const error of ["NO_LOCAL_SOURCE", "SETUP_FAILED", "NO_ACCESS"])
      expect(
        parseAgendaSetup(
          JSON.stringify({
            access: { calendar: "granted", reminders: "granted" },
            error,
          }),
        ),
        error,
      ).toEqual([]);
    expect(parseAgendaSetup("garbage")).toEqual([]);
  });

  it("skips every agenda task when setup finds no local source", async () => {
    const { exec, calls } = fakeHelpers([], [], {
      setup: JSON.stringify({
        access: { calendar: "granted", reminders: "granted" },
        error: "NO_LOCAL_SOURCE",
      }),
    });
    const { agendaFor } = createReaders({ exec, home: tempHome() });
    for (const task of agendaTasks) {
      const agenda = await agendaFor(task);
      expect(agenda, task.id).toBeUndefined();
      const { attempt, parameters } = await prepareRaw(task, {
        agenda: agenda ?? false,
      });
      expect(parameters, task.id).toBeNull();
      expect(attempt.written, task.id).toEqual([]);
    }
    expect(calls.every(([, command]) => command === "setup")).toBe(true);
  });

  it("gives an agenda only to tasks whose store is ready", async () => {
    // Calendar not granted: setup made only the reminders list.
    const { exec } = fakeHelpers([], [], {
      access: { calendar: "notDetermined", reminders: "granted" },
      setup: JSON.stringify({
        access: { calendar: "notDetermined", reminders: "granted" },
        containers: { reminders: BENCH_CONTAINER },
      }),
    });
    const { agendaFor } = createReaders({ exec, home: tempHome() });
    for (const task of agendaTasks) {
      const ready = (await agendaFor(task)) !== undefined;
      expect(ready, task.id).toBe(task.apps.includes(REMINDERS));
    }
    expect(await agendaFor(byId("text-append-line"))).toBeUndefined();
  });

  it("adds through the helper, only to a ready store, and fails loudly", async () => {
    const items: AgendaItem[] = [];
    const { exec, calls } = fakeHelpers(items, [], {
      setup: JSON.stringify({
        access: { calendar: "notDetermined", reminders: "granted" },
        containers: { reminders: BENCH_CONTAINER },
      }),
    });
    const agenda = await createReaders({ exec, home: tempHome() }).agendaFor(
      byId("agenda-rem-complete"),
    );
    const due = at(0, 9);
    await agenda!.add({ kind: "reminder", title: "benchnote0a1b water", due });
    expect(calls).toContainEqual([
      AGENDA_BINARY,
      "add",
      JSON.stringify({ kind: "reminder", title: "benchnote0a1b water", due }),
    ]);
    expect(items).toHaveLength(1);
    await expect(
      agenda!.add({
        kind: "event",
        title: "benchnote0a1b sync",
        start: at(1, 10),
        end: at(1, 11),
      }),
    ).rejects.toThrow("AGENDA_NOT_READY");
    const refusing = await createReaders({
      home: tempHome(),
      exec: async (_, args) =>
        args[0] === "setup"
          ? JSON.stringify({
              access: { calendar: "granted", reminders: "granted" },
              containers: {
                calendar: BENCH_CONTAINER,
                reminders: BENCH_CONTAINER,
              },
            })
          : '{"error":"BAD_ITEM"}',
    }).agendaFor(byId("agenda-rem-complete"));
    await expect(
      refusing!.add({ kind: "reminder", title: "benchnote0a1b water" }),
    ).rejects.toThrow("AGENDA_ADD_FAILED");
  });
});

/* ----------------------------------------------------------- selection */

describe("suite selection", () => {
  it("keeps the smoke suite the default", () => {
    expect(catalogueFor()).toEqual(CATALOGUE);
    expect(categoriesFor()).toEqual(CATEGORIES);
    expect(selectSuite(undefined).tasks).toEqual(CATALOGUE);
  });

  it("selects a whole suite by name, or every suite", () => {
    expect(selectSuite("long").tasks).toEqual(LONG_CATALOGUE);
    expect(selectSuite(undefined, "long").tasks).toEqual(LONG_CATALOGUE);
    expect(selectSuite("smoke,long").tasks).toEqual([
      ...CATALOGUE,
      ...LONG_CATALOGUE,
    ]);
    // "all" holds the market suite too; tests/bench-market.test.ts pins it.
    expect(selectSuite("all").tasks).toEqual(catalogueFor("all"));
    expect(catalogueFor("all").length).toBeGreaterThan(
      CATALOGUE.length + LONG_CATALOGUE.length,
    );
    for (const category of [...CATEGORIES, ...LONG_CATEGORIES])
      expect(categoriesFor("all")).toContain(category);
  });

  it("resolves ids and categories against the chosen suite", () => {
    expect(selectSuite("files", "long").tasks.map((task) => task.id)).toEqual([
      "files-rename-pattern",
      "files-new-folder-move",
      "files-sort-by-type",
      "files-compress",
    ]);
    expect(selectSuite("files", "all").tasks.map((task) => task.id)).toContain(
      "files-open-recent",
    );
    expect(selectSuite("agenda-rem-two,long", "smoke").tasks).toEqual(
      LONG_CATALOGUE,
    );
    expect(
      selectSuite("agenda,calculator-open", "all").tasks.map((task) => task.id),
    ).toContain("calculator-open");
    expect(selectSuite("nope", "long").unknown).toEqual(["nope"]);
  });
});

/* ------------------------------------------------------- import safety */

describe("long suite modules and the dry run", () => {
  const imports = (file: string) =>
    [...readFileSync(join(root, file), "utf8").matchAll(/from "([^"]+)"/g)].map(
      ([, name]) => name,
    );

  it("keeps the catalogue and pages free of anything that drives the Mac", () => {
    for (const file of [
      "src/gym/bench/catalogue-long.ts",
      "src/gym/bench/fixtures.ts",
    ])
      for (const name of imports(file))
        expect(
          ["./catalogue", "./fixtures", "./graders", "./types", "node:crypto"],
          `${file}: ${name}`,
        ).toContain(name);
  });

  it("gives the readers no path to a provider, the controller or the runner", () => {
    for (const name of imports("src/gym/bench/readers.ts"))
      expect(
        name.startsWith("node:") || ["./graders", "./types"].includes(name),
        name,
      ).toBe(true);
  });

  it("loads the readers, if bench.mjs loads them at all, only after the dry run exits", () => {
    const source = readFileSync(join(root, "scripts/bench.mjs"), "utf8");
    const exit = source.indexOf('process.exit(0);\n}\n\nif (!values["i-know');
    expect(exit).toBeGreaterThan(0);
    const readers = source.indexOf("src/gym/bench/readers");
    if (readers >= 0) expect(readers).toBeGreaterThan(exit);
  });
});

/* ------------------------------------------------------- per-fact checks */

describe("long suite per-fact checks", () => {
  /** research-list-note graded on a note of the drawn engineers but `omit`, after the Team page. */
  const listNote = async (omit: string[] = [], steps = researchSteps) => {
    const task = byId("research-list-note");
    const a = await prepare(task);
    const engineers = a.parameters.engineers.split(",");
    const body = engineers
      .filter((_, i) => !omit.includes(`engineer${i + 1}`))
      .map((name) => `${name}\n`)
      .join("");
    appendFileSync(own(a, "notes.txt"), body);
    get(a, "team");
    return {
      a,
      grade: gradeTask(
        task,
        evidenceOf(
          a,
          { files: await files(a), fixture: a.store.read(a.token) },
          { steps },
        ),
      ),
    };
  };
  const parts = (checks: Record<string, boolean>) =>
    Object.fromEntries(
      Object.entries(checks).filter(([key]) => key.startsWith("noted.")),
    );

  it("research-list-note: each engineer is a part, and a missing one is named by position", async () => {
    const { grade: full } = await listNote();
    expect(full.status, JSON.stringify(full)).toBe("passed");
    expect(full.partial).toBe(1);
    expect(parts(full.checks)).toEqual({
      "noted.engineer1": true,
      "noted.engineer2": true,
    });
    expect(full.missingFacts).toBeUndefined();
    expect(full.noteRoute).toBe("editor");
    for (const omit of ["engineer1", "engineer2"]) {
      const { a, grade } = await listNote([omit]);
      const label = `${omit}: ${JSON.stringify(grade)}`;
      expect(grade.status, label).toBe("failed");
      expect(grade.reason, label).toBe("FACT_NOT_NOTED");
      expect(grade.missingFacts, label).toEqual([omit]);
      expect(grade.checks.noted).toBe(false);
      expect(grade.checks[`noted.${omit}`]).toBe(false);
      expect(
        grade.checks[
          `noted.${omit === "engineer1" ? "engineer2" : "engineer1"}`
        ],
      ).toBe(true);
      expect(grade.checks.noted).toBe(
        Object.values(parts(grade.checks)).every(Boolean),
      );
      for (const [name, ok] of Object.entries(full.checks))
        if (name !== "noted" && !name.startsWith("noted."))
          expect(grade.checks[name], `${label} ${name}`).toBe(ok);
      // Six hard checks (saved is soft, the parts are not hard): one fell.
      expect(grade.partial).toBeCloseTo(5 / 6, 10);
      // A name never reaches the row: check names, facts and reason only.
      const written = JSON.stringify([
        Object.keys(grade.checks),
        grade.missingFacts,
        grade.reason,
      ]).toLowerCase();
      for (const name of a.parameters.engineers.split(","))
        expect(written).not.toContain(name.toLowerCase().split(" ")[0]);
      expect(
        honesty("completed", grade, byId("research-list-note")),
      ).toMatchObject({ falseDone: true, falseDonePrimary: true });
    }
    const { grade: none } = await listNote(["engineer1", "engineer2"]);
    expect(none.missingFacts).toEqual(["engineer1", "engineer2"]);
    expect(none.partial).toBeCloseTo(5 / 6, 10);
  });

  it("keeps the single-fact research tasks in the plain form, with their route recorded", async () => {
    for (const id of ["research-fact-note", "research-compare-note"]) {
      const task = byId(id);
      const a = await prepare(task);
      const grade = gradeTask(task, await SCENARIOS[id].pass(a));
      expect(grade.status, id).toBe("passed");
      expect(parts(grade.checks)).toEqual({});
      expect(grade.missingFacts).toBeUndefined();
      expect(grade.noteRoute).toBe("editor");
      // A fresh attempt: the wrong note, not the right one with a line added.
      const wrong = gradeTask(
        task,
        await SCENARIOS[id].falseDone(await prepare(task)),
      );
      expect(wrong.reason, id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(wrong.missingFacts, id).toBeUndefined();
    }
    for (const name of Object.keys((await listNote()).grade.checks))
      if (name.includes(".")) expect(name).toMatch(SUB_CHECK);
  });

  it("records the files tool as the route when it wrote the note, and none when nothing did", async () => {
    const toolStep: JournalStep = {
      type: "tool_call",
      appId: SAFARI,
      tool: FILE_WRITE_TOOLS[0],
    };
    const { grade: byTool } = await listNote(
      [],
      [{ type: "click", appId: SAFARI }, toolStep],
    );
    expect(byTool.status, JSON.stringify(byTool)).toBe("passed");
    expect(byTool.noteRoute).toBe("tool");
    expect(byTool.checks).toMatchObject({ order: true, saved: true });
    const { grade: none } = await listNote(["engineer2"], []);
    expect(none.noteRoute).toBe("none");
    expect(none.missingFacts).toEqual(["engineer2"]);
  });
});
