import { createHash } from "node:crypto";
import {
  drawAbout,
  drawOrders,
  drawPlans,
  drawPrices,
  drawSheet,
  drawTeam,
  pages,
} from "./fixtures";
import {
  BROWSER_APPS,
  CALCULATOR,
  CALENDAR,
  FINDER,
  MUSIC,
  REMINDERS,
  SETTINGS,
  TEXTEDIT,
  TOKEN_RE,
  accessibilityText,
  agendaItems,
  checked,
  containsAll,
  containsNumber,
  countSteps,
  daysFrom,
  fileEntry,
  fileText,
  chosenBrowsers,
  filesMatching,
  frontmost,
  honestHandoff,
  hostMatches,
  inApp,
  inBrowser,
  inOrder,
  inputCount,
  localHour,
  menuLeafOf,
  mutations,
  normalizeText,
  onlyEntries,
  sameLocalDay,
  typedAtLeast,
  typedMarker,
  unverifiable,
  windowTitleHas,
} from "./graders";
import type {
  AgendaEvidence,
  BenchCategory,
  BenchTask,
  Evidence,
  Grade,
  PrepareContext,
} from "./types";

/**
 * The long-horizon suite: 10 to 40 step tasks across the Finder, TextEdit,
 * Calendar, Reminders, Calculator, Music, System Settings and a browser on
 * pages the benchmark serves itself. Every task works inside a namespace
 * the attempt owns: a folder under ~/OpenAssistBench named by its token,
 * agenda items titled with the token in a local calendar and list the
 * benchmark created, and web pages served on the loopback interface for that
 * token only. Nothing is sent, bought, installed or deleted by the model; the
 * harness removes what an attempt made, whatever happened.
 *
 * Every grader reads the end state back (files walked and hashed, agenda
 * items through the helper, the fixture server's log, or the frontmost
 * window's accessibility text), never the model's own report. Checks named
 * `primary` define completion: a run that said done with one of them false
 * is a false done.
 */

/**
 * The one approval a document task may answer yes to: the policy asks it
 * when the model clicks a Save label.
 */
export const SAVE_APPROVALS = ["Save these changes?"];
/**
 * Save, and Replace for the Find bar's Replace and All buttons: only for
 * text-find-replace, which cannot be done without them. The policy asks the
 * same question for the Save panel's "already exists. Do you want to replace
 * it?", which overwrites a file anywhere, and a reason string cannot tell the
 * two apart; every other task declines it, so a save that lands on one of
 * the user's documents stops there.
 */
export const REPLACE_APPROVALS = [
  "Save these changes?",
  "Replace the existing item?",
];
/** The one prompt a loopback form submit can raise. */
export const SUBMIT_APPROVALS = ["Submit or authorize this change?"];

/**
 * Action, time and cost budgets from a task's competent step range: about
 * twice the human steps in actions (the OSWorld and AndroidWorld ratio), ten
 * seconds an action, and a cost tier by length.
 */
export function budgets(steps: [number, number]) {
  const maxActions = Math.min(80, steps[1] * 2);
  return {
    steps,
    maxActions,
    maxSeconds: Math.min(900, 60 + maxActions * 10),
    maxCost: steps[1] <= 20 ? 0.25 : steps[1] <= 30 ? 0.4 : 0.6,
  };
}

/**
 * Within an hour of local midnight "tomorrow" can change between prepare and
 * the grade, so agenda attempts are not started then.
 */
export function dayBoundary(now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes < 60 || minutes >= 23 * 60;
}

/** The instruction names the site without a scheme: "127.0.0.1:47831/<token>". */
export const siteOf = (base: string) => base.replace(/^https?:\/\//, "");

/** The first line of every research notes file; digit-free apart from the token. */
export const NOTES_HEADER = (token: string) => `Research notes for ${token}\n`;

/**
 * A fixture file the model opens by name, named with the attempt's marker
 * ("benchnote0a1b-notes.txt"). A search, Open Recent or the Open panel then
 * matches only the benchmark's file, never a document of the user's with the
 * same plain name, which the model could otherwise open, read out to the
 * provider or edit and save without any approval.
 */
export const marked = (token: string, name: string) => `${token}-${name}`;

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * The token is base-36, so it can contain the digits of a number the grader
 * is looking for. Number checks run on the text with the token removed.
 */
export function withoutMarker(text: string, marker: string): string {
  const needle = marker.toLowerCase();
  return needle ? text.split(needle).join(" ") : text;
}

export const marker = (evidence: Evidence): string | undefined => {
  const token = evidence.parameters.token ?? "";
  return TOKEN_RE.test(token) ? token : undefined;
};

/** Steps in the attempt's browser, then steps in TextEdit: the page was read before the note was written. */
export const browserThenTextEdit = (evidence: Evidence) =>
  inOrder(evidence.journal, inBrowser(evidence), inApp([TEXTEDIT]));

/**
 * Whether a browser is in front, and the address it shows. Another
 * application in front does not stop grading: the fixture server's log still
 * says what the run did, so the checks that read the window are false and
 * the ones that read the log still count. A done that submitted nothing is
 * then a primary false done with partial credit, not a grade with no checks.
 * A browser in front with nothing readable means the grader cannot tell.
 */
type BrowserView = { shown: false } | { shown: true; address: string };
function browserView(evidence: Evidence): BrowserView | Grade {
  const app = frontmost(evidence);
  if (!app) return unverifiable("NO_FRONTMOST_INFO");
  // The person's other browser in front is no browser of this attempt's.
  if (!chosenBrowsers(evidence).includes(app)) return { shown: false };
  const address = evidence.domain ?? evidence.context?.browserAddress;
  if (!accessibilityText(evidence.context))
    return unverifiable("NO_ACCESSIBILITY");
  if (!address) return unverifiable("NO_BROWSER_ADDRESS");
  return { shown: true, address };
}
export const isGrade = (value: unknown): value is Grade =>
  !!value && typeof value === "object" && "status" in value;

/** The agenda reader ran and the store the task needs was readable. */
export function agendaState(
  evidence: Evidence,
  kind: "event" | "reminder",
): AgendaEvidence | Grade {
  const agenda = evidence.agenda;
  if (!agenda) return unverifiable("NO_AGENDA_EVIDENCE");
  if (kind === "event" && agenda.access.calendar !== "granted")
    return unverifiable("NO_CALENDAR_ACCESS");
  if (kind === "reminder" && agenda.access.reminders !== "granted")
    return unverifiable("NO_REMINDERS_ACCESS");
  return agenda;
}
export const dayOf = (evidence: Evidence, name: string): Date | undefined => {
  const day = new Date(evidence.parameters[name] ?? "");
  return Number.isNaN(day.getTime()) ? undefined : day;
};
/** The calendar and reminders list the agenda helper creates in the local source. */
export const BENCH_CONTAINER = "OpenAssistBench";
export const inBenchContainer = (item?: { calendar?: string }) =>
  item?.calendar === BENCH_CONTAINER;

/* ---------------------------------------------------------- research */

interface ResearchSpec {
  id: string;
  difficulty: BenchTask["difficulty"];
  steps: [number, number];
  instruction: string;
  verifies: string;
  /** The page key the task registers and the grader expects visited. */
  page: string;
  register: (
    token: string,
    random: () => number,
  ) => { html: string; parameters: Record<string, string> };
  /** The check that defines completion, on the notes file text with the token removed. */
  noted: (text: string, parameters: Record<string, string>) => boolean;
  /** Anything that must not be in the note. */
  wrong?: (text: string, parameters: Record<string, string>) => boolean;
}

/**
 * A page the benchmark serves, read in the browser, and a fact from it
 * written into a TextEdit file in the bench folder. Notes was dropped from
 * this suite (iCloud sync, an Automation prompt); a plain file in the
 * attempt's own folder is read back by the files reader and leaves nothing.
 */
function research(spec: ResearchSpec): BenchTask {
  return {
    id: spec.id,
    suite: "long",
    kind: "run",
    category: "research-note",
    difficulty: spec.difficulty,
    ...budgets(spec.steps),
    instruction: spec.instruction,
    apps: [...BROWSER_APPS, TEXTEDIT],
    evidence: ["files", "fixture"],
    primary: ["noted"],
    approve: SAVE_APPROVALS,
    safety:
      "Reads a page the benchmark serves on 127.0.0.1 for this attempt only, and edits a text file the benchmark wrote in the attempt's own folder under ~/OpenAssistBench. No real website, nothing sent; the harness removes the folder afterwards.",
    verifies: spec.verifies,
    prepare: async ({ token, benchPath, fixture, write }) => {
      if (!fixture) return null;
      const id = token();
      const drawn = spec.register(id, Math.random);
      const base = fixture.register({ [spec.page]: drawn.html });
      await write(marked(id, "notes.txt"), NOTES_HEADER(id));
      return { token: id, benchPath, site: siteOf(base), ...drawn.parameters };
    },
    grade: (evidence) => {
      const token = marker(evidence);
      if (!token) return unverifiable("NO_MARKER");
      const files = evidence.files;
      if (!files) return unverifiable("NO_FILE_EVIDENCE");
      const fixture = evidence.fixture;
      if (!fixture) return unverifiable("NO_FIXTURE_EVIDENCE");
      const notes = marked(token, "notes.txt");
      const text = fileText(files, notes);
      const body = withoutMarker(text, token);
      return checked(
        {
          noted: spec.noted(body, evidence.parameters),
          nothingWrong: !spec.wrong?.(body, evidence.parameters),
          headerKept: text.includes(NOTES_HEADER(token).trim().toLowerCase()),
          visited: fixture.visits.includes(`/${token}/${spec.page}`),
          single: onlyEntries(files, [notes]),
          order: browserThenTextEdit(evidence),
          saved: countSteps(evidence.journal, menuLeafOf("save")) > 0,
        },
        {
          noted: "FACT_NOT_NOTED",
          nothingWrong: "WRONG_FACT_NOTED",
          headerKept: "NOTE_HEADER_LOST",
          visited: "PAGE_NOT_VISITED",
          single: "EXTRA_ITEMS",
          order: "WRONG_ORDER",
        },
        ["saved"],
      );
    },
  };
}

export const researchFactNote = research({
  id: "research-fact-note",
  difficulty: "medium",
  steps: [12, 22],
  instruction:
    "In {browser}, go to{site}/about and find how many employees the company has. Then open the file {benchPath}/{token}-notes.txt in TextEdit, write that number on a new line, and save it.",
  verifies:
    "The notes file in the bench folder contains the employee count drawn for this attempt (the founding year or office count do not count), its header line is intact, nothing else is in the folder, the fixture server saw the About page, and the journal shows browser steps before TextEdit steps.",
  page: "about",
  register: (token, random) => {
    const facts = drawAbout(random);
    return {
      html: pages.about(token, facts),
      parameters: {
        employees: String(facts.employees),
        year: String(facts.year),
        offices: String(facts.offices),
      },
    };
  },
  noted: (text, { employees }) => containsNumber(text, employees),
});

export const researchCompareNote = research({
  id: "research-compare-note",
  difficulty: "medium",
  steps: [15, 25],
  instruction:
    "In {browser}, go to{site}/plans and work out which plan is the cheapest per month. Then open the file {benchPath}/{token}-notes.txt in TextEdit, write that plan's name on a new line, and save it.",
  verifies:
    "The notes file names the plan with the lowest monthly cost (one plan is billed yearly, so the comparison needs a division) and no other plan; header intact, folder otherwise empty, the Plans page visited, browser before TextEdit.",
  page: "plans",
  register: (token, random) => {
    const { plans, cheapest } = drawPlans(random);
    return {
      html: pages.plans(token, plans),
      parameters: {
        cheapest,
        others: plans
          .map((plan) => plan.name)
          .filter((name) => name !== cheapest)
          .join(","),
      },
    };
  },
  noted: (text, { cheapest }) => text.includes(cheapest.toLowerCase()),
  wrong: (text, { others }) =>
    others.split(",").some((name) => text.includes(name.toLowerCase())),
});

export const researchListNote = research({
  id: "research-list-note",
  difficulty: "hard",
  steps: [20, 35],
  instruction:
    "In {browser}, go to{site}/team. Then open the file {benchPath}/{token}-notes.txt in TextEdit, add the full names of everyone whose role is Engineer, one per line, and save it.",
  verifies:
    "The notes file contains both engineers' names and neither of the other two people; header intact, folder otherwise empty, the Team page visited, browser before TextEdit.",
  page: "team",
  register: (token, random) => {
    const { people, engineers } = drawTeam(random);
    return {
      html: pages.team(token, people),
      parameters: {
        engineers: engineers.join(","),
        others: people
          .filter((person) => person.role !== "Engineer")
          .map((person) => person.name)
          .join(","),
      },
    };
  },
  noted: (text, { engineers }) => containsAll(text, engineers.split(",")),
  wrong: (text, { others }) =>
    others.split(",").some((name) => text.includes(name.toLowerCase())),
});

/* ------------------------------------------------------------ agenda */

export const AGENDA_SAFETY =
  "Creates or edits items titled with the attempt's marker in the OpenAssistBench calendar or list, which the agenda helper made in the local (non-syncing) source. The harness removes every item titled with the marker afterwards; the helper refuses to remove anything else.";

export const agendaPrepare =
  (
    build: (
      context: PrepareContext,
      token: string,
      now: Date,
    ) => Promise<Record<string, string> | null>,
  ) =>
  async (context: PrepareContext) => {
    // The harness provides `agenda` only when the helper's setup reported
    // every store this task writes as granted with its local OpenAssistBench
    // container in place (readers.ts agendaFor). Without it the model would be
    // told to use a container that is not there and would write to the
    // user's default calendar or list, which may be shared; nothing could
    // read the item back or remove it either. So it is never asked to.
    if (!context.agenda) return null;
    const now = context.now();
    if (dayBoundary(now)) return null;
    return build(context, context.token(), now);
  };

export const agendaCalCreateTomorrow: BenchTask = {
  id: "agenda-cal-create-tomorrow",
  suite: "long",
  kind: "run",
  category: "agenda",
  difficulty: "medium",
  ...budgets([10, 20]),
  instruction:
    "In Calendar, create a new event tomorrow from 3 to 4 PM called {token}, in the OpenAssistBench calendar.",
  apps: [CALENDAR],
  evidence: ["agenda"],
  primary: ["exists", "day", "start"],
  approve: [],
  safety: AGENDA_SAFETY,
  verifies:
    "coarena-agenda find reports exactly one event titled with the marker, in the OpenAssistBench calendar, on tomorrow's local date, 15:00 to 16:00, not all-day.",
  prepare: agendaPrepare(async (_, token, now) => ({
    token,
    day: daysFrom(now, 1).toISOString(),
  })),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "event");
    if (isGrade(agenda)) return agenda;
    const day = dayOf(evidence, "day");
    if (!day) return unverifiable("NO_DAY");
    const events = agendaItems(agenda, "event", token);
    const event = events[0];
    return checked(
      {
        exists: events.length >= 1,
        single: events.length === 1,
        day: !!event && sameLocalDay(event.start, day),
        start: !!event && localHour(event.start) === 15,
        end: !!event && localHour(event.end) === 16,
        timed: !!event && !event.allDay,
        calendar: inBenchContainer(event),
        typedMarker: typedMarker(evidence.journal, token, [CALENDAR]),
      },
      {
        exists: "EVENT_NOT_CREATED",
        single: "DUPLICATE_EVENTS",
        day: "WRONG_DAY",
        start: "WRONG_START",
        end: "WRONG_END",
        timed: "ALL_DAY_EVENT",
        calendar: "WRONG_CALENDAR",
      },
      ["typedMarker"],
    );
  },
};

export const agendaCalMove: BenchTask = {
  id: "agenda-cal-move",
  suite: "long",
  kind: "run",
  category: "agenda",
  difficulty: "hard",
  ...budgets([10, 25]),
  instruction:
    "In Calendar, move tomorrow's {token} sync event to 2 PM, keeping it one hour long.",
  apps: [CALENDAR],
  evidence: ["agenda"],
  primary: ["single", "start"],
  approve: [],
  safety: AGENDA_SAFETY,
  verifies:
    "The one event titled with the marker now starts at 14:00 and ends at 15:00 on tomorrow's date, still timed, still in the OpenAssistBench calendar, its title still saying sync.",
  prepare: agendaPrepare(async ({ agenda }, token, now) => {
    if (!agenda) return null; // agendaPrepare already refused; narrows the type.
    const start = daysFrom(now, 1);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start);
    end.setHours(11, 0, 0, 0);
    await agenda.add({
      kind: "event",
      title: `${token} sync`,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: false,
    });
    return { token, day: daysFrom(now, 1).toISOString() };
  }),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "event");
    if (isGrade(agenda)) return agenda;
    const day = dayOf(evidence, "day");
    if (!day) return unverifiable("NO_DAY");
    const events = agendaItems(agenda, "event", token);
    const event = events[0];
    return checked(
      {
        single: events.length === 1,
        start: !!event && localHour(event.start) === 14,
        end: !!event && localHour(event.end) === 15,
        day: !!event && sameLocalDay(event.start, day),
        timed: !!event && !event.allDay,
        calendar: inBenchContainer(event),
        titleKept: !!event && event.title.toLowerCase().includes("sync"),
      },
      {
        single: "NOT_EXACTLY_ONE_EVENT",
        start: "WRONG_START",
        end: "WRONG_END",
        day: "WRONG_DAY",
        timed: "ALL_DAY_EVENT",
        calendar: "WRONG_CALENDAR",
        titleKept: "TITLE_CHANGED",
      },
    );
  },
};

export const agendaRemCreate: BenchTask = {
  id: "agenda-rem-create",
  suite: "long",
  kind: "run",
  category: "agenda",
  difficulty: "medium",
  ...budgets([10, 16]),
  instruction:
    "In Reminders, add a reminder called {token} due tomorrow, in the OpenAssistBench list.",
  apps: [REMINDERS],
  evidence: ["agenda"],
  primary: ["exists", "due"],
  approve: [],
  safety: AGENDA_SAFETY,
  verifies:
    "Exactly one open reminder titled with the marker exists in the OpenAssistBench list, due on tomorrow's local date.",
  prepare: agendaPrepare(async (_, token, now) => ({
    token,
    day: daysFrom(now, 1).toISOString(),
  })),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "reminder");
    if (isGrade(agenda)) return agenda;
    const day = dayOf(evidence, "day");
    if (!day) return unverifiable("NO_DAY");
    const reminders = agendaItems(agenda, "reminder", token);
    const reminder = reminders[0];
    return checked(
      {
        exists: reminders.length >= 1,
        due: !!reminder && sameLocalDay(reminder.due, day),
        open: !!reminder && !reminder.completed,
        single: reminders.length === 1,
        list: inBenchContainer(reminder),
        typedMarker: typedMarker(evidence.journal, token, [REMINDERS]),
      },
      {
        exists: "REMINDER_NOT_CREATED",
        due: "WRONG_DUE_DATE",
        open: "REMINDER_COMPLETED",
        single: "DUPLICATE_REMINDERS",
        list: "WRONG_LIST",
      },
      ["typedMarker"],
    );
  },
};

export const agendaRemComplete: BenchTask = {
  id: "agenda-rem-complete",
  suite: "long",
  kind: "run",
  category: "agenda",
  difficulty: "medium",
  ...budgets([10, 14]),
  instruction:
    "In Reminders, mark the reminder {token} water the plants as completed.",
  apps: [REMINDERS],
  evidence: ["agenda"],
  primary: ["completed"],
  approve: [],
  safety: AGENDA_SAFETY,
  verifies:
    "The one reminder titled with the marker is completed and still says water the plants; no second reminder with the marker exists.",
  prepare: agendaPrepare(async ({ agenda }, token, now) => {
    if (!agenda) return null; // agendaPrepare already refused; narrows the type.
    const due = new Date(now);
    due.setHours(9, 0, 0, 0);
    await agenda.add({
      kind: "reminder",
      title: `${token} water the plants`,
      due: due.toISOString(),
    });
    return { token };
  }),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "reminder");
    if (isGrade(agenda)) return agenda;
    const reminders = agendaItems(agenda, "reminder", token);
    const reminder = reminders[0];
    return checked(
      {
        completed: !!reminder && reminder.completed === true,
        single: reminders.length === 1,
        titleKept: !!reminder && reminder.title.toLowerCase().includes("water"),
      },
      {
        completed: "REMINDER_NOT_COMPLETED",
        single: "NOT_EXACTLY_ONE_REMINDER",
        titleKept: "TITLE_CHANGED",
      },
    );
  },
};

export const agendaRemTwo: BenchTask = {
  id: "agenda-rem-two",
  suite: "long",
  kind: "run",
  category: "agenda",
  difficulty: "hard",
  ...budgets([16, 30]),
  instruction:
    "In Reminders, in the OpenAssistBench list, add two reminders: {token} book the dentist, due tomorrow, and {token} renew the parking permit, due in three days.",
  apps: [REMINDERS],
  evidence: ["agenda"],
  primary: ["dentist", "permit"],
  approve: [],
  safety: AGENDA_SAFETY,
  verifies:
    "Exactly two reminders titled with the marker exist in the OpenAssistBench list: one saying dentist due tomorrow, one saying permit due in three days.",
  prepare: agendaPrepare(async (_, token, now) => ({
    token,
    day1: daysFrom(now, 1).toISOString(),
    day3: daysFrom(now, 3).toISOString(),
  })),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "reminder");
    if (isGrade(agenda)) return agenda;
    const day1 = dayOf(evidence, "day1");
    const day3 = dayOf(evidence, "day3");
    if (!day1 || !day3) return unverifiable("NO_DAY");
    const reminders = agendaItems(agenda, "reminder", token);
    const dentist = reminders.find((r) =>
      r.title.toLowerCase().includes("dentist"),
    );
    const permit = reminders.find((r) =>
      r.title.toLowerCase().includes("permit"),
    );
    return checked(
      {
        dentist: !!dentist && sameLocalDay(dentist.due, day1),
        permit: !!permit && sameLocalDay(permit.due, day3),
        exactlyTwo: reminders.length === 2,
        list: inBenchContainer(dentist) && inBenchContainer(permit),
      },
      {
        dentist: "DENTIST_REMINDER_WRONG",
        permit: "PERMIT_REMINDER_WRONG",
        exactlyTwo: "NOT_EXACTLY_TWO_REMINDERS",
        list: "WRONG_LIST",
      },
    );
  },
};

/* ------------------------------------------------------------- files */

export const FILES_SAFETY =
  "Works only inside a folder the benchmark created under ~/OpenAssistBench, on files the benchmark wrote, and that folder is already open in the Finder when the run starts. The instruction never asks to delete anything (the Finder's Move to Trash would be declined anyway); the harness removes the folder afterwards, whatever happened. A rename outside that folder cannot be detected, which is why the folder is opened for the model and named in the instruction.";

/**
 * The bench folder in front before the run (critique S6): a model that starts
 * in the right window has no reason to browse the user's own folders, where a
 * rename could not be detected or undone.
 */
export const openBenchFolder = (context: PrepareContext) =>
  context.openWithLaunchServices(context.benchDir);

export const DRAFTS = ["a", "b", "c"] as const;

export const filesRenamePattern: BenchTask = {
  id: "files-rename-pattern",
  suite: "long",
  kind: "run",
  category: "files",
  difficulty: "medium",
  ...budgets([10, 18]),
  instruction:
    "In the folder {benchPath}, which is open in the Finder, rename the three draft files so each one starts with {token} instead of draft, keeping the rest of the name.",
  apps: [FINDER],
  evidence: ["files"],
  primary: ["renamed"],
  approve: [],
  safety: FILES_SAFETY,
  verifies:
    "The bench folder holds exactly {token}-a.txt, {token}-b.txt and {token}-c.txt with the original contents and no draft-* file.",
  prepare: async (context) => {
    const id = context.token();
    for (const suffix of DRAFTS)
      await context.write(`draft-${suffix}.txt`, `Draft ${suffix} for ${id}\n`);
    await openBenchFolder(context);
    return { token: id, benchPath: context.benchPath };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const expected = DRAFTS.map((suffix) => `${token}-${suffix}.txt`);
    return checked(
      {
        renamed: expected.every((path) => !!fileEntry(files, path)),
        noDraftsLeft: filesMatching(files, /^draft-[abc]\.txt$/).length === 0,
        contentsKept: DRAFTS.every((suffix) =>
          fileText(files, `${token}-${suffix}.txt`).includes(
            `draft ${suffix} for ${token}`,
          ),
        ),
        nothingElse: onlyEntries(files, expected),
        typedMarker: typedMarker(evidence.journal, token, [FINDER]),
      },
      {
        renamed: "NOT_RENAMED",
        noDraftsLeft: "DRAFTS_LEFT",
        contentsKept: "CONTENT_CHANGED",
        nothingElse: "EXTRA_ITEMS",
      },
      ["typedMarker"],
    );
  },
};

export const REPORT_TEXT = "Quarterly report: all figures provisional.\n";
export const NOTES_TEXT = "Notes: nothing to add.\n";

export const filesNewFolderMove: BenchTask = {
  id: "files-new-folder-move",
  suite: "long",
  kind: "run",
  category: "files",
  difficulty: "medium",
  ...budgets([10, 18]),
  instruction:
    "In the folder {benchPath}, which is open in the Finder, create a folder called {token}-reports and move report.txt into it.",
  apps: [FINDER],
  evidence: ["files"],
  primary: ["folder", "moved"],
  approve: [],
  safety: FILES_SAFETY,
  verifies:
    "{token}-reports exists, report.txt is inside it with its original hash and no longer at the root, and notes.txt is the only other item.",
  prepare: async (context) => {
    const id = context.token();
    await context.write("report.txt", REPORT_TEXT);
    await context.write("notes.txt", NOTES_TEXT);
    await openBenchFolder(context);
    return {
      token: id,
      benchPath: context.benchPath,
      reportSha: sha256(REPORT_TEXT),
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    // Not "-archive": the policy reads that word on a Finder item as "Archive
    // this item?", and a declined prompt would fail the task for the name.
    const archive = `${token}-reports`;
    const moved = fileEntry(files, `${archive}/report.txt`);
    return checked(
      {
        folder: fileEntry(files, archive)?.kind === "folder",
        moved: !!moved && moved.sha256 === evidence.parameters.reportSha,
        rootClean: !fileEntry(files, "report.txt"),
        nothingElse: onlyEntries(files, [
          archive,
          `${archive}/report.txt`,
          "notes.txt",
        ]),
      },
      {
        folder: "FOLDER_NOT_CREATED",
        moved: "FILE_NOT_MOVED",
        rootClean: "ORIGINAL_LEFT",
        nothingElse: "EXTRA_ITEMS",
      },
    );
  },
};

export const SORT_TEXT = ["alpha", "beta", "gamma"] as const;
export const SORT_DATA = ["north", "south", "west"] as const;

export const filesSortByType: BenchTask = {
  id: "files-sort-by-type",
  suite: "long",
  kind: "run",
  category: "files",
  difficulty: "hard",
  ...budgets([25, 40]),
  instruction:
    "In the folder {benchPath}, which is open in the Finder, make two folders named text and data, then move the three .txt files into text and the three .csv files into data.",
  apps: [FINDER],
  evidence: ["files"],
  primary: ["textSorted", "dataSorted"],
  approve: [],
  safety: FILES_SAFETY,
  verifies:
    "text/ holds the three .txt files and data/ the three .csv files, each with its original hash, the root holds only the two folders.",
  prepare: async (context) => {
    const id = context.token();
    const hashes: Record<string, string> = {};
    for (const name of SORT_TEXT) {
      const body = `${name} text for ${id}\n`;
      await context.write(`${name}.txt`, body);
      hashes[`${name}.txt`] = sha256(body);
    }
    for (const name of SORT_DATA) {
      const body = `region,value\n${name},${name.length}\n`;
      await context.write(`${name}.csv`, body);
      hashes[`${name}.csv`] = sha256(body);
    }
    await openBenchFolder(context);
    return {
      token: id,
      benchPath: context.benchPath,
      hashes: JSON.stringify(hashes),
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    let hashes: Record<string, string> = {};
    try {
      hashes = JSON.parse(evidence.parameters.hashes ?? "{}");
    } catch {
      return unverifiable("NO_HASHES");
    }
    const kept = (folder: string, name: string) =>
      fileEntry(files, `${folder}/${name}`)?.sha256 === hashes[name];
    const txt = SORT_TEXT.map((name) => `${name}.txt`);
    const csv = SORT_DATA.map((name) => `${name}.csv`);
    return checked(
      {
        textSorted: txt.every((name) => kept("text", name)),
        dataSorted: csv.every((name) => kept("data", name)),
        rootClean: [...txt, ...csv].every((name) => !fileEntry(files, name)),
        nothingElse: onlyEntries(files, [
          "text",
          "data",
          ...txt.map((name) => `text/${name}`),
          ...csv.map((name) => `data/${name}`),
        ]),
      },
      {
        textSorted: "TEXT_FILES_NOT_SORTED",
        dataSorted: "DATA_FILES_NOT_SORTED",
        rootClean: "ORIGINALS_LEFT",
        nothingElse: "EXTRA_ITEMS",
      },
    );
  },
};

export const COMPRESS_FILES = [
  "invoice.txt",
  "ledger.csv",
  "summary.md",
] as const;

export const filesCompress: BenchTask = {
  id: "files-compress",
  suite: "long",
  kind: "run",
  category: "files",
  difficulty: "medium",
  ...budgets([10, 16]),
  instruction:
    "In the folder {benchPath}, which is open in the Finder, select the three files and compress them into one zip file.",
  apps: [FINDER],
  evidence: ["files"],
  primary: ["zip"],
  approve: [],
  safety: FILES_SAFETY,
  verifies:
    "Exactly one .zip is at the root of the bench folder, its entry list (read with unzip -Z1, resource forks excluded) names the three files, and the three originals are still there unchanged.",
  prepare: async (context) => {
    const id = context.token();
    const hashes: Record<string, string> = {};
    for (const name of COMPRESS_FILES) {
      const body = `${name} for ${id}\n`;
      await context.write(name, body);
      hashes[name] = sha256(body);
    }
    await openBenchFolder(context);
    return {
      token: id,
      benchPath: context.benchPath,
      hashes: JSON.stringify(hashes),
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    let hashes: Record<string, string> = {};
    try {
      hashes = JSON.parse(evidence.parameters.hashes ?? "{}");
    } catch {
      return unverifiable("NO_HASHES");
    }
    const zips = filesMatching(files, /^[^/]+\.zip$/i);
    const listing =
      zips.length === 1 ? (zips[0].text ?? "").split("\n").filter(Boolean) : [];
    return checked(
      {
        zip: zips.length === 1,
        zipHasThree:
          listing.length === 3 &&
          COMPRESS_FILES.every((name) => listing.includes(name)),
        originalsKept: COMPRESS_FILES.every(
          (name) => fileEntry(files, name)?.sha256 === hashes[name],
        ),
        nothingElse:
          zips.length === 1 &&
          onlyEntries(files, [...COMPRESS_FILES, zips[0].path]),
      },
      {
        zip: "NOT_EXACTLY_ONE_ZIP",
        zipHasThree: "ZIP_CONTENTS_WRONG",
        originalsKept: "ORIGINALS_CHANGED",
        nothingElse: "EXTRA_ITEMS",
      },
    );
  },
};

/* ------------------------------------------------------ text-editing */

export const TEXT_SAFETY =
  "TextEdit on a file the benchmark wrote in the attempt's own folder under ~/OpenAssistBench, named with the attempt's marker so no search or recent-documents list can match a file of the user's. Save these changes? is the only prompt the harness may approve (text-find-replace also Replace the existing item?, for the Find bar); the harness removes the folder afterwards.";

export const DRAFT_LINES = [
  "Meeting notes, first draft.",
  "Agenda: roadmap, hiring, budget.",
  "Next step: circulate for comments.",
];
export const DRAFT_TEXT = DRAFT_LINES.join("\n") + "\n";

/** The last line of the file carries the marker and the word; the original lines come first, unchanged. */
function appendedGrade(
  text: string,
  token: string,
  word: string,
  original: string,
): { appended: boolean; originalKept: boolean } {
  const lines = normalizeText(text).split("\n");
  const last = lines[lines.length - 1] ?? "";
  return {
    appended: last.includes(token) && last.includes(word),
    originalKept: normalizeText(text).startsWith(
      normalizeText(original).toLowerCase(),
    ),
  };
}

export const textAppendLine: BenchTask = {
  id: "text-append-line",
  suite: "long",
  kind: "run",
  category: "text-editing",
  difficulty: "medium",
  ...budgets([10, 15]),
  instruction:
    "Open the file {benchPath}/{token}-draft.txt in TextEdit, add a new last line that says {token} approved, and save it.",
  apps: [TEXTEDIT],
  evidence: ["files"],
  primary: ["appended"],
  approve: SAVE_APPROVALS,
  safety: TEXT_SAFETY,
  verifies:
    "The draft on disk ends with a line carrying the marker and approved, still starts with its original three lines, and is the only item in the folder.",
  prepare: async ({ token, benchPath, write }) => {
    const id = token();
    await write(marked(id, "draft.txt"), DRAFT_TEXT);
    return { token: id, benchPath };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const draft = marked(token, "draft.txt");
    return checked(
      {
        ...appendedGrade(fileText(files, draft), token, "approved", DRAFT_TEXT),
        single: onlyEntries(files, [draft]),
        typedMarker: typedMarker(evidence.journal, token, [TEXTEDIT]),
        saved: countSteps(evidence.journal, menuLeafOf("save")) > 0,
      },
      {
        appended: "LINE_NOT_APPENDED",
        originalKept: "ORIGINAL_CHANGED",
        single: "EXTRA_ITEMS",
      },
      ["typedMarker", "saved"],
    );
  },
};

export const textNewDocSave: BenchTask = {
  id: "text-new-doc-save",
  suite: "long",
  kind: "run",
  category: "text-editing",
  difficulty: "hard",
  ...budgets([15, 30]),
  instruction:
    "In TextEdit, create a new document containing the single line {token} shopping list, and save it as {token} in the folder {benchPath}.",
  apps: [TEXTEDIT],
  evidence: ["files"],
  primary: ["saved", "content"],
  approve: SAVE_APPROVALS,
  safety:
    TEXT_SAFETY +
    " A document saved somewhere else under the marker's name is found by the harness's stray sweep: a plain file under the home folder or in TextEdit's iCloud folder is removed, anything else (an .rtfd bundle, another iCloud folder) is reported as a leftover.",
  verifies:
    "One document named with the marker (.rtf, .txt or an .rtfd bundle) is in the bench folder, its text carries the marker and shopping list, and nothing else was saved there.",
  prepare: async ({ token, benchPath }) => ({ token: token(), benchPath }),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const saved = filesMatching(
      files,
      new RegExp(`^${token}(\\.rtf|\\.txt|\\.rtfd/TXT\\.rtf)$`),
    );
    const document = saved[0];
    const allowed = document
      ? new Set([document.path, `${token}.rtfd`])
      : new Set<string>();
    return checked(
      {
        saved: saved.length === 1,
        content:
          !!document &&
          (document.text ?? "").includes(token) &&
          (document.text ?? "").includes("shopping list"),
        inBenchFolder:
          files.entries.length > 0 &&
          files.entries.every((entry) => allowed.has(entry.path)),
        typedMarker: typedMarker(evidence.journal, token, [TEXTEDIT]),
      },
      {
        saved: "DOCUMENT_NOT_SAVED",
        content: "CONTENT_WRONG",
        inBenchFolder: "EXTRA_ITEMS",
      },
      ["typedMarker"],
    );
  },
};

export const MEMO_TEXT =
  "Memo from ACME.\nACME will host the review.\nSend questions to the ACME desk.\nSigned, ACME operations.\n";

export const textFindReplace: BenchTask = {
  id: "text-find-replace",
  suite: "long",
  kind: "run",
  category: "text-editing",
  difficulty: "medium",
  ...budgets([12, 25]),
  instruction:
    "Open {benchPath}/{token}-memo.txt in TextEdit and replace every occurrence of ACME with {token}, then save.",
  apps: [TEXTEDIT],
  evidence: ["files"],
  primary: ["replaced"],
  approve: REPLACE_APPROVALS,
  safety: TEXT_SAFETY,
  verifies:
    "The memo on disk equals the original with every ACME replaced by the marker and nothing else changed; no ACME remains; it is the only item in the folder.",
  prepare: async ({ token, benchPath, write }) => {
    const id = token();
    await write(marked(id, "memo.txt"), MEMO_TEXT);
    return { token: id, benchPath };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const memo = marked(token, "memo.txt");
    const text = normalizeText(fileText(files, memo));
    const expected = normalizeText(
      MEMO_TEXT.split("ACME").join(token),
    ).toLowerCase();
    return checked(
      {
        replaced: text === expected,
        noAcme: !text.includes("acme"),
        single: onlyEntries(files, [memo]),
      },
      {
        replaced: "TEXT_NOT_REPLACED",
        noAcme: "ACME_LEFT",
        single: "EXTRA_ITEMS",
      },
    );
  },
};

/* ----------------------------------------------------------- browser */

export const BROWSER_SAFETY =
  "Loopback only: the pages are served by the benchmark for this attempt's token, carry no external link or resource, and a Content-Security-Policy keeps the browser on them. No real site, no sign-in.";

export const browserNavChain: BenchTask = {
  id: "browser-nav-chain",
  suite: "long",
  kind: "run",
  category: "browser",
  difficulty: "medium",
  ...budgets([10, 16]),
  instruction:
    "In {browser}, go to{site}, open the Orders page, and open the order for {customer}.",
  apps: BROWSER_APPS,
  evidence: ["fixture"],
  primary: ["onOrder"],
  approve: [],
  safety: BROWSER_SAFETY,
  verifies:
    "A browser is frontmost on 127.0.0.1 with the window title naming the customer's order id, and the fixture server saw that order page opened.",
  prepare: async ({ token, fixture }) => {
    if (!fixture) return null;
    const id = token();
    const rows = drawOrders(Math.random);
    const target = rows[Math.floor(Math.random() * rows.length)];
    const base = fixture.register({
      home: pages.home(id),
      orders: pages.orders(id, rows),
      ...Object.fromEntries(
        rows.map((row) => [`orders/${row.id}`, pages.order(id, row)]),
      ),
    });
    return {
      token: id,
      site: siteOf(base),
      customer: target.customer,
      orderId: target.id,
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const orderId = evidence.parameters.orderId ?? "";
    if (!orderId) return unverifiable("NO_ORDER");
    const fixture = evidence.fixture;
    if (!fixture) return unverifiable("NO_FIXTURE_EVIDENCE");
    const view = browserView(evidence);
    if (isGrade(view)) return view;
    return checked(
      {
        frontmost: view.shown,
        host: view.shown && hostMatches(view.address, "127.0.0.1"),
        onOrder: view.shown && windowTitleHas(evidence.context, orderId),
        visitedOrder: fixture.visits.includes(`/${token}/orders/${orderId}`),
      },
      {
        frontmost: "NOT_FRONTMOST",
        host: "HOST_MISMATCH",
        onOrder: "ORDER_NOT_OPEN",
        visitedOrder: "ORDER_NOT_VISITED",
      },
    );
  },
};

export const browserFormSubmitLocal: BenchTask = {
  id: "browser-form-submit-local",
  suite: "long",
  kind: "run",
  category: "browser",
  difficulty: "medium",
  ...budgets([12, 22]),
  instruction:
    "In {browser}, go to {site}/contact, put {token} in the name field and hello from the benchmark in the message field, then submit the form.",
  apps: BROWSER_APPS,
  evidence: ["fixture"],
  primary: ["submitted"],
  approve: SUBMIT_APPROVALS,
  safety:
    BROWSER_SAFETY +
    " The form posts to the benchmark's own server; Submit or authorize this change? is the one prompt the harness may approve.",
  verifies:
    "The fixture server recorded exactly one submission whose name is the marker and whose message says hello, and the browser is on the thanks page.",
  prepare: async ({ token, fixture }) => {
    if (!fixture) return null;
    const id = token();
    const base = fixture.register({
      home: pages.home(id),
      contact: pages.contact(id),
      thanks: pages.thanks(id),
    });
    return { token: id, site: siteOf(base) };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const fixture = evidence.fixture;
    if (!fixture) return unverifiable("NO_FIXTURE_EVIDENCE");
    const view = browserView(evidence);
    if (isGrade(view)) return view;
    const good = fixture.submissions.filter(
      (s) =>
        s.path === `/${token}/contact` &&
        (s.fields.name ?? "").trim() === token &&
        (s.fields.message ?? "").toLowerCase().includes("hello"),
    );
    return checked(
      {
        frontmost: view.shown,
        submitted: good.length === 1 && fixture.submissions.length === 1,
        thanksPage: view.shown && windowTitleHas(evidence.context, "thanks"),
        host: view.shown && hostMatches(view.address, "127.0.0.1"),
      },
      {
        frontmost: "NOT_FRONTMOST",
        submitted: "FORM_NOT_SUBMITTED",
        thanksPage: "NOT_ON_THANKS_PAGE",
        host: "HOST_MISMATCH",
      },
    );
  },
};

export const browserFindInTable: BenchTask = {
  id: "browser-find-in-table",
  suite: "long",
  kind: "run",
  category: "browser",
  difficulty: "medium",
  ...budgets([12, 20]),
  instruction:
    "In {browser}, go to {site}/prices, find the item with the highest unit price, and open its detail page.",
  apps: BROWSER_APPS,
  evidence: ["fixture"],
  primary: ["onItem"],
  approve: [],
  safety: BROWSER_SAFETY,
  verifies:
    "The browser's window title names the most expensive item, the fixture server saw its page opened, and no other item page was opened.",
  prepare: async ({ token, fixture }) => {
    if (!fixture) return null;
    const id = token();
    const rows = drawPrices(Math.random);
    const top = rows.reduce((best, row) => (row.unit > best.unit ? row : best));
    const base = fixture.register({
      home: pages.home(id),
      prices: pages.prices(id, rows),
      ...Object.fromEntries(
        rows.map((row) => [`items/${row.id}`, pages.item(id, row)]),
      ),
    });
    return {
      token: id,
      site: siteOf(base),
      itemName: top.name,
      itemId: top.id,
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const { itemName = "", itemId = "" } = evidence.parameters;
    if (!itemName || !itemId) return unverifiable("NO_ITEM");
    const fixture = evidence.fixture;
    if (!fixture) return unverifiable("NO_FIXTURE_EVIDENCE");
    const view = browserView(evidence);
    if (isGrade(view)) return view;
    const itemPages = fixture.visits.filter((path) =>
      path.startsWith(`/${token}/items/`),
    );
    return checked(
      {
        frontmost: view.shown,
        onItem: view.shown && windowTitleHas(evidence.context, itemName),
        visitedItem: itemPages.includes(`/${token}/items/${itemId}`),
        notWrongItem: itemPages.every(
          (path) => path === `/${token}/items/${itemId}`,
        ),
        host: view.shown && hostMatches(view.address, "127.0.0.1"),
      },
      {
        frontmost: "NOT_FRONTMOST",
        onItem: "ITEM_NOT_OPEN",
        visitedItem: "ITEM_NOT_VISITED",
        notWrongItem: "WRONG_ITEM_OPENED",
        host: "HOST_MISMATCH",
      },
    );
  },
};

/* ------------------------------------------------------------- media */

export const mediaSearchLibrary: BenchTask = {
  id: "media-search-library",
  suite: "long",
  kind: "run",
  category: "media",
  difficulty: "medium",
  ...budgets([10, 16]),
  instruction:
    "Open Music, search my library for jazz, then switch to the Albums view. Don't play anything.",
  apps: [MUSIC],
  evidence: ["music"],
  primary: ["query", "notPlaying"],
  approve: [],
  safety:
    "Read-only in Music: a library search and a view change. Playback is verified stopped through a scripted read of the player state; nothing is bought, added or made. Any subscription prompt is declined.",
  verifies:
    "Music is frontmost showing jazz and an Albums view, the search was typed in Music during this attempt, and the player state read through JXA is not playing. Without that reader the attempt is unknown.",
  grade: (evidence) => {
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const music = evidence.music;
    if (!music?.available) return unverifiable("NO_MUSIC_READER");
    const text = accessibilityText(evidence.context);
    if (!text) return unverifiable("NO_ACCESSIBILITY");
    return checked(
      {
        frontmost: app === MUSIC,
        query: text.includes("jazz"),
        // Music keeps its last search on screen: a repeat must type it again.
        searched: typedAtLeast(evidence.journal, 4, [MUSIC]),
        notPlaying: music.player !== "playing",
        albums: text.includes("albums"),
      },
      {
        frontmost: "NOT_FRONTMOST",
        query: "QUERY_NOT_SHOWN",
        searched: "SEARCH_NOT_TYPED",
        notPlaying: "PLAYBACK_STARTED",
        albums: "ALBUMS_VIEW_NOT_SHOWN",
      },
    );
  },
};

/* ---------------------------------------------------------- settings */

const SETTINGS_SAFETY =
  "System Settings, General and About panes only: neither has a control that changes anything with one click. The run starts on the General pane, opened through its settings URL; any turn off, disable or reset label is a policy prompt the harness declines.";

/**
 * The General pane, opened before the run: a list of links to other panes,
 * nothing that changes a setting. System Settings reopens on its last pane, so
 * without this a repeat would start on About, left there by the previous
 * attempt, and pass without doing anything.
 */
export const SETTINGS_GENERAL_URL =
  "x-apple.systempreferences:com.apple.systempreferences.GeneralSettings";

const settingsPrepare = async (context: PrepareContext) => {
  await context.openWithLaunchServices(SETTINGS_GENERAL_URL);
  return { token: context.token() };
};

/**
 * The About pane by its window title. Only when the title is the generic
 * application name does the text stand in, and then it must show what only
 * About shows: the General pane lists "About" and can mention macOS in its
 * Software Update row.
 */
export function onAbout(evidence: Evidence, text: string): boolean {
  const title = (evidence.context?.windowTitle ?? "").trim().toLowerCase();
  if (title.includes("about")) return true;
  if (title && title !== "system settings") return false;
  return containsAll(text, ["about", "macos", "serial number"]);
}

export const settingsAbout: BenchTask = {
  id: "settings-about",
  suite: "long",
  kind: "run",
  category: "settings",
  difficulty: "medium",
  ...budgets([10, 16]),
  instruction:
    "In System Settings, go from General to the About page. Don't change anything.",
  apps: [SETTINGS],
  evidence: [],
  primary: ["onAbout"],
  approve: [],
  safety: SETTINGS_SAFETY,
  verifies:
    "System Settings is frontmost on the About pane (its window title, or text only About shows), the run clicked or keyed in System Settings to get there, and at most one text entry happened.",
  prepare: settingsPrepare,
  grade: (evidence) => {
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const text = accessibilityText(evidence.context);
    if (!text) return unverifiable("NO_ACCESSIBILITY");
    return checked(
      {
        frontmost: app === SETTINGS,
        onAbout: onAbout(evidence, text),
        // The run got there itself, not on a pane an earlier attempt left.
        navigated: inputCount(evidence.journal, [SETTINGS]) >= 1,
        noTyping:
          countSteps(evidence.journal, (s) => s.type === "type_text") <= 1,
      },
      {
        frontmost: "NOT_FRONTMOST",
        onAbout: "ABOUT_NOT_OPEN",
        navigated: "NOT_NAVIGATED",
        noTyping: "TYPED_IN_SETTINGS",
      },
    );
  },
};

export const settingsSearchAbout: BenchTask = {
  id: "settings-search-about",
  suite: "long",
  kind: "run",
  category: "settings",
  difficulty: "medium",
  ...budgets([10, 14]),
  instruction:
    "In System Settings, use the search field to find About and open that page. Don't change anything.",
  apps: [SETTINGS],
  evidence: [],
  primary: ["onAbout"],
  approve: [],
  safety: SETTINGS_SAFETY,
  verifies:
    "System Settings is frontmost on the About pane and the journal shows a search typed in System Settings.",
  prepare: settingsPrepare,
  grade: (evidence) => {
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const text = accessibilityText(evidence.context);
    if (!text) return unverifiable("NO_ACCESSIBILITY");
    return checked(
      {
        frontmost: app === SETTINGS,
        onAbout: onAbout(evidence, text),
        searched: typedAtLeast(evidence.journal, 3, [SETTINGS]),
      },
      {
        frontmost: "NOT_FRONTMOST",
        onAbout: "ABOUT_NOT_OPEN",
        searched: "SEARCH_NOT_TYPED",
      },
    );
  },
};

/* --------------------------------------------------------- multi-app */

export const multiPageCalcNote: BenchTask = {
  id: "multi-page-calc-note",
  suite: "long",
  kind: "run",
  category: "multi-app",
  difficulty: "hard",
  ...budgets([18, 30]),
  instruction:
    "In {browser}, go to{site}/sheet. Multiply the unit price by the quantity in Calculator, then open the file {benchPath}/{token}-notes.txt in TextEdit, write the total on a new line, and save it.",
  apps: [...BROWSER_APPS, CALCULATOR, TEXTEDIT],
  evidence: ["files", "fixture"],
  primary: ["noteTotal"],
  approve: SAVE_APPROVALS,
  safety:
    "Reads a page the benchmark serves on 127.0.0.1, computes in Calculator, and edits a text file in the attempt's own folder. No real website, nothing sent; the harness removes the folder afterwards.",
  verifies:
    "The notes file contains the product of the two numbers drawn for this attempt, at least the operands were entered in Calculator, the fixture server saw the page, and the journal shows browser, then Calculator, then TextEdit steps.",
  prepare: async ({ token, benchPath, fixture, write }) => {
    if (!fixture) return null;
    const id = token();
    const numbers = drawSheet(Math.random);
    const base = fixture.register({ sheet: pages.sheet(id, numbers) });
    await write(marked(id, "notes.txt"), NOTES_HEADER(id));
    return {
      token: id,
      benchPath,
      site: siteOf(base),
      unit: String(numbers.unit),
      quantity: String(numbers.quantity),
      product: String(numbers.product),
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const { unit = "", quantity = "", product = "" } = evidence.parameters;
    if (!/^\d+$/.test(product) || !unit || !quantity)
      return unverifiable("NO_OPERANDS");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const fixture = evidence.fixture;
    if (!fixture) return unverifiable("NO_FIXTURE_EVIDENCE");
    const journal = evidence.journal;
    const notes = marked(token, "notes.txt");
    const text = withoutMarker(fileText(files, notes), token);
    return checked(
      {
        noteTotal: containsNumber(text, product),
        usedCalculator:
          inputCount(journal, [CALCULATOR]) >=
          unit.length + quantity.length + 1,
        visited: fixture.visits.includes(`/${token}/sheet`),
        order: inOrder(
          journal,
          inBrowser(evidence),
          inApp([CALCULATOR]),
          inApp([TEXTEDIT]),
        ),
        single: onlyEntries(files, [notes]),
      },
      {
        noteTotal: "TOTAL_NOT_IN_NOTE",
        usedCalculator: "CALCULATOR_NOT_USED",
        visited: "PAGE_NOT_VISITED",
        order: "WRONG_ORDER",
        single: "EXTRA_ITEMS",
      },
    );
  },
};

export const TODO_TEXT = (token: string) =>
  `Things for the week.\nTODO: ${token} book the dentist\nDone: nothing yet.\n`;

export const multiDraftToReminder: BenchTask = {
  id: "multi-draft-to-reminder",
  suite: "long",
  kind: "run",
  category: "multi-app",
  difficulty: "hard",
  ...budgets([15, 30]),
  instruction:
    "Open the file {benchPath}/{token}-todo.txt, then add a reminder in Reminders, in the OpenAssistBench list, with the text of its TODO line, due tomorrow.",
  apps: [TEXTEDIT, REMINDERS],
  evidence: ["agenda", "files"],
  primary: ["reminder", "due"],
  approve: [],
  safety:
    "Opens a text file the benchmark wrote and creates one reminder titled with the marker in the local OpenAssistBench list. The harness removes both afterwards.",
  verifies:
    "One reminder titled with the marker and dentist exists in the OpenAssistBench list, due tomorrow; the to-do file is unchanged; the journal shows the file opened before any Reminders step.",
  prepare: agendaPrepare(async ({ benchPath, write }, token, now) => {
    const body = TODO_TEXT(token);
    await write(marked(token, "todo.txt"), body);
    return {
      token,
      benchPath,
      day: daysFrom(now, 1).toISOString(),
      todoSha: sha256(body),
    };
  }),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "reminder");
    if (isGrade(agenda)) return agenda;
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const day = dayOf(evidence, "day");
    if (!day) return unverifiable("NO_DAY");
    const reminders = agendaItems(agenda, "reminder", token);
    const reminder = reminders[0];
    const journal = evidence.journal;
    return checked(
      {
        reminder:
          !!reminder && reminder.title.toLowerCase().includes("dentist"),
        due: !!reminder && sameLocalDay(reminder.due, day),
        single: reminders.length === 1,
        list: inBenchContainer(reminder),
        untouched:
          fileEntry(files, marked(token, "todo.txt"))?.sha256 ===
          evidence.parameters.todoSha,
        order: inOrder(
          journal,
          (step) => step.type === "open_file" || inApp([TEXTEDIT])(step, 0),
          inApp([REMINDERS]),
        ),
        typedMarker: typedMarker(journal, token, [REMINDERS]),
      },
      {
        reminder: "REMINDER_NOT_CREATED",
        due: "WRONG_DUE_DATE",
        single: "DUPLICATE_REMINDERS",
        list: "WRONG_LIST",
        untouched: "FILE_CHANGED",
        order: "WRONG_ORDER",
      },
      ["typedMarker"],
    );
  },
};

export const MEETING_TEXT = "Planning sync with Dana, tomorrow 3 to 4 PM.\n";

export const multiFolderNoteEvent: BenchTask = {
  id: "multi-folder-note-event",
  suite: "long",
  kind: "run",
  category: "multi-app",
  difficulty: "hard",
  ...budgets([20, 40]),
  instruction:
    "In the folder {benchPath}, which is open in the Finder, open {token}-meeting.txt and put that meeting in Calendar as an event called {token} planning sync at the time it says, in the OpenAssistBench calendar.",
  apps: [FINDER, TEXTEDIT, CALENDAR],
  evidence: ["agenda", "files"],
  primary: ["event", "day", "start"],
  approve: [],
  safety:
    "Reads a text file the benchmark wrote and creates one event titled with the marker in the local OpenAssistBench calendar. The harness removes both afterwards.",
  verifies:
    "One event titled with the marker exists in the OpenAssistBench calendar tomorrow from 15:00 to 16:00; the meeting file is unchanged; the journal shows Finder, then TextEdit, then Calendar steps.",
  prepare: agendaPrepare(async (context, token, now) => {
    const { benchPath, write } = context;
    await write(marked(token, "meeting.txt"), MEETING_TEXT);
    await openBenchFolder(context);
    return {
      token,
      benchPath,
      day: daysFrom(now, 1).toISOString(),
      meetingSha: sha256(MEETING_TEXT),
    };
  }),
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const agenda = agendaState(evidence, "event");
    if (isGrade(agenda)) return agenda;
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const day = dayOf(evidence, "day");
    if (!day) return unverifiable("NO_DAY");
    const events = agendaItems(agenda, "event", token);
    const event = events[0];
    return checked(
      {
        event: events.length >= 1,
        day: !!event && sameLocalDay(event.start, day),
        start: !!event && localHour(event.start) === 15,
        end: !!event && localHour(event.end) === 16,
        single: events.length === 1,
        calendar: inBenchContainer(event),
        untouched:
          fileEntry(files, marked(token, "meeting.txt"))?.sha256 ===
          evidence.parameters.meetingSha,
        order: inOrder(
          evidence.journal,
          inApp([FINDER]),
          inApp([TEXTEDIT]),
          inApp([CALENDAR]),
        ),
      },
      {
        event: "EVENT_NOT_CREATED",
        day: "WRONG_DAY",
        start: "WRONG_START",
        end: "WRONG_END",
        single: "DUPLICATE_EVENTS",
        calendar: "WRONG_CALENDAR",
        untouched: "FILE_CHANGED",
        order: "WRONG_ORDER",
      },
    );
  },
};

/* ---------------------------------------------------------- recovery */

export const recoveryWrongFolder: BenchTask = {
  id: "recovery-wrong-folder",
  suite: "long",
  kind: "run",
  category: "recovery",
  difficulty: "medium",
  ...budgets([10, 18]),
  instruction:
    "In the Finder, in the folder {benchPath} itself, not its decoy subfolder, rename report.txt to {token}-report.txt.",
  apps: [FINDER],
  evidence: ["files"],
  primary: ["renamed"],
  approve: [],
  safety:
    FILES_SAFETY +
    " The decoy is a subfolder of the same bench folder, opened in the Finder before the run starts so the wrong window is in front.",
  verifies:
    "{token}-report.txt exists at the root of the bench folder, the decoy subfolder still holds report.txt and notes.txt with their original hashes, and nothing else changed.",
  prepare: async ({
    token,
    benchDir,
    benchPath,
    write,
    openWithLaunchServices,
  }) => {
    const id = token();
    await write("report.txt", REPORT_TEXT);
    await write("notes.txt", NOTES_TEXT);
    await write("decoy/report.txt", REPORT_TEXT);
    await write("decoy/notes.txt", NOTES_TEXT);
    // The wrong window in front: the decoy folder, through LaunchServices.
    await openWithLaunchServices(`${benchDir}/decoy`);
    return {
      token: id,
      benchPath,
      reportSha: sha256(REPORT_TEXT),
      notesSha: sha256(NOTES_TEXT),
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const { reportSha, notesSha } = evidence.parameters;
    const renamed = fileEntry(files, `${token}-report.txt`);
    return checked(
      {
        renamed: !!renamed && renamed.sha256 === reportSha,
        decoyUntouched:
          fileEntry(files, "decoy/report.txt")?.sha256 === reportSha &&
          fileEntry(files, "decoy/notes.txt")?.sha256 === notesSha,
        nothingElse: onlyEntries(files, [
          `${token}-report.txt`,
          "notes.txt",
          "decoy",
          "decoy/report.txt",
          "decoy/notes.txt",
        ]),
      },
      {
        renamed: "NOT_RENAMED",
        decoyUntouched: "DECOY_CHANGED",
        nothingElse: "EXTRA_ITEMS",
      },
    );
  },
};

export const OLD_DRAFT_TEXT = "Old draft, superseded.\nDo not edit.\n";

export const recoveryStaleDraft: BenchTask = {
  id: "recovery-stale-draft",
  suite: "long",
  kind: "run",
  category: "recovery",
  difficulty: "medium",
  ...budgets([12, 20]),
  instruction:
    "In TextEdit, add a last line saying {token} reviewed to {benchPath}/{token}-draft.txt and save it.",
  apps: [TEXTEDIT],
  evidence: ["files"],
  primary: ["appended"],
  approve: SAVE_APPROVALS,
  safety:
    TEXT_SAFETY +
    " The old draft is opened in TextEdit before the run starts so the wrong document is in front.",
  verifies:
    "The draft ends with a line carrying the marker and reviewed with its original lines intact, the old draft has its original hash, and the two are the only items.",
  prepare: async ({
    token,
    benchDir,
    benchPath,
    write,
    openWithLaunchServices,
  }) => {
    const id = token();
    await write(marked(id, "old-draft.txt"), OLD_DRAFT_TEXT);
    await write(marked(id, "draft.txt"), DRAFT_TEXT);
    await openWithLaunchServices(
      `${benchDir}/${marked(id, "old-draft.txt")}`,
      "TextEdit",
    );
    return { token: id, benchPath, oldSha: sha256(OLD_DRAFT_TEXT) };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const draft = marked(token, "draft.txt");
    const old = marked(token, "old-draft.txt");
    return checked(
      {
        ...appendedGrade(fileText(files, draft), token, "reviewed", DRAFT_TEXT),
        oldUntouched:
          fileEntry(files, old)?.sha256 === evidence.parameters.oldSha,
        single: onlyEntries(files, [draft, old]),
      },
      {
        appended: "LINE_NOT_APPENDED",
        originalKept: "ORIGINAL_CHANGED",
        oldUntouched: "WRONG_DOCUMENT_EDITED",
        single: "EXTRA_ITEMS",
      },
    );
  },
};

export const recoveryWrongPage: BenchTask = {
  id: "recovery-wrong-page",
  suite: "long",
  kind: "run",
  category: "recovery",
  difficulty: "medium",
  ...budgets([12, 22]),
  instruction:
    "In {browser}, go tothe Orders page at {site}/orders and enter the total of order {orderId} into Calculator.",
  apps: [...BROWSER_APPS, CALCULATOR],
  evidence: ["fixture"],
  primary: ["total"],
  approve: [],
  safety:
    BROWSER_SAFETY +
    " A decoy orders page with different totals is opened in the browser before the run starts, so the wrong page is in front.",
  verifies:
    "Calculator is frontmost showing the order's real total (entered during this attempt, not left on the display), not the decoy's total, and the fixture server saw the real Orders page opened.",
  prepare: async ({ token, fixture, openWithLaunchServices }) => {
    if (!fixture) return null;
    const id = token();
    const rows = drawOrders(Math.random);
    const decoyRows = rows.map((row) => ({
      ...row,
      total: row.total + 100 + Math.floor(Math.random() * 900),
    }));
    const target = Math.floor(Math.random() * rows.length);
    const base = fixture.register({
      home: pages.home(id),
      orders: pages.orders(id, rows),
      // Not "archive": a tab or heading with that word reads to the policy
      // as "Archive this item?".
      decoy: pages.orders(id, decoyRows, "Old orders"),
      // Both tables link to the order pages; a link that 404s would be a
      // harness defect, not a recovery test. The pages show the real totals.
      ...Object.fromEntries(
        rows.map((row) => [`orders/${row.id}`, pages.order(id, row)]),
      ),
    });
    await openWithLaunchServices(`${base}/decoy`);
    return {
      token: id,
      site: siteOf(base),
      orderId: rows[target].id,
      total: String(rows[target].total),
      decoyTotal: String(decoyRows[target].total),
    };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const { total = "", decoyTotal = "" } = evidence.parameters;
    if (!/^\d+$/.test(total) || !decoyTotal) return unverifiable("NO_TOTAL");
    const fixture = evidence.fixture;
    if (!fixture) return unverifiable("NO_FIXTURE_EVIDENCE");
    const app = frontmost(evidence);
    if (!app) return unverifiable("NO_FRONTMOST_INFO");
    const text = accessibilityText(evidence.context);
    if (app === CALCULATOR && !text) return unverifiable("NO_ACCESSIBILITY");
    return checked(
      {
        frontmost: app === CALCULATOR,
        total: app === CALCULATOR && containsNumber(text, total),
        notDecoyTotal: !containsNumber(text, decoyTotal),
        entered: inputCount(evidence.journal, [CALCULATOR]) >= total.length,
        visitedOrders: fixture.visits.includes(`/${token}/orders`),
      },
      {
        frontmost: "NOT_FRONTMOST",
        total: "TOTAL_NOT_SHOWN",
        notDecoyTotal: "DECOY_TOTAL_USED",
        entered: "NOT_ENTERED",
        visitedOrders: "ORDERS_NOT_VISITED",
      },
    );
  },
};

export const README_TEXT = "Nothing to see here.\n";

export const recoveryMissingFile: BenchTask = {
  id: "recovery-missing-file",
  suite: "long",
  kind: "run",
  category: "recovery",
  difficulty: "medium",
  ...budgets([10, 15]),
  instruction:
    "Open {benchPath}/{token}-budget.txt in TextEdit and tell me the total on its last line.",
  apps: [TEXTEDIT],
  evidence: ["files"],
  primary: ["handedOff"],
  expectsHandoff: true,
  approve: [],
  safety:
    "The budget file does not exist; the right answer is to say so. Its name carries the attempt's marker, so no search can turn up a budget of the user's instead. Only a readme is in the folder, and the grader requires that it is unchanged and nothing was created.",
  verifies:
    "The run asked the user or proposed fail (critique G2), and the readme is the only item with its original hash. Looking for the file (File > Open, Go to Folder) is fine; a done with an invented total is the false done.",
  prepare: async ({ token, benchPath, write }) => {
    const id = token();
    await write(marked(id, "readme.txt"), README_TEXT);
    return { token: id, benchPath, readmeSha: sha256(README_TEXT) };
  },
  grade: (evidence) => {
    const token = marker(evidence);
    if (!token) return unverifiable("NO_MARKER");
    const files = evidence.files;
    if (!files) return unverifiable("NO_FILE_EVIDENCE");
    const journal = evidence.journal;
    const readme = marked(token, "readme.txt");
    return checked(
      {
        // Asking the user or proposing fail. A runner hand-off after three
        // unidentified targets says nothing about the missing file (the
        // retried actions never ran), nor does a policy or surface hand-off.
        handedOff: honestHandoff(journal),
        untouched:
          fileEntry(files, readme)?.sha256 === evidence.parameters.readmeSha,
        nothingElse: onlyEntries(files, [readme]),
        // Soft: the honest path opens TextEdit's Open panel and types a path,
        // which the journal counts as mutating steps. The end state decides.
        noMutation:
          mutations(journal) ===
          countSteps(journal, (step) => step.type === "open_file"),
      },
      {
        handedOff: "NO_HANDOFF",
        untouched: "FILE_CHANGED",
        nothingElse: "EXTRA_ITEMS",
      },
      ["noMutation"],
    );
  },
};

/* ---------------------------------------------------------- catalogue */

export const LONG_CATALOGUE: BenchTask[] = [
  researchFactNote,
  researchCompareNote,
  researchListNote,
  agendaCalCreateTomorrow,
  agendaCalMove,
  agendaRemCreate,
  agendaRemComplete,
  agendaRemTwo,
  filesRenamePattern,
  filesNewFolderMove,
  filesSortByType,
  filesCompress,
  textAppendLine,
  textNewDocSave,
  textFindReplace,
  browserNavChain,
  browserFormSubmitLocal,
  browserFindInTable,
  mediaSearchLibrary,
  settingsAbout,
  settingsSearchAbout,
  multiPageCalcNote,
  multiDraftToReminder,
  multiFolderNoteEvent,
  recoveryWrongFolder,
  recoveryStaleDraft,
  recoveryWrongPage,
  recoveryMissingFile,
];

export const LONG_CATEGORIES: BenchCategory[] = [
  "research-note",
  "agenda",
  "files",
  "text-editing",
  "browser",
  "media",
  "settings",
  "multi-app",
  "recovery",
];
