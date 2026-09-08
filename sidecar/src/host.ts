/** The link back to the Rust host: outbound framing plus the request/reply correlation
 * behind `permissions.ts` and `ide-tools.ts`. The sidecar answers none of its own questions. */

import { encodeLine, type SidecarMessage } from "./protocol.ts";

/** How long an IDE tool waits for the host. Long enough to cross a busy UI thread, short
 * enough that the model gets a usable error instead of a stalled turn. */
export const TOOL_TIMEOUT_MS = 30_000;

/** A backstop against a host that never answers, not a UI deadline -- the host applies its
 * own, shorter one. */
export const PERMISSION_TIMEOUT_MS = 15 * 60_000;

interface Pending {
  label: string;
  sessionId: string;
  settle: (value: unknown) => void;
  fail: (error: Error) => void;
  dispose: () => void;
}

export class HostLink {
  readonly #pending = new Map<string, Pending>();
  readonly #writeLine: (line: string) => void;
  #counter = 0;

  constructor(writeLine: (line: string) => void) {
    this.#writeLine = writeLine;
  }

  /** Fire and forget. Ordering is the write order; there is no reply. */
  send(message: SidecarMessage): void {
    this.#writeLine(encodeLine(message));
  }

/** Send `build(id)` and resolve when the host replies with that id. Unregisters on timeout
 * or abort, so a late reply is dropped rather than resolving a dead request. */
  request<T>(options: {
    prefix: string;
    label: string;
    sessionId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    build: (id: string) => SidecarMessage;
  }): Promise<T> {
    const id = `${options.prefix}-${++this.#counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${options.label} timed out after ${options.timeoutMs}ms with no reply from the IDE`));
      }, options.timeoutMs);
      // A pending request must not be the reason the process stays alive.
      timer.unref();

      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`${options.label} was aborted`));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        label: options.label,
        sessionId: options.sessionId,
        settle: (value) => resolve(value as T),
        fail: reject,
        dispose: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      });

      this.send(options.build(id));
    });
  }

/** Deliver a reply. False means the id is unknown: a duplicate, or one that lost a race
 * with a timeout. Not an error. */
  settle(id: string, value: unknown): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    pending.dispose();
    pending.settle(value);
    return true;
  }

  /** Fail every request belonging to `sessionId`, e.g. when its turn is interrupted. */
  failSession(sessionId: string, reason: string): void {
    for (const [id, pending] of [...this.#pending]) {
      if (pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.dispose();
      pending.fail(new Error(`${pending.label}: ${reason}`));
    }
  }

  /** Fail everything outstanding. Used on shutdown so no handler is left awaiting. */
  failAll(reason: string): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.dispose();
      pending.fail(new Error(`${pending.label}: ${reason}`));
    }
  }
}
