import { afterEach, describe, expect, it, vi } from "vitest";

import { linkSignals, ownSignal, semaphore, withOwnSignal } from "@/lib/exec/agent/signal";

// P5b contract §3.14 (C15, C16, C55): the loop's signals (no AbortSignal.any) and its concurrency limit.

afterEach(() => {
  vi.useRealTimers();
});

describe("linkSignals / ownSignal", () => {
  it("aborts with the parent (its reason) and tells a parent abort from its own deadline", () => {
    const parent = new AbortController();
    const linked = linkSignals(parent.signal, 1_000);
    parent.abort("stop");
    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe("stop");
    expect(linked.timedOut()).toBe(false);
    linked.dispose();
  });

  it("its own deadline fires with a TimeoutError; dispose clears it", () => {
    vi.useFakeTimers();
    const linked = linkSignals(new AbortController().signal, 50);
    vi.advanceTimersByTime(50);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(true);
    expect((linked.signal.reason as Error).name).toBe("TimeoutError");
    const quiet = linkSignals(undefined, 50);
    quiet.dispose();
    vi.advanceTimersByTime(100);
    expect(quiet.signal.aborted).toBe(false);
  });

  it("an already aborted parent aborts at once; ownSignal never follows anything else", async () => {
    const parent = new AbortController();
    parent.abort();
    expect(linkSignals(parent.signal, null).signal.aborted).toBe(true);
    const own = ownSignal(10_000);
    expect(own.signal.aborted).toBe(false);
    own.dispose();
    await expect(withOwnSignal(10_000, async (s) => s.aborted)).resolves.toBe(false);
  });
});

describe("semaphore", () => {
  it("never runs more than the limit at once, even when callers arrive as slots free up", async () => {
    const sem = semaphore(2);
    let active = 0;
    let peak = 0;
    const job = (ms: number) =>
      sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, ms));
        active -= 1;
        return ms;
      });
    const first = Array.from({ length: 5 }, (_, i) => job(5 + i));
    await Promise.resolve();
    const late = [job(1), job(1)];
    expect(await Promise.all([...first, ...late])).toEqual([5, 6, 7, 8, 9, 1, 1]);
    expect(peak).toBe(2);
    expect(sem.active).toBe(0);
  });

  it("a rejected run frees its slot", async () => {
    const sem = semaphore(1);
    await expect(sem.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(sem.run(async () => 7)).resolves.toBe(7);
  });
});
