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
// Written for the STOPPED_AFTER_HANDOFF lane of cycle 20260919-0739: market
// tasks ran "In Safari" for the first time and three runs saw UNIDENTIFIED_TARGET
// there. Chrome's web controls reached the model in earlier cycles; Safari's
// web area sits five or six levels under the window and its children may come
// through AXVisibleChildren differently, and only a live read can tell.
//
// Run it with nobody at the desktop and the page to probe frontmost (Safari on
// a fixture page, then Chrome on the same page for the comparison):
//
//   npm run build:native
//   node --import tsx scripts/probe-web-controls.mjs
//
// No network calls, nothing written, no input sent.
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
      roles: tally(controls.map((c) => c.role)),
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
  console.log(
    JSON.stringify({
      hitTested: hits.length,
      hitRoles: tally(hits.map((h) => h.hit)),
      inWebPage: hits.filter((h) => h.web).length,
      covered: hits.filter((h) => h.covered).length,
      coveredBy: tally(hits.filter((h) => h.covered).map((h) => h.hit)),
      named: hits.filter((h) => h.named).length,
      listedVsHit: tally(hits.map((h) => `${h.listed}→${h.hit}`)),
    }),
  );
} finally {
  try {
    await controller.stop("probe done");
  } catch {
    // Already stopped or gone: nothing to give back.
  }
  controller.close();
}
