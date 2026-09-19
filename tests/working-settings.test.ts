import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { defaultSettings, settingsSchema } from "../src/core/schema";
import { workInBackgroundHint } from "../src/ui/settings-working";
import { targetHold } from "../src/core/background";

describe("Settings › Working", () => {
  it("defaults to working in the background, for a stored config from before the setting too", () => {
    expect(defaultSettings.workInBackground).toBe(true);
    const { workInBackground: _, ...before } = defaultSettings;
    expect(settingsSchema.parse(before).workInBackground).toBe(true);
    expect(
      settingsSchema.parse({ ...before, workInBackground: false })
        .workInBackground,
    ).toBe(false);
  });
  it("says what each choice does, including what still runs in front", () => {
    const on = workInBackgroundHint(true);
    expect(on).toMatch(/^While you’re at the Mac/);
    for (const phrase of [
      "“in Slack, tell Prateek I’m late”",
      "or the one in front when you spoke",
      "without taking your cursor or keyboard",
      "accessibility controls first, then events sent to that application",
      "reading after each step whether the window changed",
      "a click, a scroll or a key inside that window pauses the task",
      "Escape stops it",
      "the window comes in front for one step (“I need Slack for a second.”)",
      "Away from the Mac, and for a window that can’t be bound, tasks run in front as before.",
    ])
      expect(on).toContain(phrase);
    const off = workInBackgroundHint(false);
    expect(off).toMatch(/^Always in front: every task takes the screen/);
    expect(off).toContain("pauses as soon as you touch the mouse or keyboard");
  });
  it("quotes the hold in the pill's words and states what ends it, the same in the hint and the product doc", () => {
    const hold = `(“${targetHold("Slack")}”)`;
    const ends =
      "which continues once that application is no longer in front and your last click, scroll or keystroke was somewhere else";
    const on = workInBackgroundHint(true);
    expect(on).toContain(`${hold}, ${ends}, and Escape stops it.`);
    expect(on).not.toContain("hands are idle");
    const doc = readFileSync(
      new URL("../docs/VOICE_PRODUCT.md", import.meta.url),
      "utf8",
    );
    expect(doc).toContain(`${hold}, ${ends}`);
    expect(doc).not.toContain("hands are idle");
    // One hold message: the pill's, recognised by the resume rule.
    expect(targetHold("Slack")).toBe(
      "Paused — you’re in Slack. I’ll continue when you switch away.",
    );
  });
  it("is one switch under Working, wired to the setting, with the hint under it", () => {
    const group = readFileSync(
      new URL("../src/ui/settings-working.tsx", import.meta.url),
      "utf8",
    );
    expect(group).toContain("checked={s.workInBackground}");
    expect(group).toContain(
      'onChange={(e) => set("workInBackground", e.target.checked)}',
    );
    expect(group).toContain("Work in the background while I’m using the Mac");
    expect(group).toContain("{workInBackgroundHint(s.workInBackground)}");
    // The summary shows the choice in force, as the other groups do.
    expect(group).toMatch(
      /s\.workInBackground\s*\?\s*"In the background while you’re here"\s*:\s*"Always in front"/,
    );
    // Mounted with the form's state and setter, just before Safety & limits.
    const ui = readFileSync(
      new URL("../src/ui/main.tsx", import.meta.url),
      "utf8",
    );
    const at = ui.indexOf("<SettingsWorking s={s} set={set} ids={ids} />");
    expect(at).toBeGreaterThan(0);
    const safety = ui.indexOf("Safety & limits", at);
    expect(safety).toBeGreaterThan(at);
    expect(safety - at).toBeLessThan(200);
  });
});
