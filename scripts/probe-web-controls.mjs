// What the helper's accessibility walk sees of the browser window in front,
// content-free: counts and roles only, never a label, a URL or text. It reads
// the same `surface` and `capture` the runner reads (one screenshot, taken and
// discarded; `surface` with a click action is the runner's hit test at that
// point and sends no input), so it says whether a page's controls reach
// `context.controls` and whether the policy would be able to identify them.
//
// Cycle 20260920-0241 (market 1/3, autonomy all): this probe on the mail
// message fixture read 14 controls with no radio among them and the hit test
// at the textarea's centre landing on an AXDockItem; `grouped` and `covered`
// below say whether the title-element names and the reveal before a covered
// click (native Reveal.swift) took: after `npm run build:native`, expect the
// radios listed with their group and `covered` 0 on that page.
//
// Cycle 20260920-0415 (market 3/3): the home panel's light switches
// hit-tested to the AXWebArea and the mail fixture's folder radios to the
// AXGroup of the <label> wrapping each input, and every click by name on them
// was refused CONTROL_COVERED. `hitAncestor` below counts the labelled
// controls whose point falls through to one of their own ancestors (native
// hitCover, Reveal.swift coveredBy): on the lights page expect it to count
// the switches, `hitAncestorRoles` to name radio buttons or check boxes, and
// the covered count to leave them out. The click_control surfaces that read
// it are taken with the helper stopped, so the reveal only reads and no page
// is scrolled.
//
// Cycle 20260920-0514 (market 1/3): research-compare-to-csv opened the first
// vendor again and again, because the vendors table lists a "Details" link in
// every row and the three were listed alike. `repeatedNames` below counts the
// names two or more listed controls of one role share and `qualified` the
// names carrying a row qualifier (native ListNames.swift): after `npm run
// build:native`, expect 0 and 3 on the vendors fixture page.
//
// Written for the STOPPED_AFTER_HANDOFF lane of cycle 20260919-0739: market
// tasks ran "In Safari" for the first time and three runs saw UNIDENTIFIED_TARGET
// there. Chrome's web controls reached the model in earlier cycles; Safari's
// web area sits five or six levels under the window and its children may come
// through AXVisibleChildren differently, and only a live read can tell.
//
// Cycles 20260920-0631 and -0731 (market, autonomy all): a field clicked by
// name read press/focused and the type_text steps after it never landed (the
// page's text nodes stayed at 15 through four typings), while the passing
// runs read the same words with the nodes growing. With `--focus` the probe
// also runs the runner's own click_control on the page's first listed text
// field (native clickNamedControl: a clear field takes the pointer first now)
// and prints `via`, `effect`, the focused role the next surface reads and
// whether its label is the field's. One click is sent then, and no keystroke;
// typing itself is the next cycle's measure (text nodes growing after each
// type_text). On the booking and CRM fixture pages expect via "pointer",
// effect "focused", focusedAfter a text role and sameLabel true.
//
// Cycles 20260920-0631, -0731 and -0957 (market, autonomy all): the booking
// runs that failed read the field clicked (by press, and by the pointer with
// effect focused at bceb9cd), type_text executed with no error and the
// per-character focus check silent, and the page's text nodes stayed at 15
// through all four typings where the passing run at 0514 read 15 -> 16 -> 17
// -> 18 -> 19 (checkin-flight-seat 8 -> 8 against 8 -> 9). One visible
// difference: the passing run's first frame was a 99-node Safari page (an
// existing window), the failing runs' a 1-node empty Safari window (a fresh
// launch), so Safari may hold two windows and the key window may not be the
// field's while the accessibility focus reads the field. With `--type` the
// probe clicks the first listed text field as `--focus` does, then runs the
// runner's own type_text of a fixed four-character synthetic string (the one
// keystroke sequence it sends; the page is the bench's own fixture), waits
// 400 ms and prints one JSON line, content-free: the application's windows
// before, after the click and after the typing (the helper's read-only
// `windows` query, native windowsReport: how many the accessibility tree
// lists and how many stand on screen, which is main, which is focused, which
// holds the focused element, and the focused element's value length), the
// page's text nodes and visible-text length before and after, whether the
// focus is still the field's, and a diagnosis naming the reading the numbers
// support: `landed` (the value grew by the typed characters and the nodes
// grew), `walk-blind` (the value grew, the nodes did not), `key-window` (the
// value did not grow and the focused element's window is not the focused or
// the main one), `dropped` (the focus intact, the value unchanged, one
// window), `moved` (the focus left the field). Run it on the CRM fixture
// page in Safari; the typed characters stay in the field until the page is
// reloaded, and a helper built before the query reports the windows as
// unavailable (REBUILD_HELPER).
//
// Run it with nobody at the desktop and the page to probe frontmost (Safari on
// a fixture page, then Chrome on the same page for the comparison):
//
//   npm run build:native
//   node --import tsx scripts/probe-web-controls.mjs
//   node --import tsx scripts/probe-web-controls.mjs --focus
//   node --import tsx scripts/probe-web-controls.mjs --type
//
// No network calls, nothing written, no input sent without `--focus` (one
// click) or `--type` (one click and one four-character typing).
import { resolve } from "node:path";
import { NativeController } from "../electron/controller.ts";
import { defaultSettings } from "../src/core/schema.ts";

const controller = new NativeController(
  resolve("native/bin/coarena-controller"),
  () => {},
  () => {},
  () => {},
);
const tally = (values) => {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    ),
  );
};
// The characters `--type` types: synthetic, fixed, four of them; the probe
// prints their count and never them.
const TYPED = "ab12";
// Which reading one typing's numbers support (the header names them). The
// value length is the focused element's, read before and after through the
// windows query; the nodes are the frame's visibleTextNodes; sameField says
// the focus after the typing is still the field's; windows is the query's
// reading after the typing. Without the query (an older helper) the nodes
// alone decide between landed and the rest.
const diagnose = ({
  typed,
  valueBefore,
  valueAfter,
  nodesBefore,
  nodesAfter,
  sameField,
  windows,
}) => {
  if (!typed.executed)
    return `not-typed: the helper refused before a keystroke (${typed.refused})`;
  const grew =
    typeof valueBefore === "number" && typeof valueAfter === "number"
      ? valueAfter - valueBefore
      : null;
  const nodesGrew =
    typeof nodesBefore === "number" &&
    typeof nodesAfter === "number" &&
    nodesAfter > nodesBefore;
  if (grew === TYPED.length)
    return nodesGrew
      ? "landed: the value grew by the typed characters and the text nodes grew"
      : "walk-blind: the value grew by the typed characters and the text nodes did not";
  if (grew !== null && grew > 0)
    return `partial: the value grew by ${grew} of ${TYPED.length}`;
  if (grew === null && nodesGrew)
    return "landed-by-nodes: the text nodes grew; the value length needs a rebuilt helper";
  // Two or more windows, and either the focused element's window (when it
  // names one) is not the focused or the main window, or the focused window
  // is not the main one.
  const twoWindows = typeof windows?.count === "number" && windows.count > 1;
  const elementElsewhere =
    windows?.elementWindowIndex >= 0 &&
    (windows.elementWindowIndex !== windows.focusedIndex ||
      windows.elementWindowIndex !== windows.mainIndex);
  if (
    twoWindows &&
    (elementElsewhere || windows.focusedIndex !== windows.mainIndex)
  )
    return "key-window: the focused element's window is not the focused or the main window";
  if (sameField)
    return "dropped: the focus is still the field's and its value did not grow";
  return "moved: the focus is not the field's after the typing";
};
try {
  await controller.configure(structuredClone(defaultSettings));
  // The helper starts stopped; the read-only capture needs it resumed, and it
  // is stopped again below before the process is closed.
  await controller.resume();
  const surface = await controller.surface();
  console.log(
    JSON.stringify({
      appId: surface.appId,
      accessibility: surface.accessibility ?? "(no verdict)",
      hasDomain: surface.domain !== undefined,
      // A page whose address the helper could not read: with hasDomain false,
      // true means the run would hand off here, false a window with no page.
      hostUnknown: surface.hostUnknown === true,
      focusedRole: surface.focusedRole ?? "(none)",
      unknown: surface.unknown,
    }),
  );
  const pageAddressFacts = (address) => {
    if (typeof address !== "string" || !address) return { present: false };
    try {
      const url = new URL(address);
      const host = url.hostname;
      const kind = /^(127\.|localhost$|\[?::1)/.test(host)
        ? "loopback"
        : "other";
      return {
        present: true,
        scheme: url.protocol.replace(":", ""),
        host: kind,
        hasPort: !!url.port,
        hasPath: url.pathname.length > 1,
      };
    } catch {
      return { present: true, parses: false, length: address.length };
    }
  };
  const frame = await controller.capture();
  const context = frame.context ?? {};
  const controls = context.controls ?? [];
  console.log(
    JSON.stringify({
      appId: frame.appId,
      controls: controls.length,
      labelled: controls.filter((c) => typeof c.label === "string" && c.label)
        .length,
      // Radio buttons and check boxes with their fieldset's legend (native
      // controlGroup): the mail fixture's folders under "File under".
      grouped: controls.filter((c) => typeof c.group === "string" && c.group)
        .length,
      disabled: controls.filter((c) => c.enabled === false).length,
      // Names shared by two or more listed controls of one role, and names
      // carrying a row qualifier (native ListNames.swift: "Details (Vendor
      // B)" for a link repeated in every row of a table, cycle
      // 20260920-0514-55e4e83): on the vendors page expect 0 and 3. Counts
      // only; a label like "Thermostat (°F)" counts as qualified too.
      repeatedNames: Object.values(
        tally(
          controls
            .filter((c) => typeof c.label === "string" && c.label)
            .map(
              (c) =>
                `${c.role}|${c.label.trim().replace(/\s+/g, " ").toLowerCase()}`,
            ),
        ),
      ).filter((n) => n >= 2).length,
      qualified: controls.filter(
        (c) => typeof c.label === "string" && /\s\([^()]+\)$/.test(c.label),
      ).length,
      roles: tally(controls.map((c) => c.role)),
      // The page address the web tools read (frame.context.browserAddress):
      // present or not, its host class and whether it carries a path — never
      // the address itself.
      pageAddress: pageAddressFacts(context.browserAddress),
      visibleTextChars: (context.visibleText ?? "").length,
      screenTextChars: (context.screenText ?? "").length,
      menus: (context.menus ?? []).length,
      accessibility: context.accessibility ?? "(no verdict)",
      timings: frame.timings ?? {},
    }),
  );
  // The runner's hit test at each listed control's centre: does the element
  // there identify itself (role) and sit in a web page (host present)?
  const hits = [];
  for (const control of controls.slice(0, 40)) {
    const at = await controller.surface({
      type: "click",
      frame_id: frame.id,
      x: control.x,
      y: control.y,
      button: "left",
    });
    hits.push({
      listed: control.role,
      hit: at.targetRole ?? "(none)",
      web: at.targetWebHost !== undefined,
      named: typeof at.targetLabel === "string" && at.targetLabel.length > 0,
      // Covered where it is: the element at the control's centre belongs to
      // another application (the Dock, another window) or there is none (the
      // point lies outside the visible content). The click path scrolls such
      // a control into the clear first (native Reveal.swift).
      covered: at.targetAppId !== frame.appId,
    });
  }
  // The runner's own surface for a click by name on each labelled control:
  // the reveal reads only while the helper is stopped (no scroll is posted),
  // and `hitAncestor` says the element at the control's point is one of the
  // control's own ancestors, so the control is hit-invisible, not covered.
  await controller.stop("probe reads the named surfaces");
  const named = [];
  for (const control of controls.slice(0, 40)) {
    if (typeof control.label !== "string" || !control.label) continue;
    const at = await controller.surface({
      type: "click_control",
      frame_id: frame.id,
      label: control.label,
      role: control.role,
      x: control.x,
      y: control.y,
    });
    named.push({
      listed: control.role,
      status: at.controlStatus ?? "(none)",
      hitAncestor: at.hitAncestor === true,
      scrolled: at.controlScrolled === true,
      hit: at.targetRole ?? "(none)",
    });
  }
  console.log(
    JSON.stringify({
      hitTested: hits.length,
      hitRoles: tally(hits.map((h) => h.hit)),
      inWebPage: hits.filter((h) => h.web).length,
      covered: hits.filter((h) => h.covered).length,
      coveredBy: tally(hits.filter((h) => h.covered).map((h) => h.hit)),
      named: hits.filter((h) => h.named).length,
      listedVsHit: tally(hits.map((h) => `${h.listed}→${h.hit}`)),
      namedSurfaces: named.length,
      namedStatus: tally(named.map((n) => n.status)),
      hitAncestor: named.filter((n) => n.hitAncestor).length,
      hitAncestorRoles: tally(
        named.filter((n) => n.hitAncestor).map((n) => n.listed),
      ),
      // The named surface's target with the flag is the control itself; without
      // it, what the hit walk settled on (a covered control's cover).
      namedHitRoles: tally(named.map((n) => `${n.listed}→${n.hit}`)),
    }),
  );
  // The first labelled text field a frame lists, the runner's own
  // click_control on it, where the application's focus is after, and the
  // helper's read-only windows query: the pieces `--focus` and `--type` share.
  const fieldRoles = [
    "textfield",
    "textarea",
    "number",
    "combobox",
    "searchfield",
  ];
  const firstField = (frame) =>
    (frame.context?.controls ?? []).find(
      (c) =>
        fieldRoles.includes(c.role) && typeof c.label === "string" && c.label,
    );
  const clickField = async (frame, field) => {
    try {
      return await controller.execute(
        {
          type: "click_control",
          frame_id: frame.id,
          label: field.label,
          role: field.role,
          x: field.x,
          y: field.y,
        },
        frame,
        new AbortController().signal,
      );
    } catch (error) {
      // The helper's refusal as its code or class, never its words.
      return { refused: error?.code ?? error?.name ?? "error" };
    }
  };
  const focusFacts = (after, field) => ({
    focusedAfter: after.focusedRole ?? "(none)",
    focusedSubrole: after.focusedSubrole ?? "(none)",
    // The focused element's label is the clicked field's (compared, never
    // printed).
    sameLabel:
      typeof after.focusedLabel === "string" &&
      after.focusedLabel.trim().toLowerCase() ===
        field.label.trim().toLowerCase(),
  });
  // Counts, indexes (-1 for none) and a value length, never a title or a
  // value; a helper built before the query says so instead of failing the
  // probe.
  const windowsFacts = async () => {
    try {
      const w = await controller.request("windows");
      return {
        count: w.count,
        onScreen: w.onScreen,
        minimized: w.minimized,
        mainIndex: w.mainIndex,
        focusedIndex: w.focusedIndex,
        elementWindowIndex: w.elementWindowIndex,
        frontmostPid: w.frontmostPid,
        valueLength: typeof w.valueLength === "number" ? w.valueLength : null,
      };
    } catch (error) {
      return {
        unavailable: /Unknown controller method/.test(error?.message ?? "")
          ? "REBUILD_HELPER"
          : (error?.code ?? error?.name ?? "error"),
      };
    }
  };
  // --focus: the click path itself on the first listed text field, then
  // where the application's focus is. The helper is resumed for the one
  // click (execute needs a current frame and the latch open) and stopped
  // again; nothing is typed.
  if (process.argv.includes("--focus")) {
    await controller.resume();
    const fresh = await controller.capture();
    const field = firstField(fresh);
    if (!field) {
      console.log(JSON.stringify({ focusProbe: "no labelled text field" }));
    } else {
      const clicked = await clickField(fresh, field);
      const after = await controller.surface();
      console.log(
        JSON.stringify({
          focusProbe: {
            clicked: field.role,
            via: clicked?.via ?? "(none)",
            effect: clicked?.effect ?? "(none)",
            refused: clicked?.refused,
            ...focusFacts(after, field),
          },
        }),
      );
    }
    await controller.stop("probe clicked the field");
  }
  // --type: the same click, then the runner's own type_text of TYPED (the
  // one keystroke sequence the probe sends) against a frame captured after
  // the click, as the runner types against the frame it captured after its
  // click; 400 ms later a capture, the surface and the windows again. The
  // helper is resumed for the click and the typing and stopped again.
  if (process.argv.includes("--type")) {
    const windowsBefore = await windowsFacts();
    await controller.resume();
    const before = await controller.capture();
    const field = firstField(before);
    if (!field) {
      console.log(JSON.stringify({ typeProbe: "no labelled text field" }));
    } else {
      const clicked = await clickField(before, field);
      const afterClick = await controller.surface();
      const windowsAfterClick = await windowsFacts();
      const mid = await controller.capture();
      let typed = { executed: false };
      try {
        await controller.execute(
          { type: "type_text", frame_id: mid.id, text: TYPED },
          mid,
          new AbortController().signal,
        );
        typed = { executed: true };
      } catch (error) {
        typed = {
          executed: false,
          refused: error?.code ?? error?.name ?? "error",
        };
      }
      await new Promise((settle) => setTimeout(settle, 400));
      const after = await controller.capture();
      const afterType = await controller.surface();
      const windowsAfterType = await windowsFacts();
      const nodes = (frame) => frame.context?.visibleTextNodes ?? null;
      const chars = (frame) => (frame.context?.visibleText ?? "").length;
      const typeFocus = focusFacts(afterType, field);
      const textRoles = [
        "AXTextField",
        "AXTextArea",
        "AXComboBox",
        "AXIncrementor",
        "AXSearchField",
      ];
      const sameField =
        typeFocus.sameLabel && textRoles.includes(typeFocus.focusedAfter);
      console.log(
        JSON.stringify({
          typeProbe: {
            clicked: field.role,
            via: clicked?.via ?? "(none)",
            effect: clicked?.effect ?? "(none)",
            refused: clicked?.refused,
            // Before the click: the windows as the run found them.
            windowsBefore,
            // After the click: the focus, the field's value length (0
            // expected) and the windows.
            afterClick: {
              ...focusFacts(afterClick, field),
              valueLength: windowsAfterClick.valueLength ?? null,
              windows: windowsAfterClick,
            },
            typedChars: TYPED.length,
            typed,
            // The page's text nodes (visibleTextNodes) at the first capture,
            // after the click and after the typing, and the visible text's
            // length after the click and after the typing.
            textNodes: {
              beforeClick: nodes(before),
              before: nodes(mid),
              after: nodes(after),
            },
            visibleTextChars: { before: chars(mid), after: chars(after) },
            // After the typing: the focus (still the field's?), the focused
            // element's value length (TYPED.length expected) and the windows.
            afterType: {
              ...typeFocus,
              sameField,
              valueLength: windowsAfterType.valueLength ?? null,
              windows: windowsAfterType,
            },
            diagnosis: diagnose({
              typed,
              valueBefore: windowsAfterClick.valueLength ?? null,
              valueAfter: windowsAfterType.valueLength ?? null,
              nodesBefore: nodes(mid),
              nodesAfter: nodes(after),
              sameField,
              windows: windowsAfterType,
            }),
          },
        }),
      );
    }
    await controller.stop("probe typed into the field");
  }
} finally {
  try {
    await controller.stop("probe done");
  } catch {
    // Already stopped or gone: nothing to give back.
  }
  controller.close();
}
