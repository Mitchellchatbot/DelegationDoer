// The stand-ins in ddtext-mocks.ts (Area D's suites mock Area C's producers/dd and
// analysis/tasks with them) must behave exactly like the real exports, or the
// ddtext handler tests would pass against a fingerprint or open-task rule the
// shipped code doesn't use. This pins them to the real modules.

import { describe, expect, it } from "vitest";

import { isOpen } from "@/lib/exec/analysis/tasks";
import { ddFingerprintKey, ddMentionFingerprint } from "@/lib/exec/producers/dd";

import { analysisTasks, ddTask, producersDd } from "./ddtext-mocks";

const KEYS = [
  "abc",
  "task_1.2-3",
  "ABC Corp",
  "Acme, Inc. / Website",
  "",
  "--",
  "x/y?z=1",
  "café déjà vu",
  "a".repeat(100),
  "a".repeat(101),
  "9f1c2d3e-0000-4000-8000-000000000001",
  "\u00e9\u0301\u200b"
];

describe("ddtext-mocks parity with Area C's real exports", () => {
  it("ddFingerprintKey and ddMentionFingerprint equal producers/dd's", () => {
    for (const k of KEYS) {
      expect(producersDd.ddFingerprintKey(k)).toBe(ddFingerprintKey(k));
      expect(producersDd.ddMentionFingerprint(k)).toBe(ddMentionFingerprint(k));
    }
  });

  it("isOpen equals analysis/tasks' for every status, draft, deleted and archive combination", () => {
    const statuses = ["pending", "in_progress", "waiting_on_client", "pending_approval", "done", "rejected"] as const;
    let n = 0;
    for (const status of statuses) {
      for (const isDraft of [false, true]) {
        for (const deletedAt of [null, "2026-11-01T00:00:00.000Z"]) {
          for (const [archivedAt, archivedBy] of [
            [null, null],
            ["2026-11-01T00:00:00.000Z", null],
            ["2026-11-01T00:00:00.000Z", "u_admin"]
          ] as const) {
            const t = ddTask({ id: `t${n++}`, status, isDraft, deletedAt, archivedAt, archivedBy } as Parameters<typeof ddTask>[0]);
            expect(analysisTasks.isOpen(t)).toBe(isOpen(t));
          }
        }
      }
    }
    expect(n).toBe(72);
  });
});
