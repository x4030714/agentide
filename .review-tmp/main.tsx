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
import ReactDOM from "react-dom/client";
import App from "../src/App";

const ROOT = "C:/Users/tung/Desktop/agentide";
localStorage.setItem("agentide.lastWorkspace", ROOT);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

/** Drive the real components into a content-full state for the capture. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rows are addressed by their full path (the `title`), never by name -- names repeat. */
function rowByPath(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.tree-row[title="${path}"]`);
}

async function click(path: string) {
  for (let i = 0; i < 60; i += 1) {
    const row = rowByPath(path);
    if (row) {
      row.click();
      await sleep(60);
      return;
    }
    await sleep(50);
  }
  console.warn(`[review] row never appeared: ${path}`);
}

async function drive() {
  await sleep(300);
  await click(`${ROOT}/src`);
  await click(`${ROOT}/src/lib`);
  await click(`${ROOT}/src-tauri`);
  await click(`${ROOT}/src-tauri/src`);
  await click(`${ROOT}/src-tauri/src/fs.rs`);
  await sleep(2200);

  /**
   * `?motion=1` freezes the open animation mid-flight.
   *
   * `.gutter-sync` ends at `opacity: 0`, so a screenshot at rest cannot tell a working
   * animation from one that never fired. Rather than trying to time a capture against a
   * 440ms curve, open a second file and pin the running animation to a fixed offset --
   * the frame is then deterministic and reproducible.
   */
  if (new URLSearchParams(location.search).get("motion") === "1") {
    await click(`${ROOT}/src-tauri/src/ipc.rs`);
    await sleep(30);
    const rule = document.querySelector(".gutter-sync");
    const running = rule?.getAnimations() ?? [];
    for (const animation of running) {
      animation.pause();
      animation.currentTime = 200; // mid-draw: past the 55% peak, before the fade-out.
    }
    // Recorded in the DOM so `--dump-dom` can confirm the freeze actually took, rather
    // than leaving a missing 1px rule ambiguous between "did not fire" and "not caught".
    const box = rule?.getBoundingClientRect();
    document.body.dataset.reviewMotion = JSON.stringify({
      found: Boolean(rule),
      animations: running.length,
      playState: running[0]?.playState ?? null,
      currentTime: running[0]?.currentTime ?? null,
      opacity: rule ? getComputedStyle(rule).opacity : null,
      rect: box ? [Math.round(box.x), Math.round(box.y), box.width, Math.round(box.height)] : null,
    });
  } else {
    rowByPath(`${ROOT}/src-tauri/src/ipc.rs`)?.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true }),
    );
  }

  document.body.setAttribute("data-review-ready", "1");
  console.log("[review] ready");
}

void drive();
