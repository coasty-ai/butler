import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupRequest,
  naturalControl,
  findGoogleClient,
  openSetupPage,
  SETUP_APPS,
} from "../src/terminal/concierge";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
test("explicit setup requests select apps without granting compound or quoted requests", () => {
  expect(setupRequest("Please connect my apps.")).toEqual([...SETUP_APPS]);
  expect(setupRequest("Set up Gmail and Slack for me")).toEqual([
    "gmail",
    "slack",
  ]);
  expect(setupRequest("Can you please connect Gmail?")).toEqual(["gmail"]);
  expect(setupRequest("Connect GitHub, codex + GitHub")).toEqual([
    "github",
    "codex",
  ]);
  for (const text of [
    "Explain ‘connect my apps’",
    "Connect Slack and send a message",
    "Connect an unknown app",
    "Connect gmail; approve access",
    '"connect gmail"',
  ])
    expect(setupRequest(text)).toBeUndefined();
});
test("local controls have bounded intervals and never infer an access approval", () => {
  expect(naturalControl("Brief me every 2 hours")).toBe("/briefings 120");
  expect(naturalControl("Read replies aloud")).toBe("/voice on");
  expect(naturalControl("Could you please brief me every 30 minutes?")).toBe(
    "/briefings 30",
  );
  expect(naturalControl("Pause")).toBe("/pause");
  for (const text of [
    "Brief me every 1 minute",
    "Brief me every 25 hours",
    "Approve everything",
    "Read replies aloud and delete my files",
    "Set my token to synthetic-value",
  ])
    expect(naturalControl(text)).toBeUndefined();
});
test("Google client discovery rejects ambiguity, symlinks, oversized files and non-desktop clients", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-client-fixture-"));
  roots.push(root);
  const client = {
    installed: {
      client_id: "synthetic.apps.googleusercontent.com",
      client_secret: "synthetic-client-secret",
    },
  };
  writeFileSync(
    join(root, "client_secret_fixture.json"),
    JSON.stringify(client),
  );
  expect(findGoogleClient([root])).toEqual({
    clientId: client.installed.client_id,
    clientSecret: client.installed.client_secret,
  });
  writeFileSync(
    join(root, "client_secret_other.json"),
    JSON.stringify({
      installed: {
        ...client.installed,
        client_id: "other.apps.googleusercontent.com",
      },
    }),
  );
  expect(findGoogleClient([root])).toBeUndefined();
  rmSync(join(root, "client_secret_other.json"));
  rmSync(join(root, "client_secret_fixture.json"));
  writeFileSync(join(root, "source.json"), JSON.stringify(client));
  symlinkSync(join(root, "source.json"), join(root, "client_secret_link.json"));
  writeFileSync(
    join(root, "client_secret_web.json"),
    JSON.stringify({ web: client.installed }),
  );
  writeFileSync(join(root, "client_secret_big.json"), " ".repeat(65537));
  writeFileSync(join(root, "client_secret_bad.json"), "malformed fixture");
  expect(findGoogleClient([root])).toBeUndefined();
});
test("sign-in page launch refuses protected hosts and secrets before launching", async () => {
  const launch = vi.fn(async () => true);
  for (const url of [
    "javascript:alert(1)",
    "https://id:secret@example.test",
    "https://example.test?access_token=synthetic",
    "https://login.blocked.test",
    "https://BLOCKED.test",
    "http://remote.test",
  ])
    expect(await openSetupPage(url, ["BLOCKED.test"], launch)).toBe(false);
  expect(launch).not.toHaveBeenCalled();
  expect(
    await openSetupPage(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&state=synthetic",
      [],
      launch,
    ),
  ).toBe(true);
  expect(launch).toHaveBeenCalledOnce();
});
