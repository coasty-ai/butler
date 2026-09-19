import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_PRODUCT_NAME,
  localApp,
  productName,
  staleBuild,
} from "../scripts/local-app.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const LAUNCHERS = [
  "scripts/debug-local.mjs",
  "scripts/start-local.mjs",
  "scripts/provider-smoke.mjs",
  "scripts/desktop-smoke.mjs",
  "scripts/native-input-smoke.mjs",
];

describe("the locally packaged app follows build.productName", () => {
  it("is Butler.app, with the executable electron-builder names after it", () => {
    expect(productName(root)).toBe("Butler");
    const local = localApp(root);
    expect(local.app).toBe(join(root, "release/mac-arm64/Butler.app"));
    expect(local.binary).toBe(
      join(root, "release/mac-arm64/Butler.app/Contents/MacOS/Butler"),
    );
    expect(local.resources).toBe(
      join(root, "release/mac-arm64/Butler.app/Contents/Resources"),
    );
    expect(local.legacy).toBe(join(root, "release/mac-arm64/Open Assist.app"));
    expect(LEGACY_PRODUCT_NAME).toBe("Open Assist");
  });

  it("refuses a release folder that holds only the build from before the rename", () => {
    const local = localApp("/p", "Butler");
    const only = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(staleBuild(local, only(local.legacy))).toMatch(
      /only "Open Assist\.app".*npm run package:mac to build "Butler\.app"/,
    );
    expect(staleBuild(local, only(local.app, local.legacy))).toBeUndefined();
    expect(staleBuild(local, only(local.app))).toBeUndefined();
    expect(staleBuild(local, only())).toBeUndefined();
  });

  it("is the only place a launcher takes the bundle path from", () => {
    for (const script of LAUNCHERS) {
      const text = readFileSync(join(root, script), "utf8");
      expect([script, /release\/mac-arm64\/[^"`]*\.app/.test(text)]).toEqual([
        script,
        false,
      ]);
      expect([script, text.includes('from "./local-app.mjs"')]).toEqual([
        script,
        true,
      ]);
    }
    for (const script of ["scripts/debug-local.mjs", "scripts/start-local.mjs"])
      expect([script, readFileSync(join(root, script), "utf8")]).toEqual([
        script,
        expect.stringContaining("staleBuild(local"),
      ]);
  });
});
