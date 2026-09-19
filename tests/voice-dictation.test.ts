import { describe, expect, it } from "vitest";
import { dictationRequest, normalizeDictation } from "../src/voice/dictation";

describe("normalizeDictation", () => {
  it.each([
    ["hello world", "Hello world"],
    ["see you at six comma maybe seven period", "See you at six, maybe seven."],
    ["is that right question mark", "Is that right?"],
    ["stop it exclamation mark", "Stop it!"],
    ["wow exclamation point", "Wow!"],
    ["done full stop next", "Done. Next"],
    ["note colon buy milk semicolon eggs", "Note: buy milk; eggs"],
    ["first line new line second line", "First line\nSecond line"],
    ["first line line break second line", "First line\nSecond line"],
    ["first new paragraph second", "First\n\nSecond"],
    ["six dash maybe seven", "Six — maybe seven"],
    ["well hyphen known", "Well-known"],
    ["he said open quote hello close quote", 'He said "hello"'],
    ["he said quote hello unquote period", 'He said "hello".'],
    ["quote hi quote there", '"Hi" there'],
    ["begin quote yes end quote comma she said", '"Yes", she said'],
    // Sentence capitals only: names, "I" and digits stay as heard.
    ["i'll be there", "I'll be there"],
    ["Hello. how are you", "Hello. How are you"],
    ["thanks Dana period see you", "Thanks Dana. See you"],
    ["github.com slash butler", "github.com slash butler"],
    ["6pm works", "6pm works"],
    // Numbers stay as the recognizer wrote them.
    ["we need 3 eggs and six apples", "We need 3 eggs and six apples"],
    ["meet at 6 period 30 people", "Meet at 6. 30 people"],
    // Spoken marks are words, whatever their case.
    ["Hello Comma world Period", "Hello, world."],
    ["  spaced   out  ", "Spaced out"],
    ["comma", ","],
    ["", ""],
  ])("%j → %j", (spoken, written) => {
    expect(normalizeDictation(spoken)).toBe(written);
  });
});

describe("dictationRequest", () => {
  it.each([
    ["type hello world", "Hello world"],
    ["Type hello world", "Hello world"],
    ["please type hello world", "Hello world"],
    ["okay so can you type hello world", "Hello world"],
    ["Hey Butler type hello world", "Hello world"],
    ["type: hello", "Hello"],
    ["type, hello", "Hello"],
    ["dictate see you at six comma maybe seven", "See you at six, maybe seven"],
    ["write see you at six", "See you at six"],
    ["write 'see you at six'", "See you at six"],
    ["write “back in five”.", "Back in five"],
    ["write down milk and eggs", "Milk and eggs"],
    ["write down the milk", "The milk"],
    ["type the quick brown fox", "The quick brown fox"],
    ["type that I'll be late", "That I'll be late"],
    ["type meet me in the lobby at six", "Meet me in the lobby at six"],
    ["type I'm in", "I'm in"],
    // Quotes make the words the text, whatever they say.
    ["type 'see you in the office'", "See you in the office"],
    ["write 'an email to Dana'", "An email to Dana"],
    ["type hello new line world", "Hello\nWorld"],
  ])("%j types %j", (said, typed) => {
    expect(dictationRequest(said)).toBe(typed);
  });

  it.each([
    // A destination is a task for the model.
    "write 'see you at six' in the note",
    "write see you at six in the note",
    "type hello world in Notes",
    "type hello into Slack",
    "type hello on the page",
    "type in Notes hello",
    "type into the search box hello",
    "write to Dana hello",
    // Something to compose, not words to put down.
    "write an email to Dana",
    "write a reply",
    "write me a poem",
    "write the summary",
    "write back",
    "write up the meeting",
    "type up my notes",
    "write it",
    // A pointer alone.
    "type it",
    "type that",
    "type that again",
    "type the same",
    "type this",
    // A secret stays with the model and its refusals.
    "type my password",
    "type the pin 1234",
    "type hunter2 as the passcode",
    // No text, or no dictation verb.
    "type",
    "type.",
    "write",
    "typewriter hello",
    "types of fish",
    "open Notes and type hello",
    "send hello to Dana",
    "hello world",
    "",
  ])("%j stays a task", (said) => {
    expect(dictationRequest(said)).toBeUndefined();
  });

  it("applies the wake-phrase restart before reading the words", () => {
    expect(dictationRequest("open Notes hey butler type hello")).toBe("Hello");
  });

  it("never exceeds the type_text limit", () => {
    expect(dictationRequest(`type ${"a ".repeat(900)}`)).toHaveLength(1799);
    expect(dictationRequest(`type ${"a ".repeat(1200)}`)).toBeUndefined();
  });
});
