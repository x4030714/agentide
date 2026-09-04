/**
 * Design-review harness (kept, not scrap).
 *
 * The UI cannot render in a plain browser -- it calls Tauri IPC -- so design review had
 * no way to see it. This mocks only the Tauri boundary (`@tauri-apps/api/core` and
 * `@tauri-apps/plugin-dialog`, aliased in `vite.review.config.ts`) and serves the REAL
 * components, CSS and Monaco theme at `npx vite --config vite.review.config.ts`.
 *
 * It ships no code into the app: nothing under `src/` imports it, and the root build
 * never sees it. Each later phase gets reviewed through it, so it stays.
 */
export async function open(): Promise<string | null> {
  return "C:/Users/tung/Desktop/agentide";
}
