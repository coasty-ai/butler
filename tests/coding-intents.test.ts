import { describe, expect, it } from "vitest";
import { codingRequest } from "../src/coding/intents";
import { voiceIntent } from "../src/voice/turns";

describe("coding requests: handing work over", () => {
  it.each([
    [
      "Ask Claude Code to fix the failing test in open-assist",
      "claude-code",
      "fix the failing test in open-assist",
      { name: "open-assist", task: "fix the failing test" },
    ],
    [
      "have Codex add a dark mode to the settings page",
      "codex",
      "add a dark mode to the settings page",
      undefined,
    ],
    [
      "tell claude to add a dark mode in the settings page, please",
      "claude-code",
      "add a dark mode in the settings page",
      { name: "settings page", task: "add a dark mode" },
    ],
    [
      "hey butler, could you get the coding agent to run the tests in my butler repo",
      undefined,
      "run the tests in my butler repo",
      { name: "butler", task: "run the tests" },
    ],
    [
      "delegate the lint cleanup to codecs",
      "codex",
      "the lint cleanup",
      undefined,
    ],
    [
      "Claude Code, rename the helper in ~/code/app",
      "claude-code",
      "rename the helper in ~/code/app",
      { name: "~/code/app", task: "rename the helper" },
    ],
  ])("%j", (text, agent, task, place) => {
    const r = codingRequest(text)!;
    expect(r).toBeDefined();
    expect(r.kind).toBe("delegate");
    if (r.kind !== "delegate") return;
    expect(r.agent).toBe(agent);
    expect(r.task).toBe(task);
    expect(r.place).toEqual(place);
  });
  it("keeps the owner's casing and words in the task", () => {
    const r = codingRequest(
      "ask Claude Code to rename FooBar to BazQux in Butler",
    );
    expect(r).toMatchObject({
      kind: "delegate",
      task: "rename FooBar to BazQux in Butler",
      place: { name: "Butler", task: "rename FooBar to BazQux" },
    });
  });
});

describe("coding requests: steering", () => {
  it.each([
    ["what's the coding agent doing?", { kind: "status", pronoun: false }],
    [
      "What is Claude Code doing right now",
      { kind: "status", agent: "claude-code" },
    ],
    ["how's codex getting on", { kind: "status", agent: "codex" }],
    ["is it done yet?", { kind: "status", pronoun: true }],
    ["what's it doing", { kind: "status", pronoun: true }],
    // "It" is the coding agent only while one is at work and no run is;
    // main.ts hands these back to the router otherwise.
    ["how's it going", { kind: "status", pronoun: true }],
    ["codex status", { kind: "status", agent: "codex" }],
    ["read me the summary", { kind: "summary", pronoun: false }],
    ["what did claude code say?", { kind: "summary", agent: "claude-code" }],
    ["what did it find", { kind: "summary", pronoun: true }],
    ["summary", { kind: "summary" }],
    ["tell it yes", { kind: "answer", yes: true, pronoun: true }],
    ["Tell it no.", { kind: "answer", yes: false, pronoun: true }],
    [
      "tell claude code yes",
      { kind: "answer", yes: true, agent: "claude-code" },
    ],
    ["tell codex to go ahead", { kind: "answer", yes: true, agent: "codex" }],
    ["tell it not to", { kind: "answer", yes: false, pronoun: true }],
    ["say no to it", { kind: "answer", yes: false, pronoun: true }],
    ["let it proceed", { kind: "answer", yes: true, pronoun: true }],
    ["don't let it", { kind: "answer", yes: false, pronoun: true }],
    [
      "answer yes to the coding agent",
      { kind: "answer", yes: true, pronoun: false },
    ],
    [
      "tell it to use the other approach",
      { kind: "tell", text: "use the other approach", pronoun: true },
    ],
    [
      "tell Claude Code that the tests live in tests/",
      { kind: "tell", text: "the tests live in tests/", agent: "claude-code" },
    ],
    ["tell it two", { kind: "tell", text: "two", pronoun: true }],
    [
      "tell it not to delete anything",
      { kind: "tell", text: "not to delete anything", pronoun: true },
    ],
    ["stop the coding agent", { kind: "interrupt", pronoun: false }],
    ["tell it to stop", { kind: "interrupt", pronoun: true }],
    ["interrupt codex", { kind: "interrupt", agent: "codex" }],
    ["quit the coding agent", { kind: "quit", pronoun: false }],
    ["close the claude code session", { kind: "quit", agent: "claude-code" }],
    ["tell it to quit", { kind: "quit", pronoun: true }],
    ["end the coding session", { kind: "quit", pronoun: false }],
  ])("%j", (text, expected) => {
    expect(codingRequest(text)).toMatchObject(expected);
  });
});

describe("coding requests: what is not one", () => {
  it.each([
    "yes",
    "no",
    "go ahead",
    "stop",
    "open Safari",
    "tell Dana I'm running late",
    "text Dana that I'm late",
    "what are you doing",
    "how are things going",
    "ask her to call me back",
    "have a look at my calendar",
    "the agent said no",
    "let's code",
    "",
  ])("%j is for the router", (text) => {
    expect(codingRequest(text)).toBeUndefined();
  });
  it("never turns a bare yes or no into a coding answer, and the router still hears them as approvals", () => {
    for (const word of ["yes", "yeah", "no", "nope", "sure", "go ahead"]) {
      expect(codingRequest(word)).toBeUndefined();
      expect(["approve", "decline"]).toContain(voiceIntent(word).kind);
    }
  });
  it("leaves Butler's own stop and pause to the router", () => {
    expect(codingRequest("stop")).toBeUndefined();
    expect(codingRequest("wait a second")).toBeUndefined();
    expect(voiceIntent("stop the coding agent").kind).toBe("command");
  });
});
