import { test, expect } from "@playwright/test";
test("minimal surface, tutorial pill, private review and cancellation", async ({
  page,
}) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:5173") &&
      !r.url().startsWith("data:")
    )
      external.push(r.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Press a key. Tell your computer what to do.",
    }),
  ).toBeVisible();
  await expect(page.locator("nav")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      document.fonts.check('400 16px "Space Grotesk Variable"'),
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/qa/voice-first-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Try the safe tutorial", exact: true })
    .click();
  await expect(page.locator(".pill-copy")).toContainText("Working");
  await page.screenshot({
    path: "output/qa/working-pill.png",
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.locator(".pill-copy")).toContainText("Done.", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Your runs stay yours" }).click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.getByRole("button", { name: /Safe tutorial/ }).click();
  await expect(
    page.getByRole("button", { name: "Contribute", exact: true }),
  ).toBeDisabled();
  await page.locator(".review-frame").first().click();
  await expect(page.locator(".review-frame.excluded")).toHaveCount(1);
  await page.locator(".consent input").check();
  await expect(
    page.getByRole("button", { name: "Contribute", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "output/qa/voice-contribution-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Keep it private" }).click();
  expect(external).toEqual([]);
  await page.getByRole("button", { name: "Delete local run" }).click();
  await expect(
    page.getByRole("heading", { name: "No local runs yet." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("tap-to-type, interrupt and correction preserve one run", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Try the safe tutorial", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause task" }).click();
  await expect(page.locator(".pill-copy")).toContainText("Paused.");
  await page.getByRole("button", { name: "Type a correction" }).click();
  await page
    .getByRole("textbox", { name: "Command", exact: true })
    .fill("Use the September report.");
  await page.getByRole("button", { name: "Execute command" }).click();
  await expect(page.locator(".pill-copy")).toContainText("Working");
  await page.getByRole("button", { name: "Stop task" }).click();
  await expect(page.locator(".pill-copy")).toContainText("Stopped.");
  await page.getByRole("button", { name: "Your runs stay yours" }).click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await expect(page.locator(".history-row")).toContainText("1 corrections");
});
test("tiny settings and responsive preview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .getByRole("combobox", { name: "Talk to Butler" })
    .selectOption("hands-free");
  await expect(page.getByText(/Keeps your microphone on/)).toBeVisible();
  await expect(page.locator(".setup-note")).toContainText("No audio uploads");
  await page
    .getByRole("combobox", { name: "Talk to Butler" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "output/qa/hands-free-settings.png",
    fullPage: true,
  });
  await page.locator("summary").filter({ hasText: "Safety & limits" }).click();
  await page.getByRole("spinbutton", { name: "Action limit" }).fill("12");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/qa/voice-settings.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "output/qa/voice-first-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "or type a command" }).click();
  await page
    .getByRole("textbox", { name: "Command", exact: true })
    .fill("Find the latest report.");
  await page.getByRole("button", { name: "Execute command" }).click();
  await expect(page.getByRole("alert")).toContainText("macOS app");
});
