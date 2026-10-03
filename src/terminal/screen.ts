import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

export type Phase =
  "idle" | "thinking" | "working" | "briefing" | "speaking" | "listening";
export interface ScreenState {
  phase: Phase;
  model: string;
  connections: string[];
  nextBriefing: string;
  messages: { who: string; text: string; id?: number }[];
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
  width = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const line of terminalText(value).split("\n")) {
    let rest = Array.from(line);
    do {
      let cut = Math.min(width, rest.length);
      if (rest.length > width && !/\s/.test(rest[width])) {
        let boundary = width - 1;
        while (boundary > 0 && !/\s/.test(rest[boundary])) boundary--;
        if (boundary > 0) cut = boundary;
      }
      out.push(rest.slice(0, cut).join(""));
      rest = rest.slice(cut);
      if (rest.length) while (rest.length && /\s/.test(rest[0])) rest.shift();
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
  scrollOffset = 0,
): string[] {
  width = Math.max(4, Math.min(width - 1, 140));
  const rule = "-".repeat(width);
  const orb = orbitalFrame(tick, s.phase !== "idle");
  const connected = s.connections.filter(
    (c) => c.includes(": on") || c.includes("[demo]"),
  );
  const spinner = s.phase === "idle" ? "o" : ["|", "/", "-", "\\"][tick % 4];
  const fixed = [
    "  B U T L E R   /   personal assistant",
    `  ${s.model}`,
    ...(width >= 65 && height >= 27
      ? orb
          .slice(2, 5)
          .map(
            (line, i) =>
              `  ${line}  ${
                [
                  `${spinner} ${s.phase.toUpperCase()}  ${s.status}`,
                  `${connected.length} connected  /connect to add apps`,
                  `Briefings: ${s.nextBriefing}`,
                ][i]
              }`,
          )
      : [
          `  ${spinner} ${s.phase.toUpperCase()}  ${s.status}`,
          `  ${connected.length} connected  |  Briefings: ${s.nextBriefing}`,
        ]),
    rule,
  ];
  const body = s.messages.flatMap((m) => [
    `  ${m.who === "You" ? "> You" : m.who}`,
    ...wrapText(m.text, Math.max(1, width - 4)).map((line) => `  ${line}`),
    "",
  ]);
  const available = Math.max(1, height - fixed.length - 4);
  const end = Math.max(available, body.length - Math.max(0, scrollOffset));
  const tail = body.slice(Math.max(0, end - available), end);
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
    "  /help  /connect  /listen  /cua   PgUp/PgDn history   Ctrl-C stop",
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
  private messageId = 0;
  private scrollOffset = 0;
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
    } else if (key.name === "pageup") {
      const width = Math.max(4, Math.min((this.output.columns || 80) - 1, 140));
      const height = this.output.rows || 24;
      const body = this.state.messages.reduce(
        (total, message) =>
          total + wrapText(message.text, Math.max(1, width - 4)).length + 2,
        0,
      );
      const available = Math.max(
        1,
        height - (width >= 65 && height >= 27 ? 6 : 5) - 4,
      );
      this.scrollOffset = Math.min(
        Math.max(0, body - available),
        this.scrollOffset + Math.max(5, height - 12),
      );
    } else if (key.name === "pagedown")
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - Math.max(5, (this.output.rows || 24) - 12),
      );
    else if (key.name === "backspace")
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
    if (who === "You") this.scrollOffset = 0;
    const id = this.messageId++;
    this.state.messages.push({ who, text: terminalText(text), id });
    this.state.messages = this.state.messages.slice(-100);
    if (!this.output.isTTY)
      this.output.write(`${who}: ${terminalText(text)}\n`);
    this.draw();
    return id;
  }
  updateMessage(index: number, text: string) {
    const message = this.state.messages.find((m) => m.id === index);
    if (!message) return;
    const previous = message.text;
    message.text = terminalText(text);
    if (!this.output.isTTY)
      this.output.write(message.text.slice(previous.length).trimStart() + "\n");
    this.draw();
  }
  get prompting() {
    return !!this.question;
  }
  clearMessages() {
    this.state.messages = [];
    this.scrollOffset = 0;
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
      this.scrollOffset,
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
