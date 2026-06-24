"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { Phone, Mail, Clock, ExternalLink, Inbox } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useHorizontalDragAutoScroll } from "@/lib/useHorizontalDragAutoScroll";
import {
  SEQUENCE_BOARD_ORDER, FLOW_META, canMoveToSequence, type FlowKey
} from "@/lib/outbound-flow-config";
import { STAGE_META } from "@/lib/outbound-stages";
import type { FlowLeadCard } from "@/lib/outbound-leads";
import type { OutboundTypeformForm } from "@/lib/outbound-typeform-forms";

// Notion-style kanban of the SMS nurture sequences. Columns map 1:1 to the
// three flows (Booking / Recovery / Engagement); each card is a lead currently
// being nurtured in that flow. Drag a card to a column → POST the new sequence,
// which cancels the lead's current pending messages and schedules the target
// drip. Booking is "out-only": you can drag a lead OUT of Booking into a drip,
// but dragging INTO Booking is rejected (booking comes from Calendly).

interface Props {
  cards: FlowLeadCard[];
  forms: OutboundTypeformForm[];
}

function timeUntil(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

const EMPTY = (): Record<FlowKey, FlowLeadCard[]> => ({ booking: [], recovery: [], engagement: [] });

export function OutboundSequenceBoard({ cards: initial, forms }: Props) {
  const router = useRouter();
  const { containerRef, onDragStart, onDragEnd: stopAutoScroll, resolveDroppableId } =
    useHorizontalDragAutoScroll();
  const [cards, setCards] = useState<FlowLeadCard[]>(initial);
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const labelForForm = (c: FlowLeadCard): string | null => {
    if (!c.typeformFormId) return null;
    return forms.find((f) => f.id === c.typeformFormId)?.label ?? "Unregistered form";
  };

  const visible = sourceFilter === "all"
    ? cards
    : cards.filter((c) => c.typeformFormId === sourceFilter);

  const grouped = EMPTY();
  for (const c of visible) {
    if (grouped[c.flow]) grouped[c.flow].push(c);
  }
  for (const k of Object.keys(grouped) as FlowKey[]) {
    grouped[k].sort((a, b) => {
      const av = a.nextScheduledFor ? +new Date(a.nextScheduledFor) : Infinity;
      const bv = b.nextScheduledFor ? +new Date(b.nextScheduledFor) : Infinity;
      return av - bv;
    });
  }

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    // Re-resolve against the live DOM so a drop after horizontal auto-scroll
    // lands in the column actually under the cursor (not the library's
    // pre-scroll destination).
    const dest = resolveDroppableId(result.destination.droppableId) as FlowKey;
    const id = result.draggableId;
    const before = cards.find((c) => c.leadId === id);
    if (!before || before.flow === dest) return;

    const who = before.name ?? before.phone;
    if (!canMoveToSequence(dest)) {
      toast.error(
        dest === "booking"
          ? "Booking is set when a Calendly meeting is booked — drag elsewhere."
          : `Can't move ${who} into ${FLOW_META[dest].label}.`
      );
      return;
    }

    // Optimistic — the card snaps into the destination column instantly.
    setCards((cur) => cur.map((c) => (c.leadId === id ? { ...c, flow: dest } : c)));

    try {
      const res = await fetch(`/api/outbound/leads/${id}/sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: dest })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(`${who} → ${FLOW_META[dest].label}`);
      router.refresh();
    } catch (e) {
      toast.error(`Move failed: ${e instanceof Error ? e.message : "network error"}`);
      setCards((cur) => cur.map((c) => (c.leadId === id ? { ...c, flow: before.flow } : c)));
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
            {SEQUENCE_BOARD_ORDER.map((flow, colIdx) => (
              <Column
                key={flow}
                flow={flow}
                cards={grouped[flow] ?? []}
                labelForForm={labelForForm}
                onOpen={(id) => router.push(`/outbound-dashboard/leads/${id}`)}
                animationDelay={colIdx * 40}
              />
            ))}
          </div>
        </div>
      </DragDropContext>
    </div>
  );
}

function Column({
  flow, cards, labelForForm, onOpen, animationDelay
}: {
  flow: FlowKey;
  cards: FlowLeadCard[];
  labelForForm: (c: FlowLeadCard) => string | null;
  onOpen: (id: string) => void;
  animationDelay: number;
}) {
  const meta = FLOW_META[flow];
  return (
    // Plain div + CSS animation only — no `transform` on this element (it would
    // create a containing block for position:fixed and break the drag clone).
    <div
      className={cn(
        "rounded-2xl bg-white border shadow-soft shrink-0 w-[300px] flex flex-col anim-fade-in",
        meta.ring
      )}
      style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "both" }}
    >
      <div className="px-3.5 pt-3 pb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{meta.label}</div>
          <div className="text-[11px] text-ink/50 mt-0.5 leading-snug">{meta.description}</div>
        </div>
        <span
          key={cards.length}
          className={cn(
            "shrink-0 inline-flex items-center justify-center min-w-[24px] h-[22px] px-2 rounded-full text-[11px] font-semibold tabular-nums anim-scale-in",
            meta.countBg,
            meta.countText
          )}
        >
          {cards.length}
        </span>
      </div>
      <Droppable droppableId={flow}>
        {(prov, snap) => (
          <div
            ref={prov.innerRef}
            {...prov.droppableProps}
            className={cn(
              "flex-1 px-2 pb-2 pt-1 space-y-2 min-h-[160px] max-h-[calc(100vh-340px)] overflow-y-auto transition-colors rounded-b-2xl",
              snap.isDraggingOver && "bg-accent/5 ring-2 ring-accent/20"
            )}
          >
            {cards.map((c, i) => (
              <Draggable draggableId={c.leadId} index={i} key={c.leadId}>
                {(p, s) => {
                  const card = (
                    <CardInner
                      card={c}
                      provided={p}
                      isDragging={s.isDragging}
                      sourceLabel={labelForForm(c)}
                      onOpen={() => onOpen(c.leadId)}
                    />
                  );
                  return s.isDragging ? <PortalToBody>{card}</PortalToBody> : card;
                }}
              </Draggable>
            ))}
            {prov.placeholder}
            {cards.length === 0 && !snap.isDraggingOver && (
              <div className="text-[11px] text-muted italic text-center py-6">
                {meta.emptyHint}
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

function CardInner({
  card: c, provided: p, isDragging, sourceLabel, onOpen
}: {
  card: FlowLeadCard;
  provided: any;
  isDragging: boolean;
  sourceLabel: string | null;
  onOpen: () => void;
}) {
  const stage = STAGE_META[c.status];
  return (
    <div
      ref={p.innerRef}
      {...p.draggableProps}
      {...p.dragHandleProps}
      style={{ ...p.draggableProps.style, ...(isDragging ? { zIndex: 9999 } : null) }}
      className={cn(
        "rounded-2xl border bg-white p-3 cursor-pointer transition-shadow",
        isDragging ? "ring-2 ring-accent/50 shadow-lift" : "border-slate-200/70 hover:shadow-soft"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13.5px] font-medium leading-snug text-ink truncate">
          {c.name ?? "(no name)"}
        </div>
        <span className={cn(
          "shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-semibold",
          stage.pill
        )}>
          {stage.label}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-ink/55">
        <span className="inline-flex items-center gap-1 truncate">
          <Phone className="w-3 h-3 shrink-0" /> {c.phone}
        </span>
        {c.email && (
          <span className="inline-flex items-center gap-1 truncate">
            <Mail className="w-3 h-3 shrink-0" /> {c.email}
          </span>
        )}
      </div>
      <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-ink/55">
        <Clock className="w-3 h-3" /> next {timeUntil(c.nextScheduledFor)}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        {sourceLabel ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-50 border border-slate-200 text-[10.5px] text-ink/60 truncate max-w-[150px]">
            <Inbox className="w-3 h-3 shrink-0" /> {sourceLabel}
          </span>
        ) : <span />}
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
