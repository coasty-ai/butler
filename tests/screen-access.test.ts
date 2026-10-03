import { expect, test } from "vitest";
import { screenAccess } from "../electron/screen-access";

test("a current helper grant clears a previous denial without a sticky restart", () => {
  expect(screenAccess(false, "denied")).toEqual({
    screen: false,
    screenNeedsRelaunch: false,
  });
  expect(screenAccess(false, "granted")).toEqual({
    screen: true,
    screenNeedsRelaunch: true,
  });
  expect(screenAccess(true, "granted")).toEqual({
    screen: true,
    screenNeedsRelaunch: false,
  });
});
test("an unreachable helper or unknown OS answer is not a denial", () => {
  expect(screenAccess(undefined, "unknown")).toEqual({
    screen: false,
    screenNeedsRelaunch: false,
  });
  expect(screenAccess(true, "unknown")).toEqual({
    screen: true,
    screenNeedsRelaunch: false,
  });
});
