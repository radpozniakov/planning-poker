import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Allow importing the @pp/shared workspace package (TS source) from outside FE/.
    fs: { allow: [".."] },
  },
  // @pp/shared is consumed as TS source (no build step) — let Vite process it directly
  // instead of trying to pre-bundle/externalize a package with no compiled output.
  optimizeDeps: { exclude: ["@pp/shared"] },
  ssr: { noExternal: ["@pp/shared"] },
});
