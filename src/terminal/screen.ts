import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

export type Phase = "idle" | "thinking" | "working" | "briefing" | "speaking";
export interface ScreenState {
  phase: Phase;
  model: string;
  connections: string[];
  nextBriefing: string;
  messages: { who: string; text: string }[];
  status: string;
}
export function terminalText(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[^\n]*/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "  ");
}
export function wrapText(value: string, width: number): string[] {
  const out: string[] = [];
  for (const line of terminalText(value).split("\n")) {
    let rest = Array.from(line);
    do {
      out.push(rest.slice(0, width).join(""));
      rest = rest.slice(width);
    } while (rest.length);
  }
  return out;
}
/** Character-only orbital display; no images, browser, or Electron renderer. */
export function orbitalFrame(tick: number, active: boolean): string[] {
  const grid = Array.from({ length: 7 }, () => Array(23).fill(" "));
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 23; x++) {
      const radius = Math.hypot((x - 11) / 1.8, y - 3);
      if (Math.abs(radius - 3) < 0.4) grid[y][x] = ".";
      if (Math.abs(radius - 1.5) < 0.35) grid[y][x] = ":";
    }
  const angle = tick * (active ? 0.2 : 0.07);
  grid[Math.round(3 + Math.sin(angle) * 3)][
    Math.round(11 + Math.cos(angle) * 5.4)
  ] = "@";
  grid[3][11] = active ? ["*", "+", "o", "+"][tick % 4] : "o";
  return grid.map((row) => row.join(""));
}
export function screenLines(
  s: ScreenState,
  width: number,
  height: number,
  tick: number,
  input: string,
  prompt = "you",
  secret = false,
): string[] {
  width = Math.max(4, Math.min(width - 1, 140));
  const rule = "-".repeat(width);
  const orb = orbitalFrame(tick, s.phase !== "idle");
  const head =
    height < 23
      ? ["  B U T L E R   /   at your service"]
      : [
          "",
          "  B U T L E R   /   at your service",
          "  A little discretion. A great deal of capability.",
          "",
        ];
  const info = [
    s.phase.toUpperCase(),
    s.model,
    s.status,
    "",
    ...s.connections.slice(0, 3),
  ];
  const top =
    width >= 65 && height >= 23
      ? orb.map((line, i) => `  ${line}  ${info[i] ?? ""}`)
      : [`  ${s.phase.toUpperCase()}  ${s.status}`];
  const fixed = [
    ...head,
    ...top,
    rule,
    `  ${s.connections.join("  |  ") || "Connections: /connect"}`,
    `  Briefings: ${s.nextBriefing}`,
    rule,
  ];
  const body = s.messages.flatMap((m) => [
    `  ${m.who.toUpperCase()}`,
    ...wrapText(m.text, Math.max(1, width - 4)).map((line) => `  ${line}`),
    "",
  ]);
  const available = Math.max(1, height - fixed.length - 4);
  const tail = body.slice(-available);
  const shown = secret
    ? "*".repeat(Array.from(input).length)
    : terminalText(input);
  const prefix = `  ${prompt}> `;
  const inputLine =
    prefix +
    Array.from(shown)
      .slice(-Math.max(1, width - prefix.length))
      .join("");
  return [
    ...fixed,
    ...tail,
    ...Array(Math.max(0, available - tail.length)).fill(""),
    rule,
    inputLine,
    "  /help   /connect   /briefing   Ctrl-C interrupt   Ctrl-D quit",
  ]
    .slice(0, Math.max(1, height))
    .map((line) => Array.from(terminalText(line)).slice(0, width).join(""));
}

export class TerminalScreen {
  state: ScreenState = {
    phase: "idle",
    model: "",
    connections: [],
    nextBriefing: "off",
    messages: [],
    status: "Ready when you are.",
  };
  private tick = 0;
  private previous: string[] = [];
  private input = "";
  private timer?: ReturnType<typeof setInterval>;
  private question?: {
    label: string;
    secret: boolean;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  };
  private history: string[] = [];
  private historyAt = 0;
  private closed = false;
  private key = (
    text: string,
    key: { name?: string; ctrl?: boolean; sequence?: string },
  ) => {
    if (key.ctrl && key.name === "c") {
      this.input = "";
      this.question?.reject(new Error("Cancelled."));
      this.question = undefined;
      this.interrupt();
    } else if (key.ctrl && key.name === "d") {
      if (!this.input) this.quit();
    } else if (key.name === "return") {
      const value = this.input.trim();
      this.input = "";
      if (this.question) {
        const q = this.question;
        this.question = undefined;
        q.resolve(value);
      } else if (value) {
        this.history.push(value);
        this.historyAt = this.history.length;
        this.submit(value);
      }
    } else if (key.name === "backspace")
      this.input = Array.from(this.input).slice(0, -1).join("");
    else if (key.ctrl && key.name === "u") this.input = "";
    else if (!this.question && key.name === "up")
      this.input =
        this.history[(this.historyAt = Math.max(0, this.historyAt - 1))] ?? "";
    else if (!this.question && key.name === "down")
      this.input =
        this.history[
          (this.historyAt = Math.min(this.history.length, this.historyAt + 1))
        ] ?? "";
    else if (text && !key.ctrl && !text.startsWith("\x1b"))
      this.input = (this.input + terminalText(text).replace(/\n/g, " ")).slice(
        0,
        8192,
      );
    this.draw();
  };
  constructor(
    private submit: (value: string) => void,
    private interrupt: () => void,
    private quit: () => void,
    private output: WriteStream = process.stdout,
    private source: ReadStream = process.stdin,
  ) {}
  start() {
    if (!this.source.isTTY || !this.output.isTTY)
      throw new Error(
        "Interactive Butler needs a terminal. Use --ask, status, or daemon for non-interactive use.",
      );
    emitKeypressEvents(this.source);
    this.source.setRawMode(true);
    this.source.resume();
    this.source.on("keypress", this.key);
    this.output.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    this.timer = setInterval(() => {
      this.tick++;
      this.draw();
    }, 125);
    this.draw();
  }
  message(who: string, text: string) {
    this.state.messages.push({ who, text: terminalText(text) });
    this.state.messages = this.state.messages.slice(-100);
    if (!this.output.isTTY)
      this.output.write(`${who}: ${terminalText(text)}\n`);
    this.draw();
  }
  async ask(label: string, secret = false): Promise<string> {
    if (!this.source.isTTY || !this.timer)
      throw new Error(
        "Run this connection command in an interactive terminal.",
      );
    if (this.question)
      throw new Error("Please answer the current question first.");
    this.input = "";
    return new Promise((resolve, reject) => {
      this.question = { label, secret, resolve, reject };
      this.draw();
    });
  }
  draw() {
    if (this.closed || !this.output.isTTY || !this.timer) return;
    const lines = screenLines(
      this.state,
      this.output.columns || 80,
      this.output.rows || 24,
      this.tick,
      this.input,
      this.question?.label ?? "you",
      this.question?.secret,
    );
    const changed = lines.flatMap((line, i) =>
      line === this.previous[i]
        ? []
        : [
            `\x1b[${i + 1};1H\x1b[2K${i < 12 ? "\x1b[38;2;125;211;252m" : "\x1b[38;2;226;232;240m"}${line}\x1b[0m`,
          ],
    );
    this.output.write(changed.join(""));
    this.previous = lines;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.source.removeListener("keypress", this.key);
    this.question?.reject(new Error("Butler closed."));
    this.question = undefined;
    if (this.source.isTTY) this.source.setRawMode(false);
    if (this.output.isTTY && this.timer)
      this.output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[0m");
    this.source.pause();
  }
}
