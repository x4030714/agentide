/**
 * Design-review harness (kept, not scrap). Stands in for @tauri-apps/api/event.
 * See .review-tmp/mock-core.ts for what this harness is and why it stays.
 */
export async function listen(): Promise<() => void> {
  return () => {};
}
