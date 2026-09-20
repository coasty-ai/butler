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
} finally {
  try {
    await controller.stop("probe done");
  } catch {
    // Already stopped or gone: nothing to give back.
  }
  controller.close();
}
