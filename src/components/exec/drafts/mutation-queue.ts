// One queue for DraftPanel's writes (P4 contract §3.13.3, C74). Pure: the
// browser calls are injected, so the queue is unit-tested in node.
//
// - edit(body) records the latest editor state and schedules one PATCH after
//   a quiet period (1.5 s); a newer edit replaces an older pending one.
// - run(action) first flushes the pending edit (sends that PATCH now and
//   awaits it), then performs the action with the version the PATCH returned,
//   so a click right after typing never races the autosave.
// - Everything goes through one chain: two quick actions run in order, never
//   at the same time.
// - A 409 (version_conflict / state_conflict) calls get(), which the panel
//   uses to re-apply the server's view, and reports "conflict"; the action is
//   not retried on its own.

import type { DraftUiAction } from "./actions";

export interface DraftMutationDeps {
  patch: (body: unknown, version: number) => Promise<{ ok: true; version: number } | { ok: false; status: number }>;
  act: (action: DraftUiAction, version: number) => Promise<{ ok: boolean; status: number }>;
  get: () => Promise<void>;
  /** The version the panel currently shows (the server's latest view). Versions only grow, so the newer of this and the last PATCH's wins. */
  version?: () => number;
  /** The autosave quiet period (default 1 500 ms). */
  debounceMs?: number;
  /** Injected timers (tests); defaults to the globals. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Called when a PATCH or an action answered 409 while a local edit was pending (the "changed elsewhere" notice). */
  onConflict?: (pendingEdit: boolean) => void;
}

export type DraftMutationOutcome = "done" | "conflict" | "failed";

export interface DraftMutationQueue {
  edit(body: unknown): void;
  run(action: DraftUiAction): Promise<DraftMutationOutcome>;
  /** Sends a pending edit now (no action); resolves once it is answered. */
  flush(): Promise<void>;
  /** Whether an edit is waiting to be sent or in flight. */
  pending(): boolean;
  /**
   * Whether an edit is waiting to be sent (not yet handed to a PATCH): typing
   * the server's answer to a running action must not overwrite (ui-1).
   */
  unsent(): boolean;
  /** Forgets a pending edit without sending it (after a conflict, or on unmount). */
  discardEdit(): void;
  /** The newest version the queue knows. */
  version(): number;
  /**
   * Runs `work` in the same chain, after the pending edit is flushed, with the
   * version that edit returned (the send and the Open-in-Outlook stamp, which
   * aren't panel actions of their own). Resolves null when the flush hit a 409.
   */
  perform<T>(work: (version: number) => Promise<T>): Promise<T | null>;
  /** Records a version the panel learned from an answer (a view it applied). */
  observe(version: number): void;
}

const DEFAULT_DEBOUNCE_MS = 1_500;

export function createDraftMutationQueue(deps: DraftMutationDeps): DraftMutationQueue {
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let known = 0;
  let pendingBody: unknown = undefined;
  let hasPending = false;
  let timer: unknown = null;
  let inFlight = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const version = () => Math.max(known, deps.version?.() ?? 0);
  const cancelTimer = () => {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  };

  /** Sends the pending edit (if any) and awaits it. Returns false on a 409 (the view was re-read), true otherwise. */
  async function sendPending(): Promise<boolean> {
    cancelTimer();
    if (!hasPending) return true;
    const body = pendingBody;
    hasPending = false;
    pendingBody = undefined;
    inFlight += 1;
    try {
      const r = await deps.patch(body, version());
      if (r.ok) {
        known = Math.max(known, r.version);
        return true;
      }
      if (r.status === 409) {
        deps.onConflict?.(true);
        await deps.get();
        return false;
      }
      // Any other failure: the edit is kept for the next quiet period, so typing isn't lost.
      if (!hasPending) {
        hasPending = true;
        pendingBody = body;
      }
      return true;
    } catch {
      if (!hasPending) {
        hasPending = true;
        pendingBody = body;
      }
      return true;
    } finally {
      inFlight -= 1;
    }
  }

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  return {
    edit(body) {
      pendingBody = body;
      hasPending = true;
      cancelTimer();
      timer = setT(() => {
        timer = null;
        void enqueue(() => sendPending());
      }, debounceMs);
    },
    run(action) {
      return enqueue(async (): Promise<DraftMutationOutcome> => {
        const flushed = await sendPending();
        if (!flushed) return "conflict";
        try {
          const r = await deps.act(action, version());
          if (r.ok) return "done";
          if (r.status === 409) {
            deps.onConflict?.(false);
            await deps.get();
            return "conflict";
          }
          return "failed";
        } catch {
          return "failed";
        }
      });
    },
    flush() {
      return enqueue(async () => {
        await sendPending();
      });
    },
    pending: () => hasPending || inFlight > 0,
    unsent: () => hasPending,
    discardEdit() {
      cancelTimer();
      hasPending = false;
      pendingBody = undefined;
    },
    version,
    perform<T>(work: (version: number) => Promise<T>): Promise<T | null> {
      return enqueue(async (): Promise<T | null> => {
        const flushed = await sendPending();
        if (!flushed) return null;
        return work(version());
      });
    },
    observe(v: number) {
      if (Number.isFinite(v)) known = Math.max(known, v);
    }
  };
}
