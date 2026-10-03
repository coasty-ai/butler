import { describe, expect, it, vi } from "vitest";
import { defaultSettings, type Settings } from "../src/core/schema";
import {
  inboxRequest,
  readInbox,
  summarizeInbox,
  type InboxReading,
} from "../src/terminal/inbox";
import { CLOCK, GH_SEARCH, fakeTools, ok } from "./tool-fakes";

const search = {
  ...GH_SEARCH,
  id: "gmail__gmail_search",
  provider: "gmail",
  name: "gmail_search",
  title: "Gmail",
  openWorld: false,
};
const read = { ...search, id: "gmail__gmail_read", name: "gmail_read" };
const settings = (): Settings => ({
  ...structuredClone(defaultSettings),
  privacy: "PRIVATE_BYOM",
  provider: "openai",
  inputPrice: 4,
  outputPrice: 20,
  model: "gpt-6.1-sol",
  dialogModel: "gpt-6.1-sol",
  endpoint: "https://api.openai.com",
  openaiServiceTier: "fast",
});
const words =
  "Read my five newest unread Gmail messages and tell me which need attention. Do not send or modify messages.";
function setup(ids = ["a1", "a2", "a3"]) {
  const s = settings(),
    tools = fakeTools({ tools: [search, read] }),
    controller = new AbortController();
  tools.script(search.id, () =>
    ok(search, JSON.stringify({ ids, more: true, messages: [] })),
  );
  tools.script(read.id, (args) =>
    ok(
      read,
      JSON.stringify({
        id: args.id,
        From: "Alex",
        Subject: "Draft review",
        body: "Please review the deck by 3 PM.",
      }),
    ),
  );
  return {
    tools,
    s,
    controller,
    run: () =>
      readInbox({
        tools: tools.access,
        settings: () => s,
        request: inboxRequest(words)!,
        words,
        signal: controller.signal,
      }),
  };
}

describe("direct inbox requests", () => {
  it("recognises bounded summaries without a planning call", () => {
    expect(inboxRequest(words)).toEqual({ limit: 5 });
    expect(inboxRequest("check my inbox")).toEqual({ limit: 5 });
    expect(
      inboxRequest("Summarise my 3 latest unread emails in Gmail?"),
    ).toEqual({ limit: 3 });
    expect(
      inboxRequest("read the eight most recent unread Gmail messages"),
    ).toEqual({ limit: 8 });
  });
  it.each([
    "don't check my inbox",
    "read my 20 newest unread emails",
    "read those emails",
    "read my five unread messages",
    "check my inbox and reply to Alex",
    "check my inbox and mark messages read",
    "read my five unread messages from Alex",
    "summarise my unread Slack messages",
    "read my unread Gmail messages then delete them",
    "check my inbox, send no messages",
  ])("leaves other requests with the normal planner: %s", (text) =>
    expect(inboxRequest(text)).toBeUndefined(),
  );
});

describe("approved inbox reads", () => {
  it("starts every unique selected read before waiting, preserving the requested scope", async () => {
    const t = setup(["a1", "a2", "a1", "a3"]),
      pending: (() => void)[] = [];
    t.tools.script(
      read.id,
      (args) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve(
              ok(
                read,
                JSON.stringify({ id: args.id, body: "Synthetic update" }),
              ),
            ),
          ),
        ),
    );
    const work = t.run();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(t.tools.calls).toEqual([
      { id: search.id, args: { query: "is:unread", limit: 5 } },
      ...["a1", "a2", "a3"].map((id) => ({ id: read.id, args: { id } })),
    ]);
    pending.forEach((resolve) => resolve());
    expect(await work).toMatchObject({
      requested: 5,
      found: 3,
      more: true,
      messages: [{ code: "ok" }, { code: "ok" }, { code: "ok" }],
    });
  });
  it("keeps identifiers before a truncated search body and marks clipped reads", async () => {
    const t = setup();
    t.tools.script(search.id, () =>
      ok(search, '{"ids":["a1","a2"],"more":false,"messages":[ [+9000 chars]'),
    );
    t.tools.script(read.id, (args) =>
      ok(read, `{"id":"${args.id}","body":"excerpt [+9000 chars]`),
    );
    expect(await t.run()).toMatchObject({
      found: 2,
      messages: [
        { code: "ok", truncated: true },
        { code: "ok", truncated: true },
      ],
    });
  });
  it.each([
    { trusted: false },
    { tier: "write" as const },
    { openWorld: true },
  ])(
    "defers before any effect when a read cannot run unattended: %j",
    async (extra) => {
      const t = setup();
      t.tools.access.list = async () => ({
        tools: [search, { ...read, ...extra }],
        unavailable: [],
      });
      expect(await t.run()).toBeUndefined();
      expect(t.tools.calls).toHaveLength(0);
    },
  );
  it("keeps the privacy and argument gates before any search", async () => {
    const t = setup();
    t.s.privacy = "PRIVATE_LOCAL";
    expect(await t.run()).toBeUndefined();
    t.s.privacy = "PRIVATE_BYOM";
    t.tools.access.prepare = () => ({ ok: false, problem: "invalid_args" });
    expect(await t.run()).toBeUndefined();
    expect(t.tools.calls).toHaveLength(0);
  });
  it("records a changed pin or substituted message as missing evidence, without a retry", async () => {
    const t = setup(["a1", "a2"]);
    t.tools.script(read.id, (args) =>
      args.id === "a1"
        ? { ...ok(read, ""), code: "pin_mismatch" }
        : ok(read, '{"id":"b9","body":"Wrong message"}'),
    );
    const result = await t.run();
    expect(result?.messages).toEqual([
      { index: 1, code: "pin_mismatch", excerpt: "", truncated: false },
      { index: 2, code: "error", excerpt: "", truncated: false },
    ]);
    expect(t.tools.calls).toHaveLength(3);
  });
  it("does not call reads or expose their contents after permissions change", async () => {
    const t = setup();
    t.tools.script(search.id, () => {
      t.s.tools.enabled = false;
      return ok(search, '{"ids":["a1"],"more":false}');
    });
    expect(await t.run()).toMatchObject({ stopped: true });
    expect(t.tools.calls).toHaveLength(1);
  });
  it("interrupts outstanding reads without returning a late answer", async () => {
    const t = setup();
    const started = vi.fn();
    t.tools.script(read.id, () => {
      started();
      return new Promise(() => {});
    });
    const work = t.run();
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(3));
    t.controller.abort();
    await expect(work).rejects.toThrow();
  });
  it("never treats malformed search output as an empty inbox", async () => {
    const t = setup();
    t.tools.script(search.id, () =>
      ok(search, '{"ids":["invalid/id"],"more":false}'),
    );
    expect(await t.run()).toMatchObject({ stopped: true });
    expect(t.tools.calls).toHaveLength(1);
  });
});

const reading: InboxReading = {
  requested: 5,
  found: 1,
  more: true,
  messages: [
    {
      index: 1,
      code: "ok",
      excerpt: "Alex needs a deck review before 3 PM.",
      truncated: false,
    },
  ],
};
function summary(
  over: Partial<Parameters<typeof summarizeInbox>[0]> = {},
  text = JSON.stringify([
    { index: 1, quote: reading.messages[0].excerpt, next: "review" },
  ]),
) {
  const fetch = vi.fn(async () => {
    return new Response(
      [
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`,
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return {
    fetch,
    run: () =>
      summarizeInbox({
        reading,
        settings: settings(),
        key: "synthetic-key",
        fetch,
        signal: new AbortController().signal,
        now: CLOCK.now,
        zone: CLOCK.zone,
        ...over,
      }),
  };
}
describe("one bounded inbox summary", () => {
  it("uses one text call on the saved Fast model, with no action tools or images", async () => {
    const t = summary();
    expect(await t.run()).toMatchObject({
      said: "Message 1: the email says “Alex needs a deck review before 3 PM.” I\'d suggest reviewing it.\nThis covers selected excerpts; some context may be missing.",
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((t.fetch.mock.calls[0] as any)[1].body);
    expect(body).toMatchObject({
      model: "gpt-6.1-sol",
      service_tier: "fast",
      reasoning: { effort: "low" },
    });
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toContain("untrusted data");
    expect(body.instructions).toContain("British English");
    expect(JSON.parse(body.input[0].content[0].text).timezone).toBe(CLOCK.zone);
  });
  it("does not publish invented deadlines, unsupported quotes or completed-action claims", async () => {
    for (const result of [
      [
        {
          index: 1,
          quote: "Alex needs a deck review before 5 PM.",
          next: "review",
        },
      ],
      [{ index: 1, quote: reading.messages[0].excerpt, next: "replied" }],
      [
        {
          index: 1,
          quote: reading.messages[0].excerpt,
          next: "review",
          status: "sent",
        },
      ],
      [{ index: 2, quote: reading.messages[0].excerpt, next: "review" }],
      [
        { index: 1, quote: reading.messages[0].excerpt, next: "review" },
        { index: 1, quote: reading.messages[0].excerpt, next: "none" },
      ],
    ]) {
      const t = summary({}, JSON.stringify(result));
      const reply = await t.run();
      expect(reply.said).toContain("summary is unavailable");
      expect(reply.said).not.toContain("5 PM");
      expect(reply.said).not.toContain("sent");
      expect(reply.usage).toBeDefined();
      expect(t.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("binds each quote to its own message and preserves partial coverage honestly", async () => {
    const first = "Please review the deck by 3 PM.",
      second = "The newsletter describes a new release.";
    const t = summary(
      {
        reading: {
          requested: 3,
          found: 3,
          more: false,
          messages: [
            {
              index: 1,
              code: "ok",
              truncated: false,
              excerpt: JSON.stringify({ Subject: "Draft review", body: first }),
            },
            {
              index: 2,
              code: "ok",
              truncated: true,
              excerpt:
                JSON.stringify({
                  Subject: "Release news",
                  snippet: second,
                }).slice(0, -1) + ',"body":"clipped [+9000 chars]',
            },
            { index: 3, code: "unavailable", truncated: false, excerpt: "" },
          ],
        },
      },
      JSON.stringify([
        { index: 1, quote: first, next: "reply" },
        // A valid quote from another message cannot replace this message.
        { index: 2, quote: first, next: "review" },
      ]),
    );
    const reply = await t.run();
    expect(reply.said).toContain("Draft review: the email says");
    expect(reply.said).toContain("I'd suggest considering a reply");
    expect(reply.said).toContain("Release news: I couldn't verify");
    expect(reply.said).toContain("Message 3: I couldn't verify");
    expect(reply.said).toContain("some context may be missing");
  });
  it("uses complete snippet fields from a clipped body without asserting current account status", async () => {
    const quote = "A payment failed on September 20.";
    const t = summary(
      {
        reading: {
          requested: 1,
          found: 1,
          more: false,
          messages: [
            {
              index: 1,
              code: "ok",
              truncated: true,
              excerpt:
                JSON.stringify({
                  Subject: "Payment alert",
                  snippet: quote,
                }).slice(0, -1) + ',"body":"clipped [+9000 chars]',
            },
          ],
        },
      },
      JSON.stringify([{ index: 1, quote, next: "check_account" }]),
    );
    const reply = await t.run();
    expect(reply.said).toContain(`the email says “${quote}”`);
    expect(reply.said).toContain("I'd suggest checking the official account");
    expect(reply.said).not.toContain("your payment is");
  });
  it("bounds escaped excerpts, redacts credentials and reports incomplete coverage", async () => {
    const t = summary({
      reading: {
        requested: 8,
        found: 8,
        more: true,
        messages: Array.from({ length: 8 }, (_, index) => ({
          index: index + 1,
          code: "ok",
          truncated: true,
          excerpt: "sk-proj-" + "x".repeat(60) + '"'.repeat(20_000),
        })),
      },
      settings: { ...settings(), maxCost: 50 },
    });
    await t.run();
    const body = JSON.parse((t.fetch.mock.calls[0] as any)[1].body),
      input = body.input[0].content[0].text;
    expect(input.length).toBeLessThanOrEqual(16_000);
    expect(input).not.toContain("sk-proj-");
    expect(input).toContain("Truncated message excerpt");
    expect(input).toContain("More unread messages remain");
  });
  it.each([
    { reading: { ...reading, found: 0, messages: [] } },
    { reading: { ...reading, stopped: true } },
    { key: "" },
    { settings: { ...settings(), inputPrice: 0, outputPrice: 0 } },
    {
      settings: {
        ...settings(),
        maxCost: 0.01,
        inputPrice: 1000,
        outputPrice: 1000,
      },
    },
  ])(
    "avoids paid work for an empty/failed inbox or unavailable budget: %j",
    async (over) => {
      const t = summary(over);
      expect((await t.run()).usage).toBeUndefined();
      expect(t.fetch).not.toHaveBeenCalled();
    },
  );
});
