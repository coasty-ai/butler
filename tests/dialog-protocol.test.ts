import { describe, expect, it } from "vitest";
import {
  DIALOG_ACTS,
  DialogParser,
  SAY_MAX,
  SENTENCE_SOFT_MAX,
  type DialogEvent,
} from "../src/assistant/protocol";

/** Feeds the text in pieces and collects every event, end included. */
function parse(text: string, pieces = [text]): DialogEvent[] {
  const parser = new DialogParser();
  const events: DialogEvent[] = [];
  for (const piece of pieces) events.push(...parser.push(piece));
  events.push(...parser.end());
  return events;
}
const split = (text: string, at: number) => [text.slice(0, at), text.slice(at)];
const heads = (events: DialogEvent[]) =>
  events.filter((e) => e.type === "head").map((e) => e.head);
const sentences = (events: DialogEvent[]) =>
  events.filter((e) => e.type === "sentence").map((e) => e.text);
const invalid = (events: DialogEvent[]) =>
  events.find((e) => e.type === "invalid")?.code;

describe("dialog protocol parser", () => {
  const reply =
    "ACT: start\nTASK: Play something mellow on Spotify\nSAY: Finding you something mellow. Back in a moment.";

  it("parses ACT, TASK and SAY split at every byte boundary", () => {
    const whole = parse(reply);
    expect(heads(whole)).toEqual([
      { act: "start", task: "Play something mellow on Spotify" },
    ]);
    expect(sentences(whole)).toEqual([
      "Finding you something mellow.",
      "Back in a moment.",
    ]);
    expect(whole.at(-1)).toEqual({
      type: "end",
      say: "Finding you something mellow. Back in a moment.",
    });
    for (let at = 1; at < reply.length; at++) {
      const events = parse(reply, split(reply, at));
      expect([at, heads(events)]).toEqual([at, heads(whole)]);
      expect([at, sentences(events)]).toEqual([at, sentences(whole)]);
      expect(invalid(events)).toBeUndefined();
    }
    // Character by character, too.
    expect(sentences(parse(reply, [...reply]))).toEqual(sentences(whole));
  });

  it("emits the head the moment SAY begins, before the reply is finished", () => {
    const parser = new DialogParser();
    expect(parser.push("ACT: answer\nSAY: It is")).toEqual([
      { type: "head", head: { act: "answer" } },
    ]);
    expect(parser.push(" three. More")).toEqual([
      { type: "sentence", text: "It is three." },
    ]);
    expect(parser.end()).toEqual([
      { type: "sentence", text: "More" },
      { type: "end", say: "It is three. More" },
    ]);
  });

  it("rejects a missing or unknown ACT within 40 characters", () => {
    expect(
      invalid(parse("Sure! Here is what I will do for you today, friend.")),
    ).toBe("no_act");
    expect(invalid(parse("ACT: approve\nSAY: Done."))).toBe("bad_act");
    expect(invalid(parse("ACT: stop\nSAY: Stopping."))).toBe("bad_act");
    expect(invalid(parse("ACT: decline\nSAY: No."))).toBe("bad_act");
    // Prose that never ends its first line is not waited for.
    const parser = new DialogParser();
    expect(
      parser.push("I think the best thing to do here would be to"),
    ).toEqual([{ type: "invalid", code: "no_act" }]);
    expect(parser.push("ACT: none\nSAY: hi")).toEqual([]);
    for (const act of DIALOG_ACTS)
      expect(["approve", "decline", "stop"]).not.toContain(act);
  });

  it("requires TASK only for task acts and ignores it otherwise", () => {
    expect(invalid(parse("ACT: start\nSAY: On my way."))).toBe("bad_task");
    expect(invalid(parse("ACT: queue\nSAY: Later."))).toBe("bad_task");
    expect(invalid(parse("ACT: revise\nTASK:\nSAY: Changing."))).toBe(
      "bad_task",
    );
    expect(
      invalid(parse(`ACT: start\nTASK: ${"x".repeat(501)}\nSAY: Go.`)),
    ).toBe("bad_task");
    const ignored = parse("ACT: answer\nTASK: Open Mail\nSAY: It is four.");
    expect(heads(ignored)).toEqual([{ act: "answer" }]);
    expect(invalid(ignored)).toBeUndefined();
    // A task act that ends before SAY still needs its task.
    expect(invalid(parse("ACT: start"))).toBe("bad_task");
    expect(heads(parse("ACT: pause"))).toEqual([{ act: "pause" }]);
  });

  it("emits sentences at boundaries but not after abbreviations or initials", () => {
    expect(
      sentences(
        parse(
          "ACT: answer\nSAY: Dr. Lee called at 3. The U.S. office is closed! Anything else?",
        ),
      ),
    ).toEqual([
      "Dr. Lee called at 3.",
      "The U.S. office is closed!",
      "Anything else?",
    ]);
    // Newlines inside SAY join into spaces.
    expect(
      sentences(parse("ACT: none\nSAY: One line.\nAnother line.")),
    ).toEqual(["One line.", "Another line."]);
  });

  it("soft-cuts a run-on at a comma once it passes the limit", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const runOn =
      words.slice(0, 20).join(" ") + ", " + words.slice(20).join(" ");
    const events = parse(`ACT: answer\nSAY: ${runOn}`);
    const [first] = sentences(events);
    expect(first.length).toBeLessThanOrEqual(SENTENCE_SOFT_MAX);
    expect(first.endsWith("word19")).toBe(true);
    expect(invalid(events)).toBeUndefined();
  });

  it("stops at the size cap with too_long", () => {
    const events = parse(`ACT: answer\nSAY: ${"Words and more. ".repeat(100)}`);
    expect(invalid(events)).toBe("too_long");
    expect(events.filter((e) => e.type === "end")).toEqual([]);
    expect(sentences(events).join(" ").length).toBeLessThanOrEqual(SAY_MAX);
  });

  it("treats an empty SAY as no_say for answer and status only", () => {
    expect(invalid(parse("ACT: answer\nSAY:"))).toBe("no_say");
    expect(invalid(parse("ACT: status"))).toBe("no_say");
    expect(parse("ACT: none\nSAY:").at(-1)).toEqual({ type: "end", say: "" });
    expect(parse("ACT: resume").at(-1)).toEqual({ type: "end", say: "" });
  });

  it("ignores code fences and Windows line endings", () => {
    const events = parse(
      "```\r\nACT: revise\r\nTASK: Make it Saturday\r\nSAY: Switching to Saturday.\r\n```\r\n",
    );
    expect(heads(events)).toEqual([
      { act: "revise", task: "Make it Saturday" },
    ]);
    expect(sentences(events)).toEqual(["Switching to Saturday."]);
  });

  it("produces nothing more once it has ended", () => {
    const parser = new DialogParser();
    parser.push("ACT: none\nSAY: Hi.\n");
    expect(parser.end().at(-1)).toEqual({ type: "end", say: "Hi." });
    expect(parser.push("SAY: more")).toEqual([]);
    expect(parser.end()).toEqual([]);
  });
});
