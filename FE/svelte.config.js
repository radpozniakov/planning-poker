import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA mode: no SSR, a single fallback shell that boots the client app.
    adapter: adapter({ fallback: "200.html" }),
  },
};

export default config;
