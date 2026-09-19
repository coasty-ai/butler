import { describe, expect, it } from "vitest";
import {
  ClauseTracker,
  EARLY_LIMITS,
  earlyLead,
  finalKeeps,
  leadingClause,
  type EarlyClause,
  type TrackerEvent,
} from "../src/voice/early";

type Row = [text: string, clause: Partial<EarlyClause> | undefined];
const open = (name: string, next: EarlyClause["next"]) => ({
  verb: "open" as const,
  name,
  next,
});
const sw = (name: string, next: EarlyClause["next"]) => ({
  verb: "switch" as const,
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
    ["open Slack dot com", open("Slack", "veto")],
    ["open slack.com and", open("slack.com", "veto")],
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
    ["um open uh Slack and", open("Slack", "boundary")],
    // Every early verb.
    ["open up Slack and", open("Slack", "boundary")],
    ["launch Slack and", open("Slack", "boundary")],
    ["pull up Notes and", open("Notes", "boundary")],
    ["bring up Calendar then", open("Calendar", "boundary")],
    ["Switch to Safari and", sw("Safari", "boundary")],
    ["switch over to Safari and", sw("Safari", "boundary")],
    // Names.
    ["open App Store and", open("App Store", "boundary")],
    ["open Slack app and", open("Slack", "boundary")],
    ["open the Notes app and", open("Notes", "boundary")],
    ["open Visual Studio Code and", open("Visual Studio Code", "boundary")],
    ["open Google Chrome and", open("Google Chrome", "boundary")],
    ["open Wi-Fi settings and", open("Wi-Fi settings", "boundary")],
    // Parsed here; native resolution and policy decide.
    ["open 1Password and", open("1Password", "boundary")],
    ["open settings and", open("settings", "boundary")],
    ["open Gmail and", open("Gmail", "boundary")],
    // No clause: pointers, descriptions, other verbs, too long a name.
    ["open the Notes and", undefined],
    ["Open the Slack message from Dana", undefined],
    ["open a new tab and", undefined],
    ["open my email and", undefined],
    ["Open it and send it to Dana", undefined],
    ["Open that and", undefined],
    ["Open Microsoft Visual Studio Code Insiders and", undefined],
    ["go to Safari and", undefined],
    ["Go to YouTube and", undefined],
    ["Start a timer and", undefined],
    ["Type hello and", undefined],
    ["send Dana a message", undefined],
    ["switch Slack and", undefined],
    ["Open", undefined],
    ["Open the", undefined],
    ["open up", undefined],
    ["Hey Butler", undefined],
    ["stop", undefined],
    ["", undefined],
  ];
  it("has a table worth trusting", () =>
    expect(rows.length).toBeGreaterThan(40));
  for (const [text, want] of rows)
    it(JSON.stringify(text), () => {
      const got = leadingClause(text);
      if (!want) expect(got).toBeUndefined();
      else {
        expect(got).toMatchObject(want);
        expect(got!.key).toBe(got!.name.toLowerCase());
      }
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
      "can you open",
      "um open",
    ])
      expect(earlyLead(text), text).toBe(true);
    for (const text of [
      "go",
      "Go to",
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
});

/** Feeds timed partials, firing the tracker's timers in order. */
function play(
  steps: [text: string | null, at: number][],
  knownApps?: string[],
) {
  const tracker = new ClauseTracker(
    knownApps && ((key) => knownApps.includes(key)),
  );
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
      "Go to YouTube and",
      "Start a timer and",
      "Type hello and",
      "Hey Butler",
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
