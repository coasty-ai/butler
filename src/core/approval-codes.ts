/**
 * Every question the policy can ask, as a short fixed code.
 *
 * The policy's questions are fixed strings or fixed shapes around a quoted
 * label or an application's name (src/core/policy.ts consequentialReason and
 * its other CONFIRM sites; src/core/tool-text.ts toolQuestion for a tool
 * step). The bench answers those questions unattended and the diagnostics
 * stream records the answer, and both must say what was asked without the
 * label, the application or any other screen text, so the code names the
 * shape of the question and nothing in it. A question this table does not
 * know is OTHER; tests/policy-approval-codes.test.ts enumerates the policy's
 * CONFIRM sites so a new question cannot stay OTHER unnoticed.
 */
import { PROTECTED_SITE_QUESTION, UNDO_QUESTION } from "./policy";

export const APPROVAL_CODES = [
  // consequentialReason: a control whose label names its consequence.
  "SEND_MESSAGE",
  "DISCARD_CHANGES",
  "REPLACE_ITEM",
  "SUBSCRIPTION",
  "CALL_CONTACT",
  "PLACE_ORDER",
  "DELETE_ITEM",
  "TRANSACTION",
  "PUBLISH_POST",
  "PUBLISH_COMMENT",
  "SHARE_UPLOAD",
  "ACCOUNT_SECURITY",
  "INSTALL_SOFTWARE",
  "SEND_INVITATION",
  "DECLINE_INVITATION",
  "SIGN_OUT",
  "RESTART_SHUTDOWN",
  "ACCEPT_SIGN",
  "ARCHIVE_ITEM",
  "RESET_ERASE",
  "DISABLE_REVOKE",
  "SAVE_CHANGES",
  "SUBMIT_AUTHORIZE",
  // Keys and shortcuts.
  "QUIT_APP",
  "RUN_RELOAD",
  "SHORTCUT_SEND_DELETE",
  "ACTIVATE_CONTROL",
  "TYPE_LINE_BREAKS",
  // Opening things.
  "OPEN_ITEM",
  "OPEN_FILE",
  "OPEN_FOLDER",
  "PROTECTED_SITE",
  "PALETTE_COMMAND",
  // Pointer targets.
  "CLICK_CONTROL",
  "CHANGE_SETTING",
  "DISCARD_AGENT_CHANGES",
  "UNDO",
  // An application that publishes no accessibility.
  "TYPE_BLIND",
  "CLICK_BLIND",
  // Tool steps (toolQuestion).
  "TOOL_CALENDAR_ADD",
  "TOOL_REMINDER_ADD",
  "TOOL_NOTE_ADD",
  "TOOL_MAIL_DRAFT",
  "TOOL_AGENT_RUN",
  "TOOL_MCP_READ",
  "TOOL_MCP_WRITE",
  "TOOL_SEND_TO",
  "OTHER",
] as const;
export type ApprovalCode = (typeof APPROVAL_CODES)[number];

/** The questions that are one fixed string, compared whole. */
const FIXED = new Map<string, ApprovalCode>([
  ["Send this message?", "SEND_MESSAGE"],
  ["Discard unsaved changes?", "DISCARD_CHANGES"],
  ["Replace the existing item?", "REPLACE_ITEM"],
  ["Change this subscription?", "SUBSCRIPTION"],
  ["Call this contact?", "CALL_CONTACT"],
  ["Place this order?", "PLACE_ORDER"],
  ["Delete this item?", "DELETE_ITEM"],
  ["Approve this transaction?", "TRANSACTION"],
  ["Publish this post?", "PUBLISH_POST"],
  ["Publish this comment?", "PUBLISH_COMMENT"],
  ["Share or upload this item?", "SHARE_UPLOAD"],
  ["Change these account or security settings?", "ACCOUNT_SECURITY"],
  ["Install this software?", "INSTALL_SOFTWARE"],
  ["Send this invitation?", "SEND_INVITATION"],
  ["Decline this invitation?", "DECLINE_INVITATION"],
  ["Sign out of this account?", "SIGN_OUT"],
  ["Restart, shut down or force quit?", "RESTART_SHUTDOWN"],
  ["Accept or sign this?", "ACCEPT_SIGN"],
  ["Archive this item?", "ARCHIVE_ITEM"],
  ["Reset or erase this?", "RESET_ERASE"],
  ["Disable or revoke this?", "DISABLE_REVOKE"],
  ["Save these changes?", "SAVE_CHANGES"],
  ["Submit or authorize this change?", "SUBMIT_AUTHORIZE"],
  ["Quit this application?", "QUIT_APP"],
  ["Run or reload in this application?", "RUN_RELOAD"],
  [
    "This shortcut may send or delete content. Allow it?",
    "SHORTCUT_SEND_DELETE",
  ],
  [
    "Activate this control? It may submit or change content.",
    "ACTIVATE_CONTROL",
  ],
  [
    "Type text with line breaks or tabs? Line breaks may send a message and tabs may move focus.",
    "TYPE_LINE_BREAKS",
  ],
  ["Open this item? It may run a program.", "OPEN_ITEM"],
  ["Open this file? It may run a program.", "OPEN_FILE"],
  ["Change this setting?", "CHANGE_SETTING"],
  ["Discard the coding agent's changes?", "DISCARD_AGENT_CHANGES"],
  [UNDO_QUESTION, "UNDO"],
  [PROTECTED_SITE_QUESTION, "PROTECTED_SITE"],
]);

/**
 * The questions that quote a label, an application or a tool's facts inside
 * a fixed frame; the frame decides, and a quoted part that reads like another
 * question changes nothing (the click question comes first, so a control
 * labelled with a question of its own is still a click). Tried in order
 * after the fixed table, so "Send this message?" is never a tool's send.
 */
const SHAPES: readonly (readonly [RegExp, ApprovalCode])[] = [
  [/^Click “.*”\?$/su, "CLICK_CONTROL"],
  [
    /\? An editor can run a project's own tasks when it opens its folder\.$/su,
    "OPEN_FOLDER",
  ],
  [/\? It may not be exactly that command\.$/su, "PALETTE_COMMAND"],
  [/\? I can’t see its text fields\.$/su, "TYPE_BLIND"],
  [/\? I can’t see its controls\.$/su, "CLICK_BLIND"],
  [/^Add .* to Calendar, .*\?$/su, "TOOL_CALENDAR_ADD"],
  [/^Add .* to Reminders(?:, due .*)?\?$/su, "TOOL_REMINDER_ADD"],
  [/^Add a note .* to Notes\?$/su, "TOOL_NOTE_ADD"],
  [/^Add a Mail draft to .*\?$/su, "TOOL_MAIL_DRAFT"],
  [/^Use .* to read with .*\?$/su, "TOOL_MCP_READ"],
  [/^Use .* to run .*\?$/su, "TOOL_MCP_WRITE"],
  [/^Run .* in .*\?$/su, "TOOL_AGENT_RUN"],
  [/^Send .* to .*\?$/su, "TOOL_SEND_TO"],
];

/**
 * The code for a question the policy asked (a CONFIRM decision's reason).
 * Exact, never trimmed or lowercased: a question that drifted from the
 * policy's string is OTHER, which the enumeration test turns into a failure.
 */
export function approvalCode(reason: string): ApprovalCode {
  const fixed = FIXED.get(reason);
  if (fixed) return fixed;
  for (const [shape, code] of SHAPES) if (shape.test(reason)) return code;
  return "OTHER";
}
