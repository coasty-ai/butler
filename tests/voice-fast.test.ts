import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLAUSE_ACTS,
  CLAUSE_QUESTION,
  JEV_CLAUSE_MIN_P,
  clauseOf,
  clauseState,
  decideFast,
  decideFastWithJev,
  hostProtected,
  type FastAction,
  type FastContext,
  type FastNone,
  type JevAnswer,
  type JevClient,
  type JevQuestion,
} from "../src/voice/fast";
import { clausesOf } from "../src/voice/stream";
import { consequential, irreversible } from "../src/core/policy";
import { defaultSettings } from "../src/core/schema";
import type { ChoiceAnswer, JevChoiceQuestion } from "../src/providers/jev";
import {
  JEV_CLAUSE_QUESTION_ID,
  createJevClauseClient,
  type JevClauseResult,
  type JevClient as ProvidersJevClient,
} from "../src/providers/jev-clause";
import { DECISIONS_ENDPOINT, JEV_MODEL } from "../src/providers/jev";

const root = fileURLToPath(new URL("..", import.meta.url));
const ctx = (o: Partial<FastContext> = {}): FastContext => ({
  protectedHosts: [...defaultSettings.protectedDomains],
  ...o,
});
const decide = (text: string, c: FastContext = ctx()): FastAction =>
  decideFast(clauseOf(text), c);
const none = (reason: FastNone) => ({ kind: "none", reason });
const url = (siteKey: string, url: string) =>
  expect.objectContaining({ kind: "open_url", siteKey, url });

// The types S2 imports are one shape: a client written against the wire types
// serves the decider, and the decider's question is a wire question.
const wireQuestion: JevChoiceQuestion = CLAUSE_QUESTION;
const wireAnswer: ChoiceAnswer = {} as JevAnswer;
const backAgain: JevAnswer = {} as ChoiceAnswer;
const fromProviders: JevClient = {} as ProvidersJevClient;
const toProviders: ProvidersJevClient = {} as JevClient;
void [wireQuestion, wireAnswer, backAgain, fromProviders, toProviders];

describe("decideFast: the owner's sentence", () => {
  it("opens YouTube's front page for 'go to youtube'", () => {
    expect(decide("go to youtube")).toEqual({
      kind: "open_url",
      url: "https://www.youtube.com/",
      siteKey: "youtube",
      label: "YouTube",
    });
    expect(decide("Go to YouTube")).toEqual(decide("go to youtube"));
    expect(decide("open youtube")).toEqual(decide("go to youtube"));
  });

  it("loads the results for 'midwest safety' once the browser is on YouTube, 'video' dropped", () => {
    const onYouTube = ctx({ frontHost: "www.youtube.com" });
    const results = {
      kind: "open_url",
      url: "https://www.youtube.com/results?search_query=midwest%20safety",
      siteKey: "youtube",
      label: "YouTube search for midwest safety",
    };
    expect(decide("play a midwest safety", onYouTube)).toEqual(results);
    expect(decide("play a midwest safety video", onYouTube)).toEqual(results);
    expect(
      decide(
        "play a midwest safety video",
        ctx({ frontHost: "m.youtube.com" }),
      ),
    ).toEqual(results);
    // The site said in the clause needs no front host.
    expect(decide("play a midwest safety video on youtube")).toEqual(results);
    expect(decide("play midwest safety videos on youtube")).toEqual(results);
    // Without either, the rules alone cannot say where to play it.
    expect(decide("play a midwest safety")).toEqual(none("unsure"));
  });

  it("reads 'go to youtube midwest safety channel' as the site and what to look up there", () => {
    expect(decide("go to youtube midwest safety channel")).toEqual(
      url(
        "youtube",
        "https://www.youtube.com/results?search_query=midwest%20safety%20channel",
      ),
    );
  });
});

describe("decideFast: never a fast action", () => {
  it("refuses any clause with a consequential or irreversible word, connector or not", () => {
    for (const text of [
      "and send it",
      "send it",
      "send the email",
      "pay the invoice",
      "delete the file",
      "share it on twitter",
      "buy headphones on amazon",
      "order a pizza",
      "call mom",
      "sign in to github",
      "search google for how to delete my account",
      "play call me maybe on youtube",
    ]) {
      expect(consequential.test(text) || irreversible.test(text)).toBe(true);
      expect(decide(text), text).toEqual(none("not_navigational"));
    }
  });

  it("refuses a protected host wherever it comes from", () => {
    expect(decide("go to paypal.com")).toEqual(none("protected"));
    expect(decide("go to paypal dot com")).toEqual(none("protected"));
    expect(decide("open www.chase.com")).toEqual(none("protected"));
    expect(decide("go to login.gov")).toEqual(none("protected"));
    // With nothing protected the same words open the site.
    expect(decide("go to paypal.com", ctx({ protectedHosts: [] }))).toEqual({
      kind: "open_url",
      url: "https://paypal.com/",
      siteKey: "paypal.com",
      label: "paypal.com",
    });
    // A recipe site on the list is refused for its front page and its search.
    const protectedYouTube = ctx({ protectedHosts: ["youtube.com"] });
    expect(decide("go to youtube", protectedYouTube)).toEqual(
      none("protected"),
    );
    expect(decide("play cats on youtube", protectedYouTube)).toEqual(
      none("protected"),
    );
    expect(
      decide("play cats", {
        ...protectedYouTube,
        frontHost: "www.youtube.com",
      }),
    ).toEqual(none("protected"));
  });

  it("mirrors the policy's suffix rule for protected hosts", () => {
    expect(hostProtected("paypal.com", ["paypal.com"])).toBe(true);
    expect(hostProtected("www.PayPal.com", ["paypal.com"])).toBe(true);
    expect(hostProtected("notpaypal.com", ["paypal.com"])).toBe(false);
    expect(hostProtected("paypal.com.evil.io", ["paypal.com"])).toBe(false);
    expect(hostProtected("x.com", [])).toBe(false);
  });

  it("waits for the final on a credential, an '@' or a host in the query", () => {
    expect(decide("search google for sk-abcdefghijklmnopqrst")).toEqual(
      none("needs_final"),
    );
    expect(decide("search google for me@example.com")).toEqual(
      none("needs_final"),
    );
    expect(decide("search google for paypal.com")).toEqual(none("needs_final"));
    expect(decide("search google for https://example.com/x")).toEqual(
      none("needs_final"),
    );
    expect(decide("search for AKIAABCDEFGHIJKLMNOP on google")).toEqual(
      none("needs_final"),
    );
  });

  it("refuses pointers, fragments, questions, typing, clicking and keys", () => {
    for (const text of [
      "the one on the right",
      "that one",
      "it",
      "what is the weather",
      "type hello world",
      "write a note",
      "click the button",
      "press return",
      "hit enter",
      "select all",
      "compose an email",
      "check my balance",
    ])
      expect(decide(text), text).toEqual(none("not_navigational"));
    expect(decide("")).toEqual(none("needs_final"));
    expect(decide("um")).toEqual(none("needs_final"));
  });

  it("refuses stops, pauses, undo, approvals and scroll steering", () => {
    for (const text of [
      "stop",
      "cancel",
      "wait a second",
      "undo that",
      "yes",
      "no",
      "never mind",
      "stop scrolling",
      "faster",
      "slower",
    ])
      expect(decide(text), text).toEqual(none("not_navigational"));
  });

  it("refuses folders (the early start's own step) and generic app names", () => {
    expect(decide("open downloads")).toEqual(none("not_navigational"));
    expect(decide("open my desktop folder")).toEqual(none("not_navigational"));
    expect(decide("open settings")).toEqual(none("ambiguous"));
    expect(decide("open mail")).toEqual(none("ambiguous"));
  });
});

describe("decideFast: the early rules", () => {
  it("opens an application by the name heard", () => {
    expect(decide("open slack")).toEqual({ kind: "open_app", name: "slack" });
    expect(decide("Open Slack")).toEqual({ kind: "open_app", name: "Slack" });
    expect(decide("launch Visual Studio Code")).toEqual({
      kind: "open_app",
      name: "Visual Studio Code",
    });
    expect(decide("switch to Notes")).toEqual({
      kind: "open_app",
      name: "Notes",
    });
    expect(decide("open the notes app")).toEqual({
      kind: "open_app",
      name: "notes",
    });
    expect(decide("please open slack")).toEqual({
      kind: "open_app",
      name: "slack",
    });
    // A boundary in the clause text does not matter: the words before it decide.
    expect(decide("open Slack and scroll down")).toEqual({
      kind: "open_app",
      name: "Slack",
    });
  });

  it("opens a known site's or a spoken domain's front page, recipe hosts by their recipe", () => {
    expect(decide("go to github dot com")).toEqual(
      url("github", "https://github.com/"),
    );
    expect(decide("go to gmail")).toEqual(
      url("gmail", "https://mail.google.com/"),
    );
    expect(decide("open twitter")).toEqual(url("x", "https://x.com/"));
    expect(decide("open wikipedia")).toEqual(
      url("wikipedia", "https://en.wikipedia.org/"),
    );
    expect(decide("go to linkedin")).toEqual(
      url("linkedin.com", "https://linkedin.com/"),
    );
    expect(decide("go to notion.so")).toEqual(
      url("notion.so", "https://notion.so/"),
    );
    expect(decide("take me to reddit")).toEqual(
      url("reddit", "https://www.reddit.com/"),
    );
  });

  it("opens a recipe application named as an app", () => {
    expect(decide("open spotify")).toEqual({
      kind: "open_app",
      name: "Spotify",
    });
    expect(decide("open the app store")).toEqual({
      kind: "open_app",
      name: "App Store",
    });
    expect(decide("play something on spotify")).toEqual({
      kind: "open_app",
      name: "Spotify",
    });
  });

  it("waits on a veto: a place inside something, a change of mind", () => {
    expect(decide("open slack's settings")).toEqual(none("needs_final"));
    expect(decide("open slack— no, discord")).toEqual(none("needs_final"));
    expect(decide("open slack in chrome")).toEqual(none("needs_final"));
  });
});

describe("decideFast: recipes and scrolling", () => {
  it("builds the site's own URL for a named search", () => {
    expect(decide("search google for the weather in austin")).toEqual({
      kind: "open_url",
      url: "https://www.google.com/search?q=the%20weather%20in%20austin",
      siteKey: "google",
      label: "Google search for the weather in austin",
    });
    expect(decide("google the weather")).toEqual(
      url("google", "https://www.google.com/search?q=the%20weather"),
    );
    expect(decide("search amazon for headphones")).toEqual(
      url("amazon", "https://www.amazon.com/s?k=headphones"),
    );
    expect(decide("search gmail for receipts from amazon")).toEqual(
      url(
        "gmail",
        "https://mail.google.com/mail/u/0/#search/receipts%20from%20amazon",
      ),
    );
    expect(decide("search on x for butler")).toEqual(
      url("x", "https://x.com/search?q=butler"),
    );
    expect(decide("look up saturn on wikipedia")).toEqual(
      url("wikipedia", "https://en.wikipedia.org/w/index.php?search=saturn"),
    );
    expect(decide("find the vitest repo on github")).toEqual(
      url("github", "https://github.com/search?q=the%20vitest%20repo"),
    );
    expect(decide("search reddit for mechanical keyboards")).toEqual(
      url("reddit", "https://www.reddit.com/search/?q=mechanical%20keyboards"),
    );
    expect(decide("directions to the airport")).toEqual({
      kind: "open_url",
      url: "https://www.google.com/maps/dir/?api=1&destination=the%20airport",
      siteKey: "google-maps",
      label: "Google Maps directions to the airport",
    });
    expect(decide("search google maps for coffee")).toEqual(
      url("google-maps", "https://www.google.com/maps/search/coffee"),
    );
  });

  it("goes where the browser is for a bare search, to Google in a browser, and asks otherwise", () => {
    expect(
      decide("search for cats", ctx({ frontHost: "www.amazon.com" })),
    ).toEqual(url("amazon", "https://www.amazon.com/s?k=cats"));
    expect(
      decide("search for cats", ctx({ frontAppId: "com.apple.Safari" })),
    ).toEqual(url("google", "https://www.google.com/search?q=cats"));
    expect(
      decide(
        "look up quantum physics",
        ctx({ frontAppId: "com.google.Chrome" }),
      ),
    ).toEqual(
      url("google", "https://www.google.com/search?q=quantum%20physics"),
    );
    expect(
      decide("search for cats", ctx({ frontAppId: "com.apple.finder" })),
    ).toEqual(none("unsure"));
    expect(decide("find my tax documents")).toEqual(none("unsure"));
    expect(decide("start spotify")).toEqual(none("unsure"));
    expect(decide("watch the game")).toEqual(none("unsure"));
  });

  it("needs the final when the object is missing or too short", () => {
    expect(decide("search youtube")).toEqual(none("needs_final"));
    expect(decide("search youtube for a")).toEqual(none("needs_final"));
    expect(decide("play the video on youtube")).toEqual(none("needs_final"));
  });

  it("scrolls one way from the words alone", () => {
    expect(decide("scroll down")).toEqual({
      kind: "scroll",
      direction: "down",
    });
    expect(decide("scroll up")).toEqual({ kind: "scroll", direction: "up" });
    expect(decide("keep scrolling")).toEqual({
      kind: "scroll",
      direction: "down",
    });
    expect(decide("scroll down slowly")).toEqual({
      kind: "scroll",
      direction: "down",
    });
    expect(decide("scroll to the top")).toEqual({
      kind: "scroll",
      direction: "up",
    });
    expect(decide("scroll down to the comments")).toEqual({
      kind: "scroll",
      direction: "down",
    });
  });

  it("decides every clause of the stream's own cut the same way", () => {
    const [first, second] = clausesOf("open Slack and scroll down");
    expect(decideFast(first, ctx())).toEqual({
      kind: "open_app",
      name: "Slack",
    });
    expect(decideFast(second, ctx())).toEqual({
      kind: "scroll",
      direction: "down",
    });
  });
});

// Jev ---------------------------------------------------------------------

/** A client that answers after `ms` with `choice` at `p`, and remembers what it was asked. */
function fakeJev(choice: string, p: number, ms = 160) {
  const asked: { question: JevQuestion; state: object }[] = [];
  const client: JevClient = {
    ask(question, state) {
      asked.push({ question, state });
      const probabilities = Object.fromEntries(CLAUSE_ACTS.map((a) => [a, 0]));
      probabilities[choice] = p;
      const answer: JevAnswer = { choice, probabilities, confidence: p };
      return new Promise((resolve) => setTimeout(() => resolve(answer), ms));
    },
  };
  return { client, asked };
}

describe("decideFastWithJev", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Run the decider against a fake at 160 ms and measure with the faked clock. */
  async function withJev(
    text: string,
    c: FastContext,
    choice: string,
    p = 0.92,
  ) {
    const jev = fakeJev(choice, p);
    const started = Date.now();
    const pending = decideFastWithJev(clauseOf(text), c, jev.client);
    await vi.advanceTimersByTimeAsync(160);
    const action = await pending;
    return { action, ms: Date.now() - started, asked: jev.asked };
  }

  it("asks Jev only for an unsure clause, and decides within the budget with a 160 ms answer", async () => {
    const { action, ms, asked } = await withJev(
      "play a midwest safety",
      ctx(),
      "search_on_site",
    );
    expect(action).toEqual({
      kind: "open_url",
      url: "https://www.youtube.com/results?search_query=midwest%20safety",
      siteKey: "youtube",
      label: "YouTube search for midwest safety",
    });
    expect(ms).toBe(160);
    expect(ms).toBeLessThanOrEqual(250);
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toBe(CLAUSE_QUESTION);
    expect(Object.keys(asked[0].question.criteria)).toEqual([...CLAUSE_ACTS]);
    expect(asked[0].state).toEqual({
      clause: "play a midwest safety",
      frontApp: null,
      frontHost: null,
      browser: null,
    });
  });

  it("shows Jev the clause and where the screen is, and nothing else", () => {
    expect(
      clauseState(clauseOf("start spotify"), {
        frontAppId: "com.apple.finder",
        frontHost: "www.amazon.com",
        browser: "Safari",
        protectedHosts: ["paypal.com"],
      }),
    ).toEqual({
      clause: "start spotify",
      frontApp: "com.apple.finder",
      frontHost: "www.amazon.com",
      browser: "Safari",
    });
    expect(JEV_CLAUSE_MIN_P).toBe(0.85);
  });

  it("never asks when the rules already decided, refused or need the final", async () => {
    for (const [text, c] of [
      ["go to youtube", ctx()],
      ["send it", ctx()],
      ["go to paypal.com", ctx()],
      ["search google for me@example.com", ctx()],
      ["the one on the right", ctx()],
      ["type hello", ctx()],
      ["scroll down", ctx()],
    ] as const) {
      const jev = fakeJev("open_site", 0.99);
      const pending = decideFastWithJev(clauseOf(text), c, jev.client);
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending, text).toEqual(decide(text, c));
      expect(jev.asked, text).toHaveLength(0);
    }
  });

  it("takes each act at p ≥ 0.85 with the object from the local extraction", async () => {
    expect((await withJev("start spotify", ctx(), "open_app")).action).toEqual({
      kind: "open_app",
      name: "Spotify",
    });
    expect((await withJev("fire up slack", ctx(), "open_app")).action).toEqual({
      kind: "open_app",
      name: "slack",
    });
    expect(
      (await withJev("head over to youtube", ctx(), "open_site")).action,
    ).toEqual(url("youtube", "https://www.youtube.com/"));
    expect(
      (await withJev("head over to github dot com", ctx(), "open_site")).action,
    ).toEqual(url("github", "https://github.com/"));
    expect(
      (await withJev("find my tax documents", ctx(), "search_on_site")).action,
    ).toEqual(
      url("google", "https://www.google.com/search?q=my%20tax%20documents"),
    );
    expect(
      (await withJev("watch the game", ctx(), "search_on_site")).action,
    ).toEqual(
      url("youtube", "https://www.youtube.com/results?search_query=the%20game"),
    );
    expect(
      (
        await withJev(
          "search for cats",
          ctx({ frontAppId: "com.apple.finder", frontHost: "www.amazon.com" }),
          "search_on_site",
        )
      ).action,
    ).toEqual(url("amazon", "https://www.amazon.com/s?k=cats"));
    expect((await withJev("move up a bit", ctx(), "scroll")).action).toEqual({
      kind: "scroll",
      direction: "up",
    });
    expect(
      (await withJev("start the timer", ctx(), "not_navigational")).action,
    ).toEqual(none("not_navigational"));
    expect((await withJev("start over", ctx(), "unclear")).action).toEqual(
      none("unsure"),
    );
  });

  it("stays unsure below the threshold, on an option not asked, on no answer and on a throwing client", async () => {
    expect(
      (await withJev("start spotify", ctx(), "open_app", 0.84)).action,
    ).toEqual(none("unsure"));
    expect(
      (await withJev("start spotify", ctx(), "start", 0.99)).action,
    ).toEqual(none("unsure"));
    const silent: JevClient = { ask: async () => undefined };
    expect(
      await decideFastWithJev(clauseOf("start spotify"), ctx(), silent),
    ).toEqual(none("unsure"));
    const broken: JevClient = {
      ask: () => Promise.reject(new Error("no")),
    };
    expect(
      await decideFastWithJev(clauseOf("start spotify"), ctx(), broken),
    ).toEqual(none("unsure"));
  });

  it("holds the floors whatever Jev says: a protected host and a credential stay refused", async () => {
    // Jev is never asked for these, so its answer cannot matter.
    expect(
      (await withJev("head over to paypal.com", ctx(), "open_site")).action,
    ).toEqual(none("protected"));
    expect(
      (
        await withJev(
          "head over to sk-abcdefghijklmnopqrst",
          ctx(),
          "open_site",
        )
      ).action,
    ).toEqual(none("needs_final"));
    // ...and a verdict naming a site the words do not is nothing.
    expect(
      (await withJev("fire up the thing", ctx(), "open_site")).action,
    ).toEqual(none("unsure"));
  });
});

// The wire client -------------------------------------------------------------

const KEY = "sk-or-v1-TESTKEY-0123456789abcdef";
function served(
  o: {
    choice?: string;
    p?: number;
    provider?: string | null;
    model?: string | null;
    status?: number;
    body?: unknown;
  } = {},
) {
  const choice = o.choice ?? "search_on_site";
  const probabilities = Object.fromEntries(CLAUSE_ACTS.map((a) => [a, 0]));
  probabilities[choice] = o.p ?? 0.93;
  const body = o.body ?? {
    model: o.model === undefined ? "typesafe/jev-1.13-20260917" : o.model,
    provider: o.provider === undefined ? "TypeSafe" : o.provider,
    answers: {
      [JEV_CLAUSE_QUESTION_ID]: {
        type: "choice",
        choice,
        probabilities,
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 400, output_tokens: 0, cost: 0.00002 },
  };
  return new Response(JSON.stringify(body), {
    status: o.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(o.provider === null
        ? {}
        : { "x-provider-name": o.provider ?? "TypeSafe" }),
    },
  });
}

describe("createJevClauseClient", () => {
  it("sends one Decisions request under the clause id and returns the checked answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const results: JevClauseResult[] = [];
    const client = createJevClauseClient({
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init! });
        return served();
      },
      key: KEY,
      onResult: (r) => results.push(r),
    });
    const answer = await client.ask(CLAUSE_QUESTION, { clause: "play cats" });
    expect(answer).toEqual({
      choice: "search_on_site",
      probabilities: expect.objectContaining({
        search_on_site: 0.93,
        open_app: 0,
      }),
      confidence: 0.9,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DECISIONS_ENDPOINT);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      model: JEV_MODEL,
      state: { clause: "play cats" },
      questions: { [JEV_CLAUSE_QUESTION_ID]: CLAUSE_QUESTION },
      provider: { zdr: true, data_collection: "deny", allow_fallbacks: false },
    });
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${KEY}`);
    expect(results).toEqual([
      {
        ok: true,
        choice: "search_on_site",
        p: 0.93,
        ms: expect.any(Number),
        cost: 0.00002,
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it("answers undefined with a code for every failure and never throws", async () => {
    const run = async (
      fetch: typeof globalThis.fetch,
      key = KEY,
      signal?: AbortSignal,
    ) => {
      const results: JevClauseResult[] = [];
      const client = createJevClauseClient({
        fetch,
        key,
        onResult: (r) => results.push(r),
      });
      const answer = await client.ask(CLAUSE_QUESTION, {}, signal);
      return {
        answer,
        code: results[0] && !results[0].ok ? results[0].code : undefined,
      };
    };
    expect(await run(async () => served(), "")).toEqual({
      answer: undefined,
      code: "no_key",
    });
    expect(await run(async () => served({ provider: "Other" }))).toEqual({
      answer: undefined,
      code: "wrong_provider",
    });
    expect(await run(async () => served({ provider: null }))).toEqual({
      answer: undefined,
      code: "wrong_provider",
    });
    expect(
      await run(async () => served({ model: "typesafe/jev-1.13-20260101" })),
    ).toEqual({
      answer: undefined,
      code: "wrong_model",
    });
    expect(await run(async () => served({ status: 500 }))).toEqual({
      answer: undefined,
      code: "http_500",
    });
    expect(await run(async () => served({ choice: "start" }))).toEqual({
      answer: undefined,
      code: "bad_choice",
    });
    expect(
      await run(async () =>
        served({
          body: {
            model: "typesafe/jev-1.13-20260917",
            provider: "TypeSafe",
            answers: {},
          },
        }),
      ),
    ).toEqual({
      answer: undefined,
      code: "no_answer",
    });
    expect(
      await run(async () => new Response("nope", { status: 200 })),
    ).toEqual({
      answer: undefined,
      code: "bad_body",
    });
    expect(
      await run(async () => {
        throw new Error("ECONNRESET");
      }),
    ).toEqual({ answer: undefined, code: "network" });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await run(
        async (_input, init) => {
          if (init?.signal?.aborted) throw new Error("aborted");
          return served();
        },
        KEY,
        aborted.signal,
      ),
    ).toEqual({ answer: undefined, code: "cancelled" });
  });

  it("gives up at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const results: JevClauseResult[] = [];
      const client = createJevClauseClient({
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
        key: KEY,
        timeoutMs: 600,
        onResult: (r) => results.push(r),
      });
      const pending = client.ask(CLAUSE_QUESTION, {});
      await vi.advanceTimersByTimeAsync(600);
      expect(await pending).toBeUndefined();
      expect(results[0]).toMatchObject({ ok: false, code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("source pins", () => {
  it("exports the two regexes from the policy with no other change to their lines", () => {
    const policy = readFileSync(`${root}src/core/policy.ts`, "utf8");
    expect(policy).toMatch(/^export const consequential =$/m);
    expect(policy).toMatch(/^export const irreversible =$/m);
  });
  it("keeps src/voice to src/core and itself; the providers client re-exports the decider's interface", () => {
    const fast = readFileSync(`${root}src/voice/fast.ts`, "utf8");
    expect(fast).not.toMatch(/from "\.\.\/providers/);
    const clause = readFileSync(`${root}src/providers/jev-clause.ts`, "utf8");
    expect(clause).toMatch(
      /export type \{ JevAnswer, JevClient, JevQuestion \} from "\.\.\/voice\/fast"/,
    );
    expect(clause).toMatch(/JEV_TIMEOUT_MS/);
    expect(clause).toMatch(
      /readChoice\(body, JEV_CLAUSE_QUESTION_ID, options\)/,
    );
  });
});
