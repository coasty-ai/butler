import { build } from "esbuild";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
await build({
  entryPoints: ["src/terminal/main.ts", "src/terminal/mcp-server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist-terminal",
  outExtension: { ".js": ".cjs" },
  target: "node22",
  external: ["@modelcontextprotocol/client", "@modelcontextprotocol/client/*"],
  banner: { js: "#!/usr/bin/env node" },
});
mkdirSync("bin", { recursive: true });
writeFileSync(
  "bin/butler",
  '#!/bin/sh\nBUTLER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec node "$BUTLER_ROOT/dist-terminal/main.cjs" "$@"\n',
);
chmodSync("bin/butler", 0o755);
chmodSync("dist-terminal/main.cjs", 0o755);
