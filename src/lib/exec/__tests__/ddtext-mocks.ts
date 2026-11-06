// Test support for Area D's suites: stand-ins for the cross-area exports the DD
// text triage imports (contract §4: every cross-area import is mocked at the
// module boundary), with the behaviour the contract freezes for them.
//
//   producers/dd.ts (Area C): ddFingerprintKey = P2b's keyPart; ddMentionFingerprint.
//   analysis/tasks.ts (Area C): isOpen, P2b's open-task predicate.
//
// Use from a vi.mock factory: vi.mock("@/lib/exec/producers/dd", async () => (await import("./__tests__/ddtext-mocks")).producersDd).

import { createHash } from "node:crypto";

import type { DdTask } from "@/lib/exec/sources/dd-types";

const PLAIN_KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** P2b's keyPart (producers/dd.ts), verbatim. */
export function keyPart(key: string): string {
  if (PLAIN_KEY.test(key)) return key;
  const slug = key
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return slug ? `${slug}-${hash}` : hash;
}

export const producersDd = {
  ddFingerprintKey: (key: string) => keyPart(key),
  ddMentionFingerprint: (taskId: string) => `dd:mention:task:${keyPart(taskId)}`
};

/** P2b's isOpen (analysis/tasks.ts): not a draft, not deleted, not done or rejected, live or auto-archived. */
export function isOpen(t: Pick<DdTask, "isDraft" | "deletedAt" | "status" | "archivedAt" | "archivedBy">): boolean {
  return !t.isDraft && t.deletedAt == null && t.status !== "done" && t.status !== "rejected" && (t.archivedAt == null || t.archivedBy == null);
}

export const analysisTasks = { isOpen };

/** A DD task with every field, for fixtures. */
export function ddTask(over: Partial<DdTask> & { id: string }): DdTask {
  return {
    title: `Task ${over.id}`,
    status: "in_progress",
    priority: "medium",
    tags: [],
    departmentId: null,
    assigneeId: "u_worker",
    creatorId: "u_worker",
    projectId: null,
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    completedAt: null,
    lastActivityAt: "2026-11-01T12:00:00.000Z",
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 0,
    ...over
  } as DdTask;
}
