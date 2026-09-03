"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { StickyNote, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/Avatar";
import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/utils";
import { teamMeta, type TeamId } from "@/lib/client-teams";

// One client as this board needs it — deliberately a narrow projection of
// lib/clients-data.ts:Client so the server doesn't ship 40 unused columns
// (health, touchpoints, WP counts, ...) into the browser on every load.
export type HealthLabel = "thriving" | "steady" | "shaky" | "at_risk" | null;

export interface BoardClient {
  id: string;
  name: string;
  website: string | null;
  iconUrl: string | null;
  teamId: string | null;
  assignedUserIds: string[];
  // Ranking inputs.
  displayOrder: number;
  priorityRank: number | null;
  health: HealthLabel;
  lastOutboundEmailAt: string | null;
  // Mitch's quick notes, edited inline on this board.
  notes: string | null;
}

// How the client cards within each column are ordered.
export type ClientSortMode = "importance" | "health" | "time" | "name";

// Worst-first health order (at-risk clients surface first).
const HEALTH_ORDER: Record<string, number> = { at_risk: 0, shaky: 1, steady: 2, thriving: 3 };
function healthRankOf(h: HealthLabel): number {
  return h && h in HEALTH_ORDER ? HEALTH_ORDER[h] : 99;
}
// Importance = the leader's manual drag order (display_order), then the sheet's
// priorityRank, then name. This is the same ordering /clients uses.
function importanceCmp(a: BoardClient, b: BoardClient): number {
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
  const ar = a.priorityRank ?? Number.POSITIVE_INFINITY;
  const br = b.priorityRank ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return a.name.localeCompare(b.name);
}
function comparatorFor(mode: ClientSortMode): (a: BoardClient, b: BoardClient) => number {
  if (mode === "name") return (a, b) => a.name.localeCompare(b.name);
  if (mode === "health") {
    return (a, b) => healthRankOf(a.health) - healthRankOf(b.health) || a.name.localeCompare(b.name);
  }
  if (mode === "time") {
    // Stalest first: oldest (or never-contacted) last-outbound at the top.
    return (a, b) => {
      const at = a.lastOutboundEmailAt ? Date.parse(a.lastOutboundEmailAt) : -Infinity;
      const bt = b.lastOutboundEmailAt ? Date.parse(b.lastOutboundEmailAt) : -Infinity;
      return at - bt || a.name.localeCompare(b.name);
    };
  }
  return importanceCmp;
}

export interface BoardUser {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

// The buckets rendered as columns, left to right. The trailing `null`
// column is "Unassigned" — it has to exist even when it's empty, because
// it's the only drop target that can take a client OFF a lead's plate.
export interface BoardColumn {
  teamId: TeamId | null;
  label: string;
  leadEmail?: string;
  /** Direct reports of the lead, from the org chart. Shown on hover. */
  members: string[];
}

const UNASSIGNED = "__unassigned__";

export function ClientTeamsBoard({
  clients: initial,
  users,
  columns,
  canEdit
}: {
  clients: BoardClient[];
  users: BoardUser[];
  columns: BoardColumn[];
  canEdit: boolean;
}) {
  const [clients, setClients] = useState(initial);
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ClientSortMode>("importance");

  // Per-column rank that EXACTLY matches the visual order of the cards in each
  // lead's column: top card = 1, next = 2, ... down to N (the column count).
  // It uses the same comparator as the rendered list, so under the Importance
  // sort the number IS the drag ranking, and it always reads top-to-bottom.
  // Each column numbers 1..N on its own (Bismah's #1 is unrelated to Samir's).
  const rankById = useMemo(() => {
    const m = new Map<string, number>();
    const groups = new Map<string, BoardClient[]>();
    for (const c of clients) {
      const key = c.teamId ?? UNASSIGNED;
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }
    const cmp = comparatorFor(sortMode);
    for (const arr of groups.values()) {
      arr.sort(cmp);
      arr.forEach((c, i) => m.set(c.id, i + 1));
    }
    return m;
  }, [clients, sortMode]);

  // Re-sync when the server re-renders (e.g. after a client is created
  // elsewhere and the user navigates back). Without this the board would
  // keep showing whatever local state it was left in.
  useEffect(() => { setClients(initial); }, [initial]);

  const usersById = useMemo(() => {
    const m = new Map<string, BoardUser>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  const leadByEmail = useMemo(() => {
    const m = new Map<string, BoardUser>();
    for (const u of users) if (u.email) m.set(u.email.trim().toLowerCase(), u);
    return m;
  }, [users]);

  // Filter is a *display* filter only. Dragging while a filter is active
  // would reorder against a partial list, so the drag handles are disabled
  // below whenever `query` is non-empty.
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (q ? clients.filter((c) =>
      c.name.toLowerCase().includes(q) || (c.website ?? "").toLowerCase().includes(q)
    ) : clients),
    [clients, q]
  );

  const byColumn = useMemo(() => {
    const m = new Map<string, BoardClient[]>();
    for (const col of columns) m.set(col.teamId ?? UNASSIGNED, []);
    for (const c of visible) {
      const key = c.teamId ?? UNASSIGNED;
      // A client owned by a non-SEO team (Websites / Software) simply has
      // no column here — skip rather than dumping it into Unassigned,
      // which would misrepresent it as unowned.
      const bucket = m.get(key);
      if (bucket) bucket.push(c);
    }
    const cmp = comparatorFor(sortMode);
    for (const bucket of m.values()) bucket.sort(cmp);
    return m;
  }, [visible, columns, sortMode]);

  async function onDragEnd(res: DropResult) {
    setActiveDrag(null);
    const { draggableId, source, destination } = res;
    if (!destination) return;

    // Same column → this is a RANK reorder (only under the Importance sort,
    // for editors, with no active filter). Persists the global display_order.
    if (destination.droppableId === source.droppableId) {
      if (sortMode !== "importance" || !canEdit || q || source.index === destination.index) return;
      await reorderWithinColumn(source.droppableId, source.index, destination.index, draggableId);
      return;
    }

    const nextTeam = destination.droppableId === UNASSIGNED
      ? null
      : (destination.droppableId as TeamId);
    const prevTeam = source.droppableId === UNASSIGNED ? null : source.droppableId;
    const moved = clients.find((c) => c.id === draggableId);

    // Optimistic — the card lands instantly, then we reconcile. A failed
    // PATCH rolls the single card back rather than refetching the board,
    // so a concurrent edit by someone else isn't clobbered.
    setClients((cur) => cur.map((c) => (c.id === draggableId ? { ...c, teamId: nextTeam } : c)));

    try {
      const r = await fetch(`/api/clients/${draggableId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: nextTeam })
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const to = teamMeta(nextTeam)?.label ?? "Unassigned";
      toast.success(`${moved?.name ?? "Client"} → ${to}`);
    } catch (e) {
      setClients((cur) =>
        cur.map((c) => (c.id === draggableId ? { ...c, teamId: prevTeam as string | null } : c))
      );
      toast.error(
        `Couldn't move ${moved?.name ?? "client"}: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
  }

  // Reorder a client within its column to change its importance rank. The
  // rank is a GLOBAL order (display_order), so we splice the moved client into
  // the global importance order just ahead of its new in-column neighbour, then
  // persist the whole order. Optimistic with rollback (mirrors /clients).
  async function reorderWithinColumn(colKey: string, fromIdx: number, toIdx: number, movedId: string) {
    const colList = byColumn.get(colKey) ?? [];
    const moved = colList[fromIdx];
    if (!moved || moved.id !== movedId) return;

    const newCol = [...colList];
    newCol.splice(fromIdx, 1);
    newCol.splice(toIdx, 0, moved);
    const nextNeighbour = newCol[toIdx + 1];

    const globalSorted = [...clients].sort(importanceCmp).filter((c) => c.id !== moved.id);
    let insertAt = nextNeighbour ? globalSorted.findIndex((c) => c.id === nextNeighbour.id) : globalSorted.length;
    if (insertAt < 0) insertAt = globalSorted.length;
    globalSorted.splice(insertAt, 0, moved);

    const orderById = new Map(globalSorted.map((c, i) => [c.id, (i + 1) * 100]));
    const newRank = globalSorted.findIndex((c) => c.id === moved.id) + 1;
    const before = clients;
    setClients((cur) => cur.map((c) => ({ ...c, displayOrder: orderById.get(c.id) ?? c.displayOrder })));

    try {
      const r = await fetch("/api/clients/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: globalSorted.map((c) => c.id) })
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      toast.success(`Ranked ${moved.name} #${newRank}`);
    } catch (e) {
      setClients(before);
      toast.error(`Couldn't save ranking: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  // Save a client's inline notes (the "jot without leaving" affordance).
  // Optimistic with rollback, same posture as the other mutations here.
  async function saveNotes(id: string, notes: string) {
    const value = notes.trim() ? notes : null;
    const before = clients;
    setClients((cur) => cur.map((c) => (c.id === id ? { ...c, notes: value } : c)));
    try {
      const r = await fetch(`/api/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: value })
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      toast.success("Notes saved");
    } catch (e) {
      setClients(before);
      toast.error(`Couldn't save notes: ${e instanceof Error ? e.message : "unknown error"}`);
      throw e;
    }
  }

  const dragEnabled = canEdit && !q;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter clients…"
          className="px-3 py-1.5 rounded-full text-xs bg-white border border-slate-200 text-ink placeholder:text-muted focus:outline-none focus:border-accent/50 w-56"
        />
        <div className="inline-flex items-center gap-0.5 rounded-full bg-white border border-slate-200 p-0.5 shadow-sm">
          <span className="pl-2 pr-1 text-[10px] uppercase tracking-wide text-ink/40 font-semibold">Rank</span>
          {([
            ["importance", "Importance"],
            ["health", "Health"],
            ["time", "Time since contact"],
            ["name", "A–Z"]
          ] as [ClientSortMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setSortMode(mode)}
              className={cn(
                "px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
                sortMode === mode ? "bg-accent/10 text-accent" : "text-ink/55 hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted">
          {!canEdit
            ? "Read-only — only Mitch, Sam, Tabrez and Farez can change this."
            : q
              ? "Clear the filter to drag."
              : sortMode === "importance"
                ? "Drag to rank (top = #1) · drag between leads to reassign."
                : "Drag between leads to reassign · switch to Importance to drag-rank."}
        </span>
      </div>

      <DragDropContext
        onDragEnd={onDragEnd}
        onDragStart={(s) => setActiveDrag(s.source.droppableId)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((col) => {
            const key = col.teamId ?? UNASSIGNED;
            const list = byColumn.get(key) ?? [];
            const lead = col.leadEmail ? leadByEmail.get(col.leadEmail) : undefined;
            return (
              <Column
                key={key}
                droppableId={key}
                label={col.label}
                lead={lead}
                members={col.members}
                clients={list}
                usersById={usersById}
                rankById={rankById}
                dragEnabled={dragEnabled}
                canEdit={canEdit}
                onSaveNotes={saveNotes}
                activeDrag={activeDrag}
                unassigned={col.teamId === null}
              />
            );
          })}
        </div>
      </DragDropContext>
    </div>
  );
}

function Column({
  droppableId, label, lead, members, clients, usersById, rankById, dragEnabled, canEdit, onSaveNotes, activeDrag, unassigned
}: {
  droppableId: string;
  label: string;
  lead?: BoardUser;
  members: string[];
  clients: BoardClient[];
  usersById: Map<string, BoardUser>;
  rankById: Map<string, number>;
  dragEnabled: boolean;
  canEdit: boolean;
  onSaveNotes: (id: string, notes: string) => Promise<void>;
  activeDrag: string | null;
  unassigned: boolean;
}) {
  // Tooltip copy. Empty members is a real signal, not a blank — it means the
  // org chart has nobody reporting to this lead, which is worth saying out
  // loud rather than showing an empty bubble.
  const tip = unassigned
    ? "Clients with no SEO lead yet."
    : members.length
      ? `${label}'s team: ${members.join(", ")}`
      : `No one reports to ${label} in the org chart.`;
  return (
    // Plain div, no `transform` — a transform here would create a
    // containing block for position:fixed and strand @hello-pangea/dnd's
    // portaled drag clone mid-flight. Same constraint as OutboundLeadsBoard.
    <div
      className={cn(
        "rounded-2xl bg-white border shadow-soft shrink-0 w-[264px] flex flex-col",
        unassigned ? "border-dashed border-slate-300" : "border-slate-200"
      )}
    >
      <div className="px-3.5 pt-3 pb-2 flex items-center justify-between gap-2">
        <Tooltip label={tip}>
          <span className="flex items-center gap-2 min-w-0 cursor-default">
            {lead
              ? <Avatar name={lead.name} imageUrl={lead.avatarUrl} size={22} />
              : <span className={cn("w-2 h-2 rounded-full shrink-0", unassigned ? "bg-slate-300" : "bg-emerald-500")} />}
            <span className="text-[13px] font-semibold text-ink truncate">{label}</span>
            {members.length > 0 && (
              <span className="text-[10.5px] text-muted tabular-nums shrink-0">
                +{members.length}
              </span>
            )}
          </span>
        </Tooltip>
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[24px] h-[22px] px-2 rounded-full text-[11px] font-semibold tabular-nums",
            unassigned ? "bg-slate-100 text-slate-600" : "bg-emerald-100 text-emerald-700"
          )}
        >
          {clients.length}
        </span>
      </div>

      <Droppable droppableId={droppableId} isDropDisabled={!dragEnabled}>
        {(prov, snap) => (
          <div
            ref={prov.innerRef}
            {...prov.droppableProps}
            className={cn(
              "flex-1 px-2 pb-2 pt-1 space-y-2 min-h-[140px] max-h-[calc(100vh-330px)] overflow-y-auto transition-colors rounded-b-2xl",
              snap.isDraggingOver && "bg-accent/5 ring-2 ring-accent/20"
            )}
          >
            {clients.map((c, i) => (
              <Draggable draggableId={c.id} index={i} key={c.id} isDragDisabled={!dragEnabled}>
                {(p, s) => {
                  const card = (
                    <ClientCard
                      client={c}
                      provided={p}
                      isDragging={s.isDragging}
                      usersById={usersById}
                      rank={rankById.get(c.id)}
                      canEdit={canEdit}
                      onSaveNotes={onSaveNotes}
                    />
                  );
                  // Portal while dragging so the card escapes every ancestor
                  // stacking context instead of sliding behind a sibling column.
                  return s.isDragging ? <PortalToBody>{card}</PortalToBody> : card;
                }}
              </Draggable>
            ))}
            {prov.placeholder}
            {clients.length === 0 && !snap.isDraggingOver && (
              <div className="text-[11px] text-muted italic text-center py-6">
                {unassigned ? "Every SEO client has a lead." : "No clients yet."}
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

function PortalToBody({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return <>{children}</>;
  return createPortal(children, document.body);
}

function ClientCard({
  client, provided: p, isDragging, usersById, rank, canEdit, onSaveNotes
}: {
  client: BoardClient;
  provided: any;
  isDragging: boolean;
  usersById: Map<string, BoardUser>;
  rank?: number;
  canEdit: boolean;
  onSaveNotes: (id: string, notes: string) => Promise<void>;
}) {
  const people = client.assignedUserIds
    .map((id) => usersById.get(id))
    .filter((u): u is BoardUser => !!u);

  // Inline notes: clicking the name opens a jot box IN PLACE (no navigation to
  // the full client profile). A separate ↗ icon still opens the full view.
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(client.notes ?? "");
  const [saving, setSaving] = useState(false);
  const hasNotes = !!(client.notes && client.notes.trim());
  useEffect(() => { if (!open) setDraft(client.notes ?? ""); }, [client.notes, open]);

  async function save() {
    setSaving(true);
    try {
      await onSaveNotes(client.id, draft);
      setOpen(false);
    } catch {
      /* parent surfaces the error toast; keep the editor open to retry */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={p.innerRef}
      {...p.draggableProps}
      {...p.dragHandleProps}
      style={{ ...p.draggableProps.style, ...(isDragging ? { zIndex: 9999 } : null) }}
      className={cn(
        "rounded-xl border bg-white px-2.5 py-2 transition-shadow",
        isDragging ? "border-accent/40 shadow-lg" : "border-slate-200 hover:border-accent/30"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {client.iconUrl
          ? // eslint-disable-next-line @next/next/no-img-element
            <img src={client.iconUrl} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
          : <span className="w-5 h-5 rounded bg-slate-100 shrink-0" />}
        {canEdit ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            title="Click to add a note (stays on this tab)"
            className="flex-1 min-w-0 text-left text-[12.5px] font-medium text-ink hover:text-accent truncate inline-flex items-center gap-1"
          >
            <span className="truncate">{client.name}</span>
            {hasNotes && <StickyNote className="w-3 h-3 text-amber-500 shrink-0" />}
          </button>
        ) : (
          <Link
            href={`/clients/${client.id}`}
            className="flex-1 min-w-0 text-[12.5px] font-medium text-ink hover:text-accent truncate"
            onDragStart={(e) => e.preventDefault()}
          >
            {client.name}
          </Link>
        )}
        {/* Full profile — still reachable, just not on a plain name click. */}
        <Link
          href={`/clients/${client.id}`}
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => e.preventDefault()}
          title="Open full profile"
          aria-label="Open full profile"
          className="shrink-0 text-muted hover:text-accent"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
        {rank != null && (
          <span
            title={rank === 1 ? "Most important in this list" : `Importance rank #${rank} in this list`}
            className={cn(
              "shrink-0 inline-flex items-center justify-center min-w-[24px] h-[20px] px-1.5 rounded-full text-[11px] font-semibold tabular-nums",
              rank === 1 ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300" : "bg-slate-100 text-ink/60"
            )}
          >
            {rank}
          </span>
        )}
      </div>

      {people.length > 0 && (
        <Tooltip label={`Point ${people.length === 1 ? "person" : "people"}: ${people.map((u) => u.name).join(", ")}`}>
          <span className="flex items-center gap-1 mt-1.5 pl-7 cursor-default">
            {people.slice(0, 4).map((u) => (
              <Avatar key={u.id} name={u.name} imageUrl={u.avatarUrl} size={16} />
            ))}
            {people.length > 4 && (
              <span className="text-[10px] text-muted">+{people.length - 4}</span>
            )}
          </span>
        </Tooltip>
      )}

      {open && (
        // stopPropagation so typing / selecting text in the box never starts a
        // card drag or bubbles a click up to the drag handle.
        <div className="mt-2" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
            placeholder={`Notes on ${client.name}…`}
            className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { setDraft(client.notes ?? ""); setOpen(false); }}
              className="text-[11px] text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white transition-colors",
                saving ? "bg-slate-300 cursor-not-allowed" : "bg-accent hover:bg-accent/90"
              )}
            >
              {saving ? "Saving…" : "Save notes"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
