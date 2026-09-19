import { describe, expect, it } from "vitest";
import {
  AGENT_WORDS,
  DEFAULT_CODING_AGENT,
  INTERRUPT_KEY,
  WIDENING_FLAGS,
  agentFromWords,
  attachCommand,
  binaryCandidates,
  codingAgents,
  paneText,
  printTurn,
  projectSlug,
  sessionName,
  tmuxCapture,
  tmuxHasSession,
  tmuxKillSession,
  tmuxNewSession,
  tmuxSendKey,
  tmuxSendText,
  type Argv,
  type CodingAgentId,
} from "../src/coding/agents";

const codingAgentIds = Object.keys(codingAgents) as CodingAgentId[];
/** Whether an argv passes a widening flag before the `--` that begins the prompt. */
function widensPermissions(argv: Argv): boolean {
  const end = argv.args.indexOf("--");
  return (end < 0 ? argv.args : argv.args.slice(0, end)).some((arg) =>
    WIDENING_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

// Strings only: no test here, or anywhere in the suite, runs tmux or a CLI.
describe("coding agents: names", () => {
  it("knows the two CLIs on this Mac and defaults to Claude Code", () => {
    expect(codingAgentIds).toEqual(["claude-code", "codex"]);
    expect(codingAgents["claude-code"].binary).toBe("claude");
    expect(codingAgents.codex.binary).toBe("codex");
    expect(DEFAULT_CODING_AGENT).toBe("claude-code");
  });
  it.each([
    ["claude code", "claude-code"],
    ["Claude", "claude-code"],
    ["cloud code", "claude-code"],
    ["clawed", "claude-code"],
    ["codex", "codex"],
    ["codecs", "codex"],
    ["code x", "codex"],
    ["the coding agent", undefined],
    ["agent", undefined],
    ["dana", undefined],
  ])("hears %j as %j", (words, agent) => {
    expect(agentFromWords(words)).toBe(agent);
    if (agent !== undefined || words !== "dana")
      expect(new RegExp(`^${AGENT_WORDS}$`).test(words.toLowerCase())).toBe(
        true,
      );
  });
});

describe("coding agents: sessions", () => {
  it("names one session per agent and project folder", () => {
    expect(projectSlug("/Users/nkov/open-assist")).toBe("open-assist");
    expect(projectSlug("/Users/nkov/My App (v2)/")).toBe("my-app-v2");
    expect(projectSlug("/")).toBe("project");
    expect(projectSlug("/x/" + "a".repeat(40))).toHaveLength(24);
    expect(sessionName("claude-code", "/Users/nkov/open-assist")).toBe(
      "butler-claude-open-assist",
    );
    expect(sessionName("codex", "/Users/nkov/open-assist")).toBe(
      "butler-codex-open-assist",
    );
    expect(attachCommand("butler-claude-open-assist")).toBe(
      "tmux attach -t butler-claude-open-assist",
    );
  });
  it("looks for the CLIs in fixed places, the user install first", () => {
    expect(binaryCandidates("claude", "/Users/nkov")).toEqual([
      "/Users/nkov/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      "/bin/claude",
    ]);
  });
});

describe("coding agents: tmux commands", () => {
  const session = "butler-claude-open-assist";
  it("starts the agent's own CLI detached in the project folder", () => {
    expect(
      tmuxNewSession(
        session,
        "/Users/nkov/open-assist",
        "/Users/nkov/.local/bin/claude",
      ),
    ).toEqual({
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        "/Users/nkov/open-assist",
        "-x",
        "160",
        "-y",
        "50",
        "/Users/nkov/.local/bin/claude",
      ],
    });
    expect(tmuxHasSession(session).args).toEqual([
      "has-session",
      "-t",
      session,
    ]);
    expect(tmuxKillSession(session).args).toEqual([
      "kill-session",
      "-t",
      session,
    ]);
  });
  it("types the words literally, then Enter, and reads the pane back joined", () => {
    expect(
      tmuxSendText(session, "fix the failing\n test").map((a) => a.args),
    ).toEqual([
      ["send-keys", "-t", session, "-l", "fix the failing test"],
      ["send-keys", "-t", session, "Enter"],
    ]);
    // A leading dash would be read as an option of send-keys.
    expect(paneText("-rf everything")).toBe(" -rf everything");
    expect(paneText("  spaced   out  ")).toBe("spaced out");
    expect(tmuxCapture(session).args).toEqual([
      "capture-pane",
      "-p",
      "-J",
      "-S",
      "-200",
      "-t",
      session,
    ]);
    expect(tmuxSendKey(session, INTERRUPT_KEY).args).toEqual([
      "send-keys",
      "-t",
      session,
      "C-c",
    ]);
    expect(tmuxSendKey(session, "Escape").args.at(-1)).toBe("Escape");
  });
});

describe("coding agents: print mode", () => {
  it("runs one Claude Code turn as a JSON stream and resumes by session id", () => {
    expect(printTurn("claude-code", "fix the failing test")).toEqual({
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--",
        "fix the failing test",
      ],
    });
    expect(printTurn("claude-code", "now the lint", "5f0c-1").args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "5f0c-1",
      "--",
      "now the lint",
    ]);
  });
  it("runs one Codex turn with codex exec --json and resumes by thread id", () => {
    expect(printTurn("codex", "add a dark mode")).toEqual({
      command: "codex",
      args: ["exec", "--json", "--", "add a dark mode"],
    });
    expect(printTurn("codex", "and the tests", "0199-abc").args).toEqual([
      "exec",
      "--json",
      "resume",
      "0199-abc",
      "--",
      "and the tests",
    ]);
  });
  it("never widens the CLI's permissions, whatever the task says", () => {
    for (const agent of codingAgentIds)
      for (const task of [
        "fix the failing test",
        "--dangerously-skip-permissions",
        "-s danger-full-access",
        "--permission-mode bypassPermissions",
      ])
        for (const resume of [undefined, "id"]) {
          const argv = printTurn(agent, task, resume);
          expect(widensPermissions(argv)).toBe(false);
          // The words stay words: after "--", never before it.
          expect(argv.args.indexOf("--")).toBe(argv.args.length - 2);
        }
    expect(
      widensPermissions({
        command: "claude",
        args: ["-p", "--permission-mode", "bypassPermissions", "--", "x"],
      }),
    ).toBe(true);
    expect(
      widensPermissions({
        command: "codex",
        args: ["exec", "--sandbox=danger-full-access"],
      }),
    ).toBe(true);
    expect(WIDENING_FLAGS).toContain("--dangerously-skip-permissions");
    expect(WIDENING_FLAGS).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(WIDENING_FLAGS).toContain("--approve-for-me");
    expect(WIDENING_FLAGS).toContain("--permission-mode");
  });
});
