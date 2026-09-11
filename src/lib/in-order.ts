/**
 * One queue per key, so calls that address the same thing happen in the order they were
 * asked for.
 *
 * Written for terminals. A pty session is addressed by an id the caller chooses and reuses,
 * and starting and killing one are separate `invoke` calls that are in flight independently.
 * React's StrictMode mounts an effect, tears it down and mounts it again, so one id saw
 * spawn, kill, spawn with nothing ordering them -- and the kill landed on the session the
 * second spawn had just registered. Windows reports that killed conpty child as exit code 1,
 * which is how every terminal in the app came up dead.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `work` after everything already queued for `key`.
 *
 * A rejection never breaks the chain: one failed call must not strand every later call for
 * the same key. The caller still sees its own rejection.
 */
export function inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const queued = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(
    key,
    queued.catch(() => undefined),
  );
  return queued;
}

/** Forget a key's queue. For tests; the map is otherwise bounded by live terminal ids. */
export function forgetOrder(key: string): void {
  queues.delete(key);
}
