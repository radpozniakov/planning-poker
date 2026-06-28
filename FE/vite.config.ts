import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPA build (replaces the SvelteKit adapter-static app). Output goes to `build/` so the
// Dockerfile's `COPY --from=build /app/FE/build` path is unchanged; nginx serves `index.html`
// + content-hashed `assets/`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Allow importing the @pp/shared workspace package (TS source) from outside FE/.
    fs: { allow: [".."] },
    // Same-origin dev: the client always opens a RELATIVE /ws (no hardcoded host), and Vite
    // upgrades it to the BE. This keeps dev byte-identical to prod (nginx proxies /ws to be:3000)
    // and survives ssh tunnels — no `localhost:3000` literal ever reaches the bundle.
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/health": { target: "http://localhost:3000" },
    },
  },
  // @pp/shared is consumed as TS source (no build step) — let Vite process it directly.
  optimizeDeps: { exclude: ["@pp/shared"] },
  build: { outDir: "build" },
});
