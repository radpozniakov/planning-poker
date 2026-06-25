// Bundle BE for production (ADR-003). esbuild inlines @pp/shared TS source AND all
// node_modules deps into a single self-contained CJS file, so the runtime image needs
// no node_modules and `node dist/server.cjs` resolves everything. The optional native
// ws acceleration deps are marked external (ws falls back gracefully if absent).
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: false,
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});
