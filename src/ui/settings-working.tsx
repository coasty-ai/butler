/**
 * Settings › Working. Whether a task works in the window it names while the
 * user is at the Mac (.data/design/background-actuation.md §2.2) or always
 * takes the screen. One ordinary setting saved with the form; the hint says
 * exactly what each choice does and what still runs in front.
 */
import React from "react";
import { ChevronDown } from "lucide-react";
import type { Settings } from "../core/schema";
import { targetHold } from "../core/background";

/**
 * What the switch means, under it. Honest about both sides: what a
 * background task does with the window and the user's hands, when the window
 * is asked for, and what runs in front regardless. The hold is quoted in the
 * pill's own words (targetHold), and the condition that ends it is the one
 * src/core/resume.ts applies; docs/VOICE_PRODUCT.md says the same.
 */
export function workInBackgroundHint(workInBackground: boolean): string {
  if (!workInBackground)
    return "Always in front: every task takes the screen, moving the cursor and typing in the window in front, and pauses as soon as you touch the mouse or keyboard.";
  return `While you’re at the Mac, a task that names an application (“in Slack, tell Prateek I’m late”), or the one in front when you spoke, works in that window without taking your cursor or keyboard: through its accessibility controls first, then events sent to that application, reading after each step whether the window changed. Your hands elsewhere are normal life; a click, a scroll or a key inside that window pauses the task (“${targetHold("Slack")}”), which continues once that application is no longer in front and your last click, scroll or keystroke was somewhere else, and Escape stops it. When the application ignores that input, the window comes in front for one step (“I need Slack for a second.”) and yours comes back. Away from the Mac, and for a window that can’t be bound, tasks run in front as before.`;
}

export function SettingsWorking({
  s,
  set,
  ids,
}: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  ids: string;
}) {
  return (
    <details className="setting-group">
      <summary>
        <span>
          Working
          <span>
            {s.workInBackground
              ? "In the background while you’re here"
              : "Always in front"}
          </span>
        </span>
        <ChevronDown size={15} />
      </summary>
      <div className="setting-fields">
        <label className="consent">
          <input
            type="checkbox"
            checked={s.workInBackground}
            aria-describedby={`${ids}-background`}
            onChange={(e) => set("workInBackground", e.target.checked)}
          />
          <span>Work in the background while I’m using the Mac</span>
        </label>
        <p id={`${ids}-background`}>
          {workInBackgroundHint(s.workInBackground)}
        </p>
      </div>
    </details>
  );
}
