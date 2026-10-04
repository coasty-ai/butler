import { expect, test } from "vitest";
import { rememberWindow, windowContexts } from "../src/core/windows";
import { taskBrowser } from "../src/terminal/apps";
import type { RunTarget, WindowContext } from "../src/core/schema";

test("visited windows stay bounded, redact credentials and never retain native tokens", () => {
  let windows: WindowContext[] = [];
  for (let i = 1; i <= 12; i++) {
    const target: RunTarget = {
      token: `synthetic-token-${i}`,
      appId: "com.microsoft.VSCode",
      appName: "Code",
      pid: 10,
      windowId: i,
      title: "SYNTHETIC " + "a".repeat(400),
    };
    for (let note = 0; note < 5; note++)
      windows = rememberWindow(
        windows,
        target,
        target.title,
        `SYNTHETIC ${note} sk-proj-${"b".repeat(60)}`,
      );
  }
  expect(windows).toHaveLength(8);
  expect(windows[0].windowId).toBe(5);
  expect(
    windows.every((w) => w.title.length <= 180 && w.facts.length === 3),
  ).toBe(true);
  expect(JSON.stringify(windows)).not.toMatch(/synthetic-token|sk-proj/);
  expect(
    windowContexts([
      null,
      { ...windows[0], pid: -1 },
      { ...windows[0], facts: "SYNTHETIC malformed" },
    ] as unknown as WindowContext[]),
  ).toHaveLength(1);
  expect(windowContexts({} as WindowContext[])).toEqual([]);
});

test("web tasks start in an installed browser and honour explicit browser choices", () => {
  const apps = [{ name: "Google Chrome" }, { name: "Safari" }];
  expect(taskBrowser("SYNTHETIC open a youtube tutorial", apps)?.bundleId).toBe(
    "com.google.Chrome",
  );
  expect(taskBrowser("SYNTHETIC open https://example.com", apps)?.name).toBe(
    "Google Chrome",
  );
  expect(
    taskBrowser("SYNTHETIC open a website in Safari", apps)?.bundleId,
  ).toBe("com.apple.Safari");
  expect(taskBrowser("SYNTHETIC use Firefox", apps)?.bundleId).toBe(
    "org.mozilla.firefox",
  );
  expect(taskBrowser("SYNTHETIC open Calendar", apps)).toBeUndefined();
  expect(
    taskBrowser("SYNTHETIC open a website", [{ name: "Safari" }])?.name,
  ).toBe("Safari");
});
