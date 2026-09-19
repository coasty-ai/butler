import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { z } from "zod";
import fixture from "./fixtures/partial-timelines.json";
import { defaultSettings } from "../src/core/schema";
import {
  FAST_NONE_REASONS,
  NONE,
  PORTS,
  PORT_NAMES,
  TOOL_SCHEMAS,
  chooseFromJev,
  chooseInputOf,
  chooseInputSchema,
  chooseOutputSchema,
  chooseQuestion,
  clauseEventSchema,
  clauseSchema,
  contracts,
  decideInputSchema,
  fastActionProblem,
  fastActionSchema,
  jevAnswerOf,
  jsonSchemaOf,
  openUrlInputSchema,
  openUrlOutputSchema,
  portOfTool,
  segmentInputSchema,
  segmentOutputSchema,
  speakOutputSchema,
  type JsonSchema,
  type PortName,
  type ToolName,
} from "../src/modules/contracts";
import {
  CLAUSE_ACTS,
  CLAUSE_QUESTION,
  clauseOf,
  decideFast,
  type FastAction,
  type FastContext,
} from "../src/voice/fast";
import {
  clausesOf,
  createClauseStream,
  type ClauseEvent,
} from "../src/voice/stream";

const ctx = (o: Partial<FastContext> = {}): FastContext => ({
  protectedHosts: [...defaultSettings.protectedDomains],
  ...o,
});
const owner = fixture.timelines.find((t) => t.id === "owner-youtube")!;

describe("PORTS", () => {
  it("names the five ports, their tools, budgets and whether they act", () => {
    expect([...PORT_NAMES].sort()).toEqual([
      "choiceModel",
      "clauseSegmenter",
      "fastDecider",
      "tts",
      "urlOpener",
    ]);
    expect(PORTS.clauseSegmenter.tool).toBe("segment_clauses");
    expect(PORTS.fastDecider).toEqual({
      tool: "decide_clause",
      budgetMs: 250,
      timeoutMs: 600,
      acts: false,
    });
    expect(PORTS.choiceModel.tool).toBe("choose");
    expect(PORTS.urlOpener).toMatchObject({ tool: "open_url", acts: true });
    expect(PORTS.tts).toMatchObject({ tool: "speak", acts: true });
    for (const port of PORT_NAMES) {
      expect(PORTS[port].budgetMs).toBeGreaterThan(0);
      expect(PORTS[port].timeoutMs).toBeGreaterThanOrEqual(
        PORTS[port].budgetMs,
      );
      expect(portOfTool(PORTS[port].tool)).toBe(port);
      expect(contracts[port].input).toBeInstanceOf(z.ZodType);
      expect(contracts[port].output).toBeInstanceOf(z.ZodType);
    }
    expect(portOfTool("bash")).toBeUndefined();
  });
});

describe("segment_clauses", () => {
  it("accepts the stream's real clauses and events for the owner's sentence", () => {
    const stream = createClauseStream();
    const events: ClauseEvent[] = [];
    for (const sample of owner.samples) events.push(...stream.push(sample));
    const last = owner.samples[owner.samples.length - 1];
    events.push(...stream.final(last.text, last.atMs + 400));
    expect(events.length).toBeGreaterThan(2);
    const output = { clauses: stream.clauses(), events };
    expect(segmentOutputSchema.parse(output)).toEqual(output);
    for (const event of events)
      expect(clauseEventSchema.parse(event)).toEqual(event);
    for (const clause of clausesOf("go to youtube and play a video"))
      expect(clauseSchema.parse(clause)).toEqual(clause);
    expect(
      contracts.clauseSegmenter.input.parse({
        text: last.text,
        atMs: last.atMs,
        previous: stream.clauses(),
      }),
    ).toMatchObject({ text: last.text });
  });

  it("refuses a clause with an unknown state or an extra key", () => {
    const clause = clauseOf("go to youtube");
    expect(clauseSchema.safeParse({ ...clause, state: "done" }).success).toBe(
      false,
    );
    expect(clauseSchema.safeParse({ ...clause, words: 3 }).success).toBe(false);
    expect(
      clauseEventSchema.safeParse({ kind: "committed", clause, by: "guess" })
        .success,
    ).toBe(false);
  });
});

describe("decide_clause", () => {
  const cases: [string, FastContext][] = [
    ["go to youtube", ctx()],
    ["play a midwest safety video", ctx({ frontHost: "www.youtube.com" })],
    ["open slack", ctx()],
    ["scroll down", ctx()],
    ["send it to dana", ctx()],
    ["the one on the right", ctx()],
    ["go to github dot com", ctx()],
    ["go to paypal", ctx()],
    ["fire up the thing", ctx()],
  ];
  it("accepts decideFast's real answers unchanged", () => {
    const seen = new Set<FastAction["kind"]>();
    for (const [text, context] of cases) {
      const clause = clauseOf(text);
      expect(decideInputSchema.parse({ clause, context })).toEqual({
        clause,
        context,
      });
      const action = decideFast(clause, context);
      seen.add(action.kind);
      expect(fastActionSchema.parse(action), text).toEqual(action);
    }
    expect([...seen].sort()).toEqual([
      "none",
      "open_app",
      "open_url",
      "scroll",
    ]);
  });

  it("gives a reply without siteKey and label the host of its address", () => {
    expect(
      fastActionSchema.parse({
        kind: "open_url",
        url: "https://www.youtube.com/results?search_query=midwest+safety",
      }),
    ).toEqual({
      kind: "open_url",
      url: "https://www.youtube.com/results?search_query=midwest+safety",
      siteKey: "youtube.com",
      label: "youtube.com",
    });
  });

  it("refuses credentials in the address, a non-web scheme, an unknown reason and extra keys", () => {
    const refused = [
      { kind: "open_url", url: "https://user:secret@example.com/" },
      { kind: "open_url", url: "javascript:alert(1)" },
      { kind: "open_url", url: "file:///etc/passwd" },
      { kind: "open_url", url: "youtube.com" },
      { kind: "none", reason: "later" },
      { kind: "open_app", name: "/Applications/Slack.app" },
      { kind: "open_app", name: "Slack", bundle: "com.tinyspeck" },
      { kind: "type", text: "hello" },
      { kind: "scroll", direction: "left" },
    ];
    for (const reply of refused)
      expect(fastActionSchema.safeParse(reply).success, reply.kind).toBe(false);
    expect(FAST_NONE_REASONS).toContain("protected");
  });

  it("re-checks an open_url's host against the protected list, subdomains included", () => {
    const hosts = defaultSettings.protectedDomains;
    const url = (u: string): FastAction => ({
      kind: "open_url",
      url: u,
      siteKey: "x",
      label: "x",
    });
    expect(fastActionProblem(url("https://www.paypal.com/"), hosts)).toBe(
      "protected_host",
    );
    expect(fastActionProblem(url("https://secure.chase.com/x"), hosts)).toBe(
      "protected_host",
    );
    expect(fastActionProblem(url("https://notpaypal.com/"), hosts)).toBe(
      undefined,
    );
    expect(fastActionProblem(url("https://www.youtube.com/"), hosts)).toBe(
      undefined,
    );
    expect(fastActionProblem(url("ftp://www.youtube.com/"), hosts)).toBe(
      "bad_url",
    );
    expect(
      fastActionProblem({ kind: "open_app", name: "PayPal" }, hosts),
    ).toBeUndefined();
  });
});

describe("choose", () => {
  it("clamps every probability and keeps the choice", () => {
    expect(
      chooseOutputSchema.parse({
        choice: "open_app",
        p: 1.4,
        probabilities: { open_app: 1.2, open_site: -0.1 },
        confidence: 2,
      }),
    ).toEqual({
      choice: "open_app",
      p: 1,
      probabilities: { open_app: 1, open_site: 0 },
      confidence: 1,
    });
    expect(chooseOutputSchema.parse({ choice: "a", p: 0.4 })).toEqual({
      choice: "a",
      p: 0.4,
    });
    expect(
      chooseOutputSchema.safeParse({ choice: "not a code", p: 0.5 }).success,
    ).toBe(false);
    expect(chooseOutputSchema.safeParse({ choice: "a" }).success).toBe(false);
  });

  it("round-trips Jev's question and answer shapes", () => {
    const input = chooseInputOf("clause", CLAUSE_QUESTION, {
      clause: "fire up slack",
      frontApp: null,
    });
    expect(input.question).toEqual({
      id: "clause",
      choices: [...CLAUSE_ACTS],
      prompt: CLAUSE_QUESTION.instructions,
      criteria: CLAUSE_QUESTION.criteria,
    });
    expect(chooseInputSchema.parse(input)).toEqual(input);
    expect(chooseQuestion(input.question)).toEqual(CLAUSE_QUESTION);
    expect(
      chooseQuestion({ id: "q", choices: ["yes", "no"], prompt: "Go?" }),
    ).toEqual({
      type: "choice",
      instructions: "Go?",
      criteria: { yes: "yes", no: "no" },
    });
    const jev = {
      choice: "open_app",
      probabilities: Object.fromEntries(
        CLAUSE_ACTS.map((act) => [act, act === "open_app" ? 0.9 : 0.02]),
      ),
      confidence: 0.88,
    };
    expect(chooseFromJev(jev)).toEqual({ ...jev, p: 0.9 });
    expect(jevAnswerOf({ choice: "a", p: 0.7 }, ["a", "b"])).toEqual({
      choice: "a",
      probabilities: { a: 0.7, b: 0 },
      confidence: 0.7,
    });
    expect(
      jevAnswerOf({ choice: "a", p: 0.6, probabilities: { a: 0.6, c: 0.4 } }, [
        "a",
        "b",
      ]),
    ).toEqual({
      choice: "a",
      probabilities: { a: 0.6, b: 0 },
      confidence: 0.6,
    });
    expect(
      chooseInputSchema.safeParse({
        question: { id: "q", choices: ["only"], prompt: "x" },
        state: {},
      }).success,
    ).toBe(false);
  });
});

describe("open_url and speak", () => {
  it("take a web address without credentials and answer a flag and a method code", () => {
    expect(
      openUrlInputSchema.parse({
        url: "https://www.youtube.com/",
        browser: "Safari",
      }),
    ).toEqual({ url: "https://www.youtube.com/", browser: "Safari" });
    expect(
      openUrlInputSchema.safeParse({ url: "https://me:pw@youtube.com/" })
        .success,
    ).toBe(false);
    expect(
      openUrlOutputSchema.parse({ navigated: true, method: "script" }),
    ).toEqual({ navigated: true, method: "script" });
    expect(
      openUrlOutputSchema.safeParse({ navigated: "yes", method: "script" })
        .success,
    ).toBe(false);
    expect(
      openUrlOutputSchema.safeParse({ navigated: true, method: "did it!" })
        .success,
    ).toBe(false);
    expect(speakOutputSchema.parse({ played: true, ms: 420 })).toEqual({
      played: true,
      ms: 420,
    });
    expect(
      speakOutputSchema.parse({ audio: "UklGRg==", format: "wav", ms: 10 }),
    ).toMatchObject({ format: "wav" });
    expect(speakOutputSchema.safeParse({ ms: -1 }).success).toBe(false);
    expect(
      speakOutputSchema.safeParse({ audio: "x", format: "ogg", ms: 1 }).success,
    ).toBe(false);
    expect(
      contracts.tts.input.safeParse({ text: "", voice: "af_heart" }).success,
    ).toBe(false);
  });
});

describe("NONE", () => {
  it("is a valid answer of every port, and nothing for the choice model", () => {
    for (const port of PORT_NAMES) {
      if (port === "choiceModel") {
        expect(NONE.choiceModel).toBeUndefined();
        continue;
      }
      expect(contracts[port].output.parse(NONE[port]), port).toEqual(
        NONE[port],
      );
    }
    expect(NONE.fastDecider).toEqual({ kind: "none", reason: "unsure" });
    expect(NONE.urlOpener).toEqual({ navigated: false, method: "none" });
    expect(NONE.clauseSegmenter).toEqual({ clauses: [], events: [] });
  });
});

describe("TOOL_SCHEMAS", () => {
  it("declares one object schema pair per tool, named after the ports' tools", () => {
    const tools = Object.keys(TOOL_SCHEMAS).sort() as ToolName[];
    expect(tools).toEqual(
      PORT_NAMES.map((port: PortName) => PORTS[port].tool).sort(),
    );
    for (const tool of tools) {
      const schema = TOOL_SCHEMAS[tool];
      expect(schema.name).toBe(tool);
      expect(PORTS[schema.port].tool).toBe(tool);
      expect(schema.description.length).toBeGreaterThan(20);
      for (const json of [schema.inputSchema, schema.outputSchema]) {
        expect(json.type, tool).toBe("object");
        expect(json.$schema).toBeUndefined();
        expect(
          "properties" in json || "oneOf" in json || "anyOf" in json,
          tool,
        ).toBe(true);
      }
    }
    // The decider's output is a union of object branches: still an object schema.
    const decide = TOOL_SCHEMAS.decide_clause.outputSchema;
    expect(decide.type).toBe("object");
    expect((decide.oneOf as unknown[]).length).toBe(4);
    // Every input is a closed object: the adapter cannot be handed keys the port never named.
    expect(TOOL_SCHEMAS.decide_clause.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["clause", "context"],
    });
    expect(TOOL_SCHEMAS.open_url.inputSchema).toMatchObject({
      required: ["url"],
    });
    expect(TOOL_SCHEMAS.choose.outputSchema).toMatchObject({
      required: ["choice", "p"],
    });
    // A schema that is not an object is left as it is.
    expect(jsonSchemaOf(z.string())).toEqual({ type: "string" });
  });
});

describe("the JSON Schemas under the client's Ajv", () => {
  const decideTexts: [string, FastContext][] = [
    ["go to youtube", ctx()],
    ["play a midwest safety video", ctx({ frontHost: "www.youtube.com" })],
    ["open slack", ctx()],
    ["scroll down", ctx()],
    ["send it to dana", ctx()],
    ["fire up the thing", ctx()],
  ];
  /** The owner's sentence through the real stream: its clauses, every event and the last partial. */
  function ownerSegments() {
    const stream = createClauseStream();
    const events: ClauseEvent[] = [];
    for (const sample of owner.samples) events.push(...stream.push(sample));
    const last = owner.samples[owner.samples.length - 1];
    events.push(...stream.final(last.text, last.atMs + 400));
    return {
      stream,
      events,
      last,
      output: { clauses: stream.clauses(), events },
    };
  }

  it("flatten the decider's union into an object schema whose branches still decide", () => {
    const decide = TOOL_SCHEMAS.decide_clause.outputSchema;
    expect(decide.type).toBe("object");
    expect(decide.required).toEqual(["kind"]);
    expect(decide.properties).toEqual({
      kind: {
        type: "string",
        enum: ["open_app", "open_url", "scroll", "none"],
      },
      name: expect.objectContaining({ type: "string" }),
      url: expect.objectContaining({ type: "string" }),
      siteKey: expect.objectContaining({ type: "string" }),
      label: expect.objectContaining({ type: "string" }),
      direction: { type: "string", enum: ["down", "up"] },
      reason: { type: "string", enum: [...FAST_NONE_REASONS] },
    });
    const branches = decide.oneOf as JsonSchema[];
    expect(branches).toHaveLength(4);
    for (const branch of branches)
      expect(branch).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    expect(
      branches.find((b) => JSON.stringify(b).includes('"open_url"'))!.required,
    ).toEqual(["kind", "url"]);
    // The segmenter's input names the stateless adapter's two optional fields after the three it needs.
    expect(TOOL_SCHEMAS.segment_clauses.inputSchema).toMatchObject({
      required: ["text", "atMs", "previous"],
    });
    expect(
      Object.keys(
        TOOL_SCHEMAS.segment_clauses.inputSchema.properties as object,
      ),
    ).toEqual(["text", "atMs", "previous", "final", "lastChangedAtMs"]);
    for (const tool of Object.keys(TOOL_SCHEMAS) as ToolName[])
      for (const json of [
        TOOL_SCHEMAS[tool].inputSchema,
        TOOL_SCHEMAS[tool].outputSchema,
      ])
        expect(json.properties, tool).toBeTypeOf("object");
  });

  it("compile in strict mode, draft-07 and 2020-12 alike, and admit exactly what the zod schemas do", () => {
    const validators = [
      new Ajv({ strict: true }),
      new Ajv2020({ strict: true }),
    ];
    for (const ajv of validators)
      for (const tool of Object.keys(TOOL_SCHEMAS) as ToolName[]) {
        expect(
          () => ajv.compile(TOOL_SCHEMAS[tool].inputSchema),
          tool,
        ).not.toThrow();
        expect(
          () => ajv.compile(TOOL_SCHEMAS[tool].outputSchema),
          tool,
        ).not.toThrow();
      }
    const ajv = validators[0];
    const decideOut = ajv.compile(TOOL_SCHEMAS.decide_clause.outputSchema);
    for (const [text, context] of decideTexts) {
      const action = decideFast(clauseOf(text), context);
      expect(decideOut(action), text).toBe(true);
      expect(decideOut({ ...action, extra: 1 }), text).toBe(false);
    }
    expect(
      decideOut({ kind: "open_url", url: "https://www.youtube.com/" }),
    ).toBe(true);
    expect(
      decideOut({
        kind: "open_url",
        url: "https://www.youtube.com/",
        label: "YouTube · example",
      }),
    ).toBe(true);
    expect(decideOut({ kind: "open_url" })).toBe(false);
    expect(decideOut({ kind: "type", text: "x" })).toBe(false);
    expect(decideOut({ kind: "none", reason: "later" })).toBe(false);
    const decideIn = ajv.compile(TOOL_SCHEMAS.decide_clause.inputSchema);
    expect(
      decideIn({ clause: clauseOf("go to youtube"), context: ctx() }),
    ).toBe(true);
    const { output, last, stream } = ownerSegments();
    expect(ajv.compile(TOOL_SCHEMAS.segment_clauses.outputSchema)(output)).toBe(
      true,
    );
    const segmentIn = ajv.compile(TOOL_SCHEMAS.segment_clauses.inputSchema);
    expect(
      segmentIn({
        text: last.text,
        atMs: last.atMs,
        previous: stream.clauses(),
      }),
    ).toBe(true);
    expect(
      segmentIn({
        text: last.text,
        atMs: last.atMs,
        previous: stream.clauses(),
        lastChangedAtMs: last.atMs,
        final: true,
      }),
    ).toBe(true);
    expect(
      segmentIn({
        text: last.text,
        atMs: last.atMs,
        previous: [],
        final: "yes",
      }),
    ).toBe(false);
    const chooseIn = ajv.compile(TOOL_SCHEMAS.choose.inputSchema);
    expect(
      chooseIn(chooseInputOf("clause", CLAUSE_QUESTION, { clause: "x" })),
    ).toBe(true);
    const chooseOut = ajv.compile(TOOL_SCHEMAS.choose.outputSchema);
    expect(chooseOut({ choice: "open_app", p: 0.9 })).toBe(true);
    expect(chooseOut({ choice: "open_app", p: 0.9, why: "because" })).toBe(
      false,
    );
    const openOut = ajv.compile(TOOL_SCHEMAS.open_url.outputSchema);
    expect(openOut({ navigated: true, method: "script" })).toBe(true);
    expect(openOut({ navigated: true })).toBe(false);
    const speakOut = ajv.compile(TOOL_SCHEMAS.speak.outputSchema);
    expect(speakOut({ played: true, ms: 3 })).toBe(true);
    expect(speakOut({ audio: "UklGRg==", format: "wav", ms: 3 })).toBe(true);
    expect(speakOut({ audio: "UklGRg==", format: "ogg", ms: 3 })).toBe(false);
  });

  it("segment_clauses takes the stateless segmenter's final flag and last-change time", () => {
    const { last, stream } = ownerSegments();
    const input = {
      text: last.text,
      atMs: last.atMs,
      previous: stream.clauses(),
    };
    expect(segmentInputSchema.parse(input)).toEqual(input);
    const full = { ...input, lastChangedAtMs: last.atMs - 350, final: true };
    expect(segmentInputSchema.parse(full)).toEqual(full);
    expect(
      segmentInputSchema.safeParse({ ...input, final: "yes" }).success,
    ).toBe(false);
    expect(
      segmentInputSchema.safeParse({ ...input, lastChangedAtMs: -1 }).success,
    ).toBe(false);
  });
});
