import "server-only";

// Signals for the chat loop (P5b contract §3.14, C15, C16, C55; Area C;
// server-only). AbortSignal.any is never used (P3 §0: Railway's Node version
// isn't pinned), so a linked signal is built by hand.
//
//   linkSignals  the turn's signal: aborts when the request's (or the job's)
//                signal aborts, or when its own deadline fires. timedOut()
//                tells the two apart.
//   ownSignal    a FRESH controller with a timeout, never linked to the
//                request: the begin RPC, the finish write, the post-finish
//                screen and the live budget read each get one (B5, C21, C55),
//                so a Stop or a disconnect can't turn into a lost write.
//   semaphore    at most n concurrent runs (tools 4 at a time, clone calls 4
//                per turn: C16).

export interface LinkedSignal {
  signal: AbortSignal;
  /** True when this signal's own deadline fired (not the parent). */
  timedOut(): boolean;
  /** Clears the timer and the parent listener. Idempotent. */
  dispose(): void;
}

function timeoutReason(): Error {
  const err = new Error("deadline reached");
  err.name = "TimeoutError";
  return err;
}

/** A signal that aborts with `parent` or after `timeoutMs` (null: no deadline). */
export function linkSignals(parent: AbortSignal | undefined, timeoutMs: number | null): LinkedSignal {
  const controller = new AbortController();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  if (timeoutMs !== null && Number.isFinite(timeoutMs) && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timer = null;
      if (controller.signal.aborted) return;
      fired = true;
      controller.abort(timeoutReason());
    }, Math.max(0, timeoutMs));
  }
  let disposed = false;
  return {
    signal: controller.signal,
    timedOut: () => fired,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      parent?.removeEventListener("abort", onParentAbort);
    }
  };
}

/** A fresh controller that aborts only after `timeoutMs`: never the request's signal. */
export function ownSignal(timeoutMs: number): LinkedSignal {
  return linkSignals(undefined, timeoutMs);
}

/** Runs fn on its own signal (timeoutMs) and disposes the timer afterwards. */
export async function withOwnSignal<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const own = ownSignal(timeoutMs);
  try {
    return await fn(own.signal);
  } finally {
    own.dispose();
  }
}

export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs in flight right now (tests). */
  readonly active: number;
}

/** At most `limit` concurrent runs; the rest wait in order. */
export function semaphore(limit: number): Semaphore {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: (() => void)[] = [];
  // A released slot passes straight to the next waiter (active stays), so a
  // caller arriving between the release and the waiter's wake-up can't take
  // it and overshoot the limit.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    get active() {
      return active;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      else active += 1;
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}
