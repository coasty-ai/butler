import { supportedKeys } from "../core/schema";

/*
 * How an action travels in a provider reply.
 *
 * Live 2026-09-19, two gpt-5.4-mini cycles (17c6e7f and 0063849): 11 of 733
 * model calls came back HTTP 200, status completed, 100 to 540 output tokens,
 * with "The action arguments were not valid JSON." The tool's schema asked
 * for action_json, a JSON-encoded string, so OpenAI's strict mode could only
 * guarantee the outer object {"action_json": "..."}; what the model wrote
 * inside the string was free text, and a quote or newline it did not escape
 * broke the inner parse. 9 of the 11 were Finder tasks, whose labels and paths
 * carry quotes. Neither the two-part request (aac7622) nor the tools
 * paragraph (443d51e) moved the per-task rate (files-new-folder-move 2 of 8
 * calls before them, 1 of 8 after; files-sort-by-type 1 of 55, then 1 of 25
 * and 2 of 18).
 *
 * The fix has three parts. OpenAI now gets the action itself as the tool's
 * strict schema (strictActionParameters), so the arguments are the action and
 * are guaranteed to parse and to match the schema
 * (developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
 * and developers.openai.com/api/docs/guides/function-calling, "Strict mode").
 * Every provider's reply goes through one repair pass before it is called
 * malformed (repairJsonObject). And a reply that still fails is described by
 * shape alone (describeArguments): counts, flags and a fixed parse-error code,
 * never the text, so the next cycle shows the mechanism.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/*
 * The strict subset, from the structured-outputs guide: the root is an object
 * (never anyOf), every property is required, an optional field is a type
 * union with null, every object sets additionalProperties false, the types
 * are string, number, integer, boolean, object, array, enum and anyOf, at
 * most 10 levels and 1000 enum values in all, and allOf, not and if/then/else
 * are not supported. Of the constraints the guide lists as supported only
 * minimum/maximum and minItems/maxItems are used; string lengths and
 * patterns stay with the zod schema, which validates every action in the
 * runner regardless. A free-form object is not expressible (every object
 * must list its properties), so tool_call carries its arguments as one
 * JSON-encoded string, args_json, which normalizeActionObject decodes. Keys
 * are emitted in schema order, so type comes first and frame_id second.
 */
// The instruction already documents every action, its fields and their
// ranges; the schema repeats only what the grammar cannot say on its own and
// stays short, since it rides in the cached prefix of every request.
const frameId = {
  type: "string",
  description: "The frame_id from the current context.",
};
const unit = {
  type: "number",
  minimum: 0,
  maximum: 1,
  description: "Fraction of the screenshot, 0 to 1.",
};
const integer = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const string = { type: "string" };
const nullable = <T extends { type: string }>(schema: T) => ({
  ...schema,
  type: [schema.type, "null"],
});
const key = { type: "string", enum: [...supportedKeys] };
const button = { type: "string", enum: ["left", "right"] };
// Every action may carry a note (schema base.note): a value read on this
// screen for a later step. Strict mode has no optional field, so it is a
// null union; normalizeActionObject drops the null.
const note = nullable({
  type: "string",
  description:
    "A value read on this screen that a later step must type or compare (at most 200 characters), or null.",
});
const variant = (type: string, properties: Json) => ({
  type: "object",
  properties: {
    type: { type: "string", enum: [type] },
    frame_id: frameId,
    ...properties,
    note,
  },
  required: ["type", "frame_id", ...Object.keys(properties), "note"],
  additionalProperties: false,
});

/** The action tool's parameters for OpenAI's strict function calling. */
export const strictActionParameters = {
  type: "object",
  properties: {
    action: {
      description: "Exactly one action, with only its own fields.",
      anyOf: [
        variant("capture", {}),
        variant("click", { x: unit, y: unit, button }),
        variant("double_click", { x: unit, y: unit, button }),
        variant("right_click", { x: unit, y: unit }),
        variant("move", { x: unit, y: unit }),
        variant("drag", {
          start_x: unit,
          start_y: unit,
          end_x: unit,
          end_y: unit,
          duration_ms: integer(100, 2000),
        }),
        variant("scroll", {
          delta_x: integer(-1000, 1000),
          delta_y: integer(-1000, 1000),
        }),
        variant("type_text", { text: string }),
        variant("key", { key }),
        variant("hotkey", {
          keys: { type: "array", items: key, minItems: 1, maxItems: 4 },
        }),
        variant("menu_item", {
          path: { type: "array", items: string, minItems: 2, maxItems: 3 },
        }),
        variant("click_control", {
          label: {
            type: "string",
            description: "The label text from context.controls, never a role.",
          },
          role: nullable(string),
          x: nullable(unit),
          y: nullable(unit),
        }),
        variant("open_app", { name: string }),
        variant("open_file", { path: string, app: nullable(string) }),
        variant("monitor", {
          reason: string,
          every_s: integer(5, 60),
          max_min: integer(1, 180),
          until: { type: "string", enum: ["done", "input", "change"] },
        }),
        variant("tool_call", {
          tool: string,
          args_json: {
            type: "string",
            description:
              'The tool\'s arguments as one JSON-encoded object, "{}" when it takes none.',
          },
          finish: { type: "boolean" },
        }),
        variant("wait", { milliseconds: integer(0, 5000) }),
        variant("request_user", { reason: string }),
        variant("done", { summary: string }),
        variant("fail", { reason: string }),
      ],
    },
  },
  required: ["action"],
  additionalProperties: false,
};

/**
 * The content-free shape of arguments that were not valid JSON: how long,
 * whether they look like an object, what the parser objected to and where,
 * how many braces, quotes, backslashes, newlines and backticks they hold,
 * how many complete top-level objects they contain, whether they end inside
 * an open object or string, and how much non-JSON text stands before and
 * after the object. Never a character of the text itself.
 */
export interface ArgumentShape {
  length: number;
  startsWithBrace: boolean;
  endsWithBrace: boolean;
  /** A fixed code for the parser's complaint; absent when the text parsed. */
  parseError?: string;
  /** The parser's offset, when its message gives one. */
  parseOffset?: number;
  openBraces: number;
  closeBraces: number;
  quotes: number;
  backslashes: number;
  newlines: number;
  backticks: number;
  /** Control characters other than tab and newline. */
  controls: number;
  /** Complete top-level objects, quotes respected. */
  objects: number;
  /** Open braces left at the end: above zero, the text was cut. */
  depthAtEnd: number;
  /** Ended inside a string: a newline or quote the model did not escape, or a cut. */
  quotedAtEnd: boolean;
  /** Non-whitespace characters before the first object, code fences aside. */
  leadingProse: number;
  /** Non-whitespace characters after the first complete object, code fences aside. */
  trailingProse: number;
}

interface Scan {
  spans: { start: number; end: number }[];
  /** Where the first top-level object opened; the text's length when none did. */
  firstBrace: number;
  depth: number;
  quoted: boolean;
}
/** Top-level objects by brace balance, with quotes respected inside them. */
function scanObjects(text: string): Scan {
  const spans: Scan["spans"] = [];
  let depth = 0,
    start = -1,
    firstBrace = text.length,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = depth > 0;
    else if (c === "{") {
      if (depth++ === 0) {
        start = i;
        if (firstBrace === text.length) firstBrace = i;
      }
    } else if (c === "}" && depth > 0 && --depth === 0)
      spans.push({ start, end: i + 1 });
  }
  return { spans, firstBrace, depth, quoted };
}

/** The parser's complaint as one of a fixed set of codes, never its message. */
function parseErrorCode(message: string): string {
  const rules: [RegExp, string][] = [
    [/bad control character/i, "BAD_CONTROL_CHARACTER"],
    [/unterminated string/i, "UNTERMINATED_STRING"],
    [/bad escaped character|bad unicode escape/i, "BAD_ESCAPE"],
    [/unexpected end of/i, "UNEXPECTED_END"],
    [/after JSON/i, "TRAILING_CONTENT"],
    [/expected (double-quoted )?property name/i, "EXPECTED_PROPERTY_NAME"],
    [/expected ',' or '}'/i, "EXPECTED_COMMA_OR_BRACE"],
    [/expected ',' or '\]'/i, "EXPECTED_COMMA_OR_BRACKET"],
    [/unexpected token/i, "UNEXPECTED_TOKEN"],
    [/number|exponent|minus|fraction/i, "BAD_NUMBER"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "OTHER";
}

const occurrences = (text: string, pattern: RegExp) =>
  (text.match(pattern) ?? []).length;
/** Characters of a span that are neither whitespace nor code-fence markup. */
const prose = (span: string) =>
  span.replace(/```[a-z]*|`/gi, "").replace(/\s+/g, "").length;

export function describeArguments(text: string): ArgumentShape {
  const scan = scanObjects(text);
  let parseError: string | undefined, parseOffset: number | undefined;
  try {
    JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    parseError = parseErrorCode(message);
    const at = /at position (\d+)/.exec(message);
    if (at) parseOffset = Number(at[1]);
  }
  const trimmed = text.trim();
  const first = scan.spans[0];
  return {
    length: text.length,
    startsWithBrace: trimmed.startsWith("{"),
    endsWithBrace: trimmed.endsWith("}"),
    ...(parseError !== undefined && { parseError }),
    ...(parseOffset !== undefined && { parseOffset }),
    openBraces: occurrences(text, /\{/g),
    closeBraces: occurrences(text, /\}/g),
    quotes: occurrences(text, /"/g),
    backslashes: occurrences(text, /\\/g),
    newlines: occurrences(text, /\n/g),
    backticks: occurrences(text, /`/g),
    controls: occurrences(text, /[ --]/g),
    objects: scan.spans.length,
    depthAtEnd: scan.depth,
    quotedAtEnd: scan.quoted,
    leadingProse: prose(text.slice(0, scan.firstBrace)),
    trailingProse: first ? prose(text.slice(first.end)) : 0,
  };
}

export type Repair =
  | { object: Json; repaired: boolean; problem?: undefined; shape?: undefined }
  | {
      object?: undefined;
      repaired?: undefined;
      problem: "badJson" | "multiple";
      shape: ArgumentShape;
    };
/**
 * The one JSON object in a model's text. Text that parses as an object is
 * taken as sent. Otherwise the repair pass strips whatever stands around
 * exactly one balanced top-level object (a code fence, prose, a stray brace)
 * and parses that, flagged repaired so the runner knows it is a guess. Two
 * complete objects are more than one action; an object left open or a
 * string left unterminated is a cut reply; a list or a scalar is not an
 * action. Each of those fails with its shape.
 */
export function repairJsonObject(text: string): Repair {
  let parsed: unknown,
    clean = false;
  try {
    parsed = JSON.parse(text);
    clean = true;
  } catch {}
  if (clean) {
    if (isObject(parsed)) return { object: parsed, repaired: false };
    return { problem: "badJson", shape: describeArguments(text) };
  }
  const scan = scanObjects(text);
  if (scan.spans.length > 1)
    return { problem: "multiple", shape: describeArguments(text) };
  const [span] = scan.spans;
  if (span && scan.depth === 0 && !scan.quoted) {
    try {
      const object = JSON.parse(text.slice(span.start, span.end));
      if (isObject(object)) return { object, repaired: true };
    } catch {}
  }
  return { problem: "badJson", shape: describeArguments(text) };
}

/** The only object in text, or undefined; repairJsonObject without the why. */
export function singleJsonObject(text: string): unknown {
  return repairJsonObject(text).object;
}

export type Normalized =
  | { action: Json; repaired: boolean; shape?: undefined }
  | { action?: undefined; repaired?: undefined; shape: ArgumentShape };
/**
 * An action object as the runner expects it. A strict schema makes the model
 * write null for an optional field it leaves out (role, x, y, app); the zod
 * schema knows those fields as absent, so nulls are dropped. tool_call's
 * arguments arrive as args_json, one JSON-encoded object, and are decoded
 * with the same repair pass; anything but an object there is the reply's
 * fault and comes back as its shape.
 */
export function normalizeActionObject(object: Json): Normalized {
  const action: Json = Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null),
  );
  if (typeof action.args_json !== "string" || action.args !== undefined)
    return { action, repaired: false };
  const { args_json, ...rest } = action;
  const args = repairJsonObject(args_json);
  if (!args.object) return { shape: args.shape };
  return { action: { ...rest, args: args.object }, repaired: args.repaired };
}
