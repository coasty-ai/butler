/**
 * What the dialog model is told about a turn: the user's words, the recent
 * conversation, the sanitized run view and a little context. Everything here
 * is built from data that is already safe to repeat (the run view never
 * carries an approval's action or typed text), bounded in size, and ordered
 * so the least essential context is dropped first when it must fit. Nothing
 * in it is an instruction to the model; the prompt says so, and arbitrate.ts
 * enforces it on the way back.
 */
import { redactSecrets } from "../core/sanitize";
import type { Channel, RunView, TurnRecord } from "./types";

export interface DialogRun {
  task: string;
  status: "working" | "waiting_for_approval" | "waiting_for_you" | "paused";
  minutes: number;
  steps: number;
  app?: string;
  /** The last few step lines, oldest first; never typed text. */
  recent: string[];
  /** The run's own question while it waits for the user. */
  question?: string;
  /** Paused only to listen to this very turn; it goes on once answered. */
  heldByVoice?: boolean;
}
export interface DialogTurn {
  role: "user" | "assistant";
  text: string;
  /** Built from screen, notification or panel text, not the assistant's own. */
  untrusted?: boolean;
}
export interface DialogState {
  channel: Channel;
  now: string;
  user: string;
  addressAs?: string;
  previousReply?: string;
  /** Oldest first, at most 8, each at most 240 characters. */
  turns: DialogTurn[];
  run?: DialogRun;
  queued?: string[];
  lastRun?: {
    task: string;
    outcome: "completed" | "failed" | "stopped";
    summary?: string;
    minutesAgo: number;
  };
  agenda?: string[];
  notifications?: string[];
  openApps?: string[];
}

export const DIALOG_TURNS = 8;
export const DIALOG_TURN_CHARS = 240;
const LIMITS = {
  agenda: { items: 8, chars: 160 },
  notifications: { items: 6, chars: 160 },
  openApps: { items: 10, chars: 60 },
} as const;

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};
const list = (
  items: readonly string[] | undefined,
  limit: { items: number; chars: number },
  each: (text: string) => string = (text) => text,
) =>
  items
    ?.map((item) => clip(each(redactSecrets(item)), limit.chars))
    .filter(Boolean)
    .slice(0, limit.items);

/**
 * Whether the user is asking about their messages or notifications. Only
 * then are recent notifications sent along: they carry other people's words
 * and one-time codes, so they are context for that question alone, never a
 * standing feed into the model.
 */
export function aboutNotifications(text: string): boolean {
  return /\b(?:notifications?|messages?|texts?|texted|dms?|slack|teams|whatsapp|imessage|pinged?|missed|messaged|emails?|inbox|unread|reply|replied|banners?|alerts?)\b/i.test(
    text,
  );
}

/** Runs of four or more digits (verification codes) are never sent. */
export function redactCodes(text: string): string {
  return text.replace(/\d[\d\s-]{2,}\d/g, (m) =>
    m.replace(/\D/g, "").length >= 4 ? "[digits]" : m,
  );
}

export interface DialogStateInput {
  channel: Channel;
  user: string;
  view: RunView;
  turns: TurnRecord[];
  addressAs?: string;
  previousReply?: string;
  agenda?: string[];
  notifications?: string[];
  openApps?: string[];
  /** The run is paused only because this activation interrupted it. */
  heldByVoice: boolean;
  now: Date;
}

export function buildDialogState(i: DialogStateInput): DialogState {
  const view = i.view;
  const state: DialogState = {
    channel: i.channel,
    now: formatNow(i.now),
    // The session never sends a turn that carries a credential at all; this
    // is the last line in case one gets past it.
    user: clip(redactSecrets(i.user), 2000),
    ...(i.addressAs?.trim() ? { addressAs: clip(i.addressAs, 40) } : {}),
    ...(i.previousReply
      ? { previousReply: clip(redactSecrets(i.previousReply), 240) }
      : {}),
    turns: i.turns.slice(-DIALOG_TURNS).map((t) => ({
      role: t.role,
      text: clip(redactSecrets(t.text), DIALOG_TURN_CHARS),
      ...(t.untrusted ? { untrusted: true } : {}),
    })),
  };
  if (view.running && view.status !== "idle")
    state.run = {
      task: view.task ?? "",
      status: view.status,
      minutes: view.minutes ?? 0,
      steps: view.steps ?? 0,
      ...(view.app ? { app: view.app } : {}),
      recent: view.recent.slice(-6),
      ...(view.question ? { question: view.question } : {}),
      ...(i.heldByVoice ? { heldByVoice: true } : {}),
    };
  if (view.queued.length) state.queued = view.queued.slice(0, 3);
  if (view.lastFinished) state.lastRun = { ...view.lastFinished };
  const agenda = list(i.agenda, LIMITS.agenda);
  if (agenda?.length) state.agenda = agenda;
  // Notifications only for a question about them, and never with a code.
  const notifications = aboutNotifications(i.user)
    ? list(i.notifications, LIMITS.notifications, redactCodes)
    : undefined;
  if (notifications?.length) state.notifications = notifications;
  const openApps = list(i.openApps, LIMITS.openApps);
  if (openApps?.length) state.openApps = openApps;
  return state;
}

function formatNow(now: Date): string {
  try {
    return now.toLocaleString("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return now.toISOString();
  }
}

/** The fixed key order the prompt's examples use. */
const KEY_ORDER: (keyof DialogState)[] = [
  "channel",
  "now",
  "user",
  "addressAs",
  "previousReply",
  "turns",
  "run",
  "queued",
  "lastRun",
  "agenda",
  "notifications",
  "openApps",
];
/** What goes first when the state must shrink to fit. */
const DROP_ORDER: (keyof DialogState)[] = [
  "notifications",
  "openApps",
  "agenda",
];

/**
 * The state as the user message, in a fixed key order. When it is longer
 * than maxChars it drops, in order, notifications, open apps, the agenda and
 * then the oldest turns, so the user's words and the run always fit.
 */
export function dialogStateJson(s: DialogState, maxChars: number): string {
  const state: DialogState = { ...s, turns: [...s.turns] };
  const render = () =>
    JSON.stringify(
      Object.fromEntries(
        KEY_ORDER.filter((key) => state[key] !== undefined).map((key) => [
          key,
          state[key],
        ]),
      ),
    );
  let json = render();
  for (const key of DROP_ORDER) {
    if (json.length <= maxChars) return json;
    if (state[key] === undefined) continue;
    delete state[key];
    json = render();
  }
  while (json.length > maxChars && state.turns.length) {
    state.turns.shift();
    json = render();
  }
  return json;
}
