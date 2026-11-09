import "server-only";

import { resolveProject } from "@/lib/exec/agent/resolve";
import type { PrivateRefKind } from "@/lib/exec/agent/types";
import { loadPublicSlackRows, type PublicSlackRow } from "@/lib/exec/client-update-facts";
import { createClientUpdateDraft, type ChatDraftRefusal } from "@/lib/exec/drafts";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { DRAFT_LIMITS, type ExecDraftStatus } from "@/lib/exec/drafts-types";
import { getEmailThread } from "@/lib/exec/email-store";
import type { MatchConfidence } from "@/lib/exec/email-types";
import { getProjectsListView } from "@/lib/exec/projects-view";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { getDigestsByIds, listChannelsLinkedToClient, listItemKeysLinkedToClient, searchSlackStored } from "@/lib/exec/slack-intel-store";
import {
  SLACK_INTEL_LIMITS,
  slackDigestKey,
  slackItemPolicy,
  slackMessageKey,
  slackUsePolicy,
  storedSearchChannels,
  type SlackIntelState
} from "@/lib/exec/slack-intel-types";
import { getSlackItemsByIds, listIntelChannels } from "@/lib/exec/slack-reading";
import type { SlackSearchHit } from "@/lib/exec/slack-search";
import {
  countEodClientWorkForClient,
  getLastClientUpdate,
  listCompletedTasksForClient,
  listOpenTasksForClient,
  listProjects,
  listTasksForThread
} from "@/lib/exec/sources/dd";
import type { DdProject, DdTask } from "@/lib/exec/sources/dd-types";
import { loadScreeningPolicy, pinnedAccounts, screenStoredRow } from "@/lib/exec/sources/mail";
import { localDateString } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// The prepare_client_update service (P7b contract §3.8.1–§3.8.2, N17, C8, C9, C18, C31, C34; Area E; server-only).
// Imported only by agent/tools.ts (boundary rule B-P7b-6). The drafter instruction is his newest message verbatim
// (ownerInstructionFrom(ctx.question)); the tool has no instruction parameter. Never sends.
//
// The flow (§3.8.2), each read on ctx.signal; a read that throws throws (the tool maps it to is_error):
//   1. the thread: P5b's id shape, then P3's stored row and its screen (gone, restricted, a tombstone or not on his pinned
//      accounts → unavailable_thread, nothing else read); a thread never triaged (no row) goes on, and the draft step
//      screens it live;
//   2. the client: the row's verdict columns: high / exact / one candidate → facts; a match short of that → no facts
//      (cuMedium); no client → not_a_client_thread, no draft;
//   3. the private-refs flag the tool layer computed (P5b's C24 over this turn and replayed ones, plus private_slack);
//   4. the draft: createClientUpdateDraft with his words (a refusal ends here);
//   5. projects (≤ 3): the one he named (needs_choice when ambiguous, after the draft), the thread's tasks' projects,
//      the open projects whose derived client is this client;
//   6. work (facts client only): open tasks and tasks completed in the last 14 days, titles, statuses and dates only;
//   7. Slack (facts client and reading "ok" only, C31): exactly the public rows the pack will use, and a COUNT of the
//      client's items a draft may not use (C18): nothing of them is read into the result;
//   8. the team-work count; 9. the last update (timestamps).
// Additive (Area E): `notes` (the fixed §3.14 sentences the tool shows), `projectChoice` (step 5's needs_choice) and
// `consulted` (what the answer read: the thread, the client, the public Slack keys) so the tool layer forwards them.
// Nothing here logs: no Slack text, name, title or instruction leaves through a log line or an error.

export interface ClientUpdateInput { threadId: string; projectId: string /* '' = derive */ }
export interface ClientUpdateResult {
  draft: { id: string; status: ExecDraftStatus; link: string; existing: boolean; regenerated: boolean; existingReason: "busy" | "edited" | "saved" | null;
    privateRefKinds: PrivateRefKind[] } | null;
  refused: ChatDraftRefusal | "not_a_client_thread" | null;   // "one_per_message" is decided by the tool layer before this runs (C34)
  client: { id: string; name: string; confidence: MatchConfidence; eligibleForFacts: boolean } | null;
  projects: { id: string; name: string; basis: "record" | "named" | "derived" }[];
  work: { open: DdTask[]; completedRecently: DdTask[] } | null;
  slack: { state: SlackIntelState; publicForDraft: SlackSearchHit[]; privateCount: number };
  teamWorkCount: number | null;
  lastClientUpdate: { teamEmailSentAt: string | null; workReportedAt: string | null } | null;
  instructionClipped: boolean;
  /** Additive: the result's notes, in order (SLACK_INTEL_COPY's cu* sentences; cuNothingSent always last). */
  notes: string[];
  /** Additive: project_id matched several projects (or none: matches []): the tool answers P5b's needs_choice with these. */
  projectChoice: { matches: { id: string; name: string }[] } | null;
  /** Additive: what this call read, for the tool's consulted budgets (P5b C19 / C24, N15). Public Slack only. */
  consulted: { threadIds: string[]; clientIds: string[]; slack: { refKeys: string[]; channelId: string }[] };
}

const DAY_MS = 86_400_000;
const L = SLACK_INTEL_LIMITS;
const WORK_ROWS = 8;
/** C18's count reads at most this many of the newest stored items of the client's linked conversations. */
const PRIVATE_COUNT_READ = 50;
/** listItemKeysLinkedToClient's read for the count (message links high / medium, last 30 days). */
const LINKED_KEYS_READ = 500;
const NOTES = SLACK_INTEL_COPY;

/** P3's thread id rule (P5b's isThreadIdShape): 1-200 characters, no whitespace or control characters. */
function isThreadIdShape(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(v);
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));

/** C8: his stored question text, whitespace-trimmed, clipped to DRAFT_LIMITS.instructionChars (2 000) at a word boundary. */
export function ownerInstructionFrom(question: string): { text: string; clipped: boolean } {
  const raw = typeof question === "string" ? question.trim() : "";
  const max = DRAFT_LIMITS.instructionChars;
  if (raw.length <= max) return { text: raw, clipped: false };
  let cut = raw.slice(0, max);
  // A surrogate pair cut in half loses its first half too.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  if (!/\s/.test(raw.charAt(cut.length))) {
    // Mid-word: back up to the last whitespace, unless the message has none in its second half (one long token).
    const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"), cut.lastIndexOf("\r"));
    if (space >= Math.floor(max / 2)) cut = cut.slice(0, space);
  }
  return { text: cut.trimEnd(), clipped: true };
}

/** A task for the result: titles, statuses and dates (§3.8.2 step 6): people and internal labels blanked (P7-4). */
function workTask(t: DdTask): DdTask {
  return { ...t, tags: [], departmentId: null, assigneeId: null, creatorId: "", archivedBy: null, estimatedHours: 0 };
}

/** Open work first by due date (none last), then newest; finished work newest completion first. */
function openOrder(a: DdTask, b: DdTask): number {
  const da = a.dueDate === null ? null : a.dueDate.slice(0, 10);
  const db = b.dueDate === null ? null : b.dueDate.slice(0, 10);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}
const completedMs = (t: DdTask) => (t.completedAt === null ? 0 : Date.parse(t.completedAt) || 0);

/** One public row as the chat's hit: the cleaned summary is its text (the drafter's own fact text), privacy "public". */
function hitOf(r: PublicSlackRow, rebuilds: number | null): SlackSearchHit {
  return {
    src: r.src,
    channelId: r.channelId,
    ts: r.src === "item" ? r.ts : null,
    localDate: r.localDate,
    kind: r.kind,
    privacy: "public",
    at: r.at,
    channelLabel: r.channel.name ?? r.channelId,
    text: r.text,
    external: false,
    assessed: true,
    answered: null,
    permalink: null,
    itemId: r.src === "item" ? r.id : null,
    digestId: r.src === "digest" ? r.id : null,
    rebuilds
  };
}

/** The consulted key of a public hit (N15: m:<C>:<ts> or d:<C>:<date>:<rebuilds>). */
function refKeyOf(h: SlackSearchHit): string | null {
  if (h.src === "item" && h.ts !== null) return slackMessageKey(h.channelId, h.ts);
  if (h.src === "digest" && h.localDate !== null && h.rebuilds !== null) return slackDigestKey(h.channelId, h.localDate, h.rebuilds);
  return null;
}

/**
 * C18: how many of the client's Slack items (in conversations with a high channel link to it, or carrying a high / medium
 * message link, last 30 days) he could see in chat but a draft may not use: a conversation that isn't public, watched,
 * standard and never shared (finance by class or name included), an item whose source_class isn't 'public', or an
 * external author's. A count, at most the newest PRIVATE_COUNT_READ items; nothing of them reaches the result.
 */
async function privateSlackCount(principal: ExecPrincipal, clientId: string, now: Date, signal: AbortSignal): Promise<number> {
  const sinceIso = new Date(now.getTime() - L.publicSlackWindowDays * DAY_MS).toISOString();
  const [keys, links] = await Promise.all([
    listItemKeysLinkedToClient(principal, clientId, { sinceIso, limit: LINKED_KEYS_READ }, { signal }),
    listChannelsLinkedToClient(principal, clientId, ["high"], { signal })
  ]);
  const linkedKeys = new Set(keys.map((k) => `${k.channelId}:${k.ts}`));
  const highChannels = new Set(links.map((l) => l.channelId));
  const channelIds = [...new Set([...keys.map((k) => k.channelId), ...highChannels])];
  if (channelIds.length === 0) return 0;
  const channels = await listIntelChannels(principal, { channelIds, signal });
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const { full, bypass } = storedSearchChannels("ok", channels, "chat_web");
  if (full.length === 0 && bypass.length === 0) return 0;
  const hits = await searchSlackStored(principal, {
    query: "", channelIds: full, bypassChannelIds: bypass, kinds: null, sinceIso, includeDigests: false, limit: PRIVATE_COUNT_READ
  }, { signal });
  const ids = [...new Set(hits.filter((h) => h.src === "item").map((h) => h.id))];
  if (ids.length === 0) return 0;
  const items = await getSlackItemsByIds(principal, ids, { surface: "web", signal });
  let count = 0;
  for (const item of items) {
    const ch = byId.get(item.channelId) ?? null;
    const linked = highChannels.has(item.channelId) || linkedKeys.has(`${item.channelId}:${item.ts}`) ||
      (item.threadTs !== null && linkedKeys.has(`${item.channelId}:${item.threadTs}`));
    if (!linked || !slackItemPolicy("ok", ch, item, "chat_web").allowed) continue;
    const draftable = slackUsePolicy("ok", ch, "draft").allowed && item.sourceClass === "public" && !item.authorExternal;
    if (!draftable) count += 1;
  }
  return count;
}

/** Step 5: ≤ 3 projects: the named one, then the thread's tasks' projects (record), then the client's derived ones. */
async function projectsFor(principal: ExecPrincipal, input: ClientUpdateInput, threadId: string, clientId: string | null, now: Date, signal: AbortSignal):
  Promise<{ projects: ClientUpdateResult["projects"]; choice: ClientUpdateResult["projectChoice"] }> {
  const all: DdProject[] = await listProjects(principal, { signal });
  const names = new Map(all.map((p) => [p.id, p.name]));
  const out: ClientUpdateResult["projects"] = [];
  const add = (id: string, basis: "record" | "named" | "derived") => {
    if (out.length >= L.projectsShown || out.some((p) => p.id === id)) return;
    const name = names.get(id);
    if (name !== undefined) out.push({ id, name, basis });
  };
  let choice: ClientUpdateResult["projectChoice"] = null;
  const named = typeof input.projectId === "string" ? input.projectId.trim() : "";
  if (named !== "") {
    const r = resolveProject(named, all, { allowAny: false, strict: false });
    if (r.status === "ok") add(r.value.id, "named");
    else choice = { matches: r.status === "ambiguous" ? r.matches.slice(0, 5).map((p) => ({ id: p.id, name: p.name })) : [] };
  }
  for (const t of await listTasksForThread(principal, threadId, { signal })) if (t.projectId !== null) add(t.projectId, "record");
  if (clientId !== null && out.length < L.projectsShown) {
    const view = await getProjectsListView(principal, "open", { now, signal });
    if (view.rows.ok) for (const row of view.rows.data) if (row.derivedClient?.clientId === clientId) add(row.health.projectId, "derived");
  }
  return { projects: out, choice };
}

export async function prepareClientUpdate(principal: ExecPrincipal, settings: ExecSettings, input: ClientUpdateInput,
  ctx: { question: string; usesPrivateRefs: boolean; privateRefKinds: PrivateRefKind[]; intelState: SlackIntelState; signal: AbortSignal; now: Date }):
  Promise<ClientUpdateResult> {
  void settings;
  const { signal, now } = ctx;
  signal.throwIfAborted();
  const ownerWords = ownerInstructionFrom(ctx.question);
  const threadId = typeof input?.threadId === "string" ? input.threadId : "";
  const notes: string[] = [];
  const consulted: ClientUpdateResult["consulted"] = { threadIds: [], clientIds: [], slack: [] };
  const slackOff = { state: ctx.intelState, publicForDraft: [] as SlackSearchHit[], privateCount: 0 };
  const answer = (over: Partial<ClientUpdateResult>): ClientUpdateResult => ({
    draft: null, refused: null, client: null, projects: [], work: null, slack: slackOff, teamWorkCount: null, lastClientUpdate: null,
    instructionClipped: ownerWords.clipped, projectChoice: null, consulted, ...over,
    notes: [...notes, ...(over.notes ?? []), NOTES.cuNothingSent]
  });
  if (ownerWords.clipped) notes.push(NOTES.cuClipped);

  // 1. The thread first: a screen refusal reads nothing else.
  if (!isThreadIdShape(threadId)) return answer({ refused: "unavailable_thread" });
  // His message is the instruction (N17): without one there is nothing to draft from.
  if (ownerWords.text === "") return answer({ refused: "unavailable" });
  const stored = await getEmailThread(principal, threadId, { signal });
  if (stored !== null) {
    const policy = await loadScreeningPolicy(principal, { signal });
    if (stored.state === "gone" || !pinnedAccounts(principal).includes(stored.accountId) ||
      screenStoredRow(stored, policy.rules, policy.hash).verdict === "restricted") {
      return answer({ refused: "unavailable_thread" });
    }
  }
  consulted.threadIds.push(threadId);

  // 2. The client (the stored verdict columns).
  let client: ClientUpdateResult["client"] = null;
  if (stored !== null) {
    const confidence = stored.matchConfidence;
    if (stored.clientId === null || stored.clientId === "" || (confidence !== "high" && confidence !== "medium")) {
      return answer({ refused: "not_a_client_thread", notes: [NOTES.cuNoClient] });
    }
    const eligible = confidence === "high" && stored.clientMatchVia === "exact" && stored.clientCandidates === 1 && (stored.clientName ?? "").trim() !== "";
    client = { id: stored.clientId, name: stored.clientName ?? "", confidence, eligibleForFacts: eligible };
    consulted.clientIds.push(stored.clientId);
    if (!eligible) notes.push(NOTES.cuMedium);
  } else {
    notes.push(NOTES.cuUntriaged);
  }

  // 3-4. The draft, with the private-refs flag the tool computed and his own words.
  const draft = await createClientUpdateDraft(principal, {
    threadId,
    ownerInstruction: ownerWords.text,
    usesPrivateRefs: ctx.usesPrivateRefs,
    projectIds: []
  }, { signal });
  if (draft.kind === "refused") return answer({ refused: draft.reason, client });
  const existing = draft.kind === "existing";
  if (existing) notes.push(draft.existingReason === "busy" ? NOTES.cuBusy : NOTES.cuExisting);
  if (draft.kind === "regenerated") notes.push(NOTES.cuRegenerated);
  const draftOut: NonNullable<ClientUpdateResult["draft"]> = {
    id: draft.draftId,
    status: draft.status,
    link: draftPageHref(draft.draftId),
    existing,
    regenerated: draft.kind === "regenerated",
    existingReason: draft.existingReason,
    // An existing draft kept its own flag (this chat didn't set it): its card claims no second confirmation (P5b ui-2).
    privateRefKinds: existing ? [] : [...ctx.privateRefKinds]
  };

  // 5. Projects (after the draft: it doesn't depend on them).
  const { projects, choice } = await projectsFor(principal, input, threadId, client?.id ?? null, now, signal);

  // 6-9. Only for the facts client.
  let work: ClientUpdateResult["work"] = null;
  let slack = slackOff;
  let teamWorkCount: number | null = null;
  let lastClientUpdate: ClientUpdateResult["lastClientUpdate"] = null;
  if (client !== null && client.eligibleForFacts) {
    const sinceIso = new Date(now.getTime() - L.completedWindowDays * DAY_MS).toISOString();
    const [open, done] = await Promise.all([
      listOpenTasksForClient(principal, client.name, { signal }),
      listCompletedTasksForClient(principal, client.name, sinceIso, { signal })
    ]);
    work = {
      open: [...open].sort(openOrder).slice(0, WORK_ROWS).map(workTask),
      completedRecently: done.filter((t) => completedMs(t) >= Date.parse(sinceIso)).sort((a, b) => completedMs(b) - completedMs(a)).slice(0, WORK_ROWS).map(workTask)
    };

    if (ctx.intelState === "ok") {
      const rows = await loadPublicSlackRows(principal, client.id, "ok", now, signal);
      const digestIds = rows.filter((r) => r.src === "digest").map((r) => r.id);
      const digests = digestIds.length === 0 ? new Map() : new Map((await getDigestsByIds(principal, digestIds, { signal })).map((d) => [d.id, d]));
      const publicForDraft: SlackSearchHit[] = [];
      for (const r of rows) {
        if (r.src === "digest") {
          const d = digests.get(r.id);
          if (d === undefined || d.status !== "built") continue;
          publicForDraft.push(hitOf(r, d.rebuilds));
        } else {
          publicForDraft.push(hitOf(r, null));
        }
      }
      const privateCount = await privateSlackCount(principal, client.id, now, signal);
      slack = { state: "ok", publicForDraft, privateCount };
      for (const h of publicForDraft) {
        const key = refKeyOf(h);
        if (key !== null) consulted.slack.push({ refKeys: [key], channelId: h.channelId });
      }
      if (privateCount > 0) notes.push(fill(NOTES.cuPrivateCount, { n: String(privateCount) }));
    }

    const today = localDateString(now, principal.timezone);
    const sinceDate = new Date(Date.parse(`${today}T00:00:00Z`) - L.teamWorkWindowDays * DAY_MS).toISOString().slice(0, 10);
    teamWorkCount = await countEodClientWorkForClient(principal, client.name, sinceDate, { signal });
    lastClientUpdate = await getLastClientUpdate(principal, { clientId: client.id, clientName: client.name }, { signal });
    const dateOf = (iso: string) => localDateString(new Date(Date.parse(iso)), principal.timezone);
    if (lastClientUpdate.teamEmailSentAt !== null) notes.push(fill(NOTES.cuLastUpdate, { date: dateOf(lastClientUpdate.teamEmailSentAt) }));
    if (lastClientUpdate.workReportedAt !== null) notes.push(fill(NOTES.cuWorkReported, { date: dateOf(lastClientUpdate.workReportedAt) }));
  }
  // C31: the draft is made either way; say when no Slack was used because reading isn't on.
  if (ctx.intelState !== "ok") notes.push(NOTES.cuSlackOff);

  return answer({ draft: draftOut, client, projects, projectChoice: choice, work, slack, teamWorkCount, lastClientUpdate });
}
