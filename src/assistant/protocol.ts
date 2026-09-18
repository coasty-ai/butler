/**
 * The line format the dialog model answers in, and a parser that reads it as
 * it streams. The format is three lines: an ACT the assistant may take, a
 * TASK when that act starts or changes a run, and SAY, the reply. The parser
 * emits the head (act and task) the moment SAY begins, so the deterministic
 * plan can be settled before the reply has finished streaming, and then each
 * finished sentence of the reply, so speech can start on the first one.
 *
 * The grammar is deliberately narrow: there is no approve, decline or stop
 * act, so nothing the model writes can answer a policy question or end a
 * run; a "pause" only removes authority, and "resume" is honoured by the
 * caller only for the hold its own activation caused.
 */
import { completeSentences } from "../voice/speakable";

export const DIALOG_ACTS = [
  "none",
  "answer",
  "status",
  "start",
  "revise",
  "replace",
  "queue",
  "resume",
  "pause",
] as const;
export type DialogAct = (typeof DIALOG_ACTS)[number];
/** Acts that carry a TASK line. */
export const TASK_ACTS: ReadonlySet<DialogAct> = new Set([
  "start",
  "revise",
  "replace",
  "queue",
]);
export interface DialogHead {
  act: DialogAct;
  task?: string;
}
export type DialogInvalid =
  "no_act" | "bad_act" | "bad_task" | "no_say" | "too_long";
export type DialogEvent =
  /** SAY has begun (or the output ended): act and task are final. */
  | { type: "head"; head: DialogHead }
  /** One finished sentence of SAY, raw and still unfiltered. */
  | { type: "sentence"; text: string }
  | { type: "end"; say: string }
  | { type: "invalid"; code: DialogInvalid };

/** The ACT line must be complete within this many characters. */
export const ACT_LINE_MAX = 40;
export const TASK_MAX = 500;
/** SAY text beyond this is a runaway reply, not something to read out. */
export const SAY_MAX = 1200;
/** A sentence with no boundary by here is cut at its last comma or space. */
export const SENTENCE_SOFT_MAX = 160;

const ACT_LINE = /^ACT:\s*([a-z]+)\s*$/i;
const TASK_LINE = /^TASK:\s*(.*)$/i;
const SAY_START = /^SAY:\s*/i;
const FENCE = /^```[a-z]*\s*$/i;

/** act: before the ACT line; head: TASK or SAY next; say: streaming SAY. */
type Phase = "act" | "head" | "say" | "ended";

export class DialogParser {
  private phase: Phase = "act";
  /** Input not yet consumed. */
  private buffer = "";
  private act?: DialogAct;
  private task?: string;
  /** Every SAY character seen, newlines joined into spaces. */
  private say = "";
  /** The tail of SAY not yet emitted as a sentence. */
  private pending = "";
  private events: DialogEvent[] = [];

  /** Feeds a delta; returns the events it completed, in order. */
  push(delta: string): DialogEvent[] {
    if (this.phase === "ended") return [];
    this.buffer += delta;
    this.drain(false);
    return this.take();
  }

  /** The stream ended: flushes the last sentence, or reports what is missing. */
  end(): DialogEvent[] {
    if (this.phase === "ended") return [];
    this.drain(true);
    // drain() may have ended the output itself (invalid, or a flushed SAY).
    if ((this.phase as Phase) !== "ended") this.finish();
    return this.take();
  }

  private take() {
    const out = this.events;
    this.events = [];
    return out;
  }

  private invalid(code: DialogInvalid) {
    this.phase = "ended";
    this.events.push({ type: "invalid", code });
  }

  /** Reads whole lines for ACT and TASK, then streams SAY sentence by sentence. */
  private drain(final: boolean) {
    while (this.phase === "act" || this.phase === "head") {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        // The ACT line must be short; a model that starts with prose is not
        // following the format and there is no point waiting for more.
        if (this.phase === "act" && this.buffer.trim().length > ACT_LINE_MAX) {
          this.invalid("no_act");
          return;
        }
        // "SAY:" needs no newline: the reply streams from there on.
        if (
          !final &&
          !(this.phase === "head" && SAY_START.test(this.buffer.trimStart()))
        )
          return;
      }
      const line = (
        newline === -1 ? this.buffer : this.buffer.slice(0, newline)
      ).replace(/\r$/, "");
      this.buffer = newline === -1 ? "" : this.buffer.slice(newline + 1);
      const trimmed = line.trim();
      if (!trimmed || FENCE.test(trimmed)) {
        if (newline === -1) return;
        continue;
      }
      if (this.phase === "act") {
        const match = ACT_LINE.exec(trimmed);
        if (!match || trimmed.length > ACT_LINE_MAX) {
          this.invalid("no_act");
          return;
        }
        const act = match[1].toLowerCase();
        if (!(DIALOG_ACTS as readonly string[]).includes(act)) {
          this.invalid("bad_act");
          return;
        }
        this.act = act as DialogAct;
        this.phase = "head";
        continue;
      }
      const task = TASK_LINE.exec(trimmed);
      if (task) {
        // A TASK line for an act that takes none is ignored.
        if (TASK_ACTS.has(this.act!)) {
          const text = task[1].trim();
          if (!text || text.length > TASK_MAX) {
            this.invalid("bad_task");
            return;
          }
          this.task = text;
        }
        continue;
      }
      if (SAY_START.test(trimmed)) {
        if (TASK_ACTS.has(this.act!) && !this.task) {
          this.invalid("bad_task");
          return;
        }
        this.phase = "say";
        this.events.push({ type: "head", head: this.head() });
        // SAY may continue on the same line and on every line after it.
        this.buffer =
          line.replace(SAY_START, "") +
          (newline === -1 ? "" : "\n") +
          this.buffer;
        break;
      }
      // Neither TASK nor SAY where one was expected.
      this.invalid(
        TASK_ACTS.has(this.act!) && !this.task ? "bad_task" : "no_say",
      );
      return;
    }
    if (this.phase === "say") this.drainSay(final);
  }

  private head(): DialogHead {
    return { act: this.act!, ...(this.task ? { task: this.task } : {}) };
  }

  private drainSay(final: boolean) {
    // Newlines join into spaces; a closing fence is not part of the reply.
    const text = this.buffer
      .replace(/```[a-z]*/gi, " ")
      .replace(/\s*\n\s*/g, " ");
    this.buffer = "";
    if (this.say.length + text.length > SAY_MAX) {
      this.invalid("too_long");
      return;
    }
    this.say += text;
    let { done, rest } = completeSentences(
      (this.pending + text).replace(/^\s+/, ""),
    );
    for (const sentence of done) this.sentence(sentence);
    // A run-on with no boundary in sight is cut so speech is not held up:
    // at its last comma when that leaves a decent clause, else at a space.
    while (rest.length > SENTENCE_SOFT_MAX) {
      const head = rest.slice(0, SENTENCE_SOFT_MAX);
      let at = head.lastIndexOf(",");
      if (at < SENTENCE_SOFT_MAX / 2) at = head.lastIndexOf(" ");
      const cut = at > 0 ? head.slice(0, at) : head;
      this.sentence(cut);
      rest = rest.slice(cut.length).replace(/^[,\s]+/, "");
    }
    this.pending = rest;
    if (final) this.finish();
  }

  private sentence(text: string) {
    const clean = text.trim();
    if (clean) this.events.push({ type: "sentence", text: clean });
  }

  private finish() {
    if (this.phase === "act") {
      this.invalid("no_act");
      return;
    }
    if (this.phase === "head") {
      // Output ended before SAY: the head is still final, with nothing to say.
      if (TASK_ACTS.has(this.act!) && !this.task) {
        this.invalid("bad_task");
        return;
      }
      this.events.push({ type: "head", head: this.head() });
    }
    this.sentence(this.pending);
    this.pending = "";
    const say = this.say.replace(/\s+/g, " ").trim();
    this.phase = "ended";
    if (!say && (this.act === "answer" || this.act === "status")) {
      this.events.push({ type: "invalid", code: "no_say" });
      return;
    }
    this.events.push({ type: "end", say });
  }
}
