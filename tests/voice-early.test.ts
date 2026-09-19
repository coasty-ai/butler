import { describe, expect, it } from "vitest";
import {
  ClauseTracker,
  EARLY_LIMITS,
  earlyLead,
  finalKeeps,
  leadingClause,
  type AppMatch,
  type EarlyClause,
  type TrackerEvent,
} from "../src/voice/early";
import { KNOWN_FOLDERS, KNOWN_SITES } from "../src/core/places";

type Row = [text: string, clause: Partial<EarlyClause> | undefined];
const open = (name: string, next: EarlyClause["next"]) => ({
  verb: "open" as const,
  target: "app" as const,
  name,
  next,
});
const sw = (name: string, next: EarlyClause["next"]) => ({
  verb: "switch" as const,
  target: "app" as const,
  name,
  next,
});
const site = (host: string, next: EarlyClause["next"]) => ({
  verb: "open" as const,
  target: "site" as const,
  name: host,
  next,
});
const folder = (name: string, next: EarlyClause["next"]) => ({
  verb: "open" as const,
  target: "folder" as const,
  name,
  next,
});

describe("leadingClause", () => {
  const rows: Row[] = [
    // The request's own example: Slack settles before "and".
    ["open slack and do xyz", open("slack", "boundary")],
    ["Open Slack and message Dana", open("Slack", "boundary")],
    ["Open Slack and", open("Slack", "boundary")],
    ["Open Slack", open("Slack", "end")],
    ["open Slack.", open("Slack", "end")],
    ["Open Slack please", open("Slack", "end")],
    ["Open Slack now and ask Dana", open("Slack", "boundary")],
    ["OPEN SLACK AND", { name: "SLACK", key: "slack", next: "boundary" }],
    ["open Slack, and message Dana", open("Slack", "boundary")],
    ["open Slack; then check mail", open("Slack", "boundary")],
    ["open Slack then check mail", open("Slack", "boundary")],
    ["open Slack also check mail", open("Slack", "boundary")],
    ["open Slack plus Notes", open("Slack", "boundary")],
    ["open Slack so I can reply", open("Slack", "boundary")],
    ["Open Slack. Then message Dana", open("Slack", "boundary")],
    ["Open Slack— and message Dana", open("Slack", "boundary")],
    // A trailing dash is a sentence still being corrected.
    ["Open Slack—", open("Slack", "more")],
    ["Open Slack— no, Discord", open("Slack", "veto")],
    // A change of mind right after the boundary is a veto, not a settle.
    ["Open Slack and no wait Discord", open("Slack", "veto")],
    ["Open Slack and never mind", open("Slack", "veto")],
    ["Open Slack and stop", open("Slack", "veto")],
    ["Open Slack, no, Discord", open("Slack", "veto")],
    ["Open Slack. No, Discord", open("Slack", "veto")],
    ["Open Slack and actually open Discord", open("Slack", "veto")],
    // An ordinary second clause still settles.
    ["Open Slack and tell Dana no", open("Slack", "boundary")],
    ["Open Slack or", open("Slack", "veto")],
    ["Open Slack no Discord", open("Slack", "veto")],
    ["Open Slack actually Discord", open("Slack", "veto")],
    ["Open Slack I mean Discord", open("Slack", "veto")],
    ["Open Slack in Chrome", open("Slack", "veto")],
    ["open Slack on my phone", open("Slack", "veto")],
    ["open Slack to the general channel", open("Slack", "veto")],
    ["open Slack with Dana", open("Slack", "veto")],
    ["open Slack for me", open("Slack", "veto")],
    ["Open Slack website", open("Slack", "veto")],
    ["Open Slack's settings", open("Slack", "veto")],
    ["open Slack?", open("Slack", "veto")],
    ["Open Slack the channel", open("Slack", "more")],
    // Leads and polite frames.
    ["can you open Slack and", open("Slack", "boundary")],
    ["could you launch Notes and", open("Notes", "boundary")],
    ["please open Slack and", open("Slack", "boundary")],
    ["and open Slack and", open("Slack", "boundary")],
    ["Okay, so open Slack and", open("Slack", "boundary")],
    ["Hey Butler open Slack and", open("Slack", "boundary")],
    ["Butler, open Slack and", open("Slack", "boundary")],
    ["um open uh Slack and", open("Slack", "boundary")],
    // Every early verb, for an app.
    ["open up Slack and", open("Slack", "boundary")],
    ["launch Slack and", open("Slack", "boundary")],
    ["pull up Notes and", open("Notes", "boundary")],
    ["bring up Calendar then", open("Calendar", "boundary")],
    ["go to Safari and", open("Safari", "boundary")],
    ["take me to Safari and", open("Safari", "boundary")],
    ["show me Slack and", open("Slack", "boundary")],
    ["Switch to Safari and", sw("Safari", "boundary")],
    ["switch over to Safari and", sw("Safari", "boundary")],
    // Every early verb, for a site.
    ["open YouTube and", site("YouTube", "boundary")],
    ["open up youtube and", site("youtube", "boundary")],
    ["launch youtube and", site("youtube", "boundary")],
    ["pull up youtube and", site("youtube", "boundary")],
    ["bring up youtube and", site("youtube", "boundary")],
    ["Go to YouTube and", site("YouTube", "boundary")],
    ["take me to youtube and", site("youtube", "boundary")],
    ["show me youtube and", site("youtube", "boundary")],
    [
      "Switch to youtube and",
      { ...site("youtube", "boundary"), verb: "switch" },
    ],
    // Every early verb, for a folder.
    ["open downloads and", folder("downloads", "boundary")],
    ["open up Downloads and", folder("Downloads", "boundary")],
    ["launch downloads and", folder("downloads", "boundary")],
    ["pull up downloads and", folder("downloads", "boundary")],
    ["bring up downloads and", folder("downloads", "boundary")],
    ["go to downloads and", folder("downloads", "boundary")],
    ["take me to downloads and", folder("downloads", "boundary")],
    ["show me downloads and", folder("downloads", "boundary")],
    [
      "switch to downloads and",
      { ...folder("downloads", "boundary"), verb: "switch" },
    ],
    // Sites: the well-known names, spoken and written addresses.
    ["go to google docs and", site("google docs", "boundary")],
    ["open my gmail", site("gmail", "end")],
    ["open Gmail and", site("Gmail", "boundary")],
    ["go to github dot com", site("github.com", "end")],
    ["go to github dot com and", site("github.com", "boundary")],
    ["go to drive dot google dot com", site("drive.google.com", "end")],
    ["go to notion dot so", site("notion.so", "end")],
    ["open github.com", site("github.com", "end")],
    ["open slack.com and", site("slack.com", "boundary")],
    ["open Slack dot com", site("slack.com", "end")],
    ["go to www.GitHub.com/anthropics", site("www.github.com", "more")],
    ["go to github dot com slash nkov", site("github.com", "more")],
    // An address still arriving is undecided; a label that is no domain vetoes.
    ["go to github dot", undefined],
    ["go to github dot foo", undefined],
    ["go to github dot something and", site("github.something", "veto")],
    ["open Notes.app", open("Notes.app", "veto")],
    ["open report.pdf and", open("report.pdf", "veto")],
    // Folders: alone, after "my", or with "folder".
    ["open my downloads", folder("downloads", "end")],
    ["open my downloads folder and", folder("downloads", "boundary")],
    ["open the downloads folder and", folder("downloads", "boundary")],
    ["open downloads folder", folder("downloads", "end")],
    ["go to Desktop", folder("Desktop", "end")],
    ["show me Documents and", folder("Documents", "boundary")],
    // Names.
    ["open App Store and", open("App Store", "boundary")],
    ["open Slack app and", open("Slack", "boundary")],
    ["open the Notes app and", open("Notes", "boundary")],
    ["open the YouTube app and", open("YouTube", "boundary")],
    ["open Visual Studio Code and", open("Visual Studio Code", "boundary")],
    ["open Google Chrome and", open("Google Chrome", "boundary")],
    ["open Wi-Fi settings and", open("Wi-Fi settings", "boundary")],
    // Parsed here; native resolution and policy decide.
    ["open 1Password and", open("1Password", "boundary")],
    ["open settings and", open("settings", "boundary")],
    // No clause: pointers, descriptions, other verbs, too long a name.
    ["open the Notes and", undefined],
    ["open the downloads", undefined],
    ["open the projects folder and", undefined],
    ["show me the desktop", undefined],
    ["Open the Slack message from Dana", undefined],
    ["open the file called notes and", undefined],
    ["open the file report and", undefined],
    ["open a new tab and", undefined],
    ["open my email and", undefined],
    ["open my Slack and", undefined],
    ["Open it and send it to Dana", undefined],
    ["Open that and", undefined],
    ["Open Microsoft Visual Studio Code Insiders and", undefined],
    ["go Safari and", undefined],
    ["take me home and", undefined],
    ["show Slack and", undefined],
    ["Start a timer and", undefined],
    ["Type hello and", undefined],
    ["send Dana a message", undefined],
    ["switch Slack and", undefined],
    ["Open", undefined],
    ["Open the", undefined],
    ["open up", undefined],
    ["go to", undefined],
    ["Hey Butler", undefined],
    ["Butler", undefined],
    ["stop", undefined],
    ["", undefined],
  ];
  it("has a table worth trusting", () =>
    expect(rows.length).toBeGreaterThan(100));
  for (const [text, want] of rows)
    it(JSON.stringify(text), () => {
      const got = leadingClause(text);
      if (!want) expect(got).toBeUndefined();
      else {
        expect(got).toMatchObject(want);
        expect(got!.key).toBe(got!.name.toLowerCase());
      }
    });
  it("names every well-known site and folder", () => {
    for (const name of KNOWN_SITES.keys())
      expect(leadingClause(`go to ${name} and`)).toMatchObject({
        target: "site",
        key: name,
        next: "boundary",
      });
    for (const name of KNOWN_FOLDERS.keys())
      expect(leadingClause(`open ${name}`)).toMatchObject({
        target: "folder",
        key: name,
        next: "end",
      });
  });
  it("never names more than four words or a pointer", () => {
    for (const text of [
      "open alpha beta gamma delta epsilon and",
      "open the thing and",
      "open this and",
      "open her inbox and",
    ])
      expect(leadingClause(text), text).toBeUndefined();
    expect(leadingClause("open alpha beta gamma delta and")?.name).toBe(
      "alpha beta gamma delta",
    );
  });
});

describe("earlyLead", () => {
  it("starts the screenshot only for an early verb", () => {
    for (const text of [
      "Open",
      "open the",
      "launch",
      "Switch to",
      "switch over to",
      "Pull up",
      "bring up",
      "Go to",
      "take me to",
      "show me",
      "can you open",
      "um open",
    ])
      expect(earlyLead(text), text).toBe(true);
    for (const text of [
      "go",
      "take me",
      "show",
      "start",
      "type",
      "send",
      "stop",
      "switch",
      "pull",
      "hey",
      "",
    ])
      expect(earlyLead(text), text).toBe(false);
  });
});

describe("finalKeeps", () => {
  const slack = leadingClause("Open Slack and")!;
  it.each([
    ["Open Slack, and message Dana hi.", true, false],
    ["open slack and message dana", true, false],
    ["Open Slack.", true, true],
    ["Open Slack", true, true],
    ["Open Slack please.", true, true],
    ["Launch Slack and check it", true, false],
    ["Open Slate and message Dana", false, false],
    ["Open Slack no Discord and message Dana", false, false],
    ["Open Slack in Chrome", false, false],
    ["Open Slack's settings", false, false],
    ["open Slack and hey butler open Discord and message Dana", false, false],
    ["Switch to Slack and message Dana", false, false],
    ["message Dana", false, false],
    ["never mind", false, false],
    ["stop", false, false],
  ])("%j keeps=%s exact=%s", (text, keeps, exact) => {
    expect(finalKeeps(slack, text)).toEqual({ keeps, exact });
  });
  it("applies the wake-phrase restart to the final too", () => {
    expect(
      finalKeeps(slack, "open Notes hey butler open Slack and message Dana"),
    ).toEqual({ keeps: true, exact: false });
  });
  it("keeps a site's step for any site, and never as the whole request", () => {
    // The step was the browser: the address is still entered by the run.
    const youtube = leadingClause("go to youtube")!;
    expect(finalKeeps(youtube, "Go to youtube.")).toEqual({
      keeps: true,
      exact: false,
    });
    expect(finalKeeps(youtube, "go to youtube dot com and play lofi")).toEqual({
      keeps: true,
      exact: false,
    });
    expect(finalKeeps(youtube, "open github and")).toEqual({
      keeps: true,
      exact: false,
    });
    expect(finalKeeps(youtube, "open youtube music")).toEqual({
      keeps: false,
      exact: false,
    });
    expect(finalKeeps(youtube, "open the youtube app")).toEqual({
      keeps: false,
      exact: false,
    });
  });
  it("keeps a step settled on the words an app's name begins with when the final names that app", () => {
    const visual = leadingClause("open Visual")!;
    const opened = "visual studio code";
    expect(finalKeeps(visual, "Open Visual Studio Code.", opened)).toEqual({
      keeps: true,
      exact: true,
    });
    expect(
      finalKeeps(visual, "open visual studio code and run the tests", opened),
    ).toEqual({ keeps: true, exact: false });
    expect(finalKeeps(visual, "Open Visual.", opened)).toEqual({
      keeps: true,
      exact: true,
    });
    // Another app whose name begins the same way, or no lookup yet.
    expect(finalKeeps(visual, "open Visual Paradigm", opened)).toEqual({
      keeps: false,
      exact: false,
    });
    expect(finalKeeps(visual, "Open Visual Studio Code.")).toEqual({
      keeps: false,
      exact: false,
    });
  });
  it("keeps a folder only by its name", () => {
    const downloads = leadingClause("open downloads")!;
    expect(finalKeeps(downloads, "Open my downloads folder.")).toEqual({
      keeps: true,
      exact: true,
    });
    expect(finalKeeps(downloads, "open downloads and find the report")).toEqual(
      { keeps: true, exact: false },
    );
    expect(finalKeeps(downloads, "open Desktop")).toEqual({
      keeps: false,
      exact: false,
    });
    expect(finalKeeps(downloads, "open Slack")).toEqual({
      keeps: false,
      exact: false,
    });
  });
});

/** The installed app list as main.ts answers for it: exact, the one name beginning with the words, several, or none. */
function installed(names: string[]): (key: string) => AppMatch {
  return (key) => {
    if (names.includes(key)) return "exact";
    const begins = names.filter((n) => n.startsWith(key + " ")).length;
    return begins === 1 ? "prefix" : begins ? "ambiguous" : "none";
  };
}
/** Feeds timed partials, firing the tracker's timers in order. */
function play(
  steps: [text: string | null, at: number][],
  knownApps?: string[],
) {
  const tracker = new ClauseTracker(knownApps && installed(knownApps));
  const events: (TrackerEvent & { t: number })[] = [];
  let timer: number | undefined;
  const record = (list: TrackerEvent[], t: number) => {
    for (const e of list) {
      events.push({ ...e, t });
      if (e.kind === "timer") timer = e.at;
    }
  };
  for (const [text, at] of steps) {
    // A timer due before this partial fires first.
    if (timer !== undefined && timer <= at) {
      const due = timer;
      timer = undefined;
      record(tracker.tick(due), due);
    }
    if (text !== null) record(tracker.push(text, at), at);
  }
  if (timer !== undefined) record(tracker.tick(timer), timer);
  const kinds = events.filter((e) => e.kind !== "timer");
  return { tracker, events, kinds };
}
const settled = (r: ReturnType<typeof play>) =>
  r.kinds.find((e) => e.kind === "settled") as
    | {
        kind: "settled";
        t: number;
        settle: {
          by: string;
          target: string;
          clause: EarlyClause;
          firstAt: number;
          at: number;
        };
      }
    | undefined;
const closed = (r: ReturnType<typeof play>) =>
  r.kinds.find((e) => e.kind === "closed") as
    { kind: "closed"; code: string; t: number } | undefined;

describe("ClauseTracker", () => {
  it("primes on the first 'open' and settles on two agreeing partials with a boundary", () => {
    const r = play([
      ["Open", 0],
      ["Open Slack", 300],
      ["Open Slack and", 600],
      ["Open Slack and message", 900],
    ]);
    expect(r.kinds.map((e) => [e.kind, e.t])).toEqual([
      ["prime", 0],
      ["settled", 600],
    ]);
    expect(settled(r)!.settle).toMatchObject({
      by: "boundary",
      firstAt: 300,
      at: 600,
      clause: { name: "Slack", next: "boundary" },
    });
  });
  it("settles a lone boundary partial after confirmMs unchanged", () => {
    const r = play([["Open Slack and message Dana", 0]]);
    expect(settled(r)).toMatchObject({ t: EARLY_LIMITS.confirmMs });
    expect(settled(r)!.settle.by).toBe("boundary");
  });
  it("settles at once when the next partial keeps the key", () => {
    const r = play([
      ["Open Slack and message Dana", 0],
      ["Open Slack and message Dana hi", 200],
    ]);
    expect(settled(r)).toMatchObject({ t: 200 });
  });
  it("opens a known app the moment its name is heard, before the boundary", () => {
    // What "open Slack and message Dana" asks for: Slack comes forward while
    // the user is still speaking, not after the "and" is recognized.
    const eager = play(
      [
        ["Open", 0],
        ["Open Slack", 300],
        ["Open Slack and", 600],
      ],
      ["slack"],
    );
    expect(settled(eager)).toMatchObject({ t: 300 });
    expect(settled(eager)!.settle.by).toBe("eager");
    // Only an exact name of an installed app: a half-heard name still waits.
    const half = play(
      [
        ["Open", 0],
        ["Open Slate", 300],
      ],
      ["slack"],
    );
    expect(settled(half)).toMatchObject({ t: 900 });
    expect(settled(half)!.settle.by).toBe("pause");
    // With no app list yet, nothing changes from before.
    const unknown = play([
      ["Open", 0],
      ["Open Slack", 300],
    ]);
    expect(settled(unknown)!.settle.by).toBe("pause");
    expect(settled(unknown)!.settle.target).toBe("app");
  });
  it("opens the one app whose name begins with the words, but waits inside a word", () => {
    // "open Visual…": only Visual Studio Code begins so, so it opens now.
    const one = play(
      [
        ["Open", 0],
        ["Open Visual", 300],
        ["Open Visual Studio", 600],
      ],
      ["visual studio code", "slack"],
    );
    expect(settled(one)).toMatchObject({ t: 300 });
    expect(settled(one)!.settle).toMatchObject({
      by: "eager",
      target: "app",
      clause: { name: "Visual" },
    });
    // Two names begin with it: wait for the rest.
    const two = play(
      [
        ["Open", 0],
        ["Open Visual", 300],
        ["Open Visual Studio Code", 600],
      ],
      ["visual studio code", "visual studio code insiders"],
    );
    expect(settled(two)).toMatchObject({ t: 600 });
    expect(settled(two)!.settle.clause.name).toBe("Visual Studio Code");
    // The name going on as heard never calls the step off; another does.
    expect(closed(one)).toBeUndefined();
    const other = play(
      [
        ["Open Visual", 0],
        ["Open Notes", 300],
      ],
      ["visual studio code"],
    );
    expect(closed(other)).toMatchObject({ code: "veto", t: 300 });
    // A word still being said is no prefix of anything.
    const mid = play(
      [
        ["Open", 0],
        ["Open Vis", 300],
      ],
      ["visual studio code"],
    );
    expect(settled(mid)).toMatchObject({ t: 900, settle: { by: "pause" } });
    // An everyday word never opens what it begins.
    const generic = play([["Open system", 0]], ["system settings"]);
    expect(settled(generic)).toMatchObject({ t: 600, settle: { by: "pause" } });
    // Two letters could begin anything.
    expect(settled(play([["Open Go", 0]], ["go far"]))).toMatchObject({
      settle: { by: "pause" },
    });
  });
  it("goes to a well-known site or a domain the moment it is heard", () => {
    const youtube = play(
      [
        ["Go to", 0],
        ["Go to youtube", 300],
        ["Go to youtube and", 600],
      ],
      ["slack"],
    );
    expect(youtube.kinds.map((e) => [e.kind, e.t])).toEqual([
      ["prime", 0],
      ["settled", 300],
    ]);
    expect(settled(youtube)!.settle).toMatchObject({
      by: "eager",
      target: "site",
      clause: { target: "site", key: "youtube" },
    });
    // A domain is complete with its top-level domain, not before.
    const domain = play([
      ["open notion", 0],
      ["open notion dot", 300],
      ["open notion dot so", 600],
    ]);
    expect(settled(domain)).toMatchObject({ t: 600 });
    expect(settled(domain)!.settle).toMatchObject({
      by: "eager",
      target: "site",
      clause: { key: "notion.so" },
    });
    // Without an app list a site still opens at once: the browser is known.
    expect(settled(play([["go to reddit", 0]]))).toMatchObject({
      t: 0,
      settle: { by: "eager", target: "site" },
    });
  });
  it("waits when a site's name could go on", () => {
    // "google" may become "google docs", "google drive" or Google Chrome.
    const google = play(
      [
        ["Go to", 0],
        ["Go to google", 300],
        ["Go to google docs", 600],
      ],
      ["google chrome"],
    );
    expect(settled(google)).toMatchObject({ t: 600 });
    expect(settled(google)!.settle.clause.key).toBe("google docs");
    // Said alone, it settles on the pause as the site.
    const alone = play([["Go to google", 0]], ["google chrome"]);
    expect(settled(alone)).toMatchObject({
      t: EARLY_LIMITS.pauseMs,
      settle: { by: "pause", target: "site" },
    });
    // "amazon" may become the Amazon Music app.
    const amazon = play(
      [
        ["open amazon", 0],
        ["open amazon music", 300],
      ],
      ["amazon music"],
    );
    expect(settled(amazon)).toMatchObject({
      t: 300,
      settle: { by: "eager", target: "app" },
    });
  });
  it("names an installed app over a site of the same name, never a domain", () => {
    const app = play([["open netflix", 0]], ["netflix"]);
    expect(settled(app)!.settle).toMatchObject({
      by: "eager",
      target: "app",
      clause: { target: "site" },
    });
    const domain = play([["open netflix dot com", 0]], ["netflix"]);
    expect(settled(domain)!.settle.target).toBe("site");
  });
  it("keeps a settled site through a longer address, but not a change of place", () => {
    const grows = play([
      ["go to youtube", 0],
      ["go to youtube dot com", 300],
      ["go to youtube dot com and play", 600],
    ]);
    expect(settled(grows)).toMatchObject({ t: 0 });
    expect(closed(grows)).toBeUndefined();
    const changes = play([
      ["go to youtube", 0],
      ["go to youtube music", 300],
    ]);
    expect(closed(changes)).toMatchObject({ code: "veto", t: 300 });
  });
  it("opens a standard folder the moment it is heard", () => {
    for (const text of [
      "open downloads",
      "open my downloads",
      "go to Desktop",
      "show me the documents folder",
    ])
      expect(settled(play([[text, 0]])), text).toMatchObject({
        t: 0,
        settle: { by: "eager", target: "folder" },
      });
    // "the downloads" may go on to name a page; the folder word decides.
    const the = play([
      ["open the", 0],
      ["open the downloads", 300],
      ["open the downloads folder", 600],
    ]);
    expect(settled(the)).toMatchObject({ t: 600 });
    expect(settled(the)!.settle.clause.key).toBe("downloads");
    // A folder that is also an app's name waits for the words to end.
    const app = play([["open downloads", 0]], ["downloads manager"]);
    expect(settled(app)).toMatchObject({ settle: { by: "pause" } });
  });
  it("never settles a file or folder described rather than named", () => {
    for (const text of [
      "open the file called notes",
      "open the file report",
      "open my email",
      "open the projects folder",
      "show me the desktop",
    ])
      expect(
        settled(
          play([
            [text, 0],
            [null, 5000],
          ]),
        ),
        text,
      ).toBeUndefined();
  });

  it("still calls off a settled step when the user changes their mind before it runs", () => {
    // The step may still be waiting for the screenshot or the app lookup.
    const r = play(
      [
        ["Open Slack", 0],
        ["Open Slack no wait Discord", 200],
      ],
      ["slack"],
    );
    expect(settled(r)).toMatchObject({ t: 0 });
    expect(closed(r)).toMatchObject({ code: "veto", t: 200 });
    // A stop after the settle closes it too.
    const stopped = play(
      [
        ["Open Slack", 0],
        ["stop", 200],
      ],
      ["slack"],
    );
    expect(closed(stopped)).toMatchObject({ code: "control", t: 200 });
    // The same words carrying on never close it.
    const carry = play(
      [
        ["Open Slack", 0],
        ["Open Slack and message Dana", 200],
      ],
      ["slack"],
    );
    expect(closed(carry)).toBeUndefined();
  });

  it("settles on a pause only after pauseMs at the name", () => {
    const r = play([
      ["Open", 0],
      ["Open Slack", 300],
    ]);
    expect(settled(r)).toMatchObject({ t: 900 });
    expect(settled(r)!.settle.by).toBe("pause");
    // A partial inside the window restarts it.
    const later = play([
      ["Open Slack", 0],
      ["Open Slack please", 500],
    ]);
    expect(settled(later)).toMatchObject({ t: 1100 });
  });
  it.each([
    [
      [
        ["Open Slack", 0],
        ["Open Slack's", 250],
        ["Open Slack's settings", 500],
      ],
    ],
    [
      [
        ["Open Slack", 0],
        ["Open Slack or", 300],
      ],
    ],
    [
      [
        ["Open Slack", 0],
        ["Open Slack no Discord", 400],
      ],
    ],
    [
      [
        ["Open Slack and", 0],
        ["Open Slack in", 200],
        ["Open Slack in Chrome", 400],
      ],
    ],
    [
      [
        ["Open Slack", 0],
        ["Open Slack website", 300],
      ],
    ],
  ] as [string, number][][][])("closes the turn on a veto: %j", (steps) => {
    const r = play(steps);
    expect(settled(r)).toBeUndefined();
    expect(closed(r)).toMatchObject({ code: "veto" });
  });
  it("follows a rewritten name and settles the new one", () => {
    const notion = play([
      ["Open Notes", 0],
      ["Open Notion and", 300],
      ["Open Notion and add", 500],
    ]);
    expect(settled(notion)).toMatchObject({ t: 500 });
    expect(settled(notion)!.settle.clause.name).toBe("Notion");
    expect(settled(notion)!.settle.firstAt).toBe(300);
    const slack = play([
      ["Open Slate and", 0],
      ["Open Slack and", 250],
      ["Open Slack and do", 500],
    ]);
    expect(settled(slack)).toMatchObject({ t: 500 });
    expect(settled(slack)!.settle.clause.name).toBe("Slack");
  });
  it("settles once: a later restart never settles again, and calls the step off", () => {
    const r = play([
      ["open Slack and", 0],
      [null, 300],
      ["open Slack and hey butler open Discord and", 900],
      ["open Slack and hey butler open Discord and go", 1200],
    ]);
    // One settle only; the restart asks for another app, so the step is
    // called off (it runs only if it already reached the point of no return).
    expect(r.kinds.map((e) => e.kind)).toEqual(["prime", "settled", "closed"]);
    expect(settled(r)!.settle.clause.name).toBe("Slack");
    expect(closed(r)).toMatchObject({ code: "veto", t: 900 });
  });
  it("applies the wake-phrase restart before reading a partial", () => {
    const r = play([
      ["open Notes hey butler open Slack and", 0],
      ["open Notes hey butler open Slack and ask", 200],
    ]);
    expect(settled(r)!.settle.clause.name).toBe("Slack");
  });
  it("primes for a pointer but never settles it", () => {
    const r = play([
      ["Open the", 0],
      ["Open the Slack message from Dana", 400],
    ]);
    expect(r.kinds.map((e) => e.kind)).toEqual(["prime"]);
  });
  it("names the app after 'the … app'", () => {
    const r = play([
      ["Open the Notes app and", 0],
      ["Open the Notes app and add milk", 300],
    ]);
    expect(settled(r)!.settle.clause.name).toBe("Notes");
    const sw = play([
      ["Switch to Safari and", 0],
      ["Switch to Safari and search", 250],
    ]);
    expect(settled(sw)!.settle.clause).toMatchObject({
      verb: "switch",
      name: "Safari",
    });
  });
  it("never primes for other verbs, the wake phrase or a stop", () => {
    for (const text of [
      "Go home and",
      "Start a timer and",
      "Type hello and",
      "Hey Butler",
      "Butler",
    ])
      expect(
        play([
          [text, 0],
          [`${text} x`, 300],
        ]).kinds,
        text,
      ).toEqual([]);
    for (const text of ["stop", "wait", "cancel that"])
      expect(closed(play([[text, 0]])), text).toMatchObject({
        code: "control",
      });
  });
  it("skips fillers", () => {
    const r = play([
      ["um open uh Slack and", 0],
      ["um open uh Slack and ask", 300],
    ]);
    expect(settled(r)).toMatchObject({ t: 300 });
  });
  it("closes on a credential before it settles", () => {
    const r = play([
      ["Open Slack and type password: hunter2x9", 0],
      ["Open Slack and type password: hunter2x9 now", 100],
    ]);
    expect(closed(r)).toMatchObject({ code: "secret" });
    expect(settled(r)).toBeUndefined();
  });
  it("never settles words that trail off after the name", () => {
    expect(
      settled(
        play([
          ["Open Slack the", 0],
          [null, 5000],
        ]),
      ),
    ).toBeUndefined();
    expect(
      settled(
        play([
          ["Open Slack—", 0],
          [null, 5000],
        ]),
      ),
    ).toBeUndefined();
  });
  it("primes once and settles once per turn", () => {
    const tracker = new ClauseTracker();
    const all = [
      ...tracker.push("Open", 0),
      ...tracker.push("Open Slack and", 100),
      ...tracker.push("Open Slack and go", 200),
      ...tracker.push("Open Slack and go on", 300),
      ...tracker.tick(10_000),
    ];
    expect(all.filter((e) => e.kind === "prime")).toHaveLength(1);
    expect(all.filter((e) => e.kind === "settled")).toHaveLength(1);
  });
});
