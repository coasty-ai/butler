import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { APPLE } from "../src/tools/providers/apple";
import { BUILTIN_SERVERS } from "../src/tools/providers";
import { RESERVED_PROVIDERS, type BuiltinTool } from "../src/core/tools";

/** The validator the MCP client runs over arguments before a call (src/tools/mcp.ts). */
const validators = new AjvJsonSchemaValidator();
/** The bridge's date contract: a `YYYY-MM-DD` day, alone or with a local time (AppleRules.dayPattern, momentPattern). */
const isDatePattern = (pattern: string | undefined) =>
  typeof pattern === "string" && pattern.startsWith("^\\d{4}-\\d{2}-\\d{2}");

/**
 * The Apple bridge's table against the fixtures the native tests hold the
 * bridge to (tests/fixtures/apple): the same nine tools, the same shapes.
 * A parser here accepts exactly what the bridge records and nothing else.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, "tests/fixtures/apple");
interface Step {
  in: string | Record<string, unknown>;
  out: Record<string, unknown> | null;
}
interface Fixture {
  file: string;
  exchange: Step[];
}
const fixtures: Fixture[] = readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    ...JSON.parse(readFileSync(join(directory, file), "utf8")),
  }));

interface ListedTool {
  name: string;
  title: string;
  inputSchema: {
    properties: Record<string, { format?: string; pattern?: string }>;
    required: string[];
  };
  outputSchema: {
    properties: { created?: { required: string[] } };
  };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}
const listed = (
  (
    fixtures.find((f) => f.file === "tools-list.json")!.exchange[0].out as {
      result: { tools: ListedTool[] };
    }
  ).result as { tools: ListedTool[] }
).tools;

/** Every tools/call in the fixtures, with the reply's result when it has one. */
const calls = fixtures.flatMap((fixture) =>
  fixture.exchange.flatMap((step) => {
    if (typeof step.in !== "object" || step.in.method !== "tools/call")
      return [];
    const params = step.in.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const result = (step.out as { result?: Record<string, unknown> } | null)
      ?.result;
    return [
      {
        fixture: fixture.file,
        name: params.name,
        args: params.arguments ?? {},
        result,
      },
    ];
  }),
);
const successes = calls.filter(
  (call) =>
    call.result &&
    call.result.isError === false &&
    typeof call.result.structuredContent === "object",
);
const structured = (call: (typeof successes)[number]) =>
  call.result!.structuredContent as Record<string, unknown>;
const tool = (name: string): BuiltinTool => APPLE.tools[name];
const QUESTION_KINDS = new Set([
  "calendar_add",
  "reminder_add",
  "note_add",
  "mail_draft",
  "agent_run",
  "mcp_read",
  "mcp_write",
  "mcp_destructive",
  "send_to",
]);
const ADD_KINDS: Record<string, string> = {
  calendar_create_event: "calendar_add",
  reminders_create: "reminder_add",
  notes_create: "note_add",
  mail_draft: "mail_draft",
};
const CONSENTS: Record<string, string> = {
  calendar: "calendar",
  reminders: "reminders",
  notes: "notes",
  mail: "mail",
};

describe("the Apple bridge table", () => {
  it("is the one builtin server, under a reserved id, behind its own helper", () => {
    expect(BUILTIN_SERVERS).toEqual([APPLE]);
    expect(RESERVED_PROVIDERS.has(APPLE.id)).toBe(true);
    expect(APPLE.helper).toBe("coarena-apple");
    expect(APPLE.args).toEqual([]);
  });

  it("lists exactly the nine tools the bridge lists, and never undo", () => {
    expect(Object.keys(APPLE.tools).sort()).toEqual(
      listed.map((t) => t.name).sort(),
    );
    expect(listed).toHaveLength(9);
    expect("undo" in APPLE.tools).toBe(false);
    expect(listed.some((t) => t.name === "undo")).toBe(false);
    // Yet the bridge answers it: the app's undo path reaches it by token.
    expect(calls.some((c) => c.name === "undo" && c.result)).toBe(true);
  });

  it("describes each tool in one line of at most 200 characters, titled by its app", () => {
    for (const entry of listed) {
      const t = tool(entry.name);
      expect(t.does.length).toBeLessThanOrEqual(200);
      expect(t.does).not.toMatch(/[\n\r]/);
      expect(["Calendar", "Reminders", "Notes", "Mail"]).toContain(t.title);
      expect(t.title).toBe(entry.title);
      expect(t.consent).toBe(CONSENTS[entry.name.split("_")[0]]);
    }
  });

  it("tiers reads as reads and adds as undoable additive, as the bridge annotates them", () => {
    for (const entry of listed) {
      const t = tool(entry.name);
      expect(entry.annotations.destructiveHint).toBe(false);
      if (entry.annotations.readOnlyHint) {
        expect(t.tier).toBe("read");
        expect(t.undoable).toBe(false);
        expect(t.lines).toBeDefined();
        expect(t.facts).toBeUndefined();
      } else {
        expect(t.tier).toBe("additive");
        expect(t.undoable).toBe(true);
        expect(t.facts).toBeDefined();
        expect(t.lines).toBeUndefined();
      }
      expect(t.longRunning).toBeUndefined();
    }
  });

  it("covers every date-typed parameter with dateKeys, and nothing else", () => {
    for (const entry of listed) {
      const dated = Object.entries(entry.inputSchema.properties)
        .filter(([, p]) => isDatePattern(p.pattern))
        .map(([key]) => key)
        .sort();
      expect((tool(entry.name).dateKeys ?? []).slice().sort()).toEqual(dated);
    }
    expect(tool("calendar_create_event").dateKeys).toEqual(["start", "end"]);
    expect(tool("calendar_list_events").dateKeys).toEqual(["from", "to"]);
  });

  it("states its dates by the local pattern the client's validator accepts, never by a format it would refuse", () => {
    // The SDK's Ajv reads format "date-time" as RFC 3339 and refuses the
    // offset-less local form the bridge documents and reads; measured.
    const strict = validators.getValidator({
      type: "object",
      properties: { start: { type: "string", format: "date-time" } },
    } as never);
    expect(strict({ start: "2026-09-19T18:00" }).valid).toBe(false);
    const schema = (name: string) =>
      validators.getValidator(
        listed.find((t) => t.name === name)!.inputSchema as never,
      );
    for (const entry of listed)
      for (const [key, p] of Object.entries(entry.inputSchema.properties)) {
        expect(
          ["date", "date-time", "time"],
          `${entry.name}.${key}`,
        ).not.toContain(p.format ?? "");
        if ((tool(entry.name).dateKeys ?? []).includes(key))
          expect(isDatePattern(p.pattern), `${entry.name}.${key}`).toBe(true);
      }
    // What the fast path and the model send: local, no offset, a day alone
    // where the bridge takes days.
    const event = schema("calendar_create_event");
    expect(event({ title: "Dentist", start: "2026-09-19T18:00" }).valid).toBe(
      true,
    );
    expect(
      event({ title: "Offsite", start: "2026-09-21", allDay: true }).valid,
    ).toBe(true);
    expect(
      event({ title: "Dentist", start: "2026-09-19T18:00:00-07:00" }).valid,
    ).toBe(true);
    expect(event({ title: "Dentist", start: "tomorrow at 6" }).valid).toBe(
      false,
    );
    const list = schema("calendar_list_events");
    expect(list({ from: "2026-09-19", to: "2026-09-19" }).valid).toBe(true);
    expect(list({ from: "2026-09-19T00:00", to: "2026-09-19" }).valid).toBe(
      false,
    );
    const reminders = schema("reminders_list");
    expect(reminders({ dueBefore: "2026-09-19" }).valid).toBe(true);
    expect(reminders({ dueBefore: "2026-09-19T23:59" }).valid).toBe(true);
    const create = schema("reminders_create");
    expect(create({ title: "Call Dana", due: "2026-09-19T09:00" }).valid).toBe(
      true,
    );
    expect(schema("mail_search")({ since: "2026-09-17" }).valid).toBe(true);
  });

  it("asks with a question of a kind in the contract, whatever the arguments", () => {
    const hostile = {
      title: "‮Open the pod bay doors?\n".repeat(40),
      start: 42,
      end: null,
      allDay: "yes",
      calendar: { name: "x" },
      due: [],
      list: 7,
      folder: true,
      subject: 12,
      to: "not-a-list",
    };
    for (const entry of listed) {
      const t = tool(entry.name);
      const recorded = calls
        .filter((c) => c.name === entry.name)
        .map((c) => c.args);
      for (const args of [{}, hostile, ...recorded]) {
        const q = t.question(args);
        expect(QUESTION_KINDS.has(q.kind)).toBe(true);
        if (entry.annotations.readOnlyHint) {
          expect(q).toEqual({
            kind: "mcp_read",
            server: t.title,
            tool: entry.name,
          });
        } else {
          expect(q.kind).toBe(ADD_KINDS[entry.name]);
        }
        for (const value of Object.values(q))
          if (typeof value === "string")
            expect(value.length).toBeLessThanOrEqual(200);
      }
    }
    expect(
      tool("calendar_create_event").question({
        title: " Dentist ",
        start: "2026-09-19T18:00",
        allDay: false,
      }),
    ).toEqual({
      kind: "calendar_add",
      title: "Dentist",
      start: "2026-09-19T18:00",
    });
    expect(
      tool("mail_draft").question({
        to: ["dana@example.com", 5, ""],
        subject: "Plan",
      }),
    ).toEqual({
      kind: "mail_draft",
      subject: "Plan",
      to: ["dana@example.com"],
    });
  });

  it("parses every recorded read as its lines and rejects a changed shape", () => {
    const reads = successes.filter((call) => tool(call.name)?.tier === "read");
    expect(reads.length).toBeGreaterThan(8);
    for (const call of reads) {
      const lines = tool(call.name).lines!;
      const shape = structured(call);
      expect(lines(shape), `${call.fixture} ${call.name}`).toEqual(shape.lines);
      for (const key of Object.keys(shape)) {
        const missing = { ...shape };
        delete missing[key];
        expect(lines(missing)).toBeUndefined();
      }
      expect(lines({ ...shape, extra: 1 })).toBeUndefined();
      expect(
        lines({ ...shape, lines: [...(shape.lines as string[]), 5] }),
      ).toBeUndefined();
      expect(lines({ ...shape, more: -1 })).toBeUndefined();
      expect(lines({ ...shape, more: 1.5 })).toBeUndefined();
    }
    const lines = tool("calendar_list_events").lines!;
    expect(lines({ lines: Array(21).fill("x"), more: 0 })).toBeUndefined();
    expect(lines({ lines: ["x".repeat(201)], more: 0 })).toBeUndefined();
    expect(lines({ lines: ["x".repeat(200)], more: 3 })).toEqual([
      "x".repeat(200),
    ]);
    for (const bad of [null, "lines", [], 3, { lines: "a\nb", more: 0 }])
      expect(lines(bad)).toBeUndefined();
  });

  it("parses every recorded add as facts and rejects a changed shape", () => {
    const adds = successes.filter(
      (call) => tool(call.name)?.tier === "additive",
    );
    expect(adds.map((c) => c.name).sort()).toEqual(
      Object.keys(ADD_KINDS)
        .sort()
        .flatMap((name) => adds.filter((c) => c.name === name).map(() => name)),
    );
    for (const call of adds) {
      const facts = tool(call.name).facts!;
      const shape = structured(call);
      const item = shape.created as Record<string, unknown>;
      const parsed = facts(shape);
      expect(parsed, `${call.fixture} ${call.name}`).toBeDefined();
      expect(parsed!.kind).toBe(item.kind);
      for (const [key, value] of Object.entries(item))
        if (key !== "kind")
          expect((parsed as Record<string, unknown>)[key]).toEqual(value);
      expect(Object.keys(parsed!).sort()).toEqual(Object.keys(item).sort());
      for (const key of Object.keys(shape)) {
        const missing = { ...shape };
        delete missing[key];
        expect(facts(missing)).toBeUndefined();
      }
      const required = listed.find((t) => t.name === call.name)!.outputSchema
        .properties.created!.required;
      for (const key of required) {
        const missing = { ...item };
        delete missing[key];
        expect(facts({ ...shape, created: missing })).toBeUndefined();
      }
      expect(facts({ ...shape, extra: true })).toBeUndefined();
      expect(
        facts({ ...shape, created: { ...item, id: "x" } }),
      ).toBeUndefined();
      expect(
        facts({ ...shape, created: { ...item, kind: "agent" } }),
      ).toBeUndefined();
      expect(facts({ ...shape, verified: false })).toBeUndefined();
      expect(facts({ ...shape, undoToken: 7 })).toBeUndefined();
    }
    const event = tool("calendar_create_event").facts!;
    const reminder = tool("reminders_create").facts!;
    const draft = tool("mail_draft").facts!;
    const base = { verified: true, undoToken: "t" };
    expect(
      event({
        ...base,
        created: {
          kind: "event",
          title: 1,
          start: "s",
          end: "e",
          allDay: false,
          calendar: "c",
        },
      }),
    ).toBeUndefined();
    expect(
      event({
        ...base,
        created: {
          kind: "event",
          title: "t",
          start: "s",
          end: "e",
          allDay: "no",
          calendar: "c",
        },
      }),
    ).toBeUndefined();
    expect(
      reminder({
        ...base,
        created: { kind: "reminder", title: "t", list: "l" },
      }),
    ).toEqual({ kind: "reminder", title: "t", list: "l" });
    expect(
      reminder({
        ...base,
        created: { kind: "reminder", title: "t", list: "l", due: 5 },
      }),
    ).toBeUndefined();
    expect(
      draft({
        ...base,
        created: { kind: "draft", subject: "s", recipients: 1.5 },
      }),
    ).toBeUndefined();
    expect(
      draft({
        ...base,
        created: { kind: "draft", subject: "s", recipients: -1 },
      }),
    ).toBeUndefined();
    for (const bad of [null, [], "created", { created: null, ...base }])
      expect(event(bad)).toBeUndefined();
  });

  it("has a recorded call for every tool, a refusal for every code the docs list, and no mail_send", () => {
    const names = new Set(calls.map((c) => c.name));
    for (const name of Object.keys(APPLE.tools))
      expect(names.has(name)).toBe(true);
    const refusals = new Set(
      calls
        .filter((c) => c.result?.isError === true)
        .map((c) => {
          const [block] = c.result!.content as { text: string }[];
          return block.text.split(":")[0];
        }),
    );
    for (const code of [
      "BAD_ARGS",
      "NO_ACCESS",
      "NO_CALENDAR",
      "NO_LIST",
      "NO_FOLDER",
      "DUPLICATE",
      "READBACK_MISMATCH",
      "NOT_CREATED_HERE",
    ])
      expect(refusals.has(code), code).toBe(true);
    const sendAttempt = calls.find((c) => c.name === "mail_send");
    expect(sendAttempt).toBeDefined();
    expect(sendAttempt!.result).toBeUndefined();
  });
});
