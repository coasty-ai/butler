import { describe, it, expect } from "vitest";
import { buildRequest } from "../src/providers/http";
import { cleanScreenContext, trimScreenContext } from "../src/core/context";
import { MODEL_HISTORY_FULL, modelHistory } from "../src/core/runner";
import { normalizeLabel } from "../src/core/labels";
import {
  defaultSettings,
  type Frame,
  type Observation,
  type ScreenContext,
  type Settings,
} from "../src/core/schema";

/** chars/4, the usual estimate for English and JSON; exact counts need a tokenizer call. */
const tokens = (value: unknown) =>
  Math.ceil(
    (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).length /
      4,
  );
const settings: Settings = {
  ...defaultSettings,
  provider: "anthropic",
  privacy: "PRIVATE_BYOM",
  endpoint: "https://api.anthropic.com",
  model: "claude-fable-5-1",
  inputPrice: 1,
  outputPrice: 2,
};
// The live display on 2026-09-19: 1440x900, sent at native size.
const geometry = {
  display_id: 1,
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
  native_width: 1440,
  native_height: 900,
  model_width: 1440,
  model_height: 900,
  scale_factor: 1,
};
const frame = (appId: string, context: ScreenContext): Frame => ({
  id: "0a1b2c3d-4e5f-4789-abcd-ef0123456789",
  sha256: "sha",
  image: "data:image/png;base64,YWJj",
  geometry,
  capturedAt: 0,
  synthetic: false,
  appId,
  context,
});

/* ------------------------------------------------------------- fixtures */

// Notes after "open Notes" and a new note: accessibility publishes little
// (under 600 characters), so Vision read the screenshot as well. The note
// body only exists in the recognized text.
const notesVisible = [
  "Notes",
  "Folders",
  "iCloud",
  "All iCloud",
  "Notes",
  "Quick Notes",
  "Recently Deleted",
  "Groceries",
  "Yesterday",
  "Milk, eggs, bread, coffee",
  "Meeting notes",
  "Tuesday",
  "Q3 planning with Sam",
  "Trip ideas",
  "9/2/26",
  "Lisbon in October, Kyoto in spring",
  "Reading list",
  "8/28/26",
  "Working in Public, The Mom Test",
  "New Note",
  "Today",
  "No additional text",
];
const notesBody = [
  "Agenda for Monday",
  "Hiring plan: two backend roles, one designer",
  "Budget review with finance before the offsite",
  "Open questions for Sam",
  "Decide the launch week",
  "Draft the customer email",
  "Book the room for Thursday",
];
const notesToolbar = [
  "Toggle Folders",
  "View",
  "New Note",
  "Delete",
  "Table",
  "Format",
  "Checklist",
  "Media",
  "Link",
  "Collaborate",
  "Share",
];
const notesScreenText = [
  "Notes File Edit Format View Window Help",
  "Fri Sep 19 9:41 AM",
  ...notesVisible.slice(2),
  ...notesToolbar,
  "Search",
  "September 19, 2026 at 9:41 AM",
  "Q3 planning with Sam",
  ...notesBody,
].join("\n");
const notesControls: NonNullable<ScreenContext["controls"]> = [
  ...notesToolbar.map((label, i) => ({
    role: "button",
    label,
    x: 0.108 + i * 0.066,
    y: 0.062,
  })),
  { role: "textfield", label: "Search", x: 0.92, y: 0.062 },
  { role: "button", label: "iCloud", x: 0.03, y: 0.13 },
  ...["All iCloud", "Notes", "Quick Notes", "Recently Deleted"].map(
    (label, i) => ({ role: "row", label, x: 0.08, y: 0.16 + i * 0.03 }),
  ),
  ...[
    "Groceries, Yesterday, Milk, eggs, bread, coffee",
    "Meeting notes, Tuesday, Q3 planning with Sam",
    "Trip ideas, 9/2/26, Lisbon in October, Kyoto in spring",
    "Reading list, 8/28/26, Working in Public, The Mom Test",
    "New Note, Today, No additional text",
  ].map((label, i) => ({ role: "cell", label, x: 0.28, y: 0.2 + i * 0.08 })),
  // The Touch Bar mirror of three toolbar buttons: same role and name.
  { role: "button", label: "New Note", x: 0.371, y: 0.964 },
  { role: "button", label: "Delete", x: 0.531, y: 0.964 },
  { role: "button", label: "Format", x: 0.606, y: 0.964 },
  // Unnamed: window furniture, scrollbars, images, the note body.
  { role: "button", x: 0.02, y: 0.02 },
  { role: "button", x: 0.035, y: 0.02 },
  { role: "button", x: 0.05, y: 0.02 },
  { role: "scrollbar", x: 0.19, y: 0.5 },
  { role: "scrollbar", x: 0.43, y: 0.5 },
  { role: "scrollbar", x: 0.995, y: 0.5 },
  { role: "image", x: 0.6, y: 0.4 },
  { role: "image", x: 0.6, y: 0.7 },
  { role: "group", x: 0.7, y: 0.5 },
  { role: "splitter", x: 0.2, y: 0.5 },
  { role: "splitter", x: 0.44, y: 0.5 },
  { role: "textarea", x: 0.72, y: 0.55 },
  { role: "button", x: 0.5, y: 0.5, enabled: false },
];
const notesMenus = [
  "File: New Note [CMD+N], New Folder [SHIFT+CMD+N], New Smart Folder, Show in Folder (disabled), Import to Notes…, Share >, Close [CMD+W], Duplicate Note [CMD+D], Pin Note, Lock Note (disabled), Export as PDF…, Print… [CMD+P]",
  "Edit: Undo [CMD+Z], Redo [SHIFT+CMD+Z], Cut [CMD+X], Copy [CMD+C], Paste [CMD+V], Paste and Match Style [ALT+SHIFT+CMD+V], Delete, Select All [CMD+A], Attach File… [SHIFT+CMD+A], Add Link… [CMD+K], Rename Attachment…, Find >, Spelling and Grammar >, Substitutions >, Transformations >, Speech >, AutoFill >, Start Dictation, Emoji & Symbols [CTRL+CMD+SPACE]",
  "Format: Title [SHIFT+CMD+T], Heading [SHIFT+CMD+H], Subheading [SHIFT+CMD+J], Body [SHIFT+CMD+B], Monostyled [SHIFT+CMD+M], Bulleted List [SHIFT+CMD+7], Dashed List [SHIFT+CMD+8], Numbered List [SHIFT+CMD+9], Block Quote [SHIFT+CMD+U], Checklist [SHIFT+CMD+L], Mark as Checked, Move List Item >, Table [ALT+CMD+T], Font >, Text >, Indentation >, Use Light Background for Note",
  "View: as List [CMD+1], as Gallery [CMD+2], Show Folders [ALT+CMD+S], Hide Note Count, Sort Folder By >, Group By Date, Show Attachments Browser [CMD+3], Show Note [CMD+0], Zoom In [CMD+PLUS], Zoom Out [CMD+MINUS], Actual Size, Show Tab Bar, Show All Tabs [SHIFT+CMD+BACKSLASH], Enter Full Screen [CTRL+CMD+F]",
  "Window: Minimize [CMD+M], Zoom, Fill, Center, Move & Resize >, Full Screen Tile >, Remove Window from Set, Notes, Bring All to Front",
  "Help: Notes Help, Notes User Guide",
];
const openApps = [
  "Notes (frontmost): Notes",
  "Google Chrome: Introducing System One Models & Jev - Google Chrome | GitHub - open-assist | Gmail - Inbox (12)",
  "Code: runner.ts — open-assist",
  "Slack: Prateek J (DM) - Coasty - Slack",
  "Spotify: Spotify Premium",
  "Finder: Downloads",
  "Terminal: nkov — zsh — 80×24",
  "Messages: Messages",
];
const recentWindows = [
  { appName: "Notes", title: "Notes" },
  {
    appName: "Google Chrome",
    title: "Introducing System One Models & Jev - Google Chrome",
  },
  { appName: "Code", title: "runner.ts — open-assist" },
  { appName: "Slack", title: "Prateek J (DM) - Coasty - Slack" },
  { appName: "Spotify", title: "Spotify Premium" },
  { appName: "Finder", title: "Downloads" },
  { appName: "Terminal", title: "nkov — zsh — 80×24" },
  { appName: "Messages", title: "Messages" },
  // Closed since: only recentWindows still knows it.
  { appName: "Preview", title: "September report.pdf" },
];
const notesContext: ScreenContext = {
  appName: "Notes",
  windowTitle: "Notes",
  windowCount: 1,
  visibleText: notesVisible.join("\n"),
  screenText: notesScreenText,
  controls: notesControls,
  accessibility: "partial",
  menus: notesMenus,
  openApps,
  recentWindows,
  recentFiles: ["September report.pdf", "Q3.xlsx"],
};
const executed = (target: string) =>
  `Executed${target}. Verify the next screenshot shows the intended result before done.`;
const notesHistory: Observation["history"] = [
  {
    type: "open_app",
    action: { type: "open_app", name: "Notes" },
    result:
      "Opened Notes (com.apple.Notes); frontmost=true. Verify appId on the next screenshot; if no window is visible use the app's New shortcut.",
  },
  {
    type: "hotkey",
    action: { type: "hotkey", keys: ["CMD", "N"] },
    result: executed(" CMD+N as “New Note” in the menus"),
  },
  {
    type: "type_text",
    action: { type: "type_text", text: "Q3 planning with Sam" },
    result: executed(" typing into “Note”"),
  },
  {
    type: "key",
    action: { type: "key", key: "ENTER" },
    result: executed(""),
  },
  {
    type: "type_text",
    action: { type: "type_text", text: notesBody.slice(0, 3).join("\n") },
    result: executed(" typing into “Note”"),
  },
  {
    type: "rejected",
    action: { type: "click", x: 0.644, y: 0.062 },
    result:
      "No input was executed. The action used an old frame_id. Return one action using the frame_id from the current context.",
  },
  {
    type: "click_control",
    action: { type: "click_control", label: "Checklist" },
    result: "Executed click on button “Checklist”. Verify the next screenshot.",
  },
  {
    type: "click",
    action: { type: "click", x: 0.72, y: 0.55 },
    result:
      "No input was sent. No control was identified at that point; use click_control with a label from context.controls, or a menu item.",
  },
  {
    type: "menu_item",
    action: { type: "menu_item", path: ["Format", "Title"] },
    result: "Executed Format > Title in the menus. Verify the next screenshot.",
  },
  {
    type: "type_text",
    action: { type: "type_text", text: "Open questions for Sam" },
    result: executed(" typing into “Note”"),
  },
  {
    type: "click_control",
    action: { type: "click_control", label: "New Note" },
    result: "Executed click on button “New Note”. Verify the next screenshot.",
  },
  {
    type: "hotkey",
    action: { type: "hotkey", keys: ["CMD", "B"] },
    result:
      executed(" CMD+B as “Bold” in the menus") +
      " Note: this action produced no visible change (same application, window, screenshot and focus), and the one before it did not either. Repeating it will not work: take a different route now, such as a keyboard shortcut from context.playbook, the menu bar, or request_user to ask the user.",
  },
];
const notes: Observation = {
  task: "open Notes and start a note for Monday's planning",
  frame: frame("com.apple.Notes", notesContext),
  history: notesHistory,
  memory: {
    preferences: ["Use Notes for quick notes"],
    episodes: ["open notes and write the agenda: completed"],
  },
};

// A Google search results page: the accessibility text is full, so Vision
// did not run; sixty controls, many of them repeated per result.
const results = Array.from(
  { length: 10 },
  (_, i) => `Result ${i + 1}: San Francisco weather this week`,
);
const chromeControls: NonNullable<ScreenContext["controls"]> = [
  { role: "textfield", label: "Search", x: 0.35, y: 0.09 },
  ...["Images", "Videos", "News", "Shopping", "Maps", "More", "Tools"].map(
    (label, i) => ({ role: "link", label, x: 0.2 + i * 0.05, y: 0.17 }),
  ),
  { role: "button", label: "Sign in", x: 0.95, y: 0.06 },
  { role: "button", label: "Google apps", x: 0.9, y: 0.06 },
  ...results.map((label, i) => ({
    role: "link",
    label,
    x: 0.3,
    y: 0.25 + i * 0.06,
  })),
  ...results.map((_, i) => ({
    role: "button",
    label: "About this result",
    x: 0.58,
    y: 0.25 + i * 0.06,
  })),
  ...results.map((_, i) => ({
    role: "link",
    label: "Images",
    x: 0.62,
    y: 0.25 + i * 0.06,
  })),
  ...results.map((_, i) => ({ role: "link", x: 0.28, y: 0.25 + i * 0.06 })),
  ...results.map((_, i) => ({ role: "image", x: 0.66, y: 0.25 + i * 0.06 })),
];
const chromeContext: ScreenContext = {
  appName: "Google Chrome",
  windowTitle: "weather san francisco - Google Search",
  windowCount: 3,
  browserAddress: "https://www.google.com/search?q=weather+san+francisco",
  visibleText: Array.from(
    { length: 60 },
    (_, i) =>
      `Result ${i + 1}: San Francisco weather stays mild this week, highs near 68°F with fog clearing by noon.`,
  )
    .join("\n")
    .slice(0, 4200),
  controls: chromeControls,
  accessibility: "full",
  menus: [
    "File: New Tab [CMD+T], New Window [CMD+N], New Incognito Window [SHIFT+CMD+N], Reopen Closed Tab [SHIFT+CMD+T], Open File… [CMD+O], Open Location… [CMD+L], Close Window [SHIFT+CMD+W], Close Tab [CMD+W], Save Page As… [CMD+S], Share >, Print… [CMD+P]",
    "Edit: Undo [CMD+Z], Redo [SHIFT+CMD+Z], Cut [CMD+X], Copy [CMD+C], Paste [CMD+V], Paste and Match Style [ALT+SHIFT+CMD+V], Delete, Select All [CMD+A], Find >, Spelling and Grammar >, Substitutions >, Speech >, Start Dictation, Emoji & Symbols [CTRL+CMD+SPACE]",
    "View: Always Show Bookmarks Bar [SHIFT+CMD+B], Always Show Toolbar in Full Screen [SHIFT+CMD+F], Customize Touch Bar…, Stop [CMD+PERIOD], Force Reload This Page [SHIFT+CMD+R], Enter Full Screen [CTRL+CMD+F], Actual Size [CMD+0], Zoom In [CMD+PLUS], Zoom Out [CMD+MINUS], Cast…, Developer >",
    "History: Home [SHIFT+CMD+H], Back [CMD+LEFT], Forward [CMD+RIGHT], Recently Closed >, Show Full History [CMD+Y]",
    "Bookmarks: Bookmark Manager [ALT+CMD+B], Bookmark This Tab… [CMD+D], Bookmark All Tabs… [SHIFT+CMD+D], Show Bookmarks Bar [SHIFT+CMD+B]",
    "Window: Minimize [CMD+M], Zoom, Fill, Center, Select Next Tab [CTRL+TAB], Select Previous Tab [CTRL+SHIFT+TAB], Show as Tab, Downloads [SHIFT+CMD+J], Extensions, Task Manager, Bring All to Front",
  ],
  openApps: openApps.map((line) =>
    line.startsWith("Notes")
      ? "Notes: Notes"
      : line.replace("Google Chrome:", "Google Chrome (frontmost):"),
  ),
  recentWindows: recentWindows.slice(0, 8),
};
const chrome: Observation = {
  task: "what's the weather in san francisco this week",
  frame: frame("com.google.Chrome", chromeContext),
  history: notesHistory.slice(0, 5),
};

/* ---------------------------------------------------------- measurement */

/** The per-step JSON, split the way the instruction names its parts. */
function sections(context: Record<string, any>) {
  const c = context.context ?? {};
  const rest = (keys: string[]) =>
    Object.fromEntries(
      Object.entries(c).filter(([key]) => !keys.includes(key)),
    );
  const seen = [
    "visibleText",
    "screenText",
    "selectedText",
    "controls",
    "menus",
    "openApps",
    "recentWindows",
    "notifications",
    "recentFiles",
    "recentTasks",
    "memory",
    "playbook",
  ];
  return {
    objective: tokens(context.objective),
    "screen text": tokens(
      [c.visibleText, c.screenText, c.selectedText].filter(Boolean),
    ),
    controls: tokens(c.controls ?? []),
    menus: tokens(c.menus ?? []),
    history: tokens(context.history),
    workspace: tokens([
      c.openApps,
      c.recentWindows,
      c.notifications,
      c.recentFiles,
      c.recentTasks,
    ]),
    "memory+playbook": tokens([c.memory, c.playbook]),
    other: tokens({
      ...context,
      objective: 0,
      history: 0,
      context: rest(seen),
    }),
  };
}
/** Anthropic's rule of thumb for an image's tokens: width * height / 750. */
const imageTokens = (g: typeof geometry) =>
  Math.ceil((g.model_width * g.model_height) / 750);

/**
 * One step's request, before and after the trims, as the provider sends it.
 * The untrimmed copy is the same request with the cleaned screen and the
 * whole history put back, which is what every step sent until now.
 */
function measure(o: Observation) {
  const request = buildRequest(settings, "K", {
    ...o,
    history: modelHistory(o.history),
  });
  const after = JSON.parse(request.body.messages[0].content[1].text);
  // A fixture over a bound would be dropped whole and measure as nothing.
  expect(after.context.appName).toBe(o.frame.context?.appName);
  const before = {
    ...after,
    history: o.history,
    context: {
      ...cleanScreenContext(o.frame.context),
      ...(after.context.memory && { memory: after.context.memory }),
      ...(after.context.playbook && { playbook: after.context.playbook }),
    },
  };
  const fixed = {
    instruction: tokens(request.body.system[0].text),
    tools: tokens(request.body.tools),
    image: imageTokens(o.frame.geometry),
  };
  return {
    before: sections(before),
    after: sections(after),
    beforeJson: tokens(before),
    afterJson: tokens(after),
    fixed,
    context: after.context as ScreenContext,
    history: after.history as Observation["history"],
  };
}
/** Shown under --reporter=verbose; the default reporter keeps a passing test's output. */
function report(name: string, m: ReturnType<typeof measure>) {
  const fixed = m.fixed.instruction + m.fixed.tools + m.fixed.image;
  const total = (json: number) => fixed + json;
  const lines = Object.keys(m.before).map(
    (key) =>
      `${key.padEnd(16)}${String(m.before[key as keyof typeof m.before]).padStart(6)}${String(m.after[key as keyof typeof m.after]).padStart(7)}`,
  );
  console.info(
    [
      `${name}: estimated tokens (chars/4), before -> after`,
      `${"instruction".padEnd(16)}${String(m.fixed.instruction).padStart(6)} (cached on Anthropic)`,
      `${"tools".padEnd(16)}${String(m.fixed.tools).padStart(6)}`,
      `${"image".padEnd(16)}${String(m.fixed.image).padStart(6)} (1440x900 / 750)`,
      ...lines,
      `${"step JSON".padEnd(16)}${String(m.beforeJson).padStart(6)}${String(m.afterJson).padStart(7)}  -${Math.round((1 - m.afterJson / m.beforeJson) * 100)}%`,
      `${"request".padEnd(16)}${String(total(m.beforeJson)).padStart(6)}${String(total(m.afterJson)).padStart(7)}  -${Math.round((1 - total(m.afterJson) / total(m.beforeJson)) * 100)}%`,
    ].join("\n"),
  );
  return { fixed, total };
}

describe("what one step costs", () => {
  it("reports the share of instruction, screen text, controls, history and image", () => {
    const m = measure(notes);
    const { fixed, total } = report("Notes", m);
    // Live 2026-09-19: 6748-6881 input tokens a step to open Notes. The
    // instruction and the screenshot are most of it; the estimate is close
    // enough to say where the rest goes.
    expect(total(m.beforeJson)).toBeGreaterThan(5500);
    expect(total(m.beforeJson)).toBeLessThan(8000);
    expect(m.fixed.instruction).toBeGreaterThan(fixed / 2);
    // The per-step JSON shrinks by at least a quarter on this screen.
    expect(m.afterJson).toBeLessThan(m.beforeJson * 0.75);
    const c = measure(chrome);
    report("Chrome", c);
    expect(c.afterJson).toBeLessThan(c.beforeJson * 0.85);
  });
  it("keeps the cached instruction under its budget and free of schema repeats", () => {
    const instruction: string = buildRequest(settings, "K", notes).body
      .system[0].text;
    // 13,924 characters before the action list lost its JSON schema repeats;
    // 14,800 with the tools paragraph (.data/design/mcp-integrated.md §2.3.2).
    expect(instruction.length).toBeLessThan(14850);
    expect(instruction).toContain("menu_item(path[] of 2-3 menu titles)");
    expect(instruction).toContain('for example path ["Playback","Play"]');
    expect(instruction).not.toContain('{"type":"menu_item"');
    // One literal example stays for providers that reply with bare JSON.
    expect(instruction).toContain('{"type":"hotkey"');
  });
});

describe("screen context the model sees", () => {
  const clean = cleanScreenContext(notesContext)!;
  const trimmed = trimScreenContext(clean)!;
  it("drops recognized lines the accessibility text, title or a control already carries", () => {
    const before = clean.screenText!.split("\n");
    const after = trimmed.screenText!.split("\n");
    expect(after.length).toBeLessThan(before.length / 2);
    const known = new Set(
      [
        clean.appName,
        clean.windowTitle,
        ...clean.visibleText!.split("\n"),
        ...clean.controls!.map((c) => c.label ?? ""),
      ].map(normalizeLabel),
    );
    for (const line of after)
      expect(known.has(normalizeLabel(line))).toBe(false);
    // What only Vision saw stays: the note body, the clock, the menu bar.
    for (const line of notesBody) expect(after).toContain(line);
    expect(after).toContain("Fri Sep 19 9:41 AM");
    expect(after).toContain("Notes File Edit Format View Window Help");
    // The note title Vision read twice was in the list already; no line is left twice.
    expect(after).not.toContain("Q3 planning with Sam");
    expect(new Set(after.map(normalizeLabel)).size).toBe(after.length);
    console.info(
      `Notes screenText: ${before.length} lines / ${clean.screenText!.length} chars -> ${after.length} lines / ${trimmed.screenText!.length} chars`,
    );
  });
  it("drops unnamed controls except text entry, and repeats of a named control", () => {
    const before = clean.controls!;
    const after = trimmed.controls!;
    expect(before).toHaveLength(38);
    expect(after).toHaveLength(23);
    for (const control of after)
      expect(
        control.label !== undefined ||
          ["textfield", "textarea", "searchfield", "combobox"].includes(
            control.role,
          ),
      ).toBe(true);
    expect(after).toContainEqual({ role: "textarea", x: 0.72, y: 0.55 });
    expect(after.some((c) => c.role === "scrollbar")).toBe(false);
    // The first of a repeated name keeps its position; the mirror goes.
    expect(after.filter((c) => c.label === "New Note")).toEqual([
      notesControls[2],
    ]);
    expect(after.filter((c) => c.label === "Delete")).toHaveLength(1);
    // Same name, different role: both stay, as the instruction promises.
    const cell = after.find(
      (c) => c.role === "cell" && /^New Note/.test(c.label!),
    );
    expect(cell).toBeDefined();
    console.info(
      `Notes controls: ${before.length} (${tokens(before)} tokens) -> ${after.length} (${tokens(after)} tokens)`,
    );
  });
  it("keeps every name the runner's named targets used", () => {
    // click_control resolves by label against context.controls; menu_item by
    // path against context.menus. Every target in the history is still there.
    const controls = trimmed.controls!.map((c) =>
      normalizeLabel(c.label ?? ""),
    );
    const menus = trimmed.menus!;
    for (const entry of notesHistory) {
      const a = entry.action ?? {};
      if (a.type === "click_control")
        expect(controls).toContain(normalizeLabel(String(a.label)));
      if (a.type === "menu_item") {
        const [menu, item] = a.path as string[];
        const line = menus.find((l) => l.startsWith(`${menu}: `));
        expect(line).toBeDefined();
        expect(line).toContain(item);
      }
    }
    expect(menus).toEqual(notesMenus);
  });
  it("drops recent windows that context.openApps already lists", () => {
    expect(trimmed.recentWindows).toEqual([
      { appName: "Preview", title: "September report.pdf" },
    ]);
    const all = trimScreenContext(
      cleanScreenContext({
        ...notesContext,
        recentWindows: recentWindows.slice(0, 8),
      }),
    );
    expect(all).not.toHaveProperty("recentWindows");
    // Without openApps, recentWindows is the only list of other windows.
    const alone = trimScreenContext(
      cleanScreenContext({ ...notesContext, openApps: undefined }),
    );
    expect(alone?.recentWindows).toHaveLength(9);
  });
  it("leaves the runner's copy whole and everything else as cleaned", () => {
    expect(clean).toEqual(cleanScreenContext(notesContext));
    expect(clean.controls).toHaveLength(38);
    const { controls, screenText, recentWindows: _r, ...rest } = clean;
    const {
      controls: _c,
      screenText: _s,
      recentWindows: _w,
      ...same
    } = trimmed;
    expect(same).toEqual(rest);
    expect(controls).not.toEqual(trimmed.controls);
    expect(screenText).not.toEqual(trimmed.screenText);
    // A screen whose recognized text is all duplicates loses the key, not
    // an empty string; a blind app with no controls stays blind.
    const dup = trimScreenContext(
      cleanScreenContext({
        appName: "A",
        windowTitle: "B",
        visibleText: "x\ny",
        screenText: "x\ny\nA",
      }),
    );
    expect(dup).not.toHaveProperty("screenText");
    const blind = trimScreenContext(
      cleanScreenContext({
        appName: "Spotify",
        windowTitle: "Spotify Premium",
        accessibility: "none",
        controls: [],
      }),
    );
    expect(blind).toMatchObject({ accessibility: "none", controls: [] });
    expect(trimScreenContext(undefined)).toBeUndefined();
  });
  it("is what the provider sends, for every provider", () => {
    for (const provider of ["anthropic", "openai", "ollama"] as const) {
      const r = buildRequest(
        {
          ...settings,
          provider,
          privacy: provider === "ollama" ? "PRIVATE_LOCAL" : "PRIVATE_BYOM",
          endpoint: {
            anthropic: "https://api.anthropic.com",
            openai: "https://api.openai.com",
            ollama: "http://127.0.0.1:11434",
          }[provider],
        },
        "K",
        notes,
      );
      const text: string =
        provider === "anthropic"
          ? r.body.messages[0].content[1].text
          : provider === "openai"
            ? r.body.input[0].content[0].text
            : r.body.messages[1].content;
      const context = JSON.parse(text).context;
      expect(context.controls).toEqual(trimmed.controls);
      expect(context.screenText).toBe(trimmed.screenText);
      expect(context.menus).toEqual(notesMenus);
    }
  });
});

describe("history the model sees", () => {
  it("keeps the last six entries whole behind one line for the earlier steps", () => {
    const seen = modelHistory(notesHistory);
    expect(seen).toHaveLength(MODEL_HISTORY_FULL + 1);
    expect(seen.slice(1)).toEqual(notesHistory.slice(-MODEL_HISTORY_FULL));
    expect(seen[0]).toEqual({
      type: "earlier_steps",
      result:
        "6 earlier steps, oldest first: open_app Notes (done); hotkey CMD+N (done); type_text (done); key ENTER (done); type_text (done); click (rejected).",
    });
    // Typed text never enters the line; the whole entries still carry it.
    expect(seen[0].result).not.toContain("Q3 planning");
    expect(JSON.stringify(seen)).toContain("Open questions for Sam");
    console.info(
      `Notes history: ${notesHistory.length} entries (${tokens(notesHistory)} tokens) -> ${seen.length} (${tokens(seen)} tokens)`,
    );
  });
  it("passes a short history through unchanged", () => {
    const six = notesHistory.slice(0, MODEL_HISTORY_FULL);
    expect(modelHistory(six)).toBe(six);
    expect(modelHistory([])).toEqual([]);
  });
  it("names outcomes the way the whole entries do", () => {
    const seen = modelHistory([
      ...notesHistory.slice(6),
      {
        type: "request_user",
        action: { type: "request_user", reason: "Which folder?" },
        result: "You asked the user this and the run paused.",
      },
      {
        type: "open_file",
        action: { type: "open_file", path: "~/Documents/Q3 plan.pdf" },
        result: "Interrupted by the user; it may or may not have taken effect.",
      },
      { type: "rejected", result: "No input was executed. Your last reply…" },
      ...notesHistory.slice(0, 6),
    ]);
    expect(seen[0].result).toBe(
      "9 earlier steps, oldest first: click_control “Checklist” (done); click (no input); menu_item Format > Title (done); type_text (done); click_control “New Note” (done); hotkey CMD+B (no visible change); request_user (asked the user); open_file Q3 plan.pdf (interrupted); reply (rejected).",
    );
    expect(seen[0].result).not.toContain("Documents");
    expect(seen[0].result).not.toContain("Which folder");
  });
  it("bounds the line on a long run, dropping the oldest steps first", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      type: "click_control",
      action: { type: "click_control", label: `Control number ${i + 1}` },
      result: "Executed click on button. Verify the next screenshot.",
    }));
    const seen = modelHistory(long);
    expect(seen).toHaveLength(MODEL_HISTORY_FULL + 1);
    const line = seen[0].result;
    expect(line.length).toBeLessThan(480);
    expect(line).toMatch(/^34 earlier steps, oldest first: …; /);
    expect(line).toContain("“Control number 34” (done).");
    expect(line).not.toContain("“Control number 1”");
  });
});
