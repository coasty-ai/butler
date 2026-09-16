import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === "serve"
      ? [
          {
            name: "development-react-refresh",
            transformIndexHtml: (html: string) =>
              html.replace(
                "script-src 'self';",
                "script-src 'self' 'unsafe-inline';",
              ),
          },
        ]
      : []),
  ],
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist" },
}));
