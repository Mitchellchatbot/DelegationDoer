"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  DragDropContext, Droppable, Draggable, type DropResult
} from "@hello-pangea/dnd";
import {
  Briefcase, Globe2, GripVertical, Folder, User as UserIcon, Mail, MailX,
  Filter, ArrowDownAZ, ArrowUpDown, Clock, LayoutGrid, List as ListIcon
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Client } from "@/lib/clients-data";
import { ClientHealthPill } from "./ClientHealthPill";
import { TouchpointPill } from "./TouchpointPill";
import { ClientTeamPicker } from "./ClientTeamPicker";
import { Tooltip } from "./Tooltip";
import {
  computeTouchpointLabel, daysSince, effectiveTouchpoint,
  TOUCHPOINT_META, type TouchpointLabel
} from "@/lib/client-touchpoint";

const VIEW_MODE_KEY = "clients:viewMode:v1";
type ViewMode = "list" | "grid";

// Drag-to-reorder client priority list. Top = most urgent. Leader-only edit.
//
// Implementation note: @hello-pangea/dnd already handles all the position
// animations (FLIP-style transforms on the non-dragged items, smooth ease
// on the dragged element). We deliberately do NOT layer framer-motion
// `layout` on top — they double-animate and visibly fight each other.
// Tailwind transitions on shadow/ring are fine since dnd doesn't manage
// those properties.

const PALETTE = [
  { ring: "ring-blue-300/40",   from: "from-blue-100",    iconBg: "bg-blue-500" },
  { ring: "ring-indigo-300/40", from: "from-indigo-100",  iconBg: "bg-indigo-500" },
  { ring: "ring-indigo-300/40", from: "from-indigo-100",  iconBg: "bg-indigo-500" },
  { ring: "ring-blue-300/40", from: "from-blue-100",  iconBg: "bg-blue-500" }
] as const;

const PRIORITY_TONES = {
  high:   "bg-blue-100 text-blue-700 border-blue-200/60",
  medium: "bg-indigo-100 text-indigo-700 border-indigo-200/60",
  low:    "bg-slate-100 text-slate-600 border-slate-200/60"
} as const;

type SortMode = "priority" | "stalest" | "freshest" | "name";
type HealthFilter = "all" | TouchpointLabel;

export interface PickableUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  departmentIds: string[];
}

interface Props {
  initial: Client[];
  openCounts: Record<string, number>;
  canEdit: boolean;
  /** Users that can be picked as the point person on a client.
   *  Server-side filtered (e.g. leaders excluded). Empty array
   *  hides the person-picker section in the menu. */
  pickableUsers?: PickableUser[];
}

export function ClientPriorityList({
  initial, openCounts, canEdit, pickableUsers = []
}: Props) {
  const [clients, setClients] = useState(initial);
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  // View mode persists per browser. SSR renders list so initial markup
  // matches what the server emitted; effect below swaps to grid if the
  // user picked it last visit.
  const [viewMode, setViewModeState] = useState<ViewMode>("list");
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_MODE_KEY);
      if (stored === "grid" || stored === "list") setViewModeState(stored);
    } catch { /* ignore */ }
  }, []);
  function setViewMode(next: ViewMode) {
    setViewModeState(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  }

  // Local-state patch for an icon upload. Called by ClientIconAvatar
  // after the upload route returns a public URL — keeps the visible
  // tile in sync without a router.refresh() round-trip.
  function updateClientIcon(clientId: string, iconUrl: string | null) {
    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, iconUrl } : c))
    );
  }

  // Same optimistic-update pattern for team / point-person changes
  // from ClientTeamPicker. Saves us an extra router.refresh() after
  // every dropdown selection.
  function updateClientAssignment(
    clientId: string,
    patch: { teamId?: string | null; assignedUserId?: string | null }
  ) {
    setClients((prev) =>
      prev.map((c) => (c.id === clientId ? { ...c, ...patch } : c))
    );
  }

  // Optimistic toggle for the per-client encourage_emails flag. Flips
  // the local state first, fires the API, reverts on failure. Used by
  // the small mail icon on each card so leaders can turn cadence
  // tracking off without opening the client detail page.
  async function toggleEncourageEmails(clientId: string, currentValue: boolean) {
    const before = clients;
    const next = clients.map((c) =>
      c.id === clientId ? { ...c, encourageEmails: !currentValue } : c
    );
    setClients(next);
    try {
      const res = await fetch(
        `/api/clients/${encodeURIComponent(clientId)}/touchpoint`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ encourageEmails: !currentValue })
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `status ${res.status}`);
      }
      toast.success(
        !currentValue
          ? "Email cadence tracking ON for this client."
          : "Email cadence tracking OFF — touchpoint pill hidden."
      );
    } catch (err) {
      setClients(before);
      toast.error(`Couldn't update: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // Tally counts for the filter chips so we can show "Red · 3". Excludes
  // clients with encourageEmails=false — they don't have a health band.
  const tallies = useMemo(() => {
    const t: Record<TouchpointLabel, number> = { green: 0, yellow: 0, red: 0 };
    for (const c of clients) {
      if (!c.encourageEmails) continue;
      const { label } = effectiveTouchpoint(c.touchpointOverrideLabel, c.lastOutboundEmailAt);
      t[label] += 1;
    }
    return t;
  }, [clients]);

  // Filtered + sorted view used for rendering. Drag-reorder still
  // mutates the canonical `clients` array (which controls priority);
  // it's only enabled when sortMode === 'priority' and no filter is
  // active, since drag-position is meaningless under sort/filter.
  const visible = useMemo(() => {
    let arr = clients.slice();
    if (healthFilter !== "all") {
      arr = arr.filter((c) => {
        if (!c.encourageEmails) return false;
        const { label } = effectiveTouchpoint(c.touchpointOverrideLabel, c.lastOutboundEmailAt);
        return label === healthFilter;
      });
    }
    switch (sortMode) {
      case "stalest":
        arr.sort((a, b) => {
          const ad = a.lastOutboundEmailAt ? new Date(a.lastOutboundEmailAt).getTime() : 0;
          const bd = b.lastOutboundEmailAt ? new Date(b.lastOutboundEmailAt).getTime() : 0;
          return ad - bd; // oldest first = stalest first
        });
        break;
      case "freshest":
        arr.sort((a, b) => {
          const ad = a.lastOutboundEmailAt ? new Date(a.lastOutboundEmailAt).getTime() : 0;
          const bd = b.lastOutboundEmailAt ? new Date(b.lastOutboundEmailAt).getTime() : 0;
          return bd - ad;
        });
        break;
      case "name":
        arr.sort((a, b) => a.name.localeCompare(b.name));
        break;
      // 'priority' = leave in `clients` order (display_order)
    }
    return arr;
  }, [clients, sortMode, healthFilter]);

  const dragEnabled = canEdit && sortMode === "priority" && healthFilter === "all";

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;

    const next = Array.from(clients);
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);

    const before = clients;
    setClients(next);

    try {
      const res = await fetch("/api/clients/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: next.map((c) => c.id) })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "failed");
      }
    } catch (err) {
      setClients(before);
      toast.error(`Couldn't save order: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  if (clients.length === 0) {
    return (
      <div className="card p-10 text-center">
        <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 grid place-items-center mx-auto mb-3">
          <Folder className="w-8 h-8" />
        </div>
        <div className="text-base font-medium">No clients yet</div>
        <div className="text-sm text-muted mt-1 max-w-md mx-auto">
          Create your first client folder to start tracking meeting links, documents, and notes.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Sort + health filter toolbar */}
      <div className="flex items-center gap-3 flex-wrap px-1">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-ink/60 font-medium">
          <Filter className="w-3 h-3" /> Health:
        </div>
        <FilterChip
          active={healthFilter === "all"}
          onClick={() => setHealthFilter("all")}
          label="All"
          count={clients.length}
        />
        {(["red", "yellow", "green"] as const).map((tone) => (
          <FilterChip
            key={tone}
            active={healthFilter === tone}
            onClick={() => setHealthFilter(tone)}
            label={TOUCHPOINT_META[tone].label}
            count={tallies[tone]}
            dotClass={TOUCHPOINT_META[tone].dot}
          />
        ))}

        <div className="w-px h-4 bg-slate-200 mx-1" />

        <div className="inline-flex items-center gap-1.5 text-[11px] text-ink/60 font-medium">
          <ArrowUpDown className="w-3 h-3" /> Sort:
        </div>
        <SortChip
          active={sortMode === "priority"}
          onClick={() => setSortMode("priority")}
          icon={<ArrowUpDown className="w-3 h-3" />}
          label="Priority"
        />
        <SortChip
          active={sortMode === "stalest"}
          onClick={() => setSortMode("stalest")}
          icon={<Clock className="w-3 h-3" />}
          label="Stalest first"
        />
        <SortChip
          active={sortMode === "freshest"}
          onClick={() => setSortMode("freshest")}
          icon={<Clock className="w-3 h-3" />}
          label="Freshest first"
        />
        <SortChip
          active={sortMode === "name"}
          onClick={() => setSortMode("name")}
          icon={<ArrowDownAZ className="w-3 h-3" />}
          label="Name"
        />

        <div className="ml-auto inline-flex rounded-full bg-white border border-slate-200/70 p-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
              viewMode === "list" ? "bg-accent/10 text-accent" : "text-ink/55 hover:text-ink"
            )}
            title="List view — supports drag-to-reorder"
          >
            <ListIcon className="w-3 h-3" />
            List
          </button>
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
              viewMode === "grid" ? "bg-accent/10 text-accent" : "text-ink/55 hover:text-ink"
            )}
            title="Grid view — compact tiles, scan all clients at once"
          >
            <LayoutGrid className="w-3 h-3" />
            Grid
          </button>
        </div>
      </div>

      {visible.length === 0 && (
        <div className="card p-6 text-center text-sm text-muted">
          No clients match the current filter.
        </div>
      )}

      {viewMode === "grid" && visible.length > 0 && renderGrid()}

      {viewMode === "list" && (
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="clients" isDropDisabled={!dragEnabled}>
          {(prov) => (
            <ol
              ref={prov.innerRef}
              {...prov.droppableProps}
              className="space-y-2.5"
            >
              {visible.map((c, i) => {
                const tone = PALETTE[i % PALETTE.length];
                const openCount = openCounts[c.name] ?? 0;
                const { label: tpLabel, isOverride: tpOverride } = effectiveTouchpoint(
                  c.touchpointOverrideLabel, c.lastOutboundEmailAt
                );
                return (
                  <Draggable
                    key={c.id}
                    draggableId={c.id}
                    index={i}
                    isDragDisabled={!dragEnabled}
                  >
                  {(p, snap) => (
                    <li
                      ref={p.innerRef}
                      {...p.draggableProps}
                      style={p.draggableProps.style}
                      className="list-none"
                    >
                      <div
                        className={cn(
                          `relative overflow-hidden rounded-2xl border ring-1 ${tone.ring} bg-gradient-to-br ${tone.from} to-white p-3.5 flex items-center gap-3 transition-shadow duration-150`,
                          snap.isDragging
                            ? "shadow-lift ring-2 ring-indigo-400 border-indigo-300"
                            : "shadow-soft border-white/60 hover:shadow-lift"
                        )}
                      >
                        {/* Rank badge */}
                        <div className="shrink-0 w-9 h-9 rounded-xl bg-white/80 border border-white/80 grid place-items-center text-sm font-semibold text-ink/70 shadow-sm tabular-nums">
                          {sortMode === "priority" ? (i + 1) : "·"}
                        </div>

                        {/* Drag handle (only for Leader & default sort) */}
                        {dragEnabled && (
                          <span
                            {...p.dragHandleProps}
                            aria-label="Drag to reorder"
                            role="button"
                            className="shrink-0 text-muted hover:text-ink cursor-grab active:cursor-grabbing transition-colors outline-none focus-visible:text-indigo-600"
                          >
                            <GripVertical className="w-4 h-4" />
                          </span>
                        )}

                        {/* Icon tile — renders uploaded photo when set,
                            falls back to briefcase. Click affords upload
                            when the viewer can edit. */}
                        <ClientIconAvatar
                          iconUrl={c.iconUrl}
                          clientId={c.id}
                          clientName={c.name}
                          canEdit={canEdit}
                          size={40}
                          fallbackBg={tone.iconBg}
                          onUploaded={(url) => updateClientIcon(c.id, url)}
                        />

                        {/* Title + meta */}
                        <Link
                          href={`/clients/${encodeURIComponent(c.id)}`}
                          className="min-w-0 flex-1 group rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
                        >
                          <div className="text-sm font-semibold truncate group-hover:text-accent transition-colors flex items-center gap-1.5">
                            {c.name}
                            {c.websites.length > 1 && (
                              <span className="text-[10px] text-ink/55 font-normal tabular-nums">
                                · {c.websites.length} sites
                              </span>
                            )}
                            {c.encourageEmails ? (
                              <TouchpointPill
                                label={tpLabel}
                                lastSentAt={c.lastOutboundEmailAt}
                                isOverride={tpOverride}
                                showAge
                              />
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 text-ink/50 text-[10px] font-medium px-1.5 py-0.5"
                                title="Email cadence tracking is off for this client."
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                Email-free
                              </span>
                            )}
                            {/* Sentiment health, shown only when leader has set one */}
                            <ClientHealthPill label={c.healthOverrideLabel} />
                          </div>
                          <div className="text-[11px] text-ink/60 truncate inline-flex items-center gap-2 mt-0.5">
                            {c.contactName && (
                              <span className="inline-flex items-center gap-1">
                                <UserIcon className="w-3 h-3" /> {c.contactName}
                              </span>
                            )}
                            {c.website && (
                              <span className="inline-flex items-center gap-1">
                                <Globe2 className="w-3 h-3" />
                                {c.website.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")}
                              </span>
                            )}
                            <span>· {openCount} open task{openCount === 1 ? "" : "s"}</span>
                          </div>
                          {c.touchpointSummary ? (
                            <div className="text-[11px] text-ink/65 truncate mt-0.5 italic">
                              &ldquo;{c.touchpointSummary}&rdquo;
                            </div>
                          ) : c.contactEmails.length > 0 && (
                            <div className="text-[10px] text-ink/50 truncate inline-flex items-center gap-1 mt-0.5">
                              <Mail className="w-2.5 h-2.5" />
                              {c.contactEmails.slice(0, 2).join(", ")}
                              {c.contactEmails.length > 2 ? ` +${c.contactEmails.length - 2}` : ""}
                            </div>
                          )}
                        </Link>

                        {/* Team picker + rank + priority chips. Team
                            picker comes first so it's the first thing
                            the eye lands on when scanning ownership. */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <ClientTeamPicker
                            clientId={c.id}
                            teamId={c.teamId}
                            assignedUserId={c.assignedUserId}
                            canEdit={canEdit}
                            users={pickableUsers}
                            onAssigned={(patch) => updateClientAssignment(c.id, patch)}
                          />
                          {canEdit && (
                            <EmailToggleButton
                              on={c.encourageEmails}
                              onToggle={() => toggleEncourageEmails(c.id, c.encourageEmails)}
                            />
                          )}
                          {c.priorityRank !== null && (
                            <span className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-md bg-white/85 text-ink/70 border border-white/80">
                              #{c.priorityRank}
                            </span>
                          )}
                          <span className={cn("text-[10px] px-2 py-0.5 rounded-full border capitalize", PRIORITY_TONES[c.priority])}>
                            {c.priority}
                          </span>
                        </div>
                      </div>
                    </li>
                  )}
                  </Draggable>
                );
              })}
              {prov.placeholder}
            </ol>
          )}
        </Droppable>
      </DragDropContext>
      )}
    </div>
  );

  function renderGrid() {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {visible.map((c, i) => {
          const tone = PALETTE[i % PALETTE.length];
          const openCount = openCounts[c.name] ?? 0;
          const { label: tpLabel, isOverride: tpOverride } = effectiveTouchpoint(
            c.touchpointOverrideLabel, c.lastOutboundEmailAt
          );
          return (
            <div
              key={c.id}
              className={cn(
                "relative rounded-2xl border ring-1 bg-gradient-to-br to-white p-3 shadow-soft hover:shadow-lift transition-shadow",
                tone.ring, tone.from, "border-white/60"
              )}
            >
              {/* Top row: rank + priority pill. Icon used to sit here
                  but it crowded the row with metadata; it's now next
                  to the name below where it belongs visually. */}
              <div className="flex items-center gap-2 mb-2">
                <div className="shrink-0 w-7 h-7 rounded-lg bg-white/85 border border-white/80 grid place-items-center text-[11px] font-semibold text-ink/70 shadow-sm tabular-nums">
                  {sortMode === "priority" ? (i + 1) : "·"}
                </div>
                <span className={cn("ml-auto text-[10px] px-2 py-0.5 rounded-full border capitalize", PRIORITY_TONES[c.priority])}>
                  {c.priority}
                </span>
              </div>

              {/* Body — primary click target. Icon is sibling so its
                  own upload button doesn't end up nested inside a Link. */}
              <div className="flex items-start gap-2.5">
                <ClientIconAvatar
                  iconUrl={c.iconUrl}
                  clientId={c.id}
                  clientName={c.name}
                  canEdit={canEdit}
                  size={42}
                  fallbackBg={tone.iconBg}
                  onUploaded={(url) => updateClientIcon(c.id, url)}
                />
                <Link
                  href={`/clients/${encodeURIComponent(c.id)}`}
                  className="min-w-0 flex-1 group rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
                >
                  <div className="text-sm font-semibold text-ink truncate group-hover:text-accent transition-colors">
                    {c.name}
                  </div>
                  <div className="text-[11px] text-ink/55 truncate mt-0.5">
                    {c.contactName ?? (c.contactEmails[0] ?? "—")}
                  </div>
                </Link>
              </div>
              <Link
                href={`/clients/${encodeURIComponent(c.id)}`}
                className="block group rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
              >
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  {c.encourageEmails ? (
                    <TouchpointPill
                      label={tpLabel}
                      lastSentAt={c.lastOutboundEmailAt}
                      isOverride={tpOverride}
                      showAge
                    />
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 text-ink/50 text-[10px] font-medium px-1.5 py-0.5"
                      title="Email cadence tracking is off for this client."
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                      Email-free
                    </span>
                  )}
                  <ClientHealthPill label={c.healthOverrideLabel} />
                  <span className="text-[10px] text-ink/55 tabular-nums">
                    {openCount} open
                  </span>
                </div>
              </Link>

              {/* Footer: team picker + mail toggle. Sits below the
                  link so clicks on them don't bubble into navigation. */}
              <div className="mt-2 pt-2 border-t border-white/60 flex items-center justify-between gap-1.5">
                <ClientTeamPicker
                  clientId={c.id}
                  teamId={c.teamId}
                  assignedUserId={c.assignedUserId}
                  canEdit={canEdit}
                  users={pickableUsers}
                  onAssigned={(patch) => updateClientAssignment(c.id, patch)}
                />
                <div className="flex items-center gap-1.5">
                  {c.priorityRank !== null && (
                    <span className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-md bg-white/85 text-ink/70 border border-white/80">
                      #{c.priorityRank}
                    </span>
                  )}
                  {canEdit && (
                    <EmailToggleButton
                      on={c.encourageEmails}
                      onToggle={() => toggleEncourageEmails(c.id, c.encourageEmails)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
}

// Client avatar tile. Renders the uploaded icon_url if set, otherwise
// the generic briefcase on the tone color. Hovering reveals an upload
// affordance for leaders (canEdit); the underlying <input type="file">
// is hidden and triggered via ref so the styling stays consistent
// across browsers. Used in both grid and list rendering.
function ClientIconAvatar({
  iconUrl, clientId, clientName, canEdit, size, fallbackBg, onUploaded
}: {
  iconUrl: string | null;
  clientId: string;
  clientName: string;
  canEdit: boolean;
  size: number;
  fallbackBg: string;
  onUploaded: (url: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(iconUrl);
  // Sync if a parent re-renders with a new url (e.g. after a different
  // upload elsewhere on the page).
  useEffect(() => { setLocalUrl(iconUrl); }, [iconUrl]);

  async function pickAndUpload(file: File) {
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/icon`, {
        method: "PATCH",
        body: fd
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? `Upload failed (${res.status})`);
        return;
      }
      setLocalUrl(data.iconUrl);
      onUploaded(data.iconUrl);
      toast.success(`Updated ${clientName}'s photo`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  const dim = { width: size, height: size };
  return (
    <label
      className={cn(
        "relative shrink-0 rounded-xl shadow-sm grid place-items-center overflow-hidden ring-1 ring-white/70",
        localUrl ? "bg-white" : `text-white ${fallbackBg}`,
        canEdit && "cursor-pointer group/icon"
      )}
      style={dim}
      title={canEdit ? `Click to upload a photo for ${clientName}` : clientName}
      onClick={(e) => {
        // The label naturally clicks its hidden input; stop the click
        // from also bubbling into the parent Link.
        e.stopPropagation();
      }}
    >
      {localUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={localUrl}
          alt={clientName}
          style={dim}
          className="object-cover"
        />
      ) : (
        <Briefcase className="w-1/2 h-1/2" />
      )}
      {canEdit && (
        <>
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = ""; // allow re-selecting the same file
              if (f) void pickAndUpload(f);
            }}
          />
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 bg-black/50 text-white text-[9px] uppercase tracking-wider font-semibold grid place-items-center transition-opacity",
              busy ? "opacity-100" : "opacity-0 group-hover/icon:opacity-100"
            )}
          >
            {busy ? "…" : (localUrl ? "Change" : "Add")}
          </span>
        </>
      )}
    </label>
  );
}

// Small mail-on / mail-off icon button. Click flips
// encourage_emails for the client. We surface this inline on every
// card so leaders don't have to open the detail page to silence
// touchpoint nags for non-email clients.
function EmailToggleButton({
  on, onToggle
}: { on: boolean; onToggle: () => void | Promise<void> }) {
  return (
    <Tooltip
      label={on
        ? "Email cadence ON. Click to stop tracking outbound emails for this client (hides the touchpoint pill everywhere)."
        : "Email cadence OFF. Click to start tracking outbound touchpoints for this client again."}
    >
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void onToggle(); }}
        aria-label={on ? "Turn off email cadence tracking" : "Turn on email cadence tracking"}
        className={cn(
          "inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors",
          on
            ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
            : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
        )}
      >
        {on ? <Mail className="w-3.5 h-3.5" /> : <MailX className="w-3.5 h-3.5" />}
      </button>
    </Tooltip>
  );
}

function FilterChip({
  active, onClick, label, count, dotClass
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  dotClass?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors",
        active
          ? "bg-ink text-white border-ink"
          : "bg-white text-ink/70 border-slate-200 hover:border-ink/40"
      )}
    >
      {dotClass && <span className={cn("w-1.5 h-1.5 rounded-full", dotClass)} />}
      {label}
      <span className={cn("tabular-nums opacity-70", !active && "text-ink/50")}>
        · {count}
      </span>
    </button>
  );
}

function SortChip({
  active, onClick, icon, label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors",
        active
          ? "bg-accent/10 text-accent border-accent/30"
          : "bg-white text-ink/70 border-slate-200 hover:border-ink/40"
      )}
    >
      {icon} {label}
    </button>
  );
}

// Exported for use elsewhere (e.g. dashboard widget) — re-export
// keeps the import surface minimal.
export { daysSince };
