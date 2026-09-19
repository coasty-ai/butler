/**
 * The wire between the Mac and the page on the phone: the shape of every
 * request body, every server-sent event, and the content-free view of a run
 * the phone is shown. Nothing here carries a screenshot, typed text, screen
 * text, a full address or path, or a credential; the view is built from the
 * same RunView voice and texts answer from, plus the approval question and
 * the shape of the pending step. Pure, so tests can pin it and the settings
 * window can share the status type. See docs/REMOTE.md.
 */
import { z } from "zod";
import type { Action, Frame, Settings, Snapshot } from "../core/schema";
import { redactSecrets } from "../core/sanitize";
import type { RunView } from "../assistant/types";
import { speakableApproval } from "../voice/speakable";
import type { TurnPlanKind } from "../voice/turns";
import {
  approvalAllowed,
  remoteApprovalTier,
  type RemoteDevice,
  type RemoteTier,
} from "./auth";

// MARK: request bodies

export const MAX_SAY = 2000;
const HEX32 = /^[a-f0-9]{32}$/;

export const sayBody = z
  .object({ text: z.string().trim().min(1).max(MAX_SAY) })
  .strict();
export const controlBody = z
  .object({ kind: z.enum(["stop", "pause", "continue"]) })
  .strict();
export const approveBody = z
  .object({
    gate: z.string().regex(HEX32),
    nonce: z.string().regex(HEX32),
    answer: z.enum(["approve", "skip"]),
  })
  .strict();
export const askBody = z.object({ kind: z.literal("status") }).strict();
export const FRAME_ID = /^[A-Za-z0-9_-]{1,100}$/;

// MARK: routes

export type Route =
  | "page"
  | "manifest"
  | "session"
  | "events"
  | "say"
  | "control"
  | "approve"
  | "ask"
  | "frame"
  | "audio";

/** The route a request names, or undefined for anything else (a bare 404). */
export function parseRoute(
  method: string,
  url: string,
): { route: Route; frameId?: string } | undefined {
  const path = url.split("?")[0];
  const m = method.toUpperCase();
  if (m === "GET" && (path === "/" || path === "/index.html"))
    return { route: "page" };
  if (m === "GET" && path === "/manifest.webmanifest")
    return { route: "manifest" };
  if (m === "GET" && path === "/api/session") return { route: "session" };
  if (m === "GET" && path === "/api/events") return { route: "events" };
  if (m === "POST" && path === "/api/say") return { route: "say" };
  if (m === "POST" && path === "/api/control") return { route: "control" };
  if (m === "POST" && path === "/api/approve") return { route: "approve" };
  if (m === "POST" && path === "/api/ask") return { route: "ask" };
  if (m === "POST" && path === "/api/audio") return { route: "audio" };
  const frame = m === "GET" && /^\/api\/frame\/([^/]+)\.jpg$/.exec(path);
  if (frame && FRAME_ID.test(frame[1]))
    return { route: "frame", frameId: frame[1] };
  return undefined;
}

// MARK: the view

export interface RemotePending {
  /** sha256 of the gate identity (main.ts currentGate), 32 hex. */
  gate: string;
  /** This device's single-use nonce for that gate. */
  nonce: string;
  app?: string;
  /** The policy question, as speakableApproval renders it. */
  reason: string;
  /** The shape of the step: a label, a menu path, "typing 12 characters". */
  what: string;
  tier: RemoteTier;
  /** Whether this device may tap Approve for it; Skip needs only control. */
  allowed: boolean;
}

export interface RemoteView {
  running: boolean;
  status: RunView["status"];
  task?: string;
  minutes?: number;
  steps?: number;
  app?: string;
  question?: string;
  recent: string[];
  pending?: RemotePending;
  /** Present only when a thumbnail may be fetched for this frame id. */
  frame?: { id: string; at: number };
  queued: string[];
  lastFinished?: RunView["lastFinished"];
  presence: "present" | "away" | "unknown";
  locked: boolean;
  seq: number;
}

export type RemoteEvent =
  | { type: "status"; view: RemoteView }
  | { type: "progress"; line: string; at: number }
  | { type: "reply"; id: string; text: string }
  | { type: "notice"; text: string }
  | { type: "ping"; at: number };

const MAX_TASK = 120;
const MAX_LABEL = 60;
const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};
const basename = (path: string) =>
  path.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? path;

/**
 * The shape of a pending step without its content. Never describeAction
 * (that carries coordinates and typed text) and never action.text: a
 * password waiting for approval reads as "typing 8 characters".
 */
export function pendingWhat(action: Action | undefined): string {
  if (!action) return "a step";
  switch (action.type) {
    case "click_control":
      return `“${clip(redactSecrets(action.label, "[omitted]"), MAX_LABEL)}”`;
    case "menu_item":
      return action.path
        .map((p) => clip(redactSecrets(p, "[omitted]"), MAX_LABEL))
        .join(" › ");
    case "type_text": {
      const lines = action.text.split(/\r?\n/).length;
      const n = action.text.length;
      return `typing ${n} character${n === 1 ? "" : "s"}${
        lines > 1 ? ` over ${lines} lines` : ""
      }`;
    }
    case "key":
      return `pressing ${action.key}`;
    case "hotkey":
      return `pressing ${action.keys.join("+")}`;
    case "open_app":
      return `opening ${clip(action.name, MAX_LABEL)}`;
    case "open_file":
      return `opening ${clip(basename(action.path), MAX_LABEL)}`;
    case "click":
    case "double_click":
    case "right_click":
    case "move":
      return "a click on the screen";
    case "drag":
      return "a drag";
    case "scroll":
      return "a scroll";
    default:
      return "a step";
  }
}

/**
 * The view one device receives for this snapshot. The gate and nonce are
 * that device's own; `allowed` already folds in the tier and the device's
 * switches, so the page only has to show or hide a button.
 */
export function remoteView(
  v: RunView,
  s: Snapshot | undefined,
  o: {
    gate?: string;
    nonce?: string;
    device?: RemoteDevice;
    screenshots: Settings["remoteScreenshots"];
    presence: "present" | "away" | "unknown";
    locked: boolean;
    seq: number;
  },
): RemoteView {
  const pendingAction = s?.pending;
  const confirming = s?.run?.status === "confirming" && !!pendingAction;
  let pending: RemotePending | undefined;
  if (confirming && o.gate && o.nonce) {
    const tier = remoteApprovalTier(pendingAction!);
    pending = {
      gate: o.gate,
      nonce: o.nonce,
      ...(v.app ? { app: v.app } : {}),
      reason:
        speakableApproval(pendingAction!) ?? "The next step needs your okay.",
      what: pendingWhat(pendingAction!.action),
      tier,
      allowed: !!o.device && approvalAllowed(tier, o.device),
    };
  }
  const frame: Frame | null | undefined = s?.frame;
  return {
    running: v.running,
    status: v.status,
    ...(v.task ? { task: clip(v.task, MAX_TASK) } : {}),
    ...(v.minutes !== undefined ? { minutes: v.minutes } : {}),
    ...(v.steps !== undefined ? { steps: v.steps } : {}),
    ...(v.app ? { app: v.app } : {}),
    ...(v.question ? { question: v.question } : {}),
    recent: v.recent.slice(-6),
    ...(pending ? { pending } : {}),
    ...(o.screenshots !== "off" && v.running && frame?.id && !frame.synthetic
      ? { frame: { id: frame.id, at: frame.capturedAt } }
      : {}),
    queued: v.queued.map((q) => clip(q, MAX_TASK)),
    ...(v.lastFinished ? { lastFinished: v.lastFinished } : {}),
    presence: o.presence,
    locked: o.locked,
    seq: o.seq,
  };
}

/** One SSE frame. JSON escapes every newline, so an event is always one record. */
export function encodeEvent(e: RemoteEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

// MARK: fixed replies

/**
 * The line the phone shows for a plan the router chose, when main did not
 * supply one (status and reply lines come from the run view). Fixed text:
 * the model is never on this path.
 */
export function remoteReply(
  kind: TurnPlanKind,
  o: { question?: string; reason?: string } = {},
): string {
  switch (kind) {
    case "stop":
      return "Stopped.";
    case "pause":
      return "Paused.";
    case "resume":
      return "Continuing.";
    case "undo":
      return "Taking the last step back on the Mac.";
    case "approve":
    case "needClick":
      return o.reason === "restricted"
        ? "Approve this one on the Mac."
        : "Use the Approve button for that.";
    case "decline":
      return "Skipped. The task is paused; send “continue” to go on.";
    case "confirmAgain":
      return "Was that a yes or a no? Use the buttons for approvals.";
    case "nothingToApprove":
      return "Nothing to approve.";
    case "nothingRunning":
      return "Nothing is running.";
    case "stillWorking":
      return "Still on it.";
    // Texted words never end a conversation window; the router keeps the kind
    // out of this path.
    case "acknowledge":
    case "endConversation":
      return "Okay.";
    case "clarify":
      return o.question ?? "What would you like me to do?";
    case "amendTask":
    case "revise":
      return "Got it, adjusting.";
    case "start":
      return "Starting on the Mac.";
    case "replace":
      return "Starting that instead.";
    case "queue":
      return "Queued for after this one.";
    case "status":
    case "reply":
      return "Okay.";
  }
}

/** The answer to a text that carried a credential; nothing else is kept. */
export const CREDENTIAL_REFUSAL =
  "I can’t take passwords or keys from the phone. Enter those on the Mac.";

// MARK: settings status

/** The remote as the Settings window shows it; never content, never a token. */
export interface RemoteStatus {
  enabled: boolean;
  state: "off" | "on" | "error";
  /** Why it is off or failing, in a fixed sentence. */
  reason?: string;
  /** Something worth knowing while it is on (no certificate yet, Funnel elsewhere). */
  note?: string;
  url?: string;
  tailscale: "standalone" | "appstore" | "cli" | "none";
  user?: string;
  https: boolean;
  certExpires?: number;
  devices: RemoteDevice[];
  /** Device ids with an open event stream right now. */
  connected: string[];
  locked: boolean;
}
/**
 * What the phone shows after a line it sent: the dialog's own answer when it
 * gave one, else the fixed status line for a status plan, else the fixed
 * question or refusal for the plans that need the user. Undefined when the
 * plan speaks for itself (a started or queued task shows on the status card).
 */
export function remoteTurnReply(
  plan: { kind: TurnPlanKind; question?: string; reason?: string },
  o: { modelReply?: string; statusLine?: string } = {},
): string | undefined {
  if (o.modelReply) return o.modelReply;
  if (plan.kind === "status") return o.statusLine;
  if (plan.kind === "clarify")
    return remoteReply("clarify", { question: plan.question });
  if (plan.kind === "needClick")
    return remoteReply("needClick", { reason: plan.reason });
  return undefined;
}
