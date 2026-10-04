import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TerminalStore } from "../src/terminal/store";
import {
  onboardingApps,
  installedCodingClis,
  freshOnboarding,
  onboardingSchema,
  desktopSetupTask,
  continuesSetup,
  startsOnboarding,
} from "../src/terminal/onboarding";
const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "butler-onboarding-test-"));
  roots.push(root);
  return root;
};
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

test("first-launch progress survives an encrypted restart while legacy profiles stay out of onboarding", () => {
  const root = temp(),
    key = randomBytes(32);
  const store = new TerminalStore(root, key);
  expect(store.profile.onboarding).toEqual(freshOnboarding());
  store.profile.onboarding = {
    phase: "waiting",
    apps: ["calendar", "gmail"],
    pending: ["gmail"],
    desktopReady: [],
    desktopFirst: true,
    activeApp: "gmail",
  };
  store.save();
  expect(new TerminalStore(root, key).profile.onboarding).toEqual(
    store.profile.onboarding,
  );
  delete store.profile.onboarding;
  store.save();
  expect(new TerminalStore(root, key).profile.onboarding).toBeUndefined();
});
test("discovery puts available Mac apps before web access and only includes installed coding tools", () => {
  expect(
    onboardingApps(
      [{ name: "Mail" }, { name: "Calendar" }, { name: "Reminders" }],
      ["codex", "codex"],
    ),
  ).toEqual([
    "calendar",
    "reminders",
    "mail",
    "gmail",
    "slack",
    "github",
    "codex",
  ]);
  const root = temp();
  writeFileSync(join(root, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  expect(installedCodingClis(`.:${root}:${root}`)).toEqual(["claude-code"]);
});
test("ordinary app preparation uses signed-in app homes without developer credentials", () => {
  const gmail = desktopSetupTask("gmail", "Safari", false);
  expect(gmail).toContain("https://mail.google.com/");
  expect(gmail).not.toContain("console.cloud.google.com");
  expect(gmail).toContain("without reading messages");
  expect(gmail).toContain("Never create developer credentials");
  expect(desktopSetupTask("slack", "Safari", true)).toContain("In Slack,");
  expect(desktopSetupTask("slack", "Safari", false)).toContain(
    "https://app.slack.com/",
  );
  expect(desktopSetupTask("github", "Safari", false)).not.toContain(
    "settings/tokens",
  );
});
test("continuations and state cannot acquire new app names from arbitrary text", () => {
  expect(continuesSetup("Done.")).toBe(true);
  expect(continuesSetup("Done, delete my files")).toBe(false);
  expect(startsOnboarding("Get me ready!")).toBe(true);
  expect(startsOnboarding("Get me ready and send mail")).toBe(false);
  expect(
    onboardingSchema.safeParse({
      phase: "waiting",
      apps: ["SYNTHETIC-private-app"],
    }).success,
  ).toBe(false);
});
