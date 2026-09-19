import { describe, expect, it } from "vitest";
import fixture from "./fixtures/partial-timelines.json";
import {
  STREAM_LIMITS,
  clausesOf,
  createClauseStream,
  type Clause,
  type ClauseEvent,
} from "../src/voice/stream";
import {
  decideFast,
  type FastAction,
  type FastContext,
} from "../src/voice/fast";

/** The clauses of a text as [text, startWord, endWord]. */
const cut = (text: string) =>
  clausesOf(text).map((c) => [c.text, c.startWord, c.endWord]);

/** Push words one at a time, `gapMs` apart, and collect every event with the word index that produced it. */
function speak(words: string[], gapMs = 150, from = 0) {
  const stream = createClauseStream();
  const events: { word: number; event: ClauseEvent }[] = [];
  for (let i = 0; i < words.length; i++)
    for (const event of stream.push({
      text: words.slice(0, i + 1).join(" "),
      atMs: from + i * gapMs,
    }))
      events.push({ word: i, event });
  return { stream, events, last: from + (words.length - 1) * gapMs };
}
const committed = (events: { word: number; event: ClauseEvent }[]) =>
  events.filter((e) => e.event.kind === "committed") as {
    word: number;
    event: Extract<ClauseEvent, { kind: "committed" }>;
  }[];

describe("segmentation", () => {
  it("cuts at connectors followed by a clause and at a second imperative verb", () => {
    expect(cut("go to youtube and play a midwest safety video")).toEqual([
      ["go to youtube", 0, 3],
      ["play a midwest safety video", 4, 9],
    ]);
    expect(cut("open slack then check mail")).toEqual([
      ["open slack", 0, 2],
      ["check mail", 3, 5],
    ]);
    expect(cut("open slack and then check mail")).toEqual([
      ["open slack", 0, 2],
      ["check mail", 4, 6],
    ]);
    expect(cut("open slack after that check mail")).toEqual([
      ["open slack", 0, 2],
      ["check mail", 4, 6],
    ]);
    expect(cut("open slack also check mail")).toEqual([
      ["open slack", 0, 2],
      ["check mail", 3, 5],
    ]);
    expect(cut("open Slack, message Dana; then check mail.")).toEqual([
      ["open Slack", 0, 2],
      ["message Dana", 2, 4],
      ["check mail", 5, 7],
    ]);
    expect(cut("open slack and scroll down")).toEqual([
      ["open slack", 0, 2],
      ["scroll down", 3, 5],
    ]);
    expect(cut("open slack and please open notes")).toEqual([
      ["open slack", 0, 2],
      ["please open notes", 3, 6],
    ]);
    expect(cut("open slack so i can reply")).toEqual([
      ["open slack so i can reply", 0, 6],
    ]);
    // A second verb with no connector.
    expect(cut("open youtube play midwest safety")).toEqual([
      ["open youtube", 0, 2],
      ["play midwest safety", 2, 5],
    ]);
    expect(cut("go to slack show me the general channel")).toEqual([
      ["go to slack", 0, 3],
      ["show me the general channel", 3, 8],
    ]);
    expect(cut("search for cats open notes")).toEqual([
      ["search for cats", 0, 3],
      ["open notes", 3, 5],
    ]);
    expect(cut("open notes scroll down")).toEqual([
      ["open notes", 0, 2],
      ["scroll down", 2, 4],
    ]);
  });

  it("keeps an 'and' inside an object, a verb inside an object and a verb after a preposition", () => {
    expect(cut("search for salt and pepper")).toEqual([
      ["search for salt and pepper", 0, 5],
    ]);
    expect(cut("compute two plus two")).toEqual([
      ["compute two plus two", 0, 4],
    ]);
    expect(cut("play the daily show")).toEqual([["play the daily show", 0, 4]]);
    expect(cut("search for how to open a jar")).toEqual([
      ["search for how to open a jar", 0, 7],
    ]);
    expect(cut("click the open tab")).toEqual([["click the open tab", 0, 4]]);
    expect(cut("search for restaurants close to me")).toEqual([
      ["search for restaurants close to me", 0, 6],
    ]);
    expect(cut("play wait for it")).toEqual([["play wait for it", 0, 4]]);
    expect(cut("search for dr no and cats")).toEqual([
      ["search for dr no and cats", 0, 6],
    ]);
  });

  it("drops fillers, a leading connector and the wake phrase; word offsets index the recognizer's words", () => {
    expect(cut("um go to uh youtube and um play a video")).toEqual([
      ["go to youtube", 1, 5],
      ["play a video", 7, 10],
    ]);
    expect(cut("and open slack")).toEqual([["open slack", 1, 3]]);
    expect(cut("Hey Butler, open Slack, and message Dana")).toEqual([
      ["open Slack", 0, 2],
      ["message Dana", 3, 5],
    ]);
    // A wake phrase said again starts the request over (restartedTurn).
    expect(cut("open calendar hey butler open notes and scroll down")).toEqual([
      ["open notes", 0, 2],
      ["scroll down", 3, 5],
    ]);
    expect(cut("")).toEqual([]);
    expect(cut("um uh")).toEqual([]);
  });

  it("treats a correction followed by a verb as replacing the clause before it", () => {
    expect(cut("go to youtube no go to gmail")).toEqual([
      ["go to gmail", 4, 7],
    ]);
    expect(cut("go to youtube actually go to gmail")).toEqual([
      ["go to gmail", 4, 7],
    ]);
    expect(cut("open slack and play the no play midwest safety")).toEqual([
      ["open slack", 0, 2],
      ["play midwest safety", 6, 9],
    ]);
    expect(cut("go to youtube never mind open slack")).toEqual([
      ["open slack", 5, 7],
    ]);
    expect(cut("go to youtube scratch that open slack")).toEqual([
      ["open slack", 5, 7],
    ]);
  });

  it("leaves a trailing connector or correction out of a partial until the next word says what it is, and in a final keeps it", () => {
    const partial = (text: string) => {
      const stream = createClauseStream();
      stream.push({ text, atMs: 0 });
      return stream.clauses().map((c) => [c.text, c.startWord, c.endWord]);
    };
    expect(partial("go to youtube and")).toEqual([["go to youtube", 0, 3]]);
    expect(partial("go to youtube no")).toEqual([["go to youtube", 0, 3]]);
    expect(partial("go to youtube and then")).toEqual([
      ["go to youtube", 0, 3],
    ]);
    expect(partial("search for dr")).toEqual([["search for dr", 0, 3]]);
    expect(cut("search for dr no")).toEqual([["search for dr no", 0, 4]]);
    expect(cut("go to youtube and")).toEqual([["go to youtube and", 0, 4]]);
  });
});

describe("commits", () => {
  it("commits by boundary the moment the next clause's first content word arrives", () => {
    const { events } = speak(
      "go to youtube and play a midwest safety video".split(" "),
    );
    const commits = committed(events);
    expect(commits).toHaveLength(1);
    expect(commits[0].word).toBe(4); // "play"
    expect(commits[0].event.by).toBe("boundary");
    expect(commits[0].event.clause).toEqual({
      index: 0,
      text: "go to youtube",
      startWord: 0,
      endWord: 3,
      state: "committed",
      committedAtMs: 600,
    });
  });

  it("does not commit by boundary on the connector alone, nor on a lead after it", () => {
    const { events } = speak("open slack and then please".split(" "), 80);
    expect(committed(events)).toEqual([]);
  });

  it("commits by stability after stableMs unchanged when the clause is verb + object", () => {
    const stream = createClauseStream();
    expect(stream.push({ text: "go to youtube", atMs: 300 })).toEqual([]);
    // Unchanged, but not for long enough.
    expect(
      stream.push({
        text: "go to youtube",
        atMs: 300 + STREAM_LIMITS.stableMs - 1,
      }),
    ).toEqual([]);
    const events = stream.push({
      text: "go to youtube",
      atMs: 300 + STREAM_LIMITS.stableMs,
    });
    expect(events).toEqual([
      {
        kind: "committed",
        by: "stable",
        clause: {
          index: 0,
          text: "go to youtube",
          startWord: 0,
          endWord: 3,
          state: "committed",
          committedAtMs: 650,
        },
      },
    ]);
    // Committed once: the same words again are no event.
    expect(stream.push({ text: "go to youtube", atMs: 2000 })).toEqual([]);
    expect(stream.clauses()[0].state).toBe("committed");
  });

  it("counts stability from the clause's own last change, not from the trailing connector", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to youtube", atMs: 300 });
    stream.push({ text: "go to youtube and", atMs: 480 });
    const events = stream.push({ text: "go to youtube and", atMs: 660 });
    expect(events.map((e) => e.kind)).toEqual(["committed"]);
  });

  it("never commits by stability a clause with no verb, a verb alone, or a lone determiner for an object", () => {
    for (const text of [
      "the one on the right",
      "scroll",
      "play the",
      "send it",
      "youtube",
    ]) {
      const stream = createClauseStream();
      stream.push({ text, atMs: 0 });
      expect(stream.push({ text, atMs: 5000 })).toEqual([]);
    }
    // ...but a verb phrase with a real object does, leads skipped.
    for (const text of [
      "scroll down",
      "please open slack",
      "can you go to youtube",
    ]) {
      const stream = createClauseStream();
      stream.push({ text, atMs: 0 });
      expect(stream.push({ text, atMs: 5000 }).map((e) => e.kind)).toEqual([
        "committed",
      ]);
    }
  });

  it("reports only the events since the last push", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to youtube and play", atMs: 0 });
    expect(
      stream.push({ text: "go to youtube and play a", atMs: 100 }),
    ).toEqual([]);
  });
});

describe("supersede", () => {
  it("supersedes a committed clause whose words the recognizer changed and recommits the replacement", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to you too", atMs: 0 });
    stream.push({ text: "go to you too", atMs: 400 });
    const events = stream.push({ text: "go to youtube and play", atMs: 500 });
    expect(events).toEqual([
      {
        kind: "superseded",
        clause: {
          index: 0,
          text: "go to you too",
          startWord: 0,
          endWord: 4,
          state: "superseded",
          committedAtMs: 400,
        },
        replacement: {
          index: 0,
          text: "go to youtube",
          startWord: 0,
          endWord: 3,
          state: "growing",
        },
      },
      {
        kind: "committed",
        by: "boundary",
        clause: {
          index: 0,
          text: "go to youtube",
          startWord: 0,
          endWord: 3,
          state: "committed",
          committedAtMs: 500,
        },
      },
    ]);
  });

  it("does not supersede for case or punctuation", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to youtube and play", atMs: 0 });
    expect(stream.push({ text: "Go to YouTube, and play", atMs: 100 })).toEqual(
      [],
    );
    expect(
      stream.push({ text: "Go to YouTube. And play a", atMs: 200 }),
    ).toEqual([]);
    expect(stream.clauses()[0].state).toBe("committed");
  });

  it("supersedes when a committed clause grows, so a stale action can be replaced", () => {
    const stream = createClauseStream();
    stream.push({ text: "play a midwest", atMs: 0 });
    stream.push({ text: "play a midwest", atMs: 400 });
    const events = stream.push({ text: "play a midwest safety", atMs: 450 });
    expect(events.map((e) => e.kind)).toEqual(["superseded"]);
    expect(stream.clauses()[0]).toMatchObject({
      text: "play a midwest safety",
      state: "growing",
    });
  });

  it("supersedes a committed clause the rewrite removed, with what stands last as its replacement", () => {
    const stream = createClauseStream();
    stream.push({ text: "open slack and play music", atMs: 0 });
    stream.push({ text: "open slack and play music", atMs: 400 });
    expect(stream.clauses().map((c) => c.state)).toEqual([
      "committed",
      "committed",
    ]);
    const events = stream.push({ text: "open slack", atMs: 500 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "superseded",
      clause: { index: 1, text: "play music", state: "superseded" },
      replacement: { index: 0, text: "open slack", state: "committed" },
    });
    // The partial emptied altogether: an empty growing clause stands in.
    const gone = stream.push({ text: "", atMs: 600 });
    expect(gone).toEqual([
      {
        kind: "superseded",
        clause: {
          index: 0,
          text: "open slack",
          startWord: 0,
          endWord: 2,
          state: "superseded",
          committedAtMs: 0,
        },
        replacement: {
          index: 0,
          text: "",
          startWord: 0,
          endWord: 0,
          state: "growing",
        },
      },
    ]);
    expect(stream.clauses()).toEqual([]);
  });

  it("a spoken correction supersedes the committed clause with the clause that replaces it", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to youtube", atMs: 0 });
    stream.push({ text: "go to youtube", atMs: 400 });
    expect(stream.push({ text: "go to youtube no", atMs: 500 })).toEqual([]);
    const events = stream.push({ text: "go to youtube no go", atMs: 650 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "superseded",
      clause: { text: "go to youtube", state: "superseded" },
      replacement: { index: 0, text: "go", startWord: 4, endWord: 5 },
    });
  });
});

describe("final", () => {
  it("keeps a committed clause the final still says whole, in order, and reports the final's clauses", () => {
    const { stream } = speak(
      "go to youtube and play a midwest safety".split(" "),
    );
    stream.push({
      text: "go to youtube and play a midwest safety",
      atMs: 1500,
    });
    const events = stream.final(
      "Go to YouTube and play a Midwest Safety video.",
      2300,
    );
    expect(events).toHaveLength(1);
    const final = events[0] as Extract<ClauseEvent, { kind: "final" }>;
    expect(final.dropped).toEqual([]);
    expect(final.clauses.map((c) => c.text)).toEqual([
      "Go to YouTube",
      "play a Midwest Safety video",
    ]);
    expect(final.clauses.map((c) => c.state)).toEqual([
      "committed",
      "committed",
    ]);
    // A clause the final carries keeps the time it committed at.
    expect(final.clauses[0].committedAtMs).toBe(600);
    expect(final.clauses[1].committedAtMs).toBe(1500);
    expect(stream.clauses()).toEqual(final.clauses);
  });

  it("drops a committed clause the final no longer contains", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to youtube and play music", atMs: 0 });
    stream.push({ text: "go to youtube and play music", atMs: 400 });
    const [final] = stream.final("go to youtube", 2000) as Extract<
      ClauseEvent,
      { kind: "final" }
    >[];
    expect(final.clauses.map((c) => c.text)).toEqual(["go to youtube"]);
    expect(final.dropped).toEqual([
      {
        index: 1,
        text: "play music",
        startWord: 4,
        endWord: 6,
        state: "committed",
        committedAtMs: 400,
      },
    ]);
  });

  it("drops a committed clause whose words the final says differently, and a superseded one is not reported twice", () => {
    const stream = createClauseStream();
    stream.push({ text: "go to you too and play", atMs: 0 });
    stream.push({ text: "go to youtube and play", atMs: 100 });
    const [final] = stream.final("go to youtube and play", 2000) as Extract<
      ClauseEvent,
      { kind: "final" }
    >[];
    expect(final.dropped).toEqual([]);
    const other = createClauseStream();
    other.push({ text: "go to you too and play", atMs: 0 });
    const [second] = other.final("go to youtube and play", 2000) as Extract<
      ClauseEvent,
      { kind: "final" }
    >[];
    expect(second.dropped.map((c) => c.text)).toEqual(["go to you too"]);
  });

  it("segments the final with the same rules, so a corrected clause is one clause", () => {
    const stream = createClauseStream();
    const [final] = stream.final(
      "go to youtube no go to gmail",
      1000,
    ) as Extract<ClauseEvent, { kind: "final" }>[];
    expect(final.clauses.map((c) => c.text)).toEqual(["go to gmail"]);
    expect(final.dropped).toEqual([]);
  });

  it("accepts nothing after the final", () => {
    const stream = createClauseStream();
    stream.final("open slack", 100);
    expect(stream.push({ text: "open slack and", atMs: 200 })).toEqual([]);
    expect(stream.final("open slack and play", 300)).toEqual([]);
    expect(stream.clauses().map((c) => c.text)).toEqual(["open slack"]);
  });
});

describe("clausesOf", () => {
  it("gives the clauses of a finished text, all committed at the time given", () => {
    expect(clausesOf("open slack and scroll down", 7)).toEqual([
      {
        index: 0,
        text: "open slack",
        startWord: 0,
        endWord: 2,
        state: "committed",
        committedAtMs: 7,
      },
      {
        index: 1,
        text: "scroll down",
        startWord: 3,
        endWord: 5,
        state: "committed",
        committedAtMs: 7,
      },
    ]);
  });
});

// The simulator over the shared fixture --------------------------------------

interface Timeline {
  about?: string;
  id: string;
  ctx: FastContext;
  samples: { text: string; atMs: number }[];
  final: { text: string; atMs: number };
  expect: {
    commits: { index: number; text: string; by: string; atSample: number }[];
    superseded: { index: number; atSample: number }[];
    actions: Record<string, unknown>[];
    finalClauses: string[];
    finalActions: Record<string, unknown>[];
    dropped: string[];
  };
}
/** An action as the fixture records it: the label is the pill's, not the measurement's. */
const flat = (index: number, action: FastAction) => {
  const { label: _label, ...rest } = action as FastAction & { label?: string };
  return { index, ...rest };
};

/** Drive the stream and the decider the way the executor would. */
function simulate(t: Timeline) {
  const stream = createClauseStream();
  const ctx: FastContext = {
    ...t.ctx,
    protectedHosts: [...t.ctx.protectedHosts],
  };
  const commits: Timeline["expect"]["commits"] = [];
  const superseded: Timeline["expect"]["superseded"] = [];
  const actions: Record<string, unknown>[] = [];
  // The executor issues a clause's action once: a replacement that decides
  // to the same action as the last one issued for its index is a repeat.
  const issued = new Map<number, string>();
  const issue = (
    index: number,
    action: FastAction,
    into: Record<string, unknown>[],
  ) => {
    const key = JSON.stringify(action);
    if (issued.get(index) === key) return;
    issued.set(index, key);
    into.push(flat(index, action));
    if (action.kind === "open_url")
      ctx.frontHost = new URL(action.url).hostname;
  };
  t.samples.forEach((sample, atSample) => {
    for (const event of stream.push(sample)) {
      if (event.kind === "superseded")
        superseded.push({ index: event.clause.index, atSample });
      if (event.kind !== "committed") continue;
      commits.push({
        index: event.clause.index,
        text: event.clause.text,
        by: event.by,
        atSample,
      });
      issue(event.clause.index, decideFast(event.clause, ctx), actions);
    }
  });
  const [final] = stream.final(t.final.text, t.final.atMs) as Extract<
    ClauseEvent,
    { kind: "final" }
  >[];
  // A final clause that carried a committed clause keeps its commit time;
  // one committed only now is decided now.
  const finalActions: Record<string, unknown>[] = [];
  for (const c of final.clauses)
    if (c.committedAtMs === t.final.atMs)
      issue(c.index, decideFast(c, ctx), finalActions);
  return {
    commits,
    superseded,
    actions,
    finalClauses: final.clauses.map((c) => c.text),
    finalActions,
    dropped: final.dropped.map((c) => c.text),
  };
}

describe("partial timelines (tests/fixtures/partial-timelines.json)", () => {
  const timelines = fixture.timelines as Timeline[];
  it("has the cases the design names", () => {
    expect(timelines.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        "owner-youtube",
        "recognizer-rewrite",
        "consequential-clause",
        "protected-host",
        "fragment",
        "spoken-correction",
      ]),
    );
    // Words 60–200 ms apart, the recognizer's pace; a re-push repeats the text.
    for (const t of timelines)
      t.samples.forEach((s, i) => {
        if (!i) return;
        const gap = s.atMs - t.samples[i - 1].atMs;
        expect(gap).toBeGreaterThan(0);
        if (s.text !== t.samples[i - 1].text && !t.about?.includes("rewrite"))
          expect(gap).toBeLessThanOrEqual(400);
      });
  });
  for (const t of timelines)
    it(`${t.id}: commits, actions and the final as expected`, () => {
      expect(simulate(t)).toEqual(t.expect);
    });

  it("owner-youtube: YouTube on the word 'play' (word 4), the results on stability before 'video'", () => {
    const t = timelines.find((x) => x.id === "owner-youtube")!;
    const out = simulate(t);
    const playAt = t.samples.findIndex((s) => s.text.endsWith(" play"));
    expect(out.commits[0]).toMatchObject({
      index: 0,
      atSample: playAt,
      by: "boundary",
    });
    expect(t.samples[playAt].text.split(" ").length - 1).toBe(4);
    const videoAt = t.samples.findIndex((s) => s.text.endsWith(" video"));
    expect(out.commits[1].atSample).toBeLessThan(videoAt);
    expect(out.actions[1]).toMatchObject({
      url: "https://www.youtube.com/results?search_query=midwest%20safety",
    });
  });
});
