import {
  appendFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { redactSecrets, sanitizeText, scanText } from "../src/core/sanitize";
import { approvalCode } from "../src/core/approval-codes";
import { allowedCode, deniedCode, retryCode } from "../src/core/decision-codes";
import { REQUIREMENT_KINDS } from "../src/core/done-audit";
import { MODIFIER_WORDS, type Snapshot } from "../src/core/schema";
import type { DiagnosticSink } from "../src/core/diagnostics";

const fields = new Set([
  "runId",
  // The module registry: which port, a measurement, a flag (moduleEvents).
  "port",
  "ms",
  "ok",
  "requestId",
  "frameId",
  "provider",
  "model",
  "status",
  "phase",
  "method",
  "attempt",
  // DoneAudited: how many calls the audit took (one, or two after an
  // unusable reply). A count.
  "attempts",
  "durationMs",
  "ttftMs",
  "delayMs",
  "httpStatus",
  "bytes",
  "code",
  "error",
  "name",
  "cause",
  "retryable",
  "actions",
  "frames",
  "usage",
  // UsageAdded: what the usage paid for, a code ("audit").
  "purpose",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cost",
  // ModelRequestStarted: whether the step carried its screenshot, and why
  // (fixed codes from src/core/vision.ts).
  "screenshot",
  "screenshotReason",
  // FrameCaptured: why a browser frame's page text was cut (a fixed code
  // from native/macos/WebText.swift) and the walk's node count and wall time.
  "textTruncated",
  "textNodes",
  "textMs",
  // FrameCaptured: which walk produced the text (page | window).
  "textWalk",
  // FrameCaptured: the modifiers the session reported held at capture, a
  // list of fixed words (MODIFIER_WORDS); a stuck key beside the typing it
  // swallowed (live 2026-09-20, Fn).
  "modifiers",
  "actionType",
  "targetRole",
  "focusedRole",
  "x",
  "y",
  "start_x",
  "start_y",
  "end_x",
  "end_y",
  "delta_x",
  "delta_y",
  "textLength",
  "confidence",
  "synthetic",
  "geometry",
  "width",
  "height",
  "model_width",
  "model_height",
  "scale_factor",
  "permissions",
  "screen",
  "accessibility",
  "microphone",
  "speech",
  "onDevice",
  "shortcut",
  "enabled",
  "listening",
  "pid",
  "sequence",
  "taskLength",
  "appId",
  // BrowserQuit (scripts/harness-cycle.mjs): the bundle id of the browser
  // the benchmark quit (or, behind a sheet it would not dismiss, whose
  // process it ended) to release secure event input, and whether it went;
  // BrowserSheet: how many buttons the sheet it met had, and whether its
  // dismissive button was clicked.
  "browser",
  "quit",
  "buttons",
  "cancelled",
  "timedOut",
  "reason",
  "source",
  "sourcePid",
  "eventType",
  "flags",
  "pointerDistance",
  // NativeInputIdle during a bound run: whether the target application is in
  // front and whether the hands are in its window (design §3).
  "targetFrontmost",
  "lastInsideTarget",
  "launcherStatus",
  "launchedAppId",
  "frontmost",
  "wasRunning",
  "launchedWindows",
  "restoredWindow",
  "nameLength",
  "noteLength",
  "problem",
  // ProviderMalformed: the shape of arguments that were not JSON (counts,
  // flags and a parse-error code, src/providers/action-format.ts), and
  // ProviderResponse: whether the action had to be repaired out of text.
  "argumentShape",
  "length",
  "startsWithBrace",
  "endsWithBrace",
  "parseError",
  "parseOffset",
  "openBraces",
  "closeBraces",
  "quotes",
  "backslashes",
  "newlines",
  "backticks",
  "controls",
  "objects",
  "depthAtEnd",
  "quotedAtEnd",
  "leadingProse",
  "trailingProse",
  "repaired",
  "normalized",
  "exitCode",
  "signal",
  "restarts",
  "incompleteReason",
  "stopReason",
  "outputTypes",
  "period",
  // The revisit rule's count on ActionLoopDetected, and the loop breaker's
  // episode number on ActionLoopBroken (its outcome is a code).
  "revisits",
  "episode",
  // The page-switch rule's count of distinct pages on ActionLoopDetected,
  // and how many of its moves retraced a control already used for one.
  "pages",
  "repeatedMoves",
  // The done audit (DoneAudited): how many requirements the model listed
  // and how many it found unmet; the unmet count on the challenge too; the
  // unmet requirements' kinds as a list of fixed codes (REQUIREMENT_KINDS),
  // on the audit's row and on RunFailed REQUIREMENTS_UNMET.
  "requirements",
  "unmet",
  "unmetKinds",
  // DoneAudited: how many files the audit read back (a count) and whether
  // the last page read was shown to it (a flag); never their text.
  "deliverables",
  "pageRead",
  // Memory and replay plans: content-free counts and fixed codes only.
  "preferences",
  "episodes",
  "apps",
  "files",
  "folders",
  "skills",
  "index",
  "plan",
  "mode",
  "openedKind",
  "openedAppId",
  // Voice turns and spoken replies: codes, timings, levels and flags only.
  // Spoken or recognized text stays under `text`, which is never allow-listed.
  "kind",
  "priority",
  "interrupted",
  "engine",
  "voiceQuality",
  "window",
  "completeness",
  "patience",
  "endReason",
  "segments",
  "stableMs",
  "quietMs",
  "latencyMs",
  "noiseFloor",
  "threshold",
  "merged",
  "speaking",
  "rate",
  "fallback",
  "utteranceId",
  "remainingMs",
  // The helper's echo cancellation (voice_processing, standby_trace): on or
  // off, the microphone format the tap gets, the channel of it the recognizer
  // reads and that channel's level.
  "voiceProcessing",
  "sampleRate",
  "channels",
  "interleaved",
  "micChannel",
  "micLevel",
  // The phone remote: route names, verdict and tier codes, and a hashed
  // device code. Never a login, an address, a token or a line of text.
  "route",
  "verdict",
  "tier",
  "device",
  // Dialog turns and streamed replies: the act chosen, timings to the ACT
  // line and the first audio, fixed decision codes and sentence counts.
  // The words themselves never appear.
  "act",
  "actMs",
  "firstAudioMs",
  "preempt",
  "stream",
  "sentences",
  "dropped",
  "channel",
  // A refused step's kind of screen change and a hotkey's route (menu or
  // keys): fixed codes from the native helper, never its sentence. A click by
  // name's route (press or pointer) and what the helper's reads found after
  // it (changed, focused, none); a bound step's rung (ax, post, foreground).
  "change",
  "via",
  "effect",
  "rung",
  // ActionExecuted and ActionRetargetRequested for a click by name: the
  // control's point fell through to its own ancestor (a flag; native hitCover).
  "hitAncestor",
  // ActionExecuted for a click on a link in a browser that read as no page
  // change: its history line carries the download hint (a flag).
  "downloadHint",
  // ActionFailed STATE_CHANGED and ActionRetargetRequested: the runner closed
  // the menu the last right_click left open for this refusal (a flag).
  "dismissed",
  // ActionLoopDetected: the loop is a click by name repeated with no effect.
  "noEffect",
  // The opt-in Jev decider on a dialog turn: its time, the act it chose and
  // that act's probability, whether it was used, and its failure code.
  "jevMs",
  "jevAct",
  "jevP",
  "jevUsed",
  "jevCode",
  // The early step taken while the user speaks: how it settled, its timings
  // and whether a journaled step was one. Never the app or the words.
  "settle",
  "earlyMs",
  "leadMs",
  "early",
  "streamed",
  // A spoken scroll: its direction, pace and how many ticks it posted.
  "direction",
  "linesPerTick",
  "tickMs",
  "ticks",
  // Tools (src/tools): hashed server and tool codes, tiers, outcomes and the
  // kind of question asked; counts, sizes and flags. Never an argument, a
  // result, a description, a command, a path or a URL.
  "server",
  "tool",
  "transport",
  "toolTier",
  "outcome",
  "questionKind",
  // A policy question as a code (src/core/approval-codes.ts), on the
  // question asked and on its decline; the question's text stays out.
  "approvalCode",
  "providerState",
  "answerTier",
  "toolCount",
  "unavailableCount",
  "resultItems",
  "toolCalls",
  "toolWrites",
  "entityCount",
  "added",
  "skippedRemote",
  "refused",
  "secretsMoved",
  "argsBytes",
  "resultBytes",
  "stderrBytes",
  // WebPageRead (src/tools/providers/web.ts): the registrable domain the
  // web tool read, or a fixed word for an address that is not a name; a
  // path or a URL in the field is dropped (hostCode).
  "host",
  "verified",
  "sandboxed",
  "disclaimed",
  "pinned",
  "finish",
  "longRunning",
  // ToolCallFinished: a read answered from the run's earlier result.
  "repeat",
  // A coding delegation's folder as a hashed code, never its path.
  "project",
  // The first step prepared while the user spoke (Speculation* events): how
  // much of it was done when the run started and how old its frame was.
  "savedMs",
  "frameAgeMs",
  // NativeSlow and NativeTimedOut: how long a helper request had waited when
  // its deadline passed and the helper was found alive (the wait extended)
  // or not (the helper killed). A measurement beside the method's name.
  "waitedMs",
  // Acting while the user speaks (Stream* events and the run's StreamedStep
  // entries): which clause committed and how, its word count and its lead
  // on the final; the fast action's kind and site code, its clause, how
  // long the decision and the issue took; how many steps a run started with
  // and how many the final dropped. Never a word, a URL or a name.
  "by",
  "words",
  "siteKey",
  "menuTop",
  "clauseIndex",
  "decideMs",
  "issueMs",
  "streamedSteps",
  // A commit of an index committed before (the clause grew or was rewritten
  // and committed again); a fast action replacing an earlier one of its
  // index; whether an open_url is a site's front page or a query. Flags and
  // a code.
  "superseded",
  "reissue",
  "nav",
  // Modules (src/modules, electron/modules.ts): which port an adapter stood
  // behind and how it fared (ModuleFallback, ModuleSlow, RecognizerStarted),
  // and the user's recipes file as counts and codes (RecipesFileLoaded,
  // RecipesFileRejected: the entry's index and why). Never an entry's words.
  "port",
  "ms",
  "loaded",
  "rejected",
  // Watching how the owner works (electron/observer.ts, src/observer): a
  // frame's exclusion code, consolidation's counts and its hashed routine
  // ids (stableId, never a name), a replay's outcome. Never a title, a
  // host, a label or a word of the timeline.
  "excluded",
  "tokens",
  "routines",
  "procedures",
  "routineId",
  "removed",
  "imagesExpired",
  "on",
  "scope",
  // Journal rows (snapshot below): a policy decision's reason as a code
  // (src/core/decision-codes.ts) and the reason's length, never its text; a
  // correction's position; a run's origin and privacy; a background rung
  // step; a search route's depth; a capped foreground detour.
  "reasonCode",
  "reasonLength",
  "after_action",
  "origin",
  "privacy",
  "from",
  "to",
  "final",
  "depth",
]);
/** Allow-listed keys that only ever carry a count or position. */
const countFields = new Set([
  "attempts",
  // BrowserSheet: buttons on the sheet the harness met before a quit.
  "buttons",
  "loaded",
  "revisits",
  "episode",
  "pages",
  "repeatedMoves",
  "rejected",
  "tokens",
  "routines",
  "procedures",
  "removed",
  "imagesExpired",
  "preferences",
  "episodes",
  "apps",
  "files",
  "folders",
  "skills",
  "index",
  "segments",
  "sentences",
  "dropped",
  "words",
  "clauseIndex",
  "streamedSteps",
  "launchedWindows",
  "ticks",
  "channels",
  "micChannel",
  "count",
  "restarts",
  "toolCount",
  "unavailableCount",
  "resultItems",
  "toolCalls",
  "toolWrites",
  "entityCount",
  "added",
  "skippedRemote",
  "refused",
  "secretsMoved",
  "requirements",
  "unmet",
  // The shape of unparseable model arguments: every one a count.
  "length",
  "parseOffset",
  "openBraces",
  "closeBraces",
  "quotes",
  "backslashes",
  "newlines",
  "backticks",
  "controls",
  "objects",
  "depthAtEnd",
  "leadingProse",
  "trailingProse",
  // A correction's place in the run and a search route's length.
  "after_action",
  "depth",
  // FrameCaptured: nodes the page-text walk visited.
  "textNodes",
  // DoneAudited: files read back for the audit.
  "deliverables",
]);
/** Allow-listed keys that only ever carry a finite measurement. */
const numberFields = new Set([
  "ms",
  "sampleRate",
  "ms",
  "micLevel",
  "textLength",
  "noteLength",
  "taskLength",
  "durationMs",
  "ttftMs",
  "confidence",
  "stableMs",
  "quietMs",
  "latencyMs",
  "remainingMs",
  "noiseFloor",
  "threshold",
  "rate",
  "actMs",
  "firstAudioMs",
  "jevMs",
  "jevP",
  "earlyMs",
  "leadMs",
  "linesPerTick",
  "tickMs",
  "argsBytes",
  "resultBytes",
  "stderrBytes",
  "savedMs",
  "frameAgeMs",
  "waitedMs",
  "decideMs",
  "issueMs",
  // How long a policy decision's reason or question was; never the words.
  "reasonLength",
  // FrameCaptured: the page-text walk's wall time.
  "textMs",
]);
/** Allow-listed keys that only ever carry a boolean. */
const flagFields = new Set([
  "interrupted",
  "ok",
  "on",
  "merged",
  "speaking",
  "voiceProcessing",
  "interleaved",
  "fallback",
  "preempt",
  "stream",
  "restoredWindow",
  "jevUsed",
  "early",
  "verified",
  "sandboxed",
  "disclaimed",
  "pinned",
  "finish",
  "longRunning",
  // An executed row for a fast action taken while the user spoke (beside early).
  "streamed",
  // StreamClauseCommitted: a re-commit of an index; StreamedAction: it
  // replaces an earlier issue of the index.
  "superseded",
  "reissue",
  // Unparseable arguments: how they begin and end; a reply's action repaired.
  "startsWithBrace",
  "endsWithBrace",
  "quotedAtEnd",
  "repaired",
  // BrowserQuit: whether the browser's process had gone. BrowserSheet:
  // whether the sheet's dismissive button was clicked.
  "quit",
  "cancelled",
  // ForegroundRequested: the detour that releases the window for good.
  "final",
  // ActionLoopDetected: a click by name with no effect repeated from one screen.
  "noEffect",
  // ToolCallFinished: a read answered from the run's earlier result, the tool not called.
  "repeat",
  // ActionExecuted, ActionRetargetRequested: a click by name whose control's
  // point fell through to the control's own ancestor (native hitCover).
  "hitAncestor",
  // ActionExecuted: a click on a link in a browser that read as no page
  // change, its line carrying the download hint (once per control a run).
  "downloadHint",
  // ActionFailed STATE_CHANGED, ActionRetargetRequested: the runner closed
  // the menu the last right_click left open for this refusal.
  "dismissed",
  // DoneAudited: the last page read was shown to the audit.
  "pageRead",
]);
/**
 * Allow-listed keys that only ever carry a short fixed code. A numeric value
 * is dropped here: HTTP and exit statuses belong in httpStatus and exitCode.
 */
const codeFields = new Set([
  "port",
  "plan",
  "port",
  "mode",
  "openedKind",
  "kind",
  "priority",
  "engine",
  "voiceQuality",
  "window",
  "completeness",
  "patience",
  "endReason",
  "source",
  "phase",
  "code",
  "status",
  "route",
  "verdict",
  "tier",
  "device",
  "act",
  "channel",
  "change",
  "via",
  // ActionExecuted: a click by name's effect and a bound step's rung.
  "effect",
  "rung",
  // UsageAdded: what the usage paid for ("audit": the done audit's calls),
  // so a harness can price those tokens at the auditor's own rates.
  "purpose",
  "jevAct",
  "jevCode",
  "settle",
  // StreamedAction: home (a site's front page) or query.
  "nav",
  "direction",
  "server",
  "tool",
  "transport",
  "toolTier",
  "outcome",
  "questionKind",
  "approvalCode",
  "providerState",
  "answerTier",
  "project",
  // The JSON parser's complaint about model arguments, as a fixed code.
  "parseError",
  // A clause's commit ("boundary" or "stable"), a fast action's site code,
  // and a menu_item's top-level menu title (a standard one, or other).
  "by",
  "siteKey",
  "menuTop",
  // The observer: an exclusion code and a forget scope. A routine's id
  // ("routine-<hash>") is not a code by shape and is scrubbed as a string.
  "excluded",
  "scope",
  // A reason is a code or nothing: the runner's fixed words (gone, pruned,
  // deliverable_unchanged, minute_budget) pass; a policy's sentence, which
  // quotes a label or an application, never does. The policy's decisions
  // travel as reasonCode (src/core/decision-codes.ts) and approvalCode.
  "reason",
  "reasonCode",
  // FrameCaptured: why the page text was cut (time, nodes or chars), and
  // which walk read it (page or window).
  "textTruncated",
  "textWalk",
  // A run's origin and privacy, a background rung step's from and to.
  "origin",
  "privacy",
  "from",
  "to",
]);
/**
 * The early step's own events keep only these keys, whatever else a caller
 * passes: a code, how the clause settled and timings, never a name.
 */
const earlyEvents = new Set(["EarlyStartExecuted", "EarlyStartEnded"]);
const earlyFields = new Set([
  "phase",
  "code",
  "settle",
  "earlyMs",
  "leadMs",
  "durationMs",
]);
/**
 * The first step prepared while the user spoke keeps only these keys: a
 * code, its kind, timings and what its request cost. Never the words.
 */
const speculationEvents = new Set([
  "SpeculationStarted",
  "SpeculationSkipped",
  "SpeculationAdopted",
  "SpeculationDiscarded",
]);
const speculationFields = new Set([
  "runId",
  "sequence",
  "synthetic",
  "code",
  "kind",
  "leadMs",
  "savedMs",
  "frameAgeMs",
  "usage",
]);
/**
 * Acting while the user speaks (electron/streaming.ts): each event keeps
 * only its own keys, whatever else a caller passes. Codes and numbers only.
 */
const streamEvents = new Map<string, Set<string>>([
  [
    "StreamClauseCommitted",
    new Set(["index", "by", "words", "leadMs", "superseded"]),
  ],
  [
    "StreamedAction",
    new Set([
      "kind",
      "siteKey",
      "nav",
      "clauseIndex",
      "decideMs",
      "issueMs",
      "reissue",
    ]),
  ],
  ["StreamedActionDropped", new Set(["kind", "clauseIndex"])],
  ["StreamedRunStarted", new Set(["streamedSteps", "dropped"])],
]);
/**
 * The module registry (src/modules/registry.ts): which port, which adapter
 * kind, a code, a measurement and a flag; never a URL, a server name or a
 * reply. Each event keeps only its own keys.
 */
const moduleEvents = new Map<string, Set<string>>([
  ["ModuleCall", new Set(["port", "kind", "ms", "ok"])],
  ["ModuleFallback", new Set(["port", "kind", "code"])],
  ["ModuleSlow", new Set(["port", "kind", "ms"])],
]);
/**
 * The observe stream (electron/controller.ts, .data/design/observer.md):
 * a frame is its application and exclusion code, an action its kind, a
 * drop its reason and count. A frame's title, host, labels, controls, text
 * digest and picture never reach the diagnostics, whatever a caller passes.
 */
const observerEvents = new Map<string, Set<string>>([
  ["ObserverFrame", new Set(["appId", "excluded"])],
  ["ObserverAction", new Set(["kind"])],
  ["ObserverDropped", new Set(["reason", "dropped"])],
]);
/**
 * The benchmark harness quitting its own browser (scripts/harness-cycle.mjs,
 * src/gym/bench/browser-reset.ts): the browser's bundle id, whether it went
 * and a fixed code (SHEET_UP, STILL_RUNNING, and for a process the harness
 * ended itself behind a sheet it would not dismiss, TERMINATED or KILLED);
 * and each sheet the quit met, as the browser's bundle id, a count of its
 * buttons, whether its dismissive button was clicked, and how its buttons
 * read as a code (NAMED, NO_DISMISS, UNNAMED). Never a title, a URL or a
 * button's name, whatever a caller passes.
 */
const harnessEvents = new Map<string, Set<string>>([
  ["BrowserQuit", new Set(["browser", "quit", "code"])],
  ["BrowserSheet", new Set(["browser", "buttons", "cancelled", "code"])],
]);
const keyedEvents = new Map([
  ...streamEvents,
  ...moduleEvents,
  ...observerEvents,
  ...harnessEvents,
]);
/** Allow-listed keys that only ever carry a bundle id (reverse-DNS, no spaces). */
const bundleFields = new Set(["browser"]);
const bundleId = (value: unknown) =>
  typeof value === "string" &&
  /^(?=.{1,120}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value)
    ? value
    : undefined;
/**
 * The web tool's trace host: a lowercase registrable domain ("example.com",
 * "bbc.co.uk") or one of its fixed words for an address that is no name
 * (loopback, private, ip). Never a path, a query or a scheme.
 */
const hostCode = (value: unknown) =>
  typeof value === "string" &&
  (/^(?=.{1,120}$)(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ||
    /^(?:loopback|private|ip)$/.test(value))
    ? value
    : undefined;
const memoryEvents = new Set([
  "MemoryRecalled",
  "PlanStepProposed",
  "PlanAbandoned",
  "PlanCompleted",
]);
/** The runner's tool events: hashed ids, codes, counts, sizes and flags only. */
const toolEvents = new Set([
  "ToolsListed",
  "ToolStepProposed",
  "ToolCallProposed",
  "ToolCallFinished",
  "ToolUndo",
]);
/** A proposed or executed action's content-free shape: positions and lengths. */
const actionKeys = [
  "actionType",
  "x",
  "y",
  "start_x",
  "start_y",
  "end_x",
  "end_y",
  "delta_x",
  "delta_y",
  "textLength",
  "nameLength",
  "noteLength",
  "siteKey",
  "menuTop",
];
/**
 * The menu bar's standard top-level titles: a menu_item row names which menu
 * it opened as one of these, or "other", never the path (cycles
 * 20260919-2339 and 20260920-0055: the CRM and ticket runs alternated
 * menu_item with a link on three pages, and the trace could not say which
 * menu; the path is the model's words and stays in the journal).
 */
const MENU_TOPS = new Set([
  "File",
  "Edit",
  "View",
  "History",
  "Bookmarks",
  "Window",
  "Help",
  "Format",
  "Go",
  "Tools",
  "Develop",
  "Tab",
  "Insert",
  "Table",
  "Apple",
]);
function menuTop(action: {
  type?: unknown;
  path?: unknown;
}): string | undefined {
  if (action.type !== "menu_item" || !Array.isArray(action.path))
    return undefined;
  const first = action.path[0];
  if (typeof first !== "string") return undefined;
  const title = first.replace(/[.…]+$/, "").trim();
  return MENU_TOPS.has(title) ? title : "other";
}
/**
 * Allow-listed keys that carry a list of codes from one fixed vocabulary:
 * each entry passes only as a member of its list, an entry off the list is
 * dropped, and anything but an array is dropped whole. The done audit's
 * unmetKinds (src/core/done-audit.ts REQUIREMENT_KINDS): which kind of
 * requirement the audit failed on (save, enter, write, …), never its words.
 * FrameCaptured's modifiers (src/core/schema.ts MODIFIER_WORDS): which
 * modifiers the session reported held at capture, never a key's name beyond
 * the six.
 */
const codeListFields = new Map<string, ReadonlySet<string>>([
  ["unmetKinds", new Set<string>(REQUIREMENT_KINDS)],
  ["modifiers", new Set<string>(MODIFIER_WORDS)],
]);
const codeList = (value: unknown, allowed: ReadonlySet<string>) =>
  Array.isArray(value)
    ? value
        .slice(0, 40)
        .map((v) => code(v))
        .filter((v): v is string => v !== undefined && allowed.has(v))
    : undefined;
/** Every journal row carries these, whatever the event. */
const journalBase = new Set(["runId", "sequence", "synthetic"]);
/**
 * The run journal (src/core/runner.ts this.event, src/storage/vault.ts):
 * what each event may put on its diagnostics row beside runId, sequence and
 * synthetic, after the readers in snapshot() have reduced it to codes,
 * counts, lengths and flags. An event not in this table writes the three
 * keys alone, whatever its payload carries (a correction's words, a summary,
 * a failure's message, a question); a key not in its set is dropped whatever
 * its value. The payload itself (`data`) is written only under verbose
 * debugging. docs/DEVELOPMENT.md "Diagnostics stream" has the same table.
 */
const journalEvents = new Map<string, Set<string>>([
  ["RunStarted", new Set(["origin", "privacy"])],
  ["RunCompleted", new Set()],
  // A failed run's code; REQUIREMENTS_UNMET adds the unmet kinds.
  ["RunFailed", new Set(["code", "unmetKinds"])],
  ["RunPaused", new Set(["reason"])],
  ["RunCancelled", new Set()],
  ["TaskAmended", new Set(["taskLength"])],
  // The done audit's rows carry purpose "audit" (Runner.addUsage).
  ["UsageAdded", new Set(["usage", "purpose"])],
  [
    "FrameCaptured",
    new Set([
      "frameId",
      "geometry",
      "textTruncated",
      "textNodes",
      "textMs",
      "textWalk",
      "modifiers",
    ]),
  ],
  ["TransitionSettled", new Set(["kind"])],
  ["ModelRequestStarted", new Set(["screenshot", "screenshotReason", "early"])],
  ["ModelResponseReceived", new Set(["usage"])],
  ["ProviderUnavailable", new Set(["attempt"])],
  ["ActionProposed", new Set([...actionKeys, "early"])],
  ["ActionNormalized", new Set(["actionType"])],
  [
    "ActionExecuted",
    new Set([
      ...actionKeys,
      "frameId",
      "early",
      "streamed",
      "via",
      "effect",
      "rung",
      "hitAncestor",
      // A link click in a browser that read as no page change: its line
      // carried the download hint (a flag, once per control a run).
      "downloadHint",
      "clauseIndex",
      "outcome",
      "launchedAppId",
      "frontmost",
      "wasRunning",
      "launchedWindows",
      "restoredWindow",
      "openedKind",
      "openedAppId",
      // An open_url's browser: the bundle id the address went to.
      "appId",
    ]),
  ],
  [
    "ActionFailed",
    new Set([
      "code",
      "change",
      "actionType",
      "reason",
      "problem",
      "unmet",
      "dismissed",
    ]),
  ],
  // The done audit's outcome: counts, its duration, ok or unavailable, the
  // attempts, the unmet requirements' kinds (codes), how many files were
  // read back for it and whether a page read was shown (never their text).
  [
    "DoneAudited",
    new Set([
      "requirements",
      "unmet",
      "unmetKinds",
      "durationMs",
      "code",
      "attempts",
      "deliverables",
      "pageRead",
    ]),
  ],
  ["ActionInterrupted", new Set(["actionType"])],
  ["ActionReaimed", new Set(["actionType"])],
  [
    "ActionRetargetRequested",
    new Set([
      "actionType",
      "appId",
      "targetRole",
      "focusedRole",
      "launcherStatus",
      "reasonCode",
      "reasonLength",
      "hitAncestor",
      // The open menu was closed for this refusal (a flag).
      "dismissed",
      // A refused tool_call: the tool's fixed trace name and server.
      "tool",
      "server",
    ]),
  ],
  [
    "ActionLoopDetected",
    new Set([
      "actionType",
      "period",
      "revisits",
      "noEffect",
      "pages",
      "repeatedMoves",
    ]),
  ],
  ["ActionLoopBroken", new Set(["episode", "outcome"])],
  ["NoProgressDetected", new Set(["actionType"])],
  ["SearchRouteTaken", new Set(["appId", "depth"])],
  ["PolicyAllowed", new Set(["actionType", "reasonCode", "reasonLength"])],
  [
    "PolicyConfirmationRequested",
    new Set([
      "actionType",
      "appId",
      "targetRole",
      "focusedRole",
      "approvalCode",
      "questionKind",
      "reasonLength",
    ]),
  ],
  ["UserConfirmed", new Set(["source"])],
  [
    "UserDenied",
    new Set([
      "source",
      "approvalCode",
      "actionType",
      "reasonCode",
      "reasonLength",
    ]),
  ],
  ["UserCorrectionRecorded", new Set(["textLength", "after_action"])],
  ["UserTakeoverStarted", new Set(["source", "scope"])],
  ["UserTakeoverEnded", new Set()],
  ["TargetBound", new Set(["appId", "by"])],
  ["TargetLeft", new Set(["reason", "code"])],
  ["TargetSelfActivated", new Set()],
  ["BackgroundRouteSkipped", new Set(["route"])],
  ["RungStepped", new Set(["from", "to", "actionType"])],
  ["ForegroundRequested", new Set(["reason", "actionType", "final"])],
  ["MonitorStarted", new Set(["appId", "mode", "delayMs", "durationMs"])],
  [
    "MemoryRecalled",
    new Set([
      "preferences",
      "episodes",
      "apps",
      "files",
      "folders",
      "skills",
      "plan",
      "mode",
    ]),
  ],
  ["PlanStepProposed", new Set(["source", "index", "actionType"])],
  ["PlanAbandoned", new Set(["index", "reason"])],
  ["PlanCompleted", new Set(["source"])],
  ["ToolsListed", new Set(["toolCount", "unavailableCount", "code"])],
  ["ToolStepProposed", new Set(["source"])],
  ["DictationStepProposed", new Set()],
  [
    "ToolCallProposed",
    new Set([
      "tool",
      "server",
      "toolTier",
      "argsBytes",
      "entityCount",
      "questionKind",
    ]),
  ],
  [
    "ToolCallFinished",
    new Set([
      "tool",
      "server",
      "outcome",
      "resultBytes",
      "resultItems",
      "durationMs",
      "verified",
      "finish",
      "longRunning",
      "repeat",
    ]),
  ],
  ["ToolUndo", new Set(["tool", "server", "outcome"])],
  ["StreamedStep", new Set(["kind", "siteKey", "clauseIndex", "outcome"])],
  ["SpeculationAdopted", new Set(["kind", "leadMs", "savedMs", "frameAgeMs"])],
  ["SpeculationDiscarded", new Set(["code", "kind", "usage"])],
]);
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value)
    ? value
    : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
/**
 * A policy decision's reason as a code: the runner's stamp when it is one,
 * else the decision's own table by event (src/core/decision-codes.ts), so a
 * journal written before the stamp, or a producer that forgot it, still
 * yields a code and never the sentence. A person's decline carries no reason
 * (its approvalCode names the question), so it yields nothing here.
 */
const reasonCodeOf = (type: string, data: Record<string, unknown>) => {
  const stamped = code(data.reasonCode);
  if (stamped) return stamped;
  if (typeof data.reason !== "string") return undefined;
  if (type === "PolicyAllowed") return allowedCode(data.reason);
  if (type === "ActionRetargetRequested") return retryCode(data.reason);
  if (type === "UserDenied") return deniedCode(data.reason);
  return undefined;
};

export class LocalDiagnostics {
  readonly file: string;
  private bytes = 0;
  private sequence = 0;
  private lastRun = "";
  private lastEvent = 0;
  private lastStatus = "";
  private warned = false;
  private lastFrame = "";
  private readonly frames: string;
  constructor(
    directory: string,
    private secrets: () => string[] = () => [],
    private output: (line: string) => void = (line) =>
      process.stdout.write(line),
    private maxBytes = 5 * 1024 * 1024,
    /**
     * Opt-in local debugging (COARENA_DIAGNOSTICS_VERBOSE=1): records spoken and
     * typed text, task text, full model actions, pill text, screen context and
     * screenshots. Provider keys are still redacted. Never enable by default.
     */
    readonly verbose = false,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.frames = join(directory, "frames");
    this.file = join(directory, "current.jsonl");
    if (existsSync(this.file)) {
      chmodSync(this.file, 0o600);
      this.bytes = statSync(this.file).size;
    }
  }
  private cleanVerbose(value: unknown, depth = 0): unknown {
    if (depth > 7) return undefined;
    if (typeof value === "string") {
      if (/^data:image\//.test(value)) return "[image]";
      let text = value;
      for (const secret of this.secrets())
        if (secret) text = text.replaceAll(secret, "[REDACTED:key]");
      // Everything stays readable except credential-shaped spans (tokens,
      // private keys, password/OTP assignments) that were spoken, typed or seen.
      return redactSecrets(text, "[REDACTED:secret]").slice(0, 4000);
    }
    if (typeof value === "number")
      return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value))
      return value.slice(0, 80).map((v) => this.cleanVerbose(v, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        this.cleanVerbose(v, depth + 1),
      ]),
    );
  }
  private clean(value: unknown, depth = 0, field = ""): unknown {
    if (this.verbose) return this.cleanVerbose(value, depth);
    if (depth > 4) return undefined;
    // Counts, measurements and flags never carry text; codes never carry
    // free-form sentences.
    if (countFields.has(field) || numberFields.has(field)) return count(value);
    if (flagFields.has(field))
      return typeof value === "boolean" ? value : undefined;
    if (codeFields.has(field)) return code(value);
    const allowedList = codeListFields.get(field);
    if (allowedList) return codeList(value, allowedList);
    if (bundleFields.has(field)) return bundleId(value);
    if (field === "host") return hostCode(value);
    if (typeof value === "string") {
      let text = value;
      for (const secret of this.secrets())
        if (secret) text = text.replaceAll(secret, "[REDACTED:key]");
      // An utterance id is an opaque token (normally a UUID), never a sentence.
      if (field === "utteranceId")
        return /^[A-Za-z0-9_-]{1,64}$/.test(text) && !scanText(text).length
          ? text
          : undefined;
      if (
        ["runId", "frameId", "requestId"].includes(field) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          text,
        )
      )
        return text;
      return sanitizeText(text).text.slice(0, 1200);
    }
    if (typeof value === "number")
      return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => fields.has(key))
        .map(([key, v]) => [key, this.clean(v, depth + 1, key)]),
    );
  }
  /**
   * What a direct write keeps before the field allow-list: the early,
   * speculation and keyed events their own keys, whatever else a caller
   * passes; a proposed action (a ProviderResponse's, with its text, note,
   * reason, summary, path or address) its type alone. Verbose debugging
   * keeps everything.
   */
  private shape(event: string, data: Record<string, unknown>) {
    if (this.verbose) return data;
    const keep = earlyEvents.has(event)
      ? earlyFields
      : speculationEvents.has(event)
        ? speculationFields
        : keyedEvents.get(event);
    const kept = keep
      ? Object.fromEntries(
          Object.entries(data).filter(([key]) => keep.has(key)),
        )
      : { ...data };
    if ("action" in kept) {
      const action = kept.action;
      delete kept.action;
      if (kept.actionType === undefined && action && typeof action === "object")
        kept.actionType = code((action as Record<string, unknown>).type);
    }
    return kept;
  }
  /**
   * A journal event's row keeps runId, sequence and synthetic and the keys
   * its table entry names (journalEvents); an event off the table keeps the
   * three alone. Verbose debugging keeps the whole row and the payload.
   */
  private journalRow(type: string, row: Record<string, unknown>) {
    if (this.verbose) return row;
    const allowed = journalEvents.get(type);
    return Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => journalBase.has(key) || allowed?.has(key) === true,
      ),
    );
  }
  readonly write: DiagnosticSink = (event, data = {}) => {
    try {
      if (!/^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(event)) return;
      const line =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          pid: process.pid,
          sequence: ++this.sequence,
          event,
          data: this.clean(this.shape(event, data)),
        }) + "\n";
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        rmSync(this.file + ".3", { force: true });
        for (let i = 2; i >= 0; i--) {
          const from = i ? this.file + "." + i : this.file;
          if (existsSync(from)) renameSync(from, this.file + "." + (i + 1));
        }
        this.bytes = 0;
      }
      appendFileSync(this.file, line, { mode: 0o600 });
      this.bytes += Buffer.byteLength(line);
      this.output(line);
    } catch {
      if (!this.warned) {
        this.warned = true;
        // A full disk or detached terminal must not stop the assistant.
        try {
          this.output('{"event":"DiagnosticWriteFailed"}\n');
        } catch {}
      }
    }
  };
  private saveFrame(s: Snapshot) {
    const frame = s.frame;
    if (!this.verbose || !s.run || !frame || frame.id === this.lastFrame)
      return;
    this.lastFrame = frame.id;
    try {
      const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(
        frame.image,
      );
      if (!match) return;
      mkdirSync(this.frames, { recursive: true, mode: 0o700 });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${s.run.id.slice(0, 8)}-${frame.id.slice(0, 8)}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
      writeFileSync(join(this.frames, name), Buffer.from(match[2], "base64"), {
        mode: 0o600,
      });
      // Keep the newest 300 screenshots.
      const files = readdirSync(this.frames).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 300)))
        rmSync(join(this.frames, old), { force: true });
      this.write("FrameSaved", {
        runId: s.run.id,
        frameId: frame.id,
        file: join(this.frames, name),
        appId: frame.appId,
        context: frame.context,
      });
    } catch {
      /* Debug screenshots must never interrupt a run. */
    }
  }
  snapshot(s: Snapshot) {
    if (!s.run) return;
    this.saveFrame(s);
    if (this.lastRun !== s.run.id) {
      this.lastRun = s.run.id;
      this.lastEvent = 0;
      this.lastStatus = "";
    }
    for (const e of s.events) {
      if (e.sequence_number <= this.lastEvent) continue;
      this.lastEvent = e.sequence_number;
      const action = e.data.action as Record<string, unknown> | undefined;
      const launched = e.data.launched as Record<string, unknown> | undefined;
      const opened = e.data.opened as Record<string, unknown> | undefined;
      const navigated = e.data.navigated as Record<string, unknown> | undefined;
      this.write(
        e.type,
        this.journalRow(e.type, {
          runId: s.run.id,
          sequence: e.sequence_number,
          // The full payload (action text, a correction's words, summaries, a
          // failure's message) is written only for opt-in verbose debugging;
          // the content-free row is built from the readers below and reduced
          // to its event's table entry by journalRow.
          ...(this.verbose ? { data: e.data } : {}),
          code: e.data.code,
          // ActionFailed for STATE_CHANGED: which kind of change, as a code.
          change: e.data.change,
          // ActionExecuted for a hotkey: pressed as its menu item or as keys;
          // for a click by name: the route that acted last (press or pointer)
          // and what the helper's reads found (changed, focused, none); for a
          // bound step: its rung. Codes, never a label.
          via: e.data.via,
          effect: e.data.effect,
          rung: e.data.rung,
          // ActionExecuted and ActionRetargetRequested for a click by name: the
          // control's point fell through to its own ancestor (native hitCover),
          // a flag beside the route.
          hitAncestor: e.data.hitAncestor,
          // ActionExecuted for a click on a link in a browser that read as no
          // page change: the history line carried DOWNLOAD_HINT (a flag).
          downloadHint: e.data.downloadHint,
          // ActionFailed STATE_CHANGED and ActionRetargetRequested: the runner
          // closed the menu the last right_click left open for this refusal.
          dismissed: e.data.dismissed,
          // A step taken before the run existed, while the user was speaking.
          early: e.data.early,
          // Its executed row, when the step was a fast action on a clause.
          streamed: e.data.streamed,
          // A fast action taken on a clause while the user spoke, journaled by
          // the run it started (StreamedStep): its kind, site code, clause and
          // outcome as codes and a count.
          ...(e.type === "StreamedStep"
            ? {
                kind: code(e.data.kind),
                siteKey: code(e.data.siteKey),
                clauseIndex: count(e.data.clauseIndex),
                outcome: code(e.data.outcome),
              }
            : {}),
          // The first step prepared while the user spoke, adopted or let go by
          // the run: its kind and timings (Speculation* events).
          ...(speculationEvents.has(e.type)
            ? {
                kind: code(e.data.kind),
                leadMs: count(e.data.leadMs),
                savedMs: count(e.data.savedMs),
                frameAgeMs: count(e.data.frameAgeMs),
              }
            : {}),
          // A decision's reason is the policy's sentence around a label, an
          // application or a question (a tool question names the item it would
          // add), so only its code and its length are written; a fixed word in
          // the field (deliverable_unchanged, refused_step, gone, pruned) is a
          // code itself and passes. The sentence stays in the encrypted journal.
          reason: code(e.data.reason),
          reasonCode: reasonCodeOf(e.type, e.data),
          reasonLength:
            typeof e.data.reason === "string"
              ? e.data.reason.length
              : undefined,
          // RunStarted: how the run began and under which privacy, as codes.
          origin: code(e.data.origin),
          privacy: code(e.data.privacy),
          // Who answered or caused it (a decline's pill or voice, a hand-off's
          // manual_input, handoff or policy, a plan's intent or skill): a code.
          source: code(e.data.source),
          // UserCorrectionRecorded: the words' length and their place in the run.
          ...(e.type === "UserCorrectionRecorded"
            ? {
                textLength:
                  typeof e.data.text === "string"
                    ? e.data.text.length
                    : undefined,
                after_action: count(e.data.after_action),
              }
            : {}),
          // A background run's rung step, a foreground detour's cap and a
          // search route's depth.
          ...(e.type === "RungStepped"
            ? { from: code(e.data.from), to: code(e.data.to) }
            : {}),
          ...(e.type === "ForegroundRequested" && e.data.final === true
            ? { final: true }
            : {}),
          ...(e.type === "SearchRouteTaken"
            ? { depth: count(e.data.depth) }
            : {}),
          ...(e.type === "UserTakeoverStarted"
            ? { scope: code(e.data.scope) }
            : {}),
          ...(e.type === "TargetBound" ? { by: code(e.data.by) } : {}),
          ...(e.type === "BackgroundRouteSkipped"
            ? { route: code(e.data.route) }
            : {}),
          ...(e.type === "MonitorStarted"
            ? {
                mode: code(e.data.mode),
                delayMs: count(e.data.delayMs),
                durationMs: count(e.data.durationMs),
              }
            : {}),
          ...(e.type === "ProviderUnavailable"
            ? { attempt: count(e.data.attempt) }
            : {}),
          // The done audit (src/core/done-audit.ts): how many requirements
          // the model listed and found unmet, the call's time and its code
          // (ok, unavailable), and the unmet requirements' kinds from the
          // fixed vocabulary (REQUIREMENT_KINDS), on the audit's row and on
          // the run it failed (RunFailed REQUIREMENTS_UNMET); on the
          // challenge (ActionFailed DONE_CHALLENGED requirement_unmet) the
          // unmet count. The requirements' words stay in the encrypted
          // journal's history line.
          ...(e.type === "DoneAudited"
            ? {
                requirements: count(e.data.requirements),
                unmet: count(e.data.unmet),
                durationMs: count(e.data.durationMs),
                // How many calls the audit took (one, or two after an
                // unusable reply); the table allowed it since abc24ae but
                // no reader carried it.
                attempts: count(e.data.attempts),
                // Files read back for the audit (a count) and whether the
                // last page read was shown (a flag); the text of neither.
                deliverables: count(e.data.deliverables),
                pageRead: e.data.pageRead,
              }
            : {}),
          ...(e.type === "DoneAudited" || e.type === "RunFailed"
            ? {
                unmetKinds: codeList(
                  e.data.unmetKinds,
                  codeListFields.get("unmetKinds")!,
                ),
              }
            : {}),
          ...(e.type === "ActionFailed" ? { unmet: count(e.data.unmet) } : {}),
          questionKind: code(e.data.questionKind),
          // The question asked as a code (src/core/approval-codes.ts): the
          // runner's stamp, else read off the question here.
          approvalCode:
            code(e.data.approvalCode) ??
            (e.type === "PolicyConfirmationRequested" &&
            typeof e.data.reason === "string"
              ? approvalCode(e.data.reason)
              : undefined),
          usage: e.data.usage,
          // UsageAdded: what the usage paid for ("audit", the done audit's
          // calls, which a harness reprices at the auditor's rates).
          purpose: code(e.data.purpose),
          screenshot: e.data.screenshot,
          screenshotReason: e.data.screenshotReason,
          frameId: e.data.frame_id,
          geometry: e.data.geometry,
          // FrameCaptured: the page text's stop as a code and the walk's counts.
          textTruncated: code(e.data.textTruncated),
          textNodes: count(e.data.textNodes),
          textMs: count(e.data.textMs),
          textWalk: code(e.data.textWalk),
          // FrameCaptured: the held modifiers as a list of the fixed words.
          modifiers: codeList(
            e.data.modifiers,
            codeListFields.get("modifiers")!,
          ),
          synthetic: s.run.synthetic,
          actionType: e.data.actionType,
          appId: e.data.appId,
          targetRole: e.data.targetRole,
          focusedRole: e.data.focusedRole,
          launcherStatus: e.data.launcherStatus,
          normalized: e.data.normalized,
          // The cycle length of a repeated action; ActionLoopDetected carries no
          // content, and a REFUSED failure is logged by its code alone.
          period: e.data.period,
          revisits: e.data.revisits,
          // The page-switch rule: how many distinct pages the run bounced
          // between (a count); the pages themselves are never journaled.
          pages: e.data.pages,
          // How many of the bounce's moves retraced a control already used
          // for one (a count); the controls themselves are never journaled.
          repeatedMoves: e.data.repeatedMoves,
          // A click by name with no effect, repeated from one screen (a flag).
          noEffect: e.data.noEffect,
          // The loop breaker's decision (ActionLoopBroken): which episode and
          // whether the run got its reflection step or was failed as stuck.
          ...(e.type === "ActionLoopBroken"
            ? { episode: count(e.data.episode), outcome: code(e.data.outcome) }
            : {}),
          // The wait before a capture after a transition (TransitionSettled).
          ...(e.type === "TransitionSettled"
            ? { kind: code(e.data.kind) }
            : {}),
          // TaskAmended records only the new task's length, never its text.
          taskLength: count(e.data.taskLength),
          // Only the fixed, content-free problem description of a malformed reply.
          problem:
            e.data.code === "MALFORMED_RESPONSE" ? e.data.problem : undefined,
          // Memory recall and replay plans: counts, positions and fixed codes.
          // Preference, episode, skill and file text or paths never appear.
          ...(memoryEvents.has(e.type)
            ? {
                preferences: count(e.data.preferences),
                episodes: count(e.data.episodes),
                apps: count(e.data.apps),
                files: count(e.data.files),
                folders: count(e.data.folders),
                skills: count(e.data.skills),
                index: count(e.data.index),
                plan: code(e.data.plan),
                mode: code(e.data.mode),
                source: code(e.data.source),
                reason: code(e.data.reason),
              }
            : {}),
          ...(toolEvents.has(e.type)
            ? {
                tool: code(e.data.tool),
                server: code(e.data.server),
                toolTier: code(e.data.toolTier),
                outcome: code(e.data.outcome),
                source: code(e.data.source),
                toolCount: count(e.data.toolCount),
                unavailableCount: count(e.data.unavailableCount),
                entityCount: count(e.data.entityCount),
                argsBytes: count(e.data.argsBytes),
                resultBytes: count(e.data.resultBytes),
                resultItems: count(e.data.resultItems),
                durationMs: count(e.data.durationMs),
                verified: e.data.verified,
                finish: e.data.finish,
                longRunning: e.data.longRunning,
                // A read answered from the run's earlier result, the tool
                // not called (ToolCallFinished).
                repeat: e.data.repeat,
              }
            : {}),
          // A refused tool_call names its tool by the frozen spec's trace
          // name and server (the runner's stamp, never the model's string),
          // so the trace pairs the refusal with the tool.
          ...(e.type === "ActionRetargetRequested" &&
          e.data.actionType === "tool_call"
            ? { tool: code(e.data.tool), server: code(e.data.server) }
            : {}),
          // App names are user metadata; only the bundle id and flags are logged.
          ...(e.type === "ActionExecuted" && launched
            ? {
                launchedAppId: launched.appId,
                frontmost: launched.frontmost,
                wasRunning: launched.wasRunning,
                // A count and a flag: whether a running app came up windowless.
                launchedWindows: launched.windows,
                restoredWindow: launched.restoredWindow,
              }
            : {}),
          // An opened file is logged by kind and handling app, never its path.
          ...(e.type === "ActionExecuted" && opened
            ? { openedKind: code(opened.kind), openedAppId: opened.appId }
            : {}),
          // An open_url's browser, as a bundle id or nothing (a pinned run
          // that still drove another browser shows here); never the address.
          ...(e.type === "ActionExecuted" && navigated
            ? { appId: bundleId(navigated.appId) }
            : {}),
          ...(action
            ? {
                actionType: action.type,
                x: action.x,
                y: action.y,
                start_x: action.start_x,
                start_y: action.start_y,
                end_x: action.end_x,
                end_y: action.end_y,
                delta_x: action.delta_x,
                delta_y: action.delta_y,
                textLength:
                  typeof action.text === "string"
                    ? action.text.length
                    : undefined,
                nameLength:
                  action.type === "open_app" && typeof action.name === "string"
                    ? action.name.length
                    : undefined,
                // An open_url's site code (a recipe's key), never its address:
                // a streamed row and a later model row of the same site read
                // as a repeat (scripts/streaming-report.mjs).
                siteKey:
                  action.type === "open_url" ? code(action.siteKey) : undefined,
                // The model's note is a value it read on screen: its length only.
                noteLength:
                  typeof action.note === "string"
                    ? action.note.length
                    : undefined,
                // Which menu a menu_item opened, as a standard title or other.
                menuTop: menuTop(action),
              }
            : {}),
        }),
      );
    }
    if (this.lastStatus !== s.run.status) {
      this.lastStatus = s.run.status;
      this.write("RunState", {
        runId: s.run.id,
        status: s.run.status,
        provider: s.run.provider,
        model: s.run.model,
        actions: s.run.actions,
        frames: s.run.frames,
        usage: s.run.usage,
        taskLength: s.run.task.length,
        appId: s.frame?.appId,
        toolCalls: count(s.run.tools?.calls),
        toolWrites: count(s.run.tools?.writes),
        // The task, the pill's message, the summary, the corrections and the
        // pending question are text and are handed over only for opt-in
        // verbose debugging; a failed run's message can quote a tool result
        // or the screen, so the same holds for it (RunFailed carries the code).
        ...(this.verbose
          ? {
              task: s.run.task,
              message: s.message,
              summary: s.run.summary,
              corrections: s.run.corrections,
              pending: s.pending,
              ...(s.run.status === "failed" ? { error: s.message } : {}),
            }
          : {}),
      });
    }
  }
}
