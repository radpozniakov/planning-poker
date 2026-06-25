// SPA mode (ADR-006): all room state is client-live, so there is nothing to render
// on the server. Disable SSR and prerendering; adapter-static emits a 200.html shell.
export const ssr = false;
export const prerender = false;
