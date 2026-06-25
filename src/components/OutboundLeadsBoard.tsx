"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { Phone, Mail, Calendar, ExternalLink, Inbox } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useHorizontalDragAutoScroll } from "@/lib/useHorizontalDragAutoScroll";
import {
  BOARD_COLUMN_ORDER, STAGE_META, canManuallyTransition, type LeadStatus
} from "@/lib/outbound-stages";
import type { OutboundLead } from "@/lib/outbound-leads";
import type { OutboundTypeformForm } from "@/lib/outbound-typeform-forms";

// Notion-style kanban for the outbound sales pipeline. Columns map 1:1 to the
// lead status stages (BOARD_COLUMN_ORDER). Drag a card to a column → POST the
// new status to /transition, which validates the move + runs the side effects
// (drip scheduling, SMS cancels, Slack). Booking is Calendly-only, so dropping
// INTO "Booked" (or any move outside MANUAL_TRANSITIONS) is rejected with a
// toast and the card snaps back.
//
// One board across every Typeform; a source dropdown filters by form and each
// card carries its source as a badge.

interface Props {
  leads: OutboundLead[];
  forms: OutboundTypeformForm[];
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const EMPTY_GROUPS = (): Record<LeadStatus, OutboundLead[]> => ({
  warm_lead: [], booked: [], showed: [], no_show: [], contract: [], success: [], lost: []
});

export function OutboundLeadsBoard({ leads: initialLeads, forms }: Props) {
  const router = useRouter();
  const { containerRef, onDragStart, onDragEnd: stopAutoScroll, resolveDroppableId, activeDroppableId } =
    useHorizontalDragAutoScroll();
  const [leads, setLeads] = useState<OutboundLead[]>(initialLeads);
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // form_id → label for the per-card source badge.
  const labelForForm = useMemo(() => {
    const m = new Map(forms.map((f) => [f.id, f.label]));
    return (lead: OutboundLead): string | null => {
      if (!lead.typeformFormId) return null;
      return m.get(lead.typeformFormId) ?? "Unregistered form";
    };
  }, [forms]);

  const visible = sourceFilter === "all"
    ? leads
    : leads.filter((l) => l.typeformFormId === sourceFilter);

  const grouped = EMPTY_GROUPS();
  for (const l of visible) {
    if (grouped[l.status]) grouped[l.status].push(l);
  }
  // Newest first within each column.
  for (const k of Object.keys(grouped) as LeadStatus[]) {
    grouped[k].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    // Re-resolve against the live DOM so a drop after horizontal auto-scroll
    // lands in the column actually under the cursor (not the library's
    // pre-scroll destination).
    const dest = resolveDroppableId(result.destination.droppableId) as LeadStatus;
    const id = result.draggableId;
    const before = leads.find((l) => l.id === id);
    if (!before || before.status === dest) return;

    const who = before.name ?? before.phone ?? before.email ?? "lead";
    if (!canManuallyTransition(before.status, dest)) {
      toast.error(
        dest === "booked"
          ? "Booking happens through Calendly — drag elsewhere."
          : `Can't move ${who} from ${STAGE_META[before.status].label} to ${STAGE_META[dest].label}.`
      );
      return;
    }

    // Optimistic — the card snaps into the destination column instantly.
    setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, status: dest } : l)));

    try {
      const res = await fetch(`/api/outbound/leads/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: dest })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(`${who} → ${STAGE_META[dest].label}`);
      // Refresh server data so the funnel strip + table view pick up the move.
      router.refresh();
    } catch (e) {
      toast.error(`Move failed: ${e instanceof Error ? e.message : "network error"}`);
      setLeads((cur) =>
        cur.map((l) => (l.id === id ? { ...l, status: before.status } : l))
      );
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <label className="text-[12px] text-ink/55">Source</label>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="text-[12.5px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-ink/80 focus:outline-none focus:ring-2 focus:ring-accent/20"
        >
          <option value="all">All sources</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
      </div>

      <DragDropContext
        onDragStart={onDragStart}
        onDragEnd={(r) => { stopAutoScroll(); void onDragEnd(r); }}
      >
        <div ref={containerRef} className="overflow-x-auto pb-2 -mx-1 px-1">
          <div className="flex gap-3 min-w-max">
            {BOARD_COLUMN_ORDER.map((status, colIdx) => (
              <Column
                key={status}
                status={status}
                leads={grouped[status] ?? []}
                labelForForm={labelForForm}
                onOpen={(id) => router.push(`/outbound-dashboard/leads/${id}`)}
                animationDelay={colIdx * 40}
                activeDroppableId={activeDroppableId}
              />
            ))}
          </div>
        </div>
      </DragDropContext>
    </div>
  );
}

function Column({
  status, leads, labelForForm, onOpen, animationDelay, activeDroppableId
}: {
  status: LeadStatus;
  leads: OutboundLead[];
  labelForForm: (lead: OutboundLead) => string | null;
  onOpen: (id: string) => void;
  animationDelay: number;
  activeDroppableId: string | null;
}) {
  const meta = STAGE_META[status];
  return (
    // Plain div + CSS opacity animation. No `transform` ever lands on this
    // element — that would create a containing block for position:fixed and
    // break @hello-pangea/dnd's drag clone (cards would get stuck mid-flight).
    <div
      className={cn(
        "rounded-2xl bg-white border shadow-soft shrink-0 w-[280px] flex flex-col anim-fade-in",
        meta.ring
      )}
      style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "both" }}
    >
      <div className="px-3.5 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-ink">{meta.label}</div>
        <span
          key={leads.length}
          className={cn(
            "inline-flex items-center justify-center min-w-[24px] h-[22px] px-2 rounded-full text-[11px] font-semibold tabular-nums anim-scale-in",
            meta.countBg,
            meta.countText
          )}
        >
          {leads.length}
        </span>
      </div>
      <Droppable droppableId={status}>
        {(prov, snap) => {
          // Prefer the live hit-tested column (correct during horizontal
          // auto-scroll); fall back to the library snapshot for keyboard drags.
          const over = activeDroppableId !== null
            ? activeDroppableId === status
            : snap.isDraggingOver;
          return (
          <div
            ref={prov.innerRef}
            {...prov.droppableProps}
            className={cn(
              "flex-1 px-2 pb-2 pt-1 space-y-2 min-h-[160px] max-h-[calc(100vh-360px)] overflow-y-auto transition-colors rounded-b-2xl",
              over && "bg-accent/5 ring-2 ring-accent/20"
            )}
          >
            {leads.map((lead, i) => (
              <Draggable draggableId={lead.id} index={i} key={lead.id}>
                {(p, s) => {
                  const card = (
                    <CardInner
                      lead={lead}
                      provided={p}
                      isDragging={s.isDragging}
                      sourceLabel={labelForForm(lead)}
                      onOpen={() => onOpen(lead.id)}
                    />
                  );
                  // Portal the dragged card into <body> so it escapes every
                  // ancestor stacking context (otherwise it slides behind the
                  // column it hovers over).
                  return s.isDragging ? <PortalToBody>{card}</PortalToBody> : card;
                }}
              </Draggable>
            ))}
            {prov.placeholder}
            {leads.length === 0 && !over && (
              <div className="text-[11px] text-muted italic text-center py-6">
                {meta.emptyHint}
              </div>
            )}
          </div>
          );
        }}
      </Droppable>
    </div>
  );
}

// Lazy portal target — renders inline on SSR, then portals into document.body
// once mounted. Used while dragging.
function PortalToBody({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return <>{children}</>;
  return createPortal(children, document.body);
}

function CardInner({
  lead, provided: p, isDragging, sourceLabel, onOpen
}: {
  lead: OutboundLead;
  provided: any;
  isDragging: boolean;
  sourceLabel: string | null;
  onOpen: () => void;
}) {
  return (
    <div
      ref={p.innerRef}
      {...p.draggableProps}
      {...p.dragHandleProps}
      // Force a high z-index while dragging — dnd's default isn't always
      // enough to beat a sibling column's background.
      style={{ ...p.draggableProps.style, ...(isDragging ? { zIndex: 9999 } : null) }}
      className={cn(
        "rounded-2xl border bg-white p-3 cursor-pointer transition-shadow",
        isDragging ? "ring-2 ring-accent/50 shadow-lift" : "border-slate-200/70 hover:shadow-soft"
      )}
    >
      <div className="text-[13.5px] font-medium leading-snug text-ink truncate">
        {lead.name ?? "(no name)"}
      </div>
      <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-ink/55">
        {lead.phone && (
          <span className="inline-flex items-center gap-1 truncate">
            <Phone className="w-3 h-3 shrink-0" /> {lead.phone}
          </span>
        )}
        {lead.email && (
          <span className="inline-flex items-center gap-1 truncate">
            <Mail className="w-3 h-3 shrink-0" /> {lead.email}
          </span>
        )}
      </div>
      {lead.meetingStartsAt && (
        <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-sky-700">
          <Calendar className="w-3 h-3" />
          {new Date(lead.meetingStartsAt).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
          })}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        {sourceLabel ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-50 border border-slate-200 text-[10.5px] text-ink/60 truncate max-w-[140px]">
            <Inbox className="w-3 h-3 shrink-0" /> {sourceLabel}
          </span>
        ) : (
          <span className="text-[10.5px] text-ink/35">{timeAgo(lead.createdAt)}</span>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline shrink-0"
        >
          Open <ExternalLink className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
