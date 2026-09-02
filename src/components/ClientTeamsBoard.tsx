"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { toast } from "sonner";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { teamMeta, type TeamId } from "@/lib/client-teams";

// One client as this board needs it — deliberately a narrow projection of
// lib/clients-data.ts:Client so the server doesn't ship 40 unused columns
// (health, touchpoints, WP counts, ...) into the browser on every load.
export interface BoardClient {
  id: string;
  name: string;
  website: string | null;
  iconUrl: string | null;
  teamId: string | null;
  assignedUserIds: string[];
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
    for (const bucket of m.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [visible, columns]);

  async function onDragEnd(res: DropResult) {
    setActiveDrag(null);
    const { draggableId, source, destination } = res;
    if (!destination || destination.droppableId === source.droppableId) return;

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
        <span className="text-[11px] text-muted">
          {canEdit
            ? q
              ? "Clear the filter to drag — reordering a filtered list would move the wrong card."
              : "Drag a client between leads to reassign them."
            : "Read-only. Ask a leader to reassign a client."}
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
                clients={list}
                usersById={usersById}
                dragEnabled={dragEnabled}
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
  droppableId, label, lead, clients, usersById, dragEnabled, activeDrag, unassigned
}: {
  droppableId: string;
  label: string;
  lead?: BoardUser;
  clients: BoardClient[];
  usersById: Map<string, BoardUser>;
  dragEnabled: boolean;
  activeDrag: string | null;
  unassigned: boolean;
}) {
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
        <div className="flex items-center gap-2 min-w-0">
          {lead
            ? <Avatar name={lead.name} imageUrl={lead.avatarUrl} size={22} />
            : <span className={cn("w-2 h-2 rounded-full shrink-0", unassigned ? "bg-slate-300" : "bg-emerald-500")} />}
          <span className="text-[13px] font-semibold text-ink truncate">{label}</span>
        </div>
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
  client, provided: p, isDragging, usersById
}: {
  client: BoardClient;
  provided: any;
  isDragging: boolean;
  usersById: Map<string, BoardUser>;
}) {
  const people = client.assignedUserIds
    .map((id) => usersById.get(id))
    .filter((u): u is BoardUser => !!u);

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
        <Link
          href={`/clients/${client.id}`}
          className="text-[12.5px] font-medium text-ink hover:text-accent truncate"
          // Otherwise the pointerdown that starts a drag also fires the link.
          onDragStart={(e) => e.preventDefault()}
        >
          {client.name}
        </Link>
      </div>
      {people.length > 0 && (
        <div className="flex items-center gap-1 mt-1.5 pl-7">
          {people.slice(0, 4).map((u) => (
            <Avatar key={u.id} name={u.name} imageUrl={u.avatarUrl} size={16} />
          ))}
          {people.length > 4 && (
            <span className="text-[10px] text-muted">+{people.length - 4}</span>
          )}
        </div>
      )}
    </div>
  );
}
