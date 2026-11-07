import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => true) }));

import { reportBindingTransformations } from "@/lib/exec/llm/binding-alert";
import { notifyOps } from "@/lib/exec/ops";

// P5b contract §3.14 (coherence-15): test 126. The loop's one ops alert lives outside the chat files and carries ids and
// counts only.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportBindingTransformations (test 126)", () => {
  it("logs once and alerts with key exec-chat-binding and a detail of ids and counts only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const turnId = "ect_0123456789abcdef0123456789abcdef";
    await reportBindingTransformations(turnId, 3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[exec-llm] binding transformations turn=${turnId} count=3`);
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledWith({ key: "exec-chat-binding", title: "Chat dropped thinking blocks", detail: `turn ${turnId}: 3` });
    const [alert] = vi.mocked(notifyOps).mock.calls[0];
    expect(alert.detail).toMatch(/^turn [A-Za-z0-9_-]+: \d+$/);
  });

  it("a turn id that isn't id-shaped is never echoed; zero transformations alert nothing; a failing notifyOps doesn't throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reportBindingTransformations("what about <Acme>?", 2);
    expect(vi.mocked(notifyOps).mock.calls[0][0].detail).toBe("turn unknown: 2");
    vi.mocked(notifyOps).mockClear();
    await reportBindingTransformations("ect_x", 0);
    expect(notifyOps).not.toHaveBeenCalled();
    vi.mocked(notifyOps).mockRejectedValueOnce(new Error("slack down"));
    await expect(reportBindingTransformations("ect_x", 1)).resolves.toBeUndefined();
  });

  it("run.ts reports through it and never calls notifyOps (static)", () => {
    const run = readFileSync(join(process.cwd(), "src/lib/exec/agent/run.ts"), "utf8");
    expect(run).toContain('from "@/lib/exec/llm/binding-alert"');
    expect(run).toMatch(/reportBindingTransformations\(input\.turnId, usage\.transformations\)/);
    expect(run).not.toMatch(/notifyOps\s*\(/);
    expect(run).not.toContain("@/lib/exec/ops");
  });
});
