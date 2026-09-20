import { describe, it, expect } from "vitest";
import { cleanScreenContext, trimScreenContext } from "../src/core/context";
import { MODIFIER_WORDS } from "../src/core/schema";
describe("bounded screen context", () => {
  it("retains references while removing detected credentials", () => {
    const result = cleanScreenContext({
      appName: "Preview",
      windowTitle: "September report.pdf",
      selectedText: "Email Lawrence at lawrence@example.com",
      launcher: {
        query: "Chrome",
        selectedResult: "Chrome Remote Desktop Host Uninstaller",
      },
      visibleText: "password=fixture_secret",
      documentName: "September report.pdf",
      recentWindows: [{ appName: "Numbers", title: "Investors" }],
      recentFiles: ["Investors.xlsx"],
      recentTasks: [{ task: "Open the report", status: "completed" }],
    });
    expect(result?.selectedText).toContain("lawrence@example.com");
    expect(result?.launcher?.selectedResult).toBe(
      "Chrome Remote Desktop Host Uninstaller",
    );
    expect(result?.visibleText).not.toContain("fixture_secret");
    expect(result?.recentWindows?.[0].title).toBe("Investors");
  });
  it("redacts only the credential span and keeps ordinary labels", () => {
    const result = cleanScreenContext({
      appName: "Safari",
      windowTitle: "Reset your password: Step 1",
      visibleText:
        "Sign in to Example. Password: Forgot? MFA: enabled. api_key=sk-fixtureSECRET123456 Continue",
    });
    expect(result?.windowTitle).toBe("Reset your password: Step 1");
    expect(result?.visibleText).toContain("Sign in to Example.");
    expect(result?.visibleText).toContain("Password: Forgot?");
    expect(result?.visibleText).toContain("MFA: enabled.");
    expect(result?.visibleText).toContain("[Sensitive text omitted] Continue");
    expect(result?.visibleText).not.toContain("fixtureSECRET");
  });
  it("keeps the held modifiers as the fixed words in their fixed order, drops a word off the list and not the context, and leaves them out of the model's copy", () => {
    // The helper's read of the session's modifier state at capture (live
    // 2026-09-20: a Fn the system believed held for seven hours); the order
    // is the fixed one whatever the helper sent, a word is kept once, and a
    // word that is not one of the six goes without taking the context.
    const held = cleanScreenContext({
      appName: "Safari",
      windowTitle: "Form",
      modifiers: ["shift", "fn", "Globe", "fn", "Shift"],
    });
    expect(held?.modifiers).toEqual(["fn", "shift"]);
    expect(held?.appName).toBe("Safari");
    expect(
      cleanScreenContext({ appName: "x", windowTitle: "x", modifiers: [] })
        ?.modifiers,
    ).toEqual([]);
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        modifiers: [...MODIFIER_WORDS].reverse(),
      })?.modifiers,
    ).toEqual([...MODIFIER_WORDS]);
    expect(
      cleanScreenContext({ appName: "x", windowTitle: "x" }),
    ).not.toHaveProperty("modifiers");
    // The model's copy carries none: the runner's history line speaks for it.
    expect(
      trimScreenContext({ appName: "x", windowTitle: "x", modifiers: ["fn"] }),
    ).not.toHaveProperty("modifiers");
    expect(MODIFIER_WORDS).toEqual([
      "fn",
      "command",
      "shift",
      "option",
      "control",
      "capslock",
    ]);
  });
  it("parses the page-text walk's stop and counts, and rejects a stop that is not one of its codes", () => {
    const cut = cleanScreenContext({
      appName: "Safari",
      windowTitle: "Site chat",
      visibleText: "a\n[page continues below; scroll to read more]",
      visibleTextTruncated: "chars",
      visibleTextNodes: 4000,
      visibleTextMs: 412,
    });
    expect(cut).toMatchObject({
      visibleTextTruncated: "chars",
      visibleTextNodes: 4000,
      visibleTextMs: 412,
    });
    // Which walk read the text: page or window (the fallback after a page
    // walk that finished small); another word is dropped, and the model's
    // copy never carries it.
    for (const walk of ["page", "window"])
      expect(
        cleanScreenContext({
          appName: "x",
          windowTitle: "x",
          visibleTextWalk: walk,
        })?.visibleTextWalk,
      ).toBe(walk);
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        visibleTextWalk: "root",
      })?.visibleTextWalk,
    ).toBeUndefined();
    expect(
      trimScreenContext({
        appName: "x",
        windowTitle: "x",
        visibleTextWalk: "window",
      }),
    ).not.toHaveProperty("visibleTextWalk");
    for (const truncated of ["time", "nodes"])
      expect(
        cleanScreenContext({
          appName: "x",
          windowTitle: "x",
          visibleTextTruncated: truncated,
        })?.visibleTextTruncated,
      ).toBe(truncated);
    // The code is one of three fixed words; a sentence or a number is not.
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        visibleTextTruncated: "the walk ran out of time",
      }),
    ).toBeUndefined();
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        visibleTextNodes: -1,
      }),
    ).toBeUndefined();
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        visibleTextMs: 1.5,
      }),
    ).toBeUndefined();
    const plain = cleanScreenContext({ appName: "x", windowTitle: "x" })!;
    expect("visibleTextTruncated" in plain).toBe(false);
    expect("visibleTextNodes" in plain).toBe(false);
  });
  it("rejects unbounded context and unknown capability fields", () => {
    expect(
      cleanScreenContext({ appName: "x", windowTitle: "x", shell: "ls" }),
    ).toBeUndefined();
    expect(
      cleanScreenContext({
        appName: "x",
        windowTitle: "x",
        selectedText: "x".repeat(2001),
      }),
    ).toBeUndefined();
  });
  it("keeps bounded grounded controls and redacts credential labels", () => {
    const controls = [
      { role: "button", label: "2", x: 0.318, y: 0.524 },
      {
        role: "textfield",
        label: "token=sk-fixtureSECRET123456",
        x: 0.5,
        y: 0.1,
      },
      { role: "button", x: 0.9, y: 0.9, enabled: false },
    ];
    const result = cleanScreenContext({
      appName: "Calculator",
      windowTitle: "Calculator",
      controls,
    });
    expect(result?.controls?.[0]).toEqual(controls[0]);
    expect(result?.controls?.[1].label).not.toContain("fixtureSECRET");
    expect(result?.controls?.[2]).toEqual(controls[2]);
    const long = cleanScreenContext({
      appName: "A".repeat(400),
      windowTitle: "B",
      controls: [{ role: "link", label: "नमस्ते".repeat(30), x: 0.1, y: 0.1 }],
    });
    expect(long?.appName).toHaveLength(300);
    expect(long?.controls?.[0].label?.length).toBeLessThanOrEqual(80);
    expect(cleanScreenContext(long)).toBeDefined();
    // A radio button's group (its fieldset's legend, native controlGroup)
    // rides beside its label, cleaned and bounded to 60 characters.
    const radio = {
      role: "radiobutton",
      label: "Receipts",
      group: "File under",
      x: 0.4,
      y: 0.6,
    };
    expect(
      cleanScreenContext({
        appName: "Safari",
        windowTitle: "Mail",
        controls: [radio],
      })?.controls?.[0],
    ).toEqual(radio);
    expect(
      cleanScreenContext({
        appName: "A",
        windowTitle: "B",
        controls: [{ ...radio, group: "g".repeat(61) }],
      })?.controls?.[0].group,
    ).toHaveLength(60);
    // A name qualified by its row (native ListNames.swift: "Details (Vendor
    // B)" for a link repeated in every row of a table) is admitted whole,
    // parentheses included, at 60 characters and at the 80-unit name cap
    // itself; one past the cap is cut like any other label.
    const listed = (label: string) =>
      cleanScreenContext({
        appName: "Safari",
        windowTitle: "Vendors",
        controls: [{ role: "link", label, x: 0.42, y: 0.38 }],
      })?.controls?.[0].label;
    const sixty = `Details (${"v".repeat(50)})`;
    expect(sixty).toHaveLength(60);
    expect(listed(sixty)).toBe(sixty);
    const eighty = `Details (${"v".repeat(70)})`;
    expect(eighty).toHaveLength(80);
    expect(listed(eighty)).toBe(eighty);
    expect(listed(eighty + "!")).toBe(eighty);
    for (const bad of [
      [{ role: "button", x: 1.5, y: 0.2 }],
      [{ role: "button", x: 0.2, y: 0.2, value: "secret" }],
      Array.from({ length: 61 }, () => ({ role: "button", x: 0.1, y: 0.1 })),
    ])
      expect(
        cleanScreenContext({ appName: "A", windowTitle: "B", controls: bad }),
      ).toBeUndefined();
  });
  it("says when the frontmost application shows no window, as a bounded count", () => {
    // Live: Calendar came to the front with no window, and the screenshot
    // showed the application behind it with an empty window title.
    const windowless = cleanScreenContext({
      appName: "Calendar",
      windowTitle: "",
      windowCount: 0,
    });
    expect(windowless?.windowCount).toBe(0);
    expect(
      cleanScreenContext({ appName: "Notes", windowTitle: "N", windowCount: 3 })
        ?.windowCount,
    ).toBe(3);
    expect(
      cleanScreenContext({ appName: "A", windowTitle: "B" }),
    ).not.toHaveProperty("windowCount");
    for (const bad of [-1, 1.5, 100, "0", Number.NaN, null])
      expect(
        cleanScreenContext({
          appName: "A",
          windowTitle: "B",
          windowCount: bad,
        }),
      ).toBeUndefined();
  });
  it("reports a blind application and its bounded menus", () => {
    const result = cleanScreenContext({
      appName: "Spotify",
      windowTitle: "Spotify Premium",
      accessibility: "none",
      menus: [
        "Edit: Undo [CMD+Z], Search [CMD+L] (disabled)",
        "Playback: Play, Next [CMD+RIGHT]",
      ],
      controls: [],
    });
    expect(result?.accessibility).toBe("none");
    expect(result?.menus).toEqual([
      "Edit: Undo [CMD+Z], Search [CMD+L] (disabled)",
      "Playback: Play, Next [CMD+RIGHT]",
    ]);
    expect(
      cleanScreenContext({ appName: "A", windowTitle: "B" })?.accessibility,
    ).toBeUndefined();
    const long = cleanScreenContext({
      appName: "A",
      windowTitle: "B",
      accessibility: "partial",
      menus: ["M".repeat(500), "token=sk-fixtureSECRET123456"],
    });
    expect(long?.menus?.[0]).toHaveLength(400);
    expect(long?.menus?.[1]).not.toContain("fixtureSECRET");
    for (const bad of [
      { accessibility: "unknown" },
      { menus: Array.from({ length: 13 }, (_, i) => `M${i}`) },
      { menus: [{ title: "File" }] },
    ])
      expect(
        cleanScreenContext({ appName: "A", windowTitle: "B", ...bad }),
      ).toBeUndefined();
  });
});

describe("workspace context", () => {
  it("carries every open application and recent notifications, redacted", () => {
    const result = cleanScreenContext({
      appName: "Code",
      windowTitle: "open-assist",
      openApps: [
        "Code (frontmost): open-assist",
        "Slack: Prateek J (DM) - Coasty - Slack",
      ],
      notifications: [
        "Slack, 4m ago: Prateek — can you look at the deck?",
        "Mail, just now: Reset — your code is token=sk-fixtureSECRET123456",
      ],
    });
    expect(result?.openApps).toEqual([
      "Code (frontmost): open-assist",
      "Slack: Prateek J (DM) - Coasty - Slack",
    ]);
    expect(result?.notifications?.[0]).toBe(
      "Slack, 4m ago: Prateek — can you look at the deck?",
    );
    // A secret in a notification never reaches the model.
    expect(result?.notifications?.[1]).not.toContain("fixtureSECRET");
  });
  it("drops a workspace that exceeds its bounds", () => {
    for (const bad of [
      { openApps: Array.from({ length: 15 }, (_, i) => `App${i}`) },
      { notifications: Array.from({ length: 13 }, (_, i) => `N${i}`) },
      { notifications: [{ app: "Slack" }] },
    ])
      expect(
        cleanScreenContext({ appName: "A", windowTitle: "B", ...bad }),
      ).toBeUndefined();
  });
});

describe("screen text", () => {
  it("carries text recognized from the screenshot, redacted and bounded", () => {
    const result = cleanScreenContext({
      appName: "Google Chrome",
      windowTitle: "Introducing System One Models & Jev",
      screenText:
        "Introducing System One Models & Jev\nDiogo Almeida, founder, TypeSafe\napi key token=sk-fixtureSECRET123456",
    });
    expect(result?.screenText).toContain("Diogo Almeida, founder, TypeSafe");
    expect(result?.screenText).not.toContain("fixtureSECRET");
    expect(
      cleanScreenContext({
        appName: "A",
        windowTitle: "B",
        screenText: "x".repeat(4000),
      })?.screenText,
    ).toHaveLength(3200);
  });
});

// The web walk lists a number input (native AXIncrementor) as "number", even
// nameless, and a labelled slider as "slider" (cycle 20260920-0415-c8c9e10:
// a thermostat never listed was clicked by coordinates into a hand-off).
describe("number inputs and sliders in context.controls", () => {
  const number = { role: "number", label: "Thermostat (°F)", x: 0.5, y: 0.4 };
  const slider = { role: "slider", label: "Brightness", x: 0.5, y: 0.5 };
  it("admits both roles", () => {
    expect(
      cleanScreenContext({
        appName: "Safari",
        windowTitle: "Home",
        controls: [number, slider],
      })?.controls,
    ).toEqual([number, slider]);
  });
  it("keeps an unnamed number input the way it keeps a text field, and drops an unnamed slider", () => {
    const unnamed = { role: "number", x: 0.5, y: 0.4 };
    expect(
      trimScreenContext({
        appName: "Safari",
        windowTitle: "Home",
        controls: [
          unnamed,
          { role: "slider", x: 0.5, y: 0.5 },
          { role: "button", x: 0.1, y: 0.1 },
          number,
        ],
      })?.controls,
    ).toEqual([unnamed, number]);
  });
});
