import "server-only";

import { extractDomain } from "@/lib/client-thread-match";
import { isActiveClientStatus } from "@/lib/exec/correlate";
import { channelSlug } from "@/lib/exec/slack-classes";
import { SLACK_INTEL_LIMITS, type ChannelRow, type SlackMessageLink } from "@/lib/exec/slack-intel-types";
import { hostsInText, parseDdPaths } from "@/lib/exec/slack-links";
import { listClientMatchSignals, listEodSlackAnchors, listTasksByIds } from "@/lib/exec/sources/dd";
import type { DdClientMatchSignals, DdTask } from "@/lib/exec/sources/dd-types";
import { listInternalAddresses } from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";

// P7b channel and message correlation (P7b contract §3.4, N18, C2–C5; Area B; server-only; P3 rule 9's `correlate`
// file class). Owner tags are high (the store's generated columns: this module never sees or writes a tag), the
// channel-name rule is low, DD paths and DD's own posts give exact message links. Only active clients take part
// (isActiveClientStatus, P3's reading of clients.status). The loader throws on any failed read: a correlator built from a
// failed read would call every message "no client" and the job would store that (P3's rule).
//
// What a verdict is built from, and nothing else: the channel's stored class, conversation type, watch state, left
// marker and name (channelRule); a stored message's DD paths, its DD-post flag, its items' AI summaries and the anchor
// table (messageLink). Nothing here logs, and nothing it returns carries a summary or a name beyond the client name a
// verdict column stores.

export interface SlackCorrelatorInput {
  clients: readonly DdClientMatchSignals[];        // listClientMatchSignals; inactive ones are dropped here
  internalDomains: readonly string[];              // P3 listInternalAddresses().domains (a site of ours never names a client)
  tasksById: ReadonlyMap<string, DdTask>;          // listTasksByIds over every task id the batch's paths name
  anchors: ReadonlyMap<string /* channel:ts */, { clientId: string | null; clientName: string }>;   // listEodSlackAnchors
  /** Optional (additive): the time stamped into each message link's checkedAt. Absent = the time messageLink runs. */
  now?: Date;
}
export interface SlackCorrelator {
  /** C3. Returns null for channels that get no verdict (hub, deny, unclassified, im, unwatched, left). */
  channelRule(ch: ChannelRow): { clientId: string | null; clientName: string | null; candidates: number } | null;
  /** N18: dd_post (anchor table) > dd_link (/clients/<id>; else the single exact active client of the linked tasks) > domain. */
  messageLink(m: { channelId: string; ts: string; isDdPost: boolean; ddPaths: readonly string[]; summaries: readonly string[] }): SlackMessageLink;
  readonly activeClients: number;
}

/** Our own company domain: never a client's site (P3's COMPANY_DOMAIN; listInternalAddresses already adds it). */
const COMPANY_DOMAIN = "scaledai.org";
/** The verdict columns' CHECKs (§2.1.2, §2.1.3): ids ≤ 100, names 1–200, candidates ≤ 1 000. */
const CLIENT_ID_MAX = 100;
const CLIENT_NAME_MAX = 200;
const CANDIDATES_MAX = 1_000;
const TASK_IDS_MAX = 20;
const PROJECT_IDS_MAX = 20;
/** C3 / RPC 1 / slackUsePolicy (coherence-2): the classes a channel verdict may come from, and the watch states that are read. */
const RULE_CLASSES: ReadonlySet<string> = new Set(["standard", "external", "finance"]);
const RULE_CONV_TYPES: ReadonlySet<string> = new Set(["channel", "group", "mpim"]);
const RULE_WATCH_STATES: ReadonlySet<string> = new Set(["watched", "muted"]);

interface ActiveClient {
  id: string;
  /** As DD stores it, clipped to the verdict column (what a verdict's clientName carries). */
  name: string;
  /** channelSlug(name) (P7a's slack-classes.ts). */
  slug: string;
}

const NO_RULE = Object.freeze({ clientId: null, clientName: null, candidates: 0 });

/** A Set's members, in insertion order, at most `max`. */
const firstOf = <T>(items: Iterable<T>, max: number): T[] => {
  const out: T[] = [];
  for (const x of items) {
    if (out.length >= max) break;
    out.push(x);
  }
  return out;
};

export function buildSlackCorrelator(input: SlackCorrelatorInput): SlackCorrelator {
  const active: ActiveClient[] = [];
  const byId = new Map<string, ActiveClient>();
  /** The exact (trimmed, case-sensitive) name → every active client of that name (DD's own join, COR §2.1). */
  const byExactName = new Map<string, ActiveClient[]>();
  /** Website host (extractDomain: lowercased, no scheme, www. or path) → the active clients claiming it. */
  const byDomain = new Map<string, Set<string>>();
  for (const c of Array.isArray(input?.clients) ? input.clients : []) {
    if (typeof c?.id !== "string" || c.id.length === 0 || c.id.length > CLIENT_ID_MAX) continue;
    if (!isActiveClientStatus(c.status)) continue;
    const trimmed = typeof c.name === "string" ? c.name.trim() : "";
    // A verdict stores a client name (1–200 characters): a client with no name can't be one.
    if (trimmed.length === 0 || byId.has(c.id)) continue;
    const client: ActiveClient = { id: c.id, name: c.name.slice(0, CLIENT_NAME_MAX), slug: channelSlug(c.name) };
    active.push(client);
    byId.set(client.id, client);
    byExactName.set(trimmed, [...(byExactName.get(trimmed) ?? []), client]);
    for (const site of [c.website ?? null, ...(Array.isArray(c.websites) ? c.websites : [])]) {
      const host = typeof site === "string" ? extractDomain(site) : null;
      if (host === null || host.length === 0) continue;
      const set = byDomain.get(host) ?? new Set<string>();
      set.add(client.id);
      byDomain.set(host, set);
    }
  }
  const internal = new Set<string>([COMPANY_DOMAIN]);
  for (const d of Array.isArray(input?.internalDomains) ? input.internalDomains : []) {
    if (typeof d === "string" && d.trim().length > 0) internal.add(d.trim().toLowerCase());
  }
  const slugged = active.filter((c) => c.slug.length >= SLACK_INTEL_LIMITS.nameRuleMinSlugChars);
  const tasksById: ReadonlyMap<string, DdTask> = input?.tasksById instanceof Map ? input.tasksById : new Map();
  const anchors: ReadonlyMap<string, { clientId: string | null; clientName: string }> = input?.anchors instanceof Map ? input.anchors : new Map();
  const fixedNow = input?.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : null;

  /** The one active client this exact name names, or null (none, or several of that name). */
  const exactlyNamed = (name: unknown): ActiveClient | null => {
    if (typeof name !== "string") return null;
    const hits = byExactName.get(name.trim()) ?? [];
    return hits.length === 1 ? hits[0] : null;
  };

  return {
    activeClients: active.length,

    channelRule(ch: ChannelRow) {
      if (ch === null || typeof ch !== "object") return null;
      // Fail closed (coherence-2): only a read class, a channel / private channel / group DM, a watched or muted state, and
      // a channel he hasn't left. Hubs, deny, unclassified, 1:1 DMs, unwatched and left channels get no verdict.
      if (!RULE_CLASSES.has(ch.class) || !RULE_CONV_TYPES.has(ch.convType) || !RULE_WATCH_STATES.has(ch.watchState) || ch.leftAt !== null) return null;
      const name = typeof ch.name === "string" && ch.name.length > 0 ? ch.name.toLowerCase() : null;
      if (name === null) return { ...NO_RULE };
      const padded = `-${name}-`;
      const hits = new Map<string, ActiveClient>();
      for (const c of slugged) {
        const s = c.slug;
        if (name === s || name.startsWith(`${s}-`) || padded.includes(`-${s}-`)) hits.set(c.id, c);
      }
      if (hits.size === 1) {
        const [only] = hits.values();
        return { clientId: only.id, clientName: only.name, candidates: 1 };
      }
      return hits.size === 0 ? { ...NO_RULE } : { clientId: null, clientName: null, candidates: Math.min(hits.size, CANDIDATES_MAX) };
    },

    messageLink(m) {
      const parsed = parseDdPaths(Array.isArray(m?.ddPaths) ? m.ddPaths : []);
      // The paths' tasks that exist (a deleted task links nothing).
      const tasks: DdTask[] = [];
      for (const id of parsed.taskIds) {
        const t = tasksById.get(id);
        if (t !== undefined && t.deletedAt === null && tasks.length < TASK_IDS_MAX) tasks.push(t);
      }
      const projects = new Set<string>(parsed.projectIds);
      for (const t of tasks) if (typeof t.projectId === "string" && t.projectId.length > 0) projects.add(t.projectId);

      let verdict: Pick<SlackMessageLink, "clientId" | "clientName" | "clientMatchVia" | "matchConfidence" | "clientCandidates"> =
        { clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null, clientCandidates: 0 };
      const high = (c: ActiveClient, via: "dd_post" | "dd_link") => ({ clientId: c.id, clientName: c.name, clientMatchVia: via, matchConfidence: "high" as const, clientCandidates: 1 });

      // (1) A Scaled Team post the anchor table names (C4): its client id when active; with no id, the one active client its
      // name names exactly. An id naming an inactive or unknown client gives nothing from this arm.
      const anchor = typeof m?.channelId === "string" && typeof m?.ts === "string" ? anchors.get(`${m.channelId}:${m.ts}`) : undefined;
      let anchored: ActiveClient | null = null;
      if (anchor !== undefined) anchored = anchor.clientId !== null ? byId.get(anchor.clientId) ?? null : exactlyNamed(anchor.clientName);
      if (anchored !== null) {
        verdict = high(anchored, "dd_post");
      } else {
        // (2) /clients/<id> paths naming exactly one active client.
        const linkedClients = new Set(parsed.clientIds.filter((id) => byId.has(id)));
        // (3) Else the linked tasks' client names, each matched exactly to one active client; exactly one distinct client.
        const taskClients = new Set<string>();
        for (const t of tasks) {
          const c = exactlyNamed(t.clientName);
          if (c !== null) taskClients.add(c.id);
        }
        if (linkedClients.size === 1) {
          verdict = high(byId.get([...linkedClients][0]) as ActiveClient, "dd_link");
        } else if (taskClients.size === 1) {
          verdict = high(byId.get([...taskClients][0]) as ActiveClient, "dd_link");
        } else {
          // (4) A client website named in the items' AI summaries (never the excerpt), our own domains aside.
          const domainClients = new Set<string>();
          const summaries = Array.isArray(m?.summaries) ? m.summaries.filter((s): s is string => typeof s === "string") : [];
          for (const host of hostsInText(summaries.join(" "))) {
            if (internal.has(host)) continue;
            for (const id of byDomain.get(host) ?? []) domainClients.add(id);
          }
          if (domainClients.size === 1) {
            const c = byId.get([...domainClients][0]) as ActiveClient;
            verdict = { clientId: c.id, clientName: c.name, clientMatchVia: "domain", matchConfidence: "medium", clientCandidates: 1 };
          } else if (domainClients.size > 1) {
            verdict = { clientId: null, clientName: null, clientMatchVia: "domain", matchConfidence: "low", clientCandidates: Math.min(domainClients.size, CANDIDATES_MAX) };
          }
        }
      }

      return {
        channelId: m.channelId,
        ts: m.ts,
        ...verdict,
        taskIds: tasks.map((t) => t.id),
        projectIds: firstOf(projects, PROJECT_IDS_MAX),
        emailThreadIds: [...parsed.emailThreadIds],
        checkedAt: (fixedNow ?? new Date()).toISOString()
      };
    }
  };
}

/** Reads every source; throws on any failure (never matches against nothing, P3's rule). */
export async function loadSlackCorrelator(principal: ExecPrincipal, q: { taskIds: readonly string[]; anchorsSince: string }, opts: { signal: AbortSignal }): Promise<SlackCorrelator> {
  const signal = opts.signal;
  const taskIds = [...new Set((Array.isArray(q?.taskIds) ? q.taskIds : []).filter((id) => typeof id === "string" && id.length > 0))];
  const [clients, internal, tasks, anchorRows] = await Promise.all([
    listClientMatchSignals(principal, { signal }),
    listInternalAddresses(principal, { signal }),
    listTasksByIds(principal, taskIds, { signal }),
    listEodSlackAnchors(principal, q.anchorsSince, { signal })
  ]);
  const tasksById = new Map<string, DdTask>();
  for (const t of tasks) if (typeof t?.id === "string") tasksById.set(t.id, t);
  // One anchor per (channel, ts). Two posts at one key that disagree on the client name no client (fail closed).
  const anchors = new Map<string, { clientId: string | null; clientName: string }>();
  for (const a of anchorRows) {
    const key = `${a.slackChannel}:${a.slackTs}`;
    const seen = anchors.get(key);
    if (seen === undefined) anchors.set(key, { clientId: a.clientId, clientName: a.clientName });
    else if (seen.clientId !== a.clientId || seen.clientName !== a.clientName) anchors.set(key, { clientId: null, clientName: "" });
  }
  return buildSlackCorrelator({ clients, internalDomains: internal.domains, tasksById, anchors });
}

const hasContent = (l: SlackMessageLink | null): l is SlackMessageLink =>
  l !== null && typeof l === "object" && (l.clientId !== null || l.taskIds.length > 0 || l.projectIds.length > 0);

/** Read-time inheritance (N18): own link if it has any client, task or project; else the root's with via kept and basis "dd_thread". */
export function effectiveLink(own: SlackMessageLink | null, root: SlackMessageLink | null): (SlackMessageLink & { inherited: boolean }) | null {
  if (hasContent(own)) return { ...own, inherited: false };
  if (hasContent(root)) return { ...root, inherited: true };
  return null;
}
