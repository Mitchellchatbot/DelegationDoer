import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import * as analysisApprovals from "@/lib/exec/analysis/approvals";
import * as projectDetail from "@/lib/exec/analysis/project-detail";
import { MIN_NAMED_CLIENT_TASKS, mergeTaskReads } from "@/lib/exec/analysis/project-detail";
import * as analysisTasks from "@/lib/exec/analysis/tasks";
import { STAGE_CLOSE_GUARD_ACTIONS } from "@/lib/exec/analysis/tasks";
import * as analysisTeam from "@/lib/exec/analysis/team";
import { MIN_RATE_SAMPLE } from "@/lib/exec/analysis/team";
import * as attention from "@/lib/exec/attention";
import { ATTENTION_ITEM_ID } from "@/lib/exec/attention";
import * as attentionFeedback from "@/lib/exec/attention-feedback";
import * as attentionRead from "@/lib/exec/attention-read";
import * as ddtextStore from "@/lib/exec/ddtext-store";
import {
  DDTEXT_AI_KINDS,
  DDTEXT_ATTENTION_KINDS,
  DDTEXT_LIVE_DAYS,
  DDTEXT_NOTE_LIVE_DAYS,
  DDTEXT_VERSION
} from "@/lib/exec/ddtext-types";
import * as draftsStore from "@/lib/exec/drafts-store";
import { DDTEXT_JOB_KIND, ddtextJobHandler, ddtextScheduledWork } from "@/lib/exec/handlers/ddtext-triage";
import * as http from "@/lib/exec/http";
import { RATE_BUCKETS } from "@/lib/exec/http";
import * as intakeScreen from "@/lib/exec/intake-screen";
import { EXEC_MODELS, FEATURE_EFFORT, FEATURE_MAX_TOKENS, HAIKU_MODEL } from "@/lib/exec/llm/models";
import * as principalModule from "@/lib/exec/principal";
import { DEFAULT_SETTINGS, SETTINGS_COLUMN_GROUPS, settingsFromRow } from "@/lib/exec/principal";
import * as producersDd from "@/lib/exec/producers/dd";
import * as producersDdtext from "@/lib/exec/producers/ddtext";
import * as projectsView from "@/lib/exec/projects-view";
import * as settings from "@/lib/exec/settings";
import * as settingsFields from "@/lib/exec/settings-fields";
import { SETTINGS_FIELDS } from "@/lib/exec/settings-fields";
import * as sourcesDd from "@/lib/exec/sources/dd";
import * as sourcesDdText from "@/lib/exec/sources/dd-text";
import type { DdTask } from "@/lib/exec/sources/dd-types";
import * as team from "@/lib/exec/team";
import * as untrusted from "@/lib/exec/text/untrusted";
import { CLIP_MARKER, DD_TEXT_ITEM_CHARS, DD_TEXT_RESULT_CHARS } from "@/lib/exec/text/untrusted";
import { normalizeWhitespace, sanitizeText } from "@/lib/exec/triage/email-text";

// P5a stage -1 (lead): the seeded types, defaults and constants hold the values
// the contract freezes (§3.1, §3.7.1, §3.7.2, §3.12), and every frozen export
// of §3.2-§3.12 / §3.14 exists in its final file. Nothing here asserts that a
// function is a stub, so no area edits this file when it implements its
// exports; an area that renames a frozen export reports it (contract §3).

const EXEC_DIR = fileURLToPath(new URL("./", import.meta.url));

function task(id: string, status: DdTask["status"] = "pending"): DdTask {
  return {
    id,
    title: id,
    status,
    priority: "medium",
    tags: [],
    departmentId: null,
    assigneeId: null,
    creatorId: "u_1",
    projectId: null,
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: "2026-11-01T00:00:00Z",
    completedAt: null,
    lastActivityAt: "2026-11-01T00:00:00Z",
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 2
  };
}

describe("P5a seed: settings (§3.1.2, §3.7.1)", () => {
  it("DEFAULT_SETTINGS gains the three P5a fields: triage off, 90-day retention, schema not ready", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ ddtextEnabled: false, retentionDaysDdtext: 90, ddtextSchemaReady: false });
  });

  it("settingsFromRow: no row, or a row without the P5a columns, leaves ddtext off and not installed", () => {
    expect(settingsFromRow(null, "ep_1")).toMatchObject({ ddtextEnabled: false, retentionDaysDdtext: 90, ddtextSchemaReady: false });
    const p4Row = { principal_id: "ep_1", email_enabled: true, drafts_enabled: true, send_enabled: false, voice_enabled: true };
    expect(settingsFromRow(p4Row as never, "ep_1", { emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: false })).toMatchObject({ ddtextEnabled: false, retentionDaysDdtext: 90, ddtextSchemaReady: false });
  });

  it("settingsFromRow: ddtextEnabled only when the schema is ready and the column is exactly true (NULL is off)", () => {
    const row = (v: unknown, days: unknown) => ({ principal_id: "ep_1", ddtext_enabled: v, retention_days_ddtext: days }) as never;
    expect(settingsFromRow(row(true, 30), "ep_1", { ddtextSchemaReady: true })).toMatchObject({ ddtextEnabled: true, retentionDaysDdtext: 30, ddtextSchemaReady: true });
    expect(settingsFromRow(row(null, null), "ep_1", { ddtextSchemaReady: true })).toMatchObject({ ddtextEnabled: false, retentionDaysDdtext: 90, ddtextSchemaReady: true });
    expect(settingsFromRow(row(true, 30), "ep_1", { ddtextSchemaReady: false })).toMatchObject({ ddtextEnabled: false, ddtextSchemaReady: false });
    expect(settingsFromRow(null, "ep_1", { ddtextSchemaReady: true })).toMatchObject({ ddtextEnabled: false, ddtextSchemaReady: true });
  });

  it("SETTINGS_COLUMN_GROUPS lists the optional groups in migration order", () => {
    expect(SETTINGS_COLUMN_GROUPS.map((g) => ({ key: g.key, columns: [...g.columns] }))).toEqual([
      { key: "email", columns: ["email_enabled"] },
      { key: "drafts", columns: ["drafts_enabled", "send_enabled", "voice_enabled"] },
      { key: "ddtext", columns: ["ddtext_enabled", "retention_days_ddtext"] },
      // P5b (bindings AM4): appended.
      { key: "chat", columns: ["chat_enabled", "ask_ai_uses_exec", "chat_daily_cap_usd"] }
    ]);
  });

  it("SETTINGS_FIELDS holds the six editable fields with the C14 bounds (and P5b's three, appended)", () => {
    expect(SETTINGS_FIELDS.map(({ key, column, group, kind, min, max }) => ({ key, column, group, kind, min, max }))).toEqual([
      { key: "ddtextEnabled", column: "ddtext_enabled", group: "ddtext", kind: "boolean", min: undefined, max: undefined },
      { key: "retentionDaysEmail", column: "retention_days_email", group: "base", kind: "int", min: 7, max: 730 },
      { key: "retentionDaysDdtext", column: "retention_days_ddtext", group: "ddtext", kind: "int", min: 7, max: 730 },
      { key: "retentionDaysChat", column: "retention_days_chat", group: "base", kind: "int", min: 7, max: 730 },
      { key: "dailyCostCapUsd", column: "daily_cost_cap_usd", group: "base", kind: "money", min: 1, max: 100 },
      { key: "voiceEnabled", column: "voice_enabled", group: "drafts", kind: "boolean", min: undefined, max: undefined },
      { key: "chatEnabled", column: "chat_enabled", group: "chat", kind: "boolean", min: undefined, max: undefined },
      { key: "askAiUsesExec", column: "ask_ai_uses_exec", group: "chat", kind: "boolean", min: undefined, max: undefined },
      { key: "chatDailyCapUsd", column: "chat_daily_cap_usd", group: "chat", kind: "money", min: 0, max: 100 }
    ]);
  });
});

describe("P5a seed: constants (§3.1.4, §3.3.1, §3.9, §3.11.1, §3.12)", () => {
  it("the ddtext LLM feature is Haiku, effort low, 4000 output tokens", () => {
    expect([EXEC_MODELS.ddtext, FEATURE_EFFORT.ddtext, FEATURE_MAX_TOKENS.ddtext]).toEqual([HAIKU_MODEL, "low", 4000]);
  });

  it("ddtext-types constants", () => {
    expect(DDTEXT_VERSION).toBe("ddtext-v1");
    expect([...DDTEXT_ATTENTION_KINDS]).toEqual(["ddtext_blocker", "ddtext_waiting", "ddtext_decision", "ddtext_mention"]);
    expect([...DDTEXT_AI_KINDS]).toEqual(["ddtext_blocker", "ddtext_waiting", "ddtext_decision"]);
    expect([DDTEXT_LIVE_DAYS, DDTEXT_NOTE_LIVE_DAYS]).toEqual([14, 3]);
  });

  it("ATTENTION_ITEM_ID is the P2b id shape", () => {
    expect(ATTENTION_ITEM_ID.test(`ea_${"0123456789abcdef".repeat(2)}`)).toBe(true);
    for (const bad of [`ea_${"0".repeat(31)}`, `ea_${"0".repeat(33)}`, `ea_${"A".repeat(32)}`, `eb_${"0".repeat(32)}`, ` ea_${"0".repeat(32)}`]) {
      expect(ATTENTION_ITEM_ID.test(bad)).toBe(false);
    }
  });

  it("analysis and text constants", () => {
    expect(STAGE_CLOSE_GUARD_ACTIONS).toEqual(["proof_approved"]);
    expect(MIN_RATE_SAMPLE).toBe(5);
    expect(MIN_NAMED_CLIENT_TASKS).toBe(3);
    expect([DD_TEXT_ITEM_CHARS, DD_TEXT_RESULT_CHARS, CLIP_MARKER]).toEqual([1500, 12000, " …[clipped]"]);
    expect(untrusted.sanitizeText).toBe(sanitizeText);
    expect(untrusted.normalizeWhitespace).toBe(normalizeWhitespace);
  });

  it("the ddtext job: its own kind, bulk lane, 240 s, every 10 minutes, 3 attempts, ungated", () => {
    expect(DDTEXT_JOB_KIND).toBe("exec.ddtext-triage");
    expect([ddtextJobHandler.kind, ddtextJobHandler.lane, ddtextJobHandler.timeoutMs]).toEqual([DDTEXT_JOB_KIND, "bulk", 240_000]);
    expect(ddtextScheduledWork).toMatchObject({ kind: DDTEXT_JOB_KIND, lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    expect(ddtextScheduledWork.enabled).toBeUndefined();
  });

  it("RATE_BUCKETS registers the four P5a buckets, P5b's two and P6's two (and loading http.ts runs no stub)", () => {
    expect(Object.keys(RATE_BUCKETS).sort()).toEqual([
      "assess", "attention_action", "attention_feedback", "chat", "proposal", "settings_update", "slack_connect", "slack_disconnect"
    ]);
    for (const def of Object.values(RATE_BUCKETS)) expect(typeof def.nthNewestAt).toBe("function");
  });

  it("mergeTaskReads is P2b's mergeTasks: open first, a completion that is also open is kept once (the open copy)", () => {
    const open = [task("t_1"), task("t_2", "in_progress")];
    const done = [task("t_2", "done"), task("t_3", "done")];
    const merged = mergeTaskReads(open, done);
    expect(merged.map((t) => [t.id, t.status])).toEqual([
      ["t_1", "pending"],
      ["t_2", "in_progress"],
      ["t_3", "done"]
    ]);
  });
});

describe("P5a seed: every frozen cross-area export exists in its final file (§3.2-§3.12, §3.14)", () => {
  const FROZEN: readonly [string, Record<string, unknown>, readonly string[]][] = [
    ["http.ts", http, ["isSameOriginRequest", "readJsonBody", "jsonError", "jsonAnswer", "assertSameOrigin", "readJsonBodyOrError", "auditNthNewestAt", "rateLimit", "runAudited"]],
    ["attention.ts", attention, ["listAttention", "lastAttentionRefresh", "listAttentionPage", "feedOrFilter", "listAttentionStatusByFingerprints", "getAttentionItemRow", "applyOwnerAction"]],
    ["attention-read.ts", attentionRead, ["listScreenedAttention", "getScreenedAttentionItem", "screenAttentionItems", "parseAttentionFilters", "encodeAttentionCursor", "decodeAttentionCursor"]],
    ["attention-feedback.ts", attentionFeedback, ["recordAttentionFeedback", "feedbackTotals", "purgeOldFeedback"]],
    ["principal.ts", principalModule, ["loadSettings", "loadSettingsSnapshot", "settingsFromRow"]],
    ["settings-fields.ts", settingsFields, ["validateSettingsField"]],
    ["settings.ts", settings, ["updateSettings", "getSettingsView", "listRecentAccess", "spendTodayByFeature"]],
    ["drafts-store.ts", draftsStore, ["getVoiceProfile", "upsertVoiceProfile", "resetVoiceProfile"]],
    [
      "sources/dd.ts",
      sourcesDd,
      [
        "listUserSchedules",
        "listTaskHours",
        "listEodNotesBetween",
        "listTaskExtensionsForTasks",
        "listProjectTasksAllStates",
        "listStatusTransitions",
        "listUpdateRepliesByUser",
        "listTaskThreadLinks",
        "listPendingApprovalItems"
      ]
    ],
    ["intake-screen.ts", intakeScreen, ["loadIntakeScreeningPolicy", "restrictedIntakeTaskIds", "listScreenedApprovalItems"]],
    ["analysis/approvals.ts", analysisApprovals, ["approverLabel"]],
    ["analysis/tasks.ts", analysisTasks, ["isStalledWork", "isOverdueWork", "closedWithStage"]],
    [
      "analysis/team.ts",
      analysisTeam,
      [
        "rateOf",
        "medianOf",
        "isRitualExpected",
        "expectedEodDays",
        "eodValue",
        "onTimeValue",
        "cycleValue",
        "extensionValue",
        "teamWindowRange",
        "weekWindows",
        "clockedMsByUser",
        "capacityValue",
        "buildTeamView"
      ]
    ],
    ["analysis/project-detail.ts", projectDetail, ["stuckBatchSignals", "deriveProjectClient", "projectUpdateEvents", "derivedBlockers", "mergeTaskReads"]],
    ["team.ts", team, ["getTeamView", "getWorkingNow"]],
    ["projects-view.ts", projectsView, ["getProjectsListView", "getProjectDetail"]],
    ["text/untrusted.ts", untrusted, ["clipForModel", "newNonce", "neutralizeDdText", "renderUntrustedBlock", "untrustedEntrySize", "untrustedBlockOverhead"]],
    [
      "sources/dd-text.ts",
      sourcesDdText,
      [
        "listActivityTextSince",
        "listActivityTextByIds",
        "listEarlierCommentText",
        "submittedTextIsCurrent",
        "listSubmittedNoteBlockersSince",
        "listNoteBlockersByIds",
        "listMeetingBriefRisks"
      ]
    ],
    [
      "ddtext-store.ts",
      ddtextStore,
      [
        "writeDdtextItem",
        "listDdtextItemsByKeys",
        "listDeferredDdtextItems",
        "listLiveDdtextSignals",
        "purgeExpiredDdtext",
        "purgeOrphanDdtextAttention",
        "deleteDdtextItems",
        "deleteDdtextItemsForTasks",
        "deleteAllDdtextData",
        "ddtextLastRunAt",
        "parseDdtextCursor"
      ]
    ],
    ["producers/ddtext.ts", producersDdtext, ["isLiveDdtextSignal", "buildDdtextCandidates"]],
    ["producers/dd.ts", producersDd, ["ddFingerprintKey", "ddMentionFingerprint"]]
  ];

  for (const [file, mod, names] of FROZEN) {
    it(`${file} exports ${names.length} frozen functions`, () => {
      for (const name of names) expect(typeof mod[name], `${file} ${name}`).toBe("function");
    });
  }
});

describe("P5a seed: the client-safe type modules (rule 16's assertions)", () => {
  const read = (rel: string) => readFileSync(`${EXEC_DIR}${rel}`, "utf8");

  it("settings-fields.ts and ddtext-types.ts import nothing at all", () => {
    for (const rel of ["settings-fields.ts", "ddtext-types.ts"]) {
      expect(read(rel), rel).not.toMatch(/^\s*import\s/m);
    }
  });

  it("view-types.ts only takes types (every import is `import type`, erased at runtime)", () => {
    const imports = read("view-types.ts").split(/\r?\n/).filter((l) => /^\s*import\s/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type \{[^}]+\} from "@\/lib\/exec\/[a-z/-]+";$/);
  });
});
