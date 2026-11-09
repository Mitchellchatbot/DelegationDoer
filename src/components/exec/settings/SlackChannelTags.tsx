"use client";

import { useId, useState } from "react";
import { Tag } from "lucide-react";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { SlackChannelLink } from "@/lib/exec/slack-intel-types";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";

// A conversation's client and project tags in the Settings picker (P7b contract §3.12.4, N18, C2, C25, UI12, UI13). A
// client island the picker renders under each row (AM-P7b-6: the picker's `tags` data prop; the server computes every
// value: `taggable` is C25 on P7a's ChannelRow, `links` is the stored link row, and the client and project lists come
// with the page, so nothing here fetches options).
//
//   * The badge, always shown: a tag → "Tagged: <client>" (High); no tag but the name rule's verdict → "Name suggests
//     <client>" or "Name matches N clients" (Low); a conversation C25 refuses → "Not taggable", greyed, nothing else.
//   * The editor, inside a closed <details> (so a long picker stays one line a row): a client <select> ("No client" and
//     the active clients by name; a tag on a client that is no longer active stays listed so the current value shows) and
//     the projects as checkboxes (at most 10 checked). Save → PUT /api/exec/slack/channels/<id>/links { clientId,
//     projectIds }; the answer's words: "Saved", 409 "This conversation can't be tagged.", 422 "That client or project no
//     longer exists.", 429 "Too many changes. Try again in a few minutes.", anything else "Couldn't save. Try again.".
//   * Framed (P4's useIsTopWindow false, also the server's first render): the badge and the tagged projects as text, and
//     "Changes are off in an embedded view."; nothing to click.
//
// Imports only client-safe modules (B-P7b-8 / P5a rule 16): the copy, the pure types, the frame guard.

export interface SlackTagsClient { id: string; name: string; active: boolean }
export interface SlackTagsProject { id: string; name: string }
export interface SlackChannelTagsProps {
  channelId: string;
  taggable: boolean;
  links: SlackChannelLink | null;
  clients: readonly SlackTagsClient[];
  projects: readonly SlackTagsProject[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type TagsSaveResult = { kind: "saved"; links: SlackChannelLink | null } | { kind: "failed"; status: number; message: string };

const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
export const MAX_TAG_PROJECTS = 10;
/** The editor's name when the row has no badge yet (R13's "Client and project tags", shortened for a picker row). */
const TAGS_LABEL = "Tags";

const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);

export const tagsPath = (channelId: string): string => `/api/exec/slack/channels/${encodeURIComponent(channelId)}/links`;

/** The words for a failed save, by status (§3.12.4). */
export function tagsFailureMessage(status: number): string {
  if (status === 409) return SLACK_INTEL_COPY.tagsNotTaggable;
  if (status === 422) return SLACK_INTEL_COPY.tagsUnknown;
  if (status === 429) return SLACK_INTEL_COPY.tagsRateLimited;
  return SLACK_INTEL_COPY.tagsError;
}

function isLink(v: unknown, channelId: string): v is SlackChannelLink {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o.channelId === channelId && Array.isArray(o.tagProjectIds) && typeof o.clientCandidates === "number";
}

/** PUT the tags (same-origin JSON). 200 → saved (with the answer's link row, or null: the route's read-back may be
 *  missing); anything else → failed with its words. Never throws. */
export async function saveChannelTags(channelId: string, body: { clientId: string | null; projectIds: readonly string[] }, fetchImpl?: FetchLike): Promise<TagsSaveResult> {
  if (typeof channelId !== "string" || !CHANNEL_RE.test(channelId)) return { kind: "failed", status: 0, message: SLACK_INTEL_COPY.tagsError };
  const f: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await f(tagsPath(channelId), {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ clientId: body.clientId, projectIds: [...new Set(body.projectIds)].slice(0, MAX_TAG_PROJECTS) })
    });
  } catch {
    return { kind: "failed", status: 0, message: SLACK_INTEL_COPY.tagsError };
  }
  if (res.status !== 200) return { kind: "failed", status: res.status, message: tagsFailureMessage(res.status) };
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const links = typeof json === "object" && json !== null ? (json as Record<string, unknown>).links : null;
  return { kind: "saved", links: isLink(links, channelId) ? links : null };
}

/** The badge for a row (§3.12.4): its words and its confidence, or "Not taggable" (greyed) when C25 refuses it. C2 (fixer
 *  ui-12): a tag to a client that is no longer active reads "inactive client", greyed and without "(High)", so he re-tags or
 *  clears it (the stored link isn't filtered by client activity; contract appendix "P7b fixer amendments" §7.5); `clients`
 *  is the picker's list with each client's active flag (absent: unknown, read as active). */
export function tagsBadge(taggable: boolean, links: SlackChannelLink | null, clients?: readonly SlackTagsClient[]):
  { text: string; confidence: "High" | "Low" | null; greyed: boolean } | null {
  if (!taggable) return { text: SLACK_INTEL_COPY.tagsGreyed, confidence: null, greyed: true };
  if (links === null) return null;
  if (links.tagClientId !== null && typeof links.tagClientName === "string" && links.tagClientName.length > 0) {
    const tagged = clients?.find((c) => c.id === links.tagClientId);
    if (tagged !== undefined && tagged.active !== true) return { text: fill(SLACK_INTEL_COPY.tagsInactive, { client: links.tagClientName }), confidence: null, greyed: true };
    return { text: fill(SLACK_INTEL_COPY.tagsTagged, { client: links.tagClientName }), confidence: "High", greyed: false };
  }
  if (links.clientMatchVia === "name" && links.matchConfidence === "low") {
    if (links.clientCandidates === 1 && typeof links.clientName === "string" && links.clientName.length > 0) {
      return { text: fill(SLACK_INTEL_COPY.tagsRuleOne, { client: links.clientName }), confidence: "Low", greyed: false };
    }
    if (links.clientCandidates > 1) return { text: fill(SLACK_INTEL_COPY.tagsRuleMany, { n: links.clientCandidates }), confidence: "Low", greyed: false };
  }
  return null;
}

/** The client choices: "No client", then the active clients (and the tagged one if it is no longer active), by name. */
export function clientOptions(clients: readonly SlackTagsClient[], taggedId: string | null): SlackTagsClient[] {
  return clients.filter((c) => c.active || c.id === taggedId);
}

/** The project ids after a checkbox change: at most 10, in the projects' order. */
export function toggleProject(current: readonly string[], projectId: string, checked: boolean): string[] {
  const set = new Set(current);
  if (checked) {
    if (set.size >= MAX_TAG_PROJECTS) return [...current];
    set.add(projectId);
  } else set.delete(projectId);
  return [...set];
}

/** The local link row after a save whose answer carried no row: the tag fields from what was sent, the rule's as they were. */
function linkAfterSave(prior: SlackChannelLink | null, channelId: string, clientId: string | null, clientName: string | null, projectIds: string[]): SlackChannelLink {
  const base: SlackChannelLink = prior ?? {
    channelId, tagClientId: null, tagClientName: null, tagProjectIds: [], taggedAt: null,
    clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null, clientCandidates: 0
  };
  return { ...base, tagClientId: clientId, tagClientName: clientId === null ? null : clientName, tagProjectIds: projectIds };
}

function Badge({ badge }: { badge: NonNullable<ReturnType<typeof tagsBadge>> }) {
  return (
    <span
      data-tags-badge={badge.greyed ? "greyed" : badge.confidence === "High" ? "tag" : "rule"}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold leading-tight",
        badge.greyed ? "border-slate-200 bg-slate-50 text-slate-400" : badge.confidence === "High" ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600"
      )}
    >
      <span className="min-w-0 break-words">
        {badge.text}
        {badge.confidence !== null && <span className="font-normal opacity-80">{` (${badge.confidence})`}</span>}
      </span>
    </span>
  );
}

export function SlackChannelTags({
  channelId,
  taggable,
  links,
  clients,
  projects,
  initialOpen = false
}: SlackChannelTagsProps & {
  /** Static renders only (tests, screenshots): the editor open on first render. The page never passes it. */
  initialOpen?: boolean;
}) {
  const isTop = useIsTopWindow();
  const id = useId();
  const [current, setCurrent] = useState<SlackChannelLink | null>(links);
  const [clientId, setClientId] = useState<string>(links?.tagClientId ?? "");
  const [projectIds, setProjectIds] = useState<string[]>(links?.tagProjectIds ? [...links.tagProjectIds] : []);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const badge = tagsBadge(taggable, current, clients);
  if (!taggable) {
    return (
      <div data-tags={channelId} data-tags-taggable="false" className="mt-1.5">
        {badge && <Badge badge={badge} />}
      </div>
    );
  }
  // The tagged projects' names in the list's order (by name); an id DD no longer has is left out.
  const taggedIds = new Set(current?.tagProjectIds ?? []);
  const taggedProjects = projects.filter((p) => taggedIds.has(p.id)).map((p) => p.name);
  const options = clientOptions(clients, current?.tagClientId ?? null);
  // Checked projects first, then the rest by name (the server sorted them), so what is tagged is in view.
  const ordered = [...projects.filter((p) => projectIds.includes(p.id)), ...projects.filter((p) => !projectIds.includes(p.id))];

  async function save() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const chosen = clientId === "" ? null : clientId;
    const result = await saveChannelTags(channelId, { clientId: chosen, projectIds });
    setPending(false);
    if (result.kind === "saved") {
      const name = chosen === null ? null : (clients.find((c) => c.id === chosen)?.name ?? null);
      setCurrent(result.links ?? linkAfterSave(current, channelId, chosen, name, projectIds));
      setMessage({ text: SLACK_INTEL_COPY.tagsSaved, ok: true });
    } else setMessage({ text: result.message, ok: false });
  }

  return (
    <details data-tags={channelId} data-tags-taggable="true" open={initialOpen || undefined} className="group mt-1.5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
        <Tag className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
        {badge ? <Badge badge={badge} /> : <span className="font-medium">{TAGS_LABEL}</span>}
        {taggedProjects.length > 0 && <span data-tags-projects className="min-w-0 break-words">{taggedProjects.join(", ")}</span>}
      </summary>
      {isTop ? (
        <div data-tags-editor className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <label htmlFor={`${id}-client`} className="sr-only">
            Client
          </label>
          <select
            id={`${id}-client`}
            data-tags-client
            value={clientId}
            disabled={pending}
            onChange={(e) => setClientId(e.currentTarget.value)}
            className="w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] text-ink focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          >
            <option value="">No client</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {projects.length > 0 && (
            <fieldset data-tags-projects-editor className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white px-2 py-1.5">
              <legend className="sr-only">Projects</legend>
              {ordered.map((p) => {
                const checked = projectIds.includes(p.id);
                return (
                  <label key={p.id} className="flex min-w-0 items-start gap-2 text-[12.5px] text-ink">
                    <input
                      type="checkbox"
                      data-tags-project={p.id}
                      checked={checked}
                      disabled={pending || (!checked && projectIds.length >= MAX_TAG_PROJECTS)}
                      onChange={(e) => setProjectIds((cur) => toggleProject(cur, p.id, e.currentTarget.checked))}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-slate-300"
                    />
                    <span className="min-w-0 break-words">{p.name}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-tags-save
              onClick={() => void save()}
              disabled={pending}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <p aria-live="polite" role="status" data-tags-message className={cn("text-[12px]", message?.ok ? "text-emerald-700" : "text-rose-700")}>
              {message?.text ?? ""}
            </p>
          </div>
        </div>
      ) : (
        <p data-tags-framed className="mt-1.5 text-[12px] text-muted">
          {SLACK_INTEL_COPY.tagsFramed}
        </p>
      )}
    </details>
  );
}
