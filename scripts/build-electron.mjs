import { build } from "esbuild";
await build({
  entryPoints: [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/kokoro/worker.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "onnxruntime-node"],
  target: "node20",
});
