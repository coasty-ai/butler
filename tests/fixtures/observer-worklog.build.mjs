// Builds tests/fixtures/observer-worklog.json: five synthetic weekdays of
// observer frames and actions in the shapes of .data/design/observer.md §2,
// with a planted morning routine, two procedures, one preference that flips
// and noise. Deterministic (a seeded generator), so the committed JSON is
// reproducible and tests/observer-eval.test.ts checks it has not drifted:
//
//   node tests/fixtures/observer-worklog.build.mjs > tests/fixtures/observer-worklog.json
//   npx prettier --write tests/fixtures/observer-worklog.json
//
// Everything here is invented: bundle ids of real applications, window title
// stems, hosts under example.com/.org/.net and control labels. What is
// planted, and where, is written in observer-worklog.README.md beside it.

/** The owner's clock: Pacific daylight time, a fixed offset for the week. */
const TIMEZONE = "America/Los_Angeles";
const UTC_OFFSET_MINUTES = -420;
const DAYS = [
  ["2026-09-14", 1],
  ["2026-09-15", 2],
  ["2026-09-16", 3],
  ["2026-09-17", 4],
  ["2026-09-18", 5],
];
const FLIP_DAY = "2026-09-17";

export const APPS = {
  slack: { id: "com.tinyspeck.slackmacgap", name: "Slack" },
  mail: { id: "com.apple.mail", name: "Mail" },
  linear: { id: "com.linear", name: "Linear" },
  safari: { id: "com.apple.Safari", name: "Safari" },
  chrome: { id: "com.google.Chrome", name: "Google Chrome" },
  preview: { id: "com.apple.Preview", name: "Preview" },
  finder: { id: "com.apple.finder", name: "Finder" },
  numbers: { id: "com.apple.iWork.Numbers", name: "Numbers" },
  terminal: { id: "com.apple.Terminal", name: "Terminal" },
  notes: { id: "com.apple.Notes", name: "Notes" },
  music: { id: "com.apple.Music", name: "Music" },
  messages: { id: "com.apple.MobileSMS", name: "Messages" },
  calendar: { id: "com.apple.iCal", name: "Calendar" },
  keychain: { id: "com.apple.keychainaccess", name: "Keychain Access" },
};

const CONTROLS = {
  slack: [
    { role: "button", label: "general" },
    { role: "button", label: "dev-butler" },
    { role: "textField", label: "Message #general" },
  ],
  mail: [
    { role: "button", label: "Inbox" },
    { role: "button", label: "Reply" },
    { role: "button", label: "Archive" },
  ],
  linear: [
    { role: "button", label: "My issues" },
    { role: "button", label: "Triage" },
    { role: "button", label: "New issue" },
  ],
  browser: [
    { role: "textField", label: "Address and Search" },
    { role: "button", label: "Back" },
    { role: "button", label: "Reload" },
  ],
  preview: [
    { role: "button", label: "Zoom In" },
    { role: "button", label: "Share" },
  ],
  exportSheet: [
    { role: "textField", label: "Export As" },
    { role: "popUpButton", label: "Where" },
    { role: "button", label: "Save" },
    { role: "button", label: "Cancel" },
  ],
  finder: [
    { role: "button", label: "Downloads" },
    { role: "button", label: "Documents" },
    { role: "button", label: "Back" },
  ],
  numbers: [
    { role: "button", label: "Table" },
    { role: "button", label: "Chart" },
    { role: "button", label: "Format" },
  ],
  numbersExport: [
    { role: "button", label: "Next…" },
    { role: "popUpButton", label: "Image Quality" },
    { role: "button", label: "Cancel" },
  ],
  saveSheet: [
    { role: "textField", label: "Save As" },
    { role: "button", label: "Export" },
    { role: "button", label: "Cancel" },
  ],
  terminal: [{ role: "button", label: "New Tab" }],
  notes: [
    { role: "button", label: "New Note" },
    { role: "textArea", label: "Note" },
  ],
  music: [
    { role: "button", label: "Play" },
    { role: "button", label: "Next" },
  ],
  messages: [
    { role: "textField", label: "iMessage" },
    { role: "button", label: "Send" },
  ],
  calendar: [
    { role: "button", label: "Today" },
    { role: "button", label: "Week" },
  ],
  compose: [
    { role: "textField", label: "To" },
    { role: "textField", label: "Subject" },
    { role: "textArea", label: "Message" },
    { role: "button", label: "Send" },
  ],
};

const RECEIPTS = [
  ["2026-09-14", 10, 40, "Acme Cloud"],
  ["2026-09-15", 14, 15, "Northwind Hosting"],
  ["2026-09-16", 11, 5, "Contoso Print"],
  ["2026-09-18", 15, 20, "Fabrikam Domains"],
];
const REPORTS = [
  ["2026-09-14", 16, 30],
  ["2026-09-16", 16, 45],
  ["2026-09-18", 16, 20],
];

/** mulberry32: small, seedable, good enough for jitter. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Epoch ms of a local clock time on a fixture day. */
function localMs(day, hour, minute, second = 0) {
  const [y, m, d] = day.split("-").map(Number);
  return (
    Date.UTC(y, m - 1, d, hour, minute, second) - UTC_OFFSET_MINUTES * 60_000
  );
}

class Day {
  constructor(day, weekday, seed) {
    this.day = day;
    this.weekday = weekday;
    this.rows = [];
    this.random = rng(seed);
    this.t = localMs(day, 8, 0);
    this.front = undefined;
    this.runs = { receipts: [], reports: [] };
  }
  /** Uniform integer in [lo, hi]. */
  int(lo, hi) {
    return lo + Math.floor(this.random() * (hi - lo + 1));
  }
  at(hour, minute) {
    this.t = localMs(this.day, hour, minute, this.int(0, 59));
  }
  /** Advance by `seconds` plus up to `jitter` seconds. */
  wait(seconds, jitter = 0) {
    this.t += (seconds + this.int(0, jitter)) * 1000;
  }
  frame(app, extra = {}) {
    const { controls = [], ...rest } = extra;
    this.front = { app, ...rest, controls };
    this.rows.push({
      event: "observe_frame",
      atMs: this.t,
      appId: app.id,
      appName: app.name,
      ...rest,
      controls,
    });
  }
  /** One periodic frame of what is in front, names only. */
  periodic() {
    const { app, windowTitle, host } = this.front;
    this.rows.push({
      event: "observe_frame",
      atMs: this.t,
      appId: app.id,
      appName: app.name,
      ...(windowTitle && { windowTitle }),
      ...(host && { host }),
      controls: [],
    });
  }
  /** Stay on the front window for `minutes`, a frame every ten and a scroll now and then. */
  dwell(minutes) {
    let left = minutes * 60;
    while (left > 0) {
      const step = Math.min(left, 600);
      this.t += step * 1000;
      left -= step;
      if (left > 0) {
        this.periodic();
        if (this.random() < 0.5) this.scroll("down", this.int(1, 4));
      }
    }
  }
  action(kind, extra = {}) {
    this.rows.push({
      event: "observe_action",
      atMs: this.t,
      appId: this.front.app.id,
      kind,
      ...extra,
    });
  }
  switchTo(app, extra) {
    this.rows.push({
      event: "observe_action",
      atMs: this.t,
      appId: app.id,
      kind: "app_switch",
    });
    this.wait(1, 2);
    this.frame(app, extra);
    this.wait(2, 4);
  }
  click(label, role = "button", kind = "click") {
    this.action(kind, { target: { role, label } });
    this.wait(2, 5);
  }
  chord(chord) {
    this.action("key_chord", { chord });
    this.wait(1, 3);
  }
  type(field, chars) {
    const ms = chars * this.int(90, 160);
    this.action("typing", { typed: { field, chars, ms } });
    this.t += ms + this.int(500, 2500);
  }
  scroll(direction, ticks) {
    this.action("scroll", { scroll: { direction, ticks } });
    this.wait(3, 8);
  }
  menu(path) {
    this.action("menu_item", { menu: path });
    this.wait(2, 4);
  }
  excluded(code, extra = {}) {
    this.rows.push({
      event: "observe_frame",
      atMs: this.t,
      ...extra,
      excluded: code,
    });
  }

  // ---- Planted -------------------------------------------------------------

  /** Slack, Mail, Linear in order, about twenty minutes from ~09:00. */
  morningRoutine(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.slack, {
      windowTitle: "general - Northwind",
      controls: CONTROLS.slack,
    });
    this.scroll("down", 3);
    this.click("dev-butler");
    this.frame(APPS.slack, {
      windowTitle: "dev-butler - Northwind",
      controls: CONTROLS.slack,
    });
    this.scroll("down", 2);
    this.wait(90, 60);
    this.switchTo(APPS.mail, {
      windowTitle: "Inbox – Work",
      controls: CONTROLS.mail,
    });
    this.click("Inbox");
    this.scroll("down", 2);
    this.click("Archive");
    this.wait(60, 60);
    this.switchTo(APPS.linear, {
      windowTitle: "My issues – Linear",
      controls: CONTROLS.linear,
    });
    this.click("My issues");
    this.scroll("down", 4);
    this.click("Triage");
    this.frame(APPS.linear, {
      windowTitle: "Triage – Linear",
      controls: CONTROLS.linear,
    });
    this.scroll("down", 2);
    this.wait(120, 120);
  }

  /** The filing procedure: a receipt PDF from Mail into Documents › Receipts, the vendor as the slot. */
  fileReceipt(hour, minute, vendor) {
    this.at(hour, minute);
    const from = this.t;
    this.switchTo(APPS.mail, {
      windowTitle: `Receipt - ${vendor} — Inbox`,
      controls: CONTROLS.mail,
    });
    this.click(`Receipt - ${vendor}.pdf`, "image", "double_click");
    this.frame(APPS.preview, {
      windowTitle: `Receipt - ${vendor}.pdf`,
      controls: CONTROLS.preview,
    });
    this.wait(3, 5);
    this.menu(["File", "Export…"]);
    this.frame(APPS.preview, {
      windowTitle: `Receipt - ${vendor}.pdf`,
      focusedRole: "textField",
      focusedLabel: "Export As",
      controls: CONTROLS.exportSheet,
    });
    this.type("Export As", `2026-09 ${vendor} receipt`.length);
    this.click("Where", "popUpButton");
    this.menu(["Receipts"]);
    this.click("Save");
    this.wait(2, 3);
    this.runs.receipts.push({
      day: this.day,
      fromMs: from,
      toMs: this.t,
      slot: vendor,
    });
    this.switchTo(APPS.mail, {
      windowTitle: "Inbox – Work",
      controls: CONTROLS.mail,
    });
    if (this.random() < 0.5) this.click("Archive");
  }

  /** The weekly report: Numbers exported to PDF, then a new message in Mail. */
  weeklyReport(hour, minute) {
    this.at(hour, minute);
    const from = this.t;
    this.switchTo(APPS.numbers, {
      windowTitle: "Weekly metrics",
      controls: CONTROLS.numbers,
    });
    this.scroll("down", 2);
    this.wait(20, 40);
    this.menu(["File", "Export To", "PDF…"]);
    this.frame(APPS.numbers, {
      windowTitle: "Weekly metrics",
      controls: CONTROLS.numbersExport,
    });
    this.click("Next…");
    this.frame(APPS.numbers, {
      windowTitle: "Weekly metrics",
      focusedRole: "textField",
      focusedLabel: "Save As",
      controls: CONTROLS.saveSheet,
    });
    this.type("Save As", 22);
    this.click("Export");
    this.wait(4, 4);
    this.switchTo(APPS.mail, {
      windowTitle: "Inbox – Work",
      controls: CONTROLS.mail,
    });
    this.chord("CMD+N");
    this.frame(APPS.mail, {
      windowTitle: "New Message",
      focusedRole: "textField",
      focusedLabel: "To",
      controls: CONTROLS.compose,
    });
    this.type("To", 24);
    this.type("Subject", 30);
    this.type("Message", this.int(140, 260));
    this.click("Send");
    this.wait(2, 3);
    this.runs.reports.push({ day: this.day, fromMs: from, toMs: this.t });
  }

  /** docs.example.com: Safari before the flip day, Chrome from it on. */
  docsVisit(hour, minute) {
    this.at(hour, minute);
    const app = this.day < FLIP_DAY ? APPS.safari : APPS.chrome;
    this.switchTo(app, {
      windowTitle: "Runbook · Docs",
      host: "docs.example.com",
      controls: CONTROLS.browser,
    });
    this.scroll("down", this.int(2, 6));
    this.click("Deploy checklist", "link");
    this.frame(app, {
      windowTitle: "Deploy checklist · Docs",
      host: "docs.example.com",
      controls: CONTROLS.browser,
    });
    this.scroll("down", this.int(1, 4));
    this.wait(60, 120);
  }

  // ---- Noise ---------------------------------------------------------------

  terminal(hour, minute, minutes) {
    this.at(hour, minute);
    this.switchTo(APPS.terminal, {
      windowTitle: "zsh — butler — 80×24",
      controls: CONTROLS.terminal,
    });
    const bursts = this.int(2, 4);
    for (let i = 0; i < bursts; i++) {
      this.type("Terminal", this.int(12, 70));
      this.wait(10, 40);
    }
    if (this.random() < 0.4) this.chord("CMD+T");
    this.dwell(minutes);
  }

  browse(hour, minute, host, title, minutes) {
    this.at(hour, minute);
    this.switchTo(APPS.safari, {
      windowTitle: title,
      host,
      controls: CONTROLS.browser,
    });
    this.scroll("down", this.int(3, 9));
    this.click("Read more", "link");
    this.scroll("down", this.int(2, 8));
    if (this.random() < 0.5) this.click("Back");
    this.dwell(minutes);
  }

  notes(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.notes, {
      windowTitle: "Standup notes",
      focusedRole: "textArea",
      focusedLabel: "Note",
      controls: CONTROLS.notes,
    });
    const bursts = this.int(2, 3);
    for (let i = 0; i < bursts; i++) {
      this.type("Note", this.int(40, 180));
      this.wait(15, 60);
    }
  }

  finder(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.finder, {
      windowTitle: "Downloads",
      controls: CONTROLS.finder,
    });
    this.click("Documents");
    this.frame(APPS.finder, {
      windowTitle: "Documents",
      controls: CONTROLS.finder,
    });
    this.scroll("down", this.int(1, 3));
    if (this.random() < 0.5) this.click("brief.pdf", "image", "right_click");
  }

  calendar(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.calendar, {
      windowTitle: "September 2026",
      controls: CONTROLS.calendar,
    });
    this.click("Today");
    this.scroll("down", this.int(1, 2));
  }

  /** Music then Messages: on two days only, at different hours. Not a routine. */
  musicMessages(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.music, {
      windowTitle: "Music",
      controls: CONTROLS.music,
    });
    this.click("Play");
    this.wait(30, 60);
    this.switchTo(APPS.messages, {
      windowTitle: "Messages",
      focusedRole: "textField",
      focusedLabel: "iMessage",
      controls: CONTROLS.messages,
    });
    this.type("iMessage", this.int(20, 90));
    this.click("Send");
  }

  /** A sign-in: secure input comes on and the frames carry only the app. */
  secureLogin(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.safari, {
      windowTitle: "Sign in",
      host: "accounts.example.com",
      controls: CONTROLS.browser,
    });
    this.click("Sign in", "link");
    this.excluded("secure_input", { appId: APPS.safari.id });
    this.wait(20, 20);
    this.excluded("secure_input", { appId: APPS.safari.id });
    this.wait(15, 10);
    this.frame(APPS.safari, {
      windowTitle: "Account",
      host: "accounts.example.com",
      controls: CONTROLS.browser,
    });
  }

  lunch(hour, minute) {
    this.at(hour, minute);
    this.excluded("idle");
  }

  ownRun(hour, minute, runId) {
    this.at(hour, minute);
    this.excluded("own_run", { runId });
  }

  protectedApp(hour, minute) {
    this.at(hour, minute);
    this.excluded("protected", { appId: APPS.keychain.id });
  }

  slackGlance(hour, minute) {
    this.at(hour, minute);
    this.switchTo(APPS.slack, {
      windowTitle: "general - Northwind",
      controls: CONTROLS.slack,
    });
    this.scroll("down", this.int(1, 3));
  }

  lock(hour, minute) {
    this.at(hour, minute);
    this.excluded("locked");
  }
}

export function build() {
  const days = [];
  const receiptRuns = [];
  const reportRuns = [];
  for (const [index, [day, weekday]] of DAYS.entries()) {
    const d = new Day(day, weekday, 0x0b5e7 + index * 7919);
    const receipt = RECEIPTS.find((r) => r[0] === day);
    const report = REPORTS.find((r) => r[0] === day);
    switch (weekday) {
      case 1:
        d.morningRoutine(8, 55);
        d.terminal(9, 25, 20);
        d.docsVisit(9, 50);
        d.notes(10, 10);
        d.fileReceipt(receipt[1], receipt[2], receipt[3]);
        d.browse(11, 10, "news.example.org", "Morning briefing – News", 15);
        d.calendar(11, 40);
        d.lunch(12, 10);
        d.browse(13, 5, "wiki.example.net", "Release process – Wiki", 20);
        d.ownRun(14, 5, "run-7f3a");
        d.finder(14, 20);
        d.terminal(14, 40, 30);
        d.docsVisit(15, 30);
        d.weeklyReport(report[1], report[2]);
        d.slackGlance(17, 5);
        d.lock(17, 40);
        break;
      case 2:
        d.morningRoutine(8, 52);
        d.notes(9, 20);
        d.docsVisit(9, 45);
        d.terminal(10, 5, 40);
        d.browse(10, 50, "wiki.example.net", "Onboarding – Wiki", 15);
        d.calendar(11, 30);
        d.lunch(12, 5);
        d.secureLogin(13, 45);
        d.fileReceipt(receipt[1], receipt[2], receipt[3]);
        d.musicMessages(15, 0);
        d.browse(15, 30, "news.example.org", "Afternoon edition – News", 10);
        d.terminal(16, 0, 30);
        d.slackGlance(16, 50);
        d.lock(17, 30);
        break;
      case 3:
        d.morningRoutine(9, 2);
        d.terminal(9, 30, 30);
        d.docsVisit(10, 0);
        d.fileReceipt(receipt[1], receipt[2], receipt[3]);
        d.notes(11, 35);
        d.lunch(12, 15);
        d.browse(13, 10, "news.example.org", "Midweek – News", 15);
        d.finder(13, 50);
        d.calendar(14, 10);
        d.docsVisit(14, 30);
        d.protectedApp(15, 30);
        d.terminal(15, 40, 40);
        d.weeklyReport(report[1], report[2]);
        d.lock(17, 35);
        break;
      case 4:
        d.morningRoutine(8, 58);
        d.docsVisit(9, 30);
        d.secureLogin(10, 20);
        d.terminal(10, 35, 40);
        d.notes(11, 20);
        d.lunch(12, 0);
        d.musicMessages(13, 30);
        d.browse(14, 0, "wiki.example.net", "Incident review – Wiki", 20);
        d.docsVisit(14, 45);
        d.finder(15, 20);
        d.terminal(15, 40, 40);
        d.calendar(16, 30);
        d.slackGlance(17, 0);
        d.lock(17, 45);
        break;
      case 5:
        d.morningRoutine(8, 54);
        d.terminal(9, 25, 30);
        d.docsVisit(10, 5);
        d.notes(10, 40);
        d.browse(11, 15, "news.example.org", "Friday – News", 20);
        d.lunch(12, 10);
        d.calendar(13, 0);
        d.terminal(13, 20, 60);
        d.fileReceipt(receipt[1], receipt[2], receipt[3]);
        d.docsVisit(15, 50);
        d.weeklyReport(report[1], report[2]);
        d.finder(17, 0);
        d.lock(17, 30);
        break;
    }
    d.rows.sort((a, b) => a.atMs - b.atMs);
    days.push({ day, weekday, rows: d.rows });
    receiptRuns.push(...d.runs.receipts);
    reportRuns.push(...d.runs.reports);
  }
  return {
    version: 1,
    timezone: TIMEZONE,
    utcOffsetMinutes: UTC_OFFSET_MINUTES,
    tier: "structure",
    days,
    planted: {
      routines: [
        {
          id: "morning-triage",
          name: "Morning triage: Slack, Mail, Linear",
          apps: [APPS.slack.id, APPS.mail.id, APPS.linear.id],
          weekdays: [1, 2, 3, 4, 5],
          hourRange: [8, 10],
          days: DAYS.map(([day]) => day),
        },
      ],
      procedures: [
        {
          id: "file-receipt",
          name: "File a receipt from Mail into Documents › Receipts",
          steps: [
            { kind: "double_click", appId: APPS.mail.id },
            {
              kind: "menu_item",
              appId: APPS.preview.id,
              menu: ["File", "Export…"],
            },
            { kind: "typing", appId: APPS.preview.id, field: "Export As" },
            { kind: "click", appId: APPS.preview.id, label: "Where" },
            { kind: "menu_item", appId: APPS.preview.id, menu: ["Receipts"] },
            { kind: "click", appId: APPS.preview.id, label: "Save" },
          ],
          runs: receiptRuns,
          slots: ["vendor"],
        },
        {
          id: "weekly-report",
          name: "Export the weekly metrics to PDF and mail it",
          steps: [
            {
              kind: "app_switch",
              appId: APPS.numbers.id,
              appName: APPS.numbers.name,
            },
            {
              kind: "menu_item",
              appId: APPS.numbers.id,
              menu: ["File", "Export To", "PDF…"],
            },
            { kind: "click", appId: APPS.numbers.id, label: "Next…" },
            { kind: "typing", appId: APPS.numbers.id, field: "Save As" },
            { kind: "click", appId: APPS.numbers.id, label: "Export" },
            {
              kind: "app_switch",
              appId: APPS.mail.id,
              appName: APPS.mail.name,
            },
            { kind: "key_chord", appId: APPS.mail.id, chord: "CMD+N" },
            { kind: "typing", appId: APPS.mail.id, field: "To" },
            { kind: "typing", appId: APPS.mail.id, field: "Subject" },
            { kind: "typing", appId: APPS.mail.id, field: "Message" },
            { kind: "click", appId: APPS.mail.id, label: "Send" },
          ],
          runs: reportRuns,
          slots: [],
        },
      ],
      preferences: [
        {
          id: "docs-browser",
          subject: ["docs.example.com", "docs"],
          earlier: ["Safari"],
          later: ["Chrome"],
          flipDay: FLIP_DAY,
        },
      ],
      decoys: [
        {
          id: "music-messages",
          apps: [APPS.music.id, APPS.messages.id],
          days: ["2026-09-15", "2026-09-17"],
          note: "Music then Messages on two days at different hours: not a routine.",
        },
        {
          id: "terminal-sessions",
          apps: [APPS.terminal.id],
          days: DAYS.map(([day]) => day),
          note: "Terminal sessions at varying hours every day: an app in use, not a routine.",
        },
        {
          id: "browsing",
          apps: [APPS.safari.id],
          days: DAYS.map(([day]) => day),
          note: "News and wiki reading in Safari at varying hours: not a routine, and Safari stays the browser for these hosts after the flip.",
        },
      ],
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  process.stdout.write(JSON.stringify(build(), null, 2) + "\n");
