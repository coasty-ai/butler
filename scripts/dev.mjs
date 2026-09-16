import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { build } from "esbuild";
if (
  process.platform === "darwin" &&
  (!existsSync("native/bin/coarena-controller") ||
    !existsSync("native/bin/coarena-voice"))
) {
  const p = spawn("node", ["scripts/build-native.mjs"], { stdio: "inherit" });
  await new Promise((resolve, reject) =>
    p.on("exit", (c) =>
      c ? reject(new Error("Native build failed")) : resolve(),
    ),
  );
}
await build({
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
});
const vite = spawn("npm", ["run", "dev:ui"], { stdio: "inherit" });
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch("http://127.0.0.1:5173")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const electron = spawn("node_modules/.bin/electron", ["."], {
  stdio: "inherit",
  env: { ...process.env, COARENA_DEV: "1" },
});
const stop = () => {
  vite.kill();
  electron.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
electron.on("exit", () => {
  vite.kill();
});
