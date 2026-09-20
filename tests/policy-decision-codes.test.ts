import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALLOWED_CODES,
  DENY_CODES,
  RETRY_CODES,
  allowedCode,
  deniedCode,
  retryCode,
} from "../src/core/decision-codes";
import {
  PASTE_ALLOWED,
  PROTECTED_SITE_REFUSAL,
  SPEAKING_RETRY,
} from "../src/core/policy";
import { windowlessRepeat } from "../src/core/runner";
import { TOOL_ALLOWED } from "../src/core/tool-policy";
import { TOOL_REFUSALS } from "../src/core/tools";

/**
 * The reason → code tables the diagnostics stream and the bench use to say
 * what the policy decided without its sentence (src/core/decision-codes.ts).
 * The policy's ALLOW, RETRY and DENY reasons are read from its source here,
 * so a decision site added without a code fails this suite rather than
 * reaching a trace as OTHER.
 */

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const policySource = read("src/core/policy.ts");
const runnerSource = read("src/core/runner.ts");
const diagnosticsSource = read("electron/diagnostics.ts");

/** The index of the brace closing the object literal that starts before `from`. */
function objectEnd(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i;
  }
  return source.length;
}
/** A template literal's text with every balanced `${…}` standing in as "Label". */
function flatten(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "$" && body[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < body.length && depth > 0; j++)
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
      out += "Label";
      i = j - 1;
    } else out += body[i];
  }
  return out;
}
/** Every string and template literal in a block, templates flattened. */
function literals(block: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < block.length && block[j] !== '"') {
        if (block[j] === "\\") {
          s += block[j + 1];
          j += 2;
          continue;
        }
        s += block[j++];
      }
      found.push(s);
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      let s = "";
      let depth = 0;
      while (j < block.length) {
        if (block[j] === "$" && block[j + 1] === "{") {
          depth++;
          s += "${";
          j += 2;
          continue;
        }
        if (depth > 0) {
          if (block[j] === "{") depth++;
          if (block[j] === "}") depth--;
          s += block[j++];
          continue;
        }
        if (block[j] === "`") break;
        if (block[j] === "\\") {
          s += block[j + 1];
          j += 2;
          continue;
        }
        s += block[j++];
      }
      found.push(flatten(s));
      i = j;
    }
  }
  return found;
}
/** A module-private constant's string value, read from the source. */
function constant(source: string, name: string): string {
  const m = new RegExp(`const ${name} =\\s*"([^"]*)"`, "s").exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}
/**
 * Every reason policy.ts can put in a decision of one kind: the literals of
 * each `kind: "<KIND>"` site's `reason:` (a sentence, or the empty ALLOW of a
 * step with no rule to state; a bare word in a ternary's condition is not a
 * reason), and the named constants the sites use. Also how many sites were
 * read, so a refactor that empties the scan is a failure, not a pass.
 */
function reasons(
  kind: "ALLOW" | "RETRY" | "DENY",
  named: Record<string, string>,
): { reasons: string[]; sites: number } {
  const found = new Set<string>();
  let at = 0;
  let sites = 0;
  while ((at = policySource.indexOf(`kind: "${kind}"`, at)) !== -1) {
    sites++;
    const block = policySource.slice(at, objectEnd(policySource, at));
    at += 1;
    const from = block.indexOf("reason");
    const part = from === -1 ? "" : block.slice(from);
    for (const literal of literals(part))
      if (literal === "" || literal.includes(" ")) found.add(literal);
    for (const [name, text] of Object.entries(named))
      if (new RegExp(`\\b${name}\\b`).test(part)) found.add(text);
  }
  return { reasons: [...found], sites };
}

const IDE_TERMINAL_REFUSAL = constant(policySource, "IDE_TERMINAL_REFUSAL");
const MENU_REFUSAL = constant(policySource, "MENU_REFUSAL");
const CLIPBOARD_REFUSAL = constant(policySource, "CLIPBOARD_REFUSAL");

describe("decision codes", () => {
  it("maps every ALLOW reason policy.ts states, and every tool ALLOW, to a code other than OTHER", () => {
    const { reasons: found, sites } = reasons("ALLOW", { PASTE_ALLOWED });
    // policy.ts has 57 ALLOW sites and about 54 distinct reasons today.
    expect(sites).toBeGreaterThanOrEqual(50);
    expect(found.length).toBeGreaterThanOrEqual(50);
    for (const reason of found)
      expect(allowedCode(reason), reason).not.toBe("OTHER");
    expect(found).toContain("");
    expect(found).toContain("Type in a known non-secure text field.");
    expect(found).toContain(PASTE_ALLOWED);
    for (const reason of Object.values(TOOL_ALLOWED))
      expect(allowedCode(reason), reason).not.toBe("OTHER");
  });

  it("maps every RETRY reason policy.ts states, every tool RETRY and the runner's windowless repeat, to a code other than OTHER", () => {
    const { reasons: found, sites } = reasons("RETRY", { SPEAKING_RETRY });
    // policy.ts has 43 RETRY sites and about 44 distinct reasons today.
    expect(sites).toBeGreaterThanOrEqual(40);
    expect(found.length).toBeGreaterThanOrEqual(40);
    for (const reason of found)
      expect(retryCode(reason), reason).not.toBe("OTHER");
    expect(found).toContain(SPEAKING_RETRY);
    for (const key of [
      "practice",
      "unknown_tool",
      "invalid_args",
      "too_large",
      "bad_path",
      "unavailable",
      "no_hook",
    ] as const)
      expect(retryCode(TOOL_REFUSALS[key]), key).not.toBe("OTHER");
    expect(retryCode(windowlessRepeat("Calendar"))).toBe("WINDOWLESS_REPEAT");
  });

  it("maps every DENY reason policy.ts states, and every tool DENY, to a code other than OTHER", () => {
    const { reasons: found, sites } = reasons("DENY", {
      PROTECTED_SITE_REFUSAL,
      IDE_TERMINAL_REFUSAL,
      MENU_REFUSAL,
      CLIPBOARD_REFUSAL,
    });
    // policy.ts has 25 DENY sites and about 21 distinct reasons today.
    expect(sites).toBeGreaterThanOrEqual(22);
    expect(found.length).toBeGreaterThanOrEqual(19);
    for (const reason of found)
      expect(deniedCode(reason), reason).not.toBe("OTHER");
    expect(found).toContain(PROTECTED_SITE_REFUSAL);
    expect(found).toContain(IDE_TERMINAL_REFUSAL);
    for (const key of [
      "denylisted",
      "credential",
      "budget",
      "privacy",
    ] as const)
      expect(deniedCode(TOOL_REFUSALS[key]), key).not.toBe("OTHER");
  });

  it("names the shape, never the label, the application, the chord or the file", () => {
    expect(
      allowedCode(
        "“Confirm reservation for SECRETWORD”: done without asking, as you set. Reported when done.",
      ),
    ).toBe("ALLOWED_AUTONOMY_ALL");
    expect(allowedCode(TOOL_ALLOWED.unasked)).toBe("ALLOWED_AUTONOMY_ALL");
    expect(
      allowedCode(
        "“Add to SECRETWORD” is what you asked for and can be undone: reported, not asked.",
      ),
    ).toBe("ALLOWED_GROUNDED");
    expect(
      allowedCode(
        "“Undo Typing SECRETWORD” takes the last step back: done without asking, and reported.",
      ),
    ).toBe("UNDO_MENU");
    expect(allowedCode("")).toBe("NONE");
    expect(allowedCode(TOOL_ALLOWED.grounded_write)).toBe(
      "TOOL_GROUNDED_WRITE",
    );
    expect(
      allowedCode("This application's own shortcut for “SECRETWORD”."),
    ).toBe("MENU_SHORTCUT");
    expect(allowedCode("Type into Spotlight’s SECRETWORD field.")).toBe(
      "SEARCH_FIELD_TYPE",
    );
    expect(
      retryCode(
        "No input was sent. Nothing in context.controls is named “SECRETWORD” now. If you can see it in the screenshot, click it by position with click(x,y) instead; otherwise take a fresh look. Do not repeat this name.",
      ),
    ).toBe("CONTROL_NOT_FOUND");
    expect(retryCode(SPEAKING_RETRY)).toBe("WAITING_FOR_SENTENCE");
    expect(
      retryCode(
        "No input was sent. Use a full http or https address without credentials.",
      ),
    ).toBe("BAD_URL");
    expect(
      retryCode(
        "No input was sent. “SECRETWORD” is open but shows no window. Choose its window from its Window menu in context.menus, or use File > New.",
      ),
    ).toBe("WINDOWLESS");
    expect(retryCode(windowlessRepeat("SECRETWORD"))).toBe("WINDOWLESS_REPEAT");
    expect(
      retryCode(
        "More than one installed application matches. Candidates: SECRETWORD, SECRETWORD Beta. Use the exact name.",
      ),
    ).toBe("APP_AMBIGUOUS");
    expect(
      retryCode(
        'No input was sent. No installed application matches "SECRETWORD" exactly. Use one of them, or request_user if it is not installed.',
      ),
    ).toBe("APP_UNRESOLVED");
    expect(retryCode(TOOL_REFUSALS.bad_path)).toBe("TOOL_BAD_PATH");
    expect(
      deniedCode(
        "No input was sent. The step's target is not the “SECRETWORD” window this run is bound to; input goes only to that window.",
      ),
    ).toBe("OUTSIDE_BOUND_WINDOW");
    expect(deniedCode(PROTECTED_SITE_REFUSAL)).toBe("PROTECTED_SITE");
    expect(deniedCode(CLIPBOARD_REFUSAL)).toBe("CLIPBOARD");
    expect(deniedCode(TOOL_REFUSALS.credential)).toBe("TOOL_CREDENTIAL");
  });

  it("is exact: a drifted or unknown reason is OTHER, and the codes are code-shaped and distinct", () => {
    for (const fn of [allowedCode, retryCode, deniedCode]) {
      expect(fn("SECRETWORD")).toBe("OTHER");
      expect(fn("Type in a known non-secure text field. ")).toBe("OTHER");
      expect(fn("type in a known non-secure text field.")).toBe("OTHER");
      expect(fn("constructor")).toBe("OTHER");
      expect(fn("__proto__")).toBe("OTHER");
    }
    expect(retryCode("")).toBe("OTHER");
    expect(deniedCode("")).toBe("OTHER");
    for (const codes of [ALLOWED_CODES, RETRY_CODES, DENY_CODES]) {
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes).toContain("OTHER");
      for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]{1,39}$/);
    }
  });

  it("is stamped by the runner on every allowed step, every retarget and every policy denial, and read by the diagnostics stream", () => {
    expect(
      runnerSource.match(/reasonCode: allowedCode\((?:decision|p)\.reason\)/g),
    ).toHaveLength(3);
    expect(
      runnerSource.match(/reasonCode: retryCode\(decision\.reason\)/g),
    ).toHaveLength(2);
    expect(
      runnerSource.match(/reasonCode: deniedCode\(decision\.reason\)/g),
    ).toHaveLength(1);
    // Every PolicyAllowed, ActionRetargetRequested and policy UserDenied
    // journal site carries the stamp (the person's decline carries the
    // question's approvalCode instead).
    expect(runnerSource.match(/this\.event\("PolicyAllowed"/g)).toHaveLength(3);
    expect(
      runnerSource.match(/this\.event\("ActionRetargetRequested"/g),
    ).toHaveLength(2);
    expect(diagnosticsSource).toContain(
      "reasonCode: reasonCodeOf(e.type, e.data)",
    );
    expect(diagnosticsSource).toContain(
      '["UserCorrectionRecorded", new Set(["textLength", "after_action"])]',
    );
  });
});
