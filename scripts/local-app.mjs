// Where the locally packaged app lives. electron-builder names the bundle, its
// executable and the release files after build.productName, so the scripts
// that launch the app by path read that name from package.json instead of
// spelling it. The bundle id, data folder and permissions do not follow the
// name (tests/identity.test.ts), so a rebuilt app keeps all three.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The product name before the Butler rename: the same app, the same bundle id. */
export const LEGACY_PRODUCT_NAME = "Open Assist";

export function productName(project) {
  return JSON.parse(readFileSync(join(project, "package.json"), "utf8")).build
    .productName;
}

export function localApp(project, name = productName(project)) {
  const release = join(project, "release", "mac-arm64");
  const app = join(release, `${name}.app`);
  return {
    name,
    app,
    binary: join(app, "Contents", "MacOS", name),
    resources: join(app, "Contents", "Resources"),
    legacy: join(release, `${LEGACY_PRODUCT_NAME}.app`),
  };
}

/**
 * Why the release folder cannot be launched as it is: it still holds only the
 * build from before the rename. Launching that stale build, or falling back to
 * a development Electron (which macOS treats as another app for every
 * permission), would both be the wrong app; undefined otherwise.
 */
export function staleBuild(paths, exists = existsSync) {
  if (exists(paths.app) || !exists(paths.legacy)) return undefined;
  return (
    `release/mac-arm64 holds only "${LEGACY_PRODUCT_NAME}.app", the build from before the rename. ` +
    `Quit it, run npm run package:mac to build "${paths.name}.app" (same bundle id, settings and permissions), then delete the old bundle.`
  );
}
