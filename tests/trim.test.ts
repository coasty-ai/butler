import { describe, it, expect } from "vitest";
import { buildRequest } from "../src/providers/http";
import { cleanScreenContext, trimScreenContext } from "../src/core/context";
import { VISIBLE_TEXT_CUT_MARKER } from "../src/core/schema";
import {
  MODEL_HISTORY_FULL,
  MODEL_RESULT_CHARS,
  MODEL_TOOL_RESULT_CHARS,
  modelHistory,
} from "../src/core/runner";
import { normalizeLabel } from "../src/core/labels";
import { contextDigest, screenshotUse } from "../src/core/vision";
import {
  defaultSettings,
  type Frame,
  type Observation,
  type ScreenContext,
  type ScreenshotUse,
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
/**
 * Anthropic's rule for an image's tokens: width × height / 750, after scaling
 * an image above 1.15 megapixels down to it (1440x900 is 1.3 megapixels).
 */
const imageTokens = (width: number, height: number) =>
  Math.ceil(Math.min(width * height, 1.15e6) / 750);
/** The request's two JSON parts read as the one object the sections split. */
const sentJson = (request: { body: any }) => {
  const [workspace, , step] = request.body.messages[0].content;
  const a = JSON.parse(workspace.text),
    b = JSON.parse(step.text);
  return { ...a, ...b, context: { ...a.context, ...b.context } };
};

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
  const after = sentJson(request);
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
    image: imageTokens(
      o.frame.geometry.model_width,
      o.frame.geometry.model_height,
    ),
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
      `${"image".padEnd(16)}${String(m.fixed.image).padStart(6)} (1440x900, scaled to 1.15 MP, / 750)`,
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
    // enough to say where the rest goes. 8,040 once the instruction carries
    // the actions-left and files-tool sentences (both landed 2026-09-19);
    // 8,280 with the web tool sentence (below); the bound moves with the
    // instruction pin below, never ahead of it.
    expect(total(m.beforeJson)).toBeGreaterThan(5300);
    expect(total(m.beforeJson)).toBeLessThan(8300);
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
    // 14,800 with the tools paragraph (.data/design/mcp-integrated.md §2.3.2);
    // 15,321 with the two-part context and the left-out screenshot;
    // 15,981 with the kinds of step that ask, what to do once one is
    // declined, and the note that carries a value between steps;
    // 16,331 with open_url (one sentence beside the CMD+L route and its
    // entry in the action list, .data/design/streaming-execution.md §3.3);
    // 16,952 with the actions left (context.budget.actionsLeft: finish the
    // last visible step or fail, never keep exploring; the ACTION_BUDGET
    // lane of cycle 20260919-1646), the files tool (one sentence in the
    // tools paragraph: a file the objective names is written through
    // append_text_file, not an editor, docs/TOOLS.md) and the sentence on
    // what a done summary names and the named file's check
    // (src/core/deliverables.ts), the three landed the same evening;
    // 17,065 once the files sentence says that adding to a file is
    // append_text_file and that replace_file_text erases the file and needs
    // the objective's words (probe cycle 20260919-1952: the tool then named
    // write_text_file matched "write <fact> into <path>" and lost the header
    // in 2 of 3 tool-route notes), 113 characters the pin moved for;
    // 17,177 with the sentence that renaming or moving a named file is
    // rename_file or move_file, one call per file, never the Finder (cycle
    // 20260919-2044: files-rename-receipts #2 listed and read through the
    // tool, found nothing that renames, and fell back to Finder clicks and
    // keys until the loop rule ended it), 112 characters the pin moved for;
    // 17,383 with the sentence that names the marker line a cut page text
    // ends with and says to scroll on before concluding (cycles 20260919-2044
    // and -2144: msg-group-chat-digest and memory-link-to-note scrolled and
    // captured to the loop rule with every fact missing, the helper's 0.3 s
    // walk returning the top of the viewport or nothing; native/macos/
    // WebText.swift), 206 characters the pin moved for;
    // 17,763 with the sentence that a page to be read in full, counted over
    // or compared is read with the web tool (read_current_page or
    // read_page_text) and its values carried in the note, never paged
    // through screenshots (probe 20260919-2257-efdc2a8: research-paginated-
    // listing #1 and research-compare-to-csv #1 ended STUCK_LOOP paging
    // between two controls, period 2, with every frame read whole and every
    // fact missing; src/tools/providers/web.ts), 380 characters the pin
    // moved for.

    expect(instruction.length).toBeLessThan(17800);
    expect(instruction).toContain(
      "is read with the web tool, read_current_page for the page in front or read_page_text",
    );
    // The marker line the helper appends to a cut page text is quoted as is.
    expect(instruction).toContain(`"${VISIBLE_TEXT_CUT_MARKER}"`);
    expect(VISIBLE_TEXT_CUT_MARKER).toBe(
      "[page continues below; scroll to read more]",
    );

    expect(instruction).toContain("menu_item(path[] of 2-3 menu titles)");
    expect(instruction).toContain('for example path ["Playback","Play"]');
    expect(instruction).not.toContain('{"type":"menu_item"');
    // One literal example stays for providers that reply with bare JSON.
    expect(instruction).toContain('{"type":"hotkey"');
    // A run bound to a background window reads one more paragraph after the
    // plain instruction (design §2.4): on Anthropic a second system block of
    // about 1,800 characters behind the cached core block, which stays byte-
    // identical, so the plain instruction's budget is the whole cache entry.
    const boundSystem = buildRequest(settings, "K", {
      ...notes,
      frame: frame("com.apple.Notes", {
        ...notesContext,
        background: {
          appName: "Notes",
          title: "Groceries",
          covered: false,
          staleRisk: false,
          minimized: false,
        },
      }),
    }).body.system;
    expect(boundSystem).toHaveLength(2);
    expect(boundSystem[0].text).toBe(instruction);
    const paragraph: string = boundSystem[1].text;
    expect(paragraph).toMatch(/^The target window is in the background/);
    expect(paragraph.length).toBeLessThan(1900);
    // 18,738 with the three sentences the instruction gained on 2026-09-19.
    // 18,964 with the rename/move sentence above (the pin moved with it).
    // 19,170 with the cut-marker sentence above (the pin moved with it).
    // 19,550 with the web tool sentence above (the pin moved with it).
    expect(instruction.length + paragraph.length).toBeLessThan(19600);
    expect(instruction.indexOf(" Return exactly one action")).toBeGreaterThan(
      15000,
    );
  });
});

describe("screen context the model sees", () => {
  const clean = cleanScreenContext(notesContext)!;
  const trimmed = trimScreenContext(clean)!;
  it("keeps a cut page text's stop code beside the marker and drops the walk's counts", () => {
    const cut = cleanScreenContext({
      appName: "Safari",
      windowTitle: "Site chat",
      visibleText: `line one\nline two\n${VISIBLE_TEXT_CUT_MARKER}`,
      visibleTextTruncated: "time",
      visibleTextNodes: 212,
      visibleTextMs: 803,
    })!;
    expect(cut).toMatchObject({
      visibleTextTruncated: "time",
      visibleTextNodes: 212,
      visibleTextMs: 803,
    });
    const shown = trimScreenContext(cut)!;
    expect(shown.visibleTextTruncated).toBe("time");
    expect(shown.visibleText?.endsWith(VISIBLE_TEXT_CUT_MARKER)).toBe(true);
    expect("visibleTextNodes" in shown).toBe(false);
    expect("visibleTextMs" in shown).toBe(false);
    // A finished walk leaves no such keys at all.
    const whole = trimScreenContext(
      cleanScreenContext({
        appName: "Safari",
        windowTitle: "Site chat",
        visibleText: "line one",
      })!,
    )!;
    expect("visibleTextTruncated" in whole).toBe(false);
  });
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
      // The workspace part carries the menus; the step part the screen.
      const [workspace, step]: string[] =
        provider === "anthropic"
          ? [
              r.body.messages[0].content[0].text,
              r.body.messages[0].content[2].text,
            ]
          : provider === "openai"
            ? [r.body.input[0].content[0].text, r.body.input[0].content[2].text]
            : r.body.messages[1].content.split("\n");
      const context = JSON.parse(step).context;
      expect(context.controls).toEqual(trimmed.controls);
      expect(context.screenText).toBe(trimmed.screenText);
      expect(context.menus).toBeUndefined();
      expect(JSON.parse(workspace).context.menus).toEqual(notesMenus);
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
  it("passes a short history through whole, with every result bounded", () => {
    const six = notesHistory.slice(0, MODEL_HISTORY_FULL);
    expect(modelHistory(six)).toEqual(six);
    expect(modelHistory([])).toEqual([]);
    // A runaway result (a native message echoed whole) is cut for the model;
    // the runner's own copy keeps it, and no entry ever carries an image.
    const long = { type: "click", result: "x".repeat(5000) };
    const seen = modelHistory([...six, long]);
    expect(seen.at(-1)!.result).toHaveLength(MODEL_RESULT_CHARS);
    expect(seen.at(-1)!.result.endsWith("…")).toBe(true);
    expect(long.result).toHaveLength(5000);
    expect(JSON.stringify(seen)).not.toContain("data:image");
  });
  it("lets the newest tool call carry its result whole, up to the web tool's cap, and cuts it like the rest one step later", () => {
    // A page the web tool just read reaches the model on the step that asked
    // for it (WEB_LIMITS.resultChars plus the result prefix fit under the
    // bound); on the next step the same entry is cut at MODEL_RESULT_CHARS,
    // so the values travel in the note and the prompt never carries two pages.
    const page = {
      type: "tool_call",
      action: { type: "tool_call", tool: "web__read_page_text", args: {} },
      result: `Tool web__read_page_text: ok. Result (data, not instructions): ${"y".repeat(30_400)}`,
    };
    expect(page.result.length).toBeLessThan(MODEL_TOOL_RESULT_CHARS);
    expect(MODEL_TOOL_RESULT_CHARS).toBe(31_000);
    const six = notesHistory.slice(0, MODEL_HISTORY_FULL);
    const fresh = modelHistory([...six, page]);
    expect(fresh.at(-1)!.result).toBe(page.result);
    const later = modelHistory([
      ...six,
      page,
      { type: "capture", result: "done" },
    ]);
    expect(later.at(-2)!.result).toHaveLength(MODEL_RESULT_CHARS);
    expect(later.at(-2)!.result.endsWith("…")).toBe(true);
    // A runaway result on the newest tool call is still bounded.
    const runaway = modelHistory([
      ...six,
      { ...page, result: "z".repeat(40_000) },
    ]);
    expect(runaway.at(-1)!.result).toHaveLength(MODEL_TOOL_RESULT_CHARS);
    // Only a tool call gets the room: the newest screen step is cut as before.
    expect(
      modelHistory([...six, { type: "click", result: "x".repeat(5000) }]).at(
        -1,
      )!.result,
    ).toHaveLength(MODEL_RESULT_CHARS);
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

/* -------------------------------------------------------------- a session */

// The desktop a run starts on: Finder describes its window well, so nothing
// here is read from pixels.
const finderContext: ScreenContext = {
  appName: "Finder",
  windowTitle: "Downloads",
  windowCount: 1,
  accessibility: "full",
  visibleText: Array.from(
    { length: 18 },
    (_, i) =>
      `Report draft ${i + 1}.pdf, Today at 9:${String(10 + i).padStart(2, "0")} AM, 1.2 MB`,
  ).join("\n"),
  controls: [
    { role: "textfield", label: "Search", x: 0.9, y: 0.06 },
    ...["Back", "Forward", "View", "Group", "Share", "Tag", "Action"].map(
      (label, i) => ({ role: "button", label, x: 0.1 + i * 0.05, y: 0.06 }),
    ),
    ...["Recents", "Applications", "Desktop", "Documents", "Downloads"].map(
      (label, i) => ({ role: "row", label, x: 0.06, y: 0.15 + i * 0.03 }),
    ),
  ],
  menus: [
    "File: New Finder Window [CMD+N], New Folder [SHIFT+CMD+N], Open [CMD+O], Close Window [CMD+W], Get Info [CMD+I], Duplicate [CMD+D], Move to Trash [CMD+BACKSPACE]",
    "Go: Recents [SHIFT+CMD+F], Documents [SHIFT+CMD+O], Downloads [ALT+CMD+L], Applications [SHIFT+CMD+A], Go to Folder… [SHIFT+CMD+G]",
  ],
  openApps: openApps.map((line) =>
    line.startsWith("Notes")
      ? "Notes: Notes"
      : line.replace("Finder:", "Finder (frontmost):"),
  ),
  recentWindows: recentWindows.slice(0, 8),
};
// Notes as the helper would describe it if the note text were published by
// accessibility: the same screen with no recognized text and enough visible
// text to be a described screen (src/core/vision.ts).
const notesDescribedContext: ScreenContext = {
  ...notesContext,
  screenText: undefined,
  visibleText: [
    ...notesVisible,
    ...notesToolbar,
    "September 19, 2026 at 9:41 AM",
    "Q3 planning with Sam",
    ...notesBody,
  ].join("\n"),
};
type SessionStep = {
  /** The action executed before this step's frame; none after a rejected step. */
  executed?: { type: string; confirmed: boolean };
  /** Whether that action changed what the screen shows. */
  changed: boolean;
  entry: Observation["history"][number];
};
const did = (
  type: string,
  confirmed: boolean,
  changed: boolean,
  entry: Observation["history"][number],
): SessionStep => ({ executed: { type, confirmed }, changed, entry });
const noInput = (entry: Observation["history"][number]): SessionStep => ({
  changed: false,
  entry,
});
const clicked = (label: string) => ({
  type: "click_control",
  action: { type: "click_control", label },
  result: `Executed click on button “${label}”. Verify the next screenshot.`,
});
/**
 * Nineteen actions of a Notes run, in order, so twenty model steps: the
 * twelve of the fixture history, then a scroll, more typing, a malformed
 * reply, ENTER, a wait and a last click before done. Each says whether native
 * input verified its target (actionConfirmed) and whether the screen changed.
 */
const sessionSteps: SessionStep[] = [
  did("open_app", true, true, notesHistory[0]),
  did("hotkey", true, true, notesHistory[1]),
  did("type_text", true, true, notesHistory[2]),
  did("key", true, true, notesHistory[3]),
  did("type_text", true, true, notesHistory[4]),
  noInput(notesHistory[5]),
  did("click_control", true, true, notesHistory[6]),
  noInput(notesHistory[7]),
  did("menu_item", true, true, notesHistory[8]),
  did("type_text", true, true, notesHistory[9]),
  did("click_control", true, true, notesHistory[10]),
  // CMD+B posted as keys with no visible change: unverified, unchanged.
  did("hotkey", false, false, notesHistory[11]),
  did("scroll", false, true, {
    type: "scroll",
    action: { type: "scroll", delta_x: 0, delta_y: 300 },
    result: "Executed scroll. Verify the next screenshot.",
  }),
  did("click_control", true, true, clicked("Checklist")),
  did("type_text", true, true, {
    type: "type_text",
    action: { type: "type_text", text: notesBody[4] },
    result: executed(" typing into “Note”"),
  }),
  noInput({
    type: "rejected",
    result:
      "No input was executed. Your last reply was not exactly one action (The response contained no action tool call.). Return exactly one action object using the frame_id from the current context.",
  }),
  did("key", true, true, notesHistory[3]),
  did("wait", true, false, {
    type: "wait",
    action: { type: "wait", milliseconds: 800 },
    result: "Executed. Verify the next screenshot.",
  }),
  did("click_control", true, true, clicked("Delete")),
];
const preview = {
  image: "data:image/jpeg;base64,anBn",
  width: 1024,
  height: 640,
};
type SessionRow = {
  step: number;
  use: ScreenshotUse;
  image: number;
  stepJson: number;
  workspace: number;
  /** Tokens before the last cache breakpoint that the cache served. */
  cached: number;
  total: number;
};
/**
 * Runs the session's screenshot decisions the way the runner does and
 * estimates each request: the instruction and tools are cached from the
 * second step on, the workspace part whenever it is byte-equal to the step
 * before, the image by Anthropic's formula, the rest by chars/4.
 */
function simulate(
  mode: Settings["visionMode"],
  contexts: { first: ScreenContext; notes: ScreenContext },
): SessionRow[] {
  const history: Observation["history"] = [];
  const rows: SessionRow[] = [];
  let shown: { sha256: string; context: string } | undefined;
  let sinceImage = 0,
    sha = 0,
    lastWorkspace: string | undefined;
  for (let i = 0; i <= sessionSteps.length; i++) {
    const before = i > 0 ? sessionSteps[i - 1] : undefined;
    if (before) {
      history.push(before.entry);
      if (before.changed) sha++;
    }
    const f: Frame = {
      ...frame(
        i === 0 ? "com.apple.finder" : "com.apple.Notes",
        i === 0 ? contexts.first : contexts.notes,
      ),
      id: `${String(i).padStart(8, "0")}-4e5f-4789-abcd-ef0123456789`,
      sha256: `sha-${sha}`,
      preview,
    };
    const use = screenshotUse({
      mode,
      frame: f,
      shown,
      sinceImage,
      executed: before?.executed,
    });
    const request = buildRequest(settings, "K", {
      ...notes,
      frame: f,
      history: modelHistory(history),
      screenshot: use,
    });
    const content = request.body.messages[0].content;
    const workspace: string = content[0].text,
      step: string = content[content.length - 1].text;
    expect(content).toHaveLength(use.send === "none" ? 2 : 3);
    const prefix =
      tokens(request.body.system[0].text) + tokens(request.body.tools);
    const image =
      use.send === "none"
        ? 0
        : use.send === "reduced"
          ? imageTokens(preview.width, preview.height)
          : imageTokens(geometry.model_width, geometry.model_height);
    rows.push({
      step: i + 1,
      use,
      image,
      stepJson: tokens(step),
      workspace: tokens(workspace),
      cached:
        (i > 0 ? prefix : 0) +
        (workspace === lastWorkspace ? tokens(workspace) : 0),
      total: prefix + tokens(workspace) + image + tokens(step),
    });
    lastWorkspace = workspace;
    shown = { sha256: f.sha256, context: contextDigest(f) };
    sinceImage = use.send === "none" ? sinceImage + 1 : 0;
  }
  return rows;
}
const average = (rows: SessionRow[], pick: (row: SessionRow) => number) =>
  Math.round(rows.reduce((sum, row) => sum + pick(row), 0) / rows.length);
/** Per step: everything, what the cache served, the rest, and the rest plus cache reads at a tenth. */
function averages(rows: SessionRow[]) {
  const total = average(rows, (r) => r.total),
    cached = average(rows, (r) => r.cached),
    uncached = total - cached;
  return {
    total,
    cached,
    uncached,
    billed: Math.round(uncached + cached / 10),
  };
}
function reportSession(name: string, rows: SessionRow[]) {
  const a = averages(rows);
  console.info(
    [
      `${name}: estimated tokens a step over ${rows.length} steps (chars/4; image by width × height / 750)`,
      ...rows.map(
        (r) =>
          `${String(r.step).padStart(4)}  ${`${r.use.send}:${r.use.reason}`.padEnd(18)}image${String(r.image).padStart(5)}  step${String(r.stepJson).padStart(5)}  workspace${String(r.workspace).padStart(4)}  cached${String(r.cached).padStart(5)}  total${String(r.total).padStart(5)}`,
      ),
      `  average: total ${a.total}, cached ${a.cached}, uncached ${a.uncached}, billed-equivalent ${a.billed} (uncached + cache reads at 0.1)`,
    ].join("\n"),
  );
  return a;
}
const notesAsObserved = { first: finderContext, notes: notesContext };
const notesDescribed = { first: finderContext, notes: notesDescribedContext };

describe("what a 20-step Notes session costs", () => {
  const modes = ["always", "auto", "text-first"] as const;
  it("never drops a screenshot the rules require, in any mode", () => {
    for (const contexts of [notesAsObserved, notesDescribed])
      for (const mode of modes) {
        const rows = simulate(mode, contexts);
        expect(rows).toHaveLength(20);
        // The first step, and every step after an unverified action.
        expect(rows[0].use.send).toBe("full");
        for (const [i, step] of sessionSteps.entries())
          if (step.executed && !step.executed.confirmed)
            expect(rows[i + 1].use.send, `step ${i + 2}`).toBe("full");
        // At least every fourth step.
        for (let i = 3; i < rows.length; i++)
          expect(
            rows.slice(i - 3, i + 1).some((r) => r.use.send !== "none"),
            `steps ${i - 2}-${i + 1}`,
          ).toBe(true);
        if (mode === "always")
          expect(rows.every((r) => r.use.reason === "always")).toBe(true);
      }
    // Notes as observed publishes little, so the helper read every frame:
    // the OCR rule keeps the full screenshot on every Notes step.
    const auto = simulate("auto", notesAsObserved);
    expect(auto.slice(1).every((r) => r.use.reason === "ocr")).toBe(true);
    // With the note text published, the switch to Notes lands on a described
    // screen and is reduced. This fixture then publishes the same context on
    // every Notes step (the pixels change, the digest does not), so the
    // screen counts as unchanged and none is sent until the cadence asks for
    // a full screenshot every fourth step; the blind CMD+B and the scroll
    // (13, 14) keep the full one. Live, typing changes visibleText and the
    // digest with it, so a described screen is reduced rather than dropped.
    const described = simulate("auto", notesDescribed);
    expect(described.map((r) => r.use.reason)).toEqual([
      "first",
      "described",
      ...Array<string>(3).fill("unchanged"),
      "cadence",
      ...Array<string>(3).fill("unchanged"),
      "cadence",
      "unchanged",
      "unchanged",
      "unconfirmed",
      "unconfirmed",
      ...Array<string>(3).fill("unchanged"),
      "cadence",
      "unchanged",
      "unchanged",
    ]);
    expect(described[1].use.send).toBe("reduced");
    expect(simulate("text-first", notesDescribed)[1].use.send).toBe("none");
  });
  it("costs less a step in auto than always, and less again in text-first", () => {
    const measured: Record<string, ReturnType<typeof averages>> = {};
    for (const [name, contexts] of [
      ["Notes as observed", notesAsObserved],
      ["Notes described", notesDescribed],
    ] as const)
      for (const mode of modes)
        measured[`${name} / ${mode}`] = reportSession(
          `${name} / ${mode}`,
          simulate(mode, contexts),
        );
    for (const name of ["Notes as observed", "Notes described"]) {
      const always = measured[`${name} / always`],
        auto = measured[`${name} / auto`],
        textFirst = measured[`${name} / text-first`];
      expect(auto.uncached).toBeLessThanOrEqual(always.uncached);
      expect(textFirst.uncached).toBeLessThanOrEqual(auto.uncached);
      // The instruction, tools and workspace part are served from the cache
      // on every step but the first: over half of every request.
      expect(auto.cached).toBeGreaterThan(auto.total / 2);
    }
    // The owner's target: 2.5k a step with the instruction cached. Met on a
    // described screen; on Notes as observed the OCR rule keeps the full
    // screenshot (1.5k) on every step, so the remainder is the image.
    const described = measured["Notes described / auto"];
    expect(described.uncached).toBeLessThanOrEqual(2500);
    expect(described.billed).toBeLessThanOrEqual(2500);
    const observed = measured["Notes as observed / auto"];
    expect(observed.uncached).toBeLessThanOrEqual(2700);
  });
});
