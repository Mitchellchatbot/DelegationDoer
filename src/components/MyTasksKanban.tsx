"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { Clock } from "lucide-react";
import { PriorityBadge, StalledBadge, Tag } from "./Badges";
import { Countdown } from "./Countdown";
import { PersonAvatar } from "./PersonAvatar";
import { useTeam } from "@/lib/team-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus } from "@/lib/types";

// Notion-style Kanban for the current user's tasks. Five columns mapped
// 1:1 to the task_status enum. Drag a card to a column → PATCH the new
// status; on completion, the existing skill-XP toast fires from the API
// route just like elsewhere.

interface ColumnDef {
  id: TaskStatus;
  label: string;
  // Subtle tone tints per column so each one reads at a glance without
  // shouting. Borders + count pills carry the color; the surface stays
  // mostly neutral so cards pop.
  ring: string;
  countBg: string;
  countText: string;
  emptyHint: string;
}

const COLUMNS: ColumnDef[] = [
  {
    id: "pending",
    label: "Not started",
    ring: "border-slate-200/70",
    countBg: "bg-slate-100",
    countText: "text-slate-700",
    emptyHint: "Nothing in the queue."
  },
  {
    id: "urgent",
    label: "Urgent",
    ring: "border-rose-200/70",
    countBg: "bg-rose-100",
    countText: "text-rose-700",
    emptyHint: "No fires today."
  },
  {
    id: "in_progress",
    label: "In progress",
    ring: "border-blue-200/70",
    countBg: "bg-blue-100",
    countText: "text-blue-700",
    emptyHint: "Pick one to start."
  },
  {
    id: "waiting_on_client",
    label: "Waiting on client",
    ring: "border-amber-200/70",
    countBg: "bg-amber-100",
    countText: "text-amber-700",
    emptyHint: "Nothing blocked."
  },
  {
    id: "done",
    label: "Done",
    ring: "border-emerald-200/70",
    countBg: "bg-emerald-100",
    countText: "text-emerald-700",
    emptyHint: "Ship something today 🚀"
  }
];

export function MyTasksKanban({ initialTasks }: { initialTasks: Task[] }) {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>(initialTasks);

  const grouped: Record<TaskStatus, Task[]> = {
    pending: [],
    urgent: [],
    in_progress: [],
    waiting_on_client: [],
    done: []
  };
  for (const t of tasks) {
    if (grouped[t.status]) grouped[t.status].push(t);
  }
  // Sort each column: priority desc, then due-date asc.
  const PRI: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const k of Object.keys(grouped) as TaskStatus[]) {
    grouped[k].sort((a, b) => {
      const p = PRI[a.priority] - PRI[b.priority];
      if (p !== 0) return p;
      const aDue = a.dueDate ? +new Date(a.dueDate) : Infinity;
      const bDue = b.dueDate ? +new Date(b.dueDate) : Infinity;
      return aDue - bDue;
    });
  }

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    const dest = result.destination.droppableId as TaskStatus;
    const id = result.draggableId;
    const before = tasks.find((t) => t.id === id);
    if (!before || before.status === dest) return;

    // Optimistic — the card snaps into the destination column instantly.
    setTasks((cur) =>
      cur.map((t) =>
        t.id === id ? { ...t, status: dest, lastActivityAt: new Date().toISOString() } : t
      )
    );

    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: dest })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);

      if (dest === "done") {
        toast.success(`✅ ${before.title}`);
        const gains = data?.skillGains as { tag: string; gain: number; total: number }[] | undefined;
        if (gains && gains.length > 0) {
          const list = gains.map((g) => `+${g.gain} #${g.tag}`).join(" · ");
          toast.success(`✨ Skill XP: ${list}`, { duration: 4500 });
        }
      }
      // Refresh server data so other surfaces (analytics, dashboard)
      // pick up the change too.
      router.refresh();
    } catch (e) {
      toast.error(`Status change failed: ${e instanceof Error ? e.message : "network error"}`);
      setTasks((cur) =>
        cur.map((t) => (t.id === id ? { ...t, status: before.status } : t))
      );
    }
  }

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="overflow-x-auto pb-2 -mx-1 px-1">
        <div className="flex gap-3 min-w-max">
          {COLUMNS.map((col, colIdx) => (
            <Column
              key={col.id}
              col={col}
              tasks={grouped[col.id] ?? []}
              animationDelay={colIdx * 40}
            />
          ))}
        </div>
      </div>
    </DragDropContext>
  );
}

function Column({
  col, tasks, animationDelay
}: {
  col: ColumnDef;
  tasks: Task[];
  animationDelay: number;
}) {
  const router = useRouter();
  return (
    // Plain div + CSS opacity animation. Critically, no `transform` ever
    // lands on this element — that would create a containing block for
    // position:fixed and break @hello-pangea/dnd's drag clone (cards
    // would get "stuck" mid-flight). The header pill below uses framer
    // motion safely because the popping happens on a non-ancestor.
    <div
      className={cn(
        "rounded-2xl bg-white border shadow-soft shrink-0 w-[300px] flex flex-col anim-fade-in",
        col.ring
      )}
      style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "both" }}
    >
      <div className="px-3.5 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-ink">{col.label}</div>
        <span
          key={tasks.length}
          className={cn(
            "inline-flex items-center justify-center min-w-[24px] h-[22px] px-2 rounded-full text-[11px] font-semibold tabular-nums anim-scale-in",
            col.countBg,
            col.countText
          )}
        >
          {tasks.length}
        </span>
      </div>
      <Droppable droppableId={col.id}>
        {(prov, snap) => (
          <div
            ref={prov.innerRef}
            {...prov.droppableProps}
            className={cn(
              "flex-1 px-2 pb-2 pt-1 space-y-2 min-h-[180px] max-h-[calc(100vh-340px)] overflow-y-auto transition-colors rounded-b-2xl",
              snap.isDraggingOver && "bg-accent/5 ring-2 ring-accent/20"
            )}
          >
            {tasks.map((t, i) => (
                <Draggable draggableId={t.id} index={i} key={t.id}>
                  {(p, s) => {
                    const card = (
                      <CardInner
                        task={t}
                        provided={p}
                        isDragging={s.isDragging}
                        onOpen={() => router.push(`/tasks/${t.id}`)}
                      />
                    );
                    // Portal the card into <body> while dragging so it
                    // bypasses every ancestor's stacking context. Without
                    // this the card slides behind whatever column it
                    // hovers over.
                    return s.isDragging
                      ? <PortalToBody>{card}</PortalToBody>
                      : card;
                  }}
                </Draggable>
              ))}
            {prov.placeholder}
            {tasks.length === 0 && !snap.isDraggingOver && (
              <div className="text-[11px] text-muted italic text-center py-6">
                {col.emptyHint}
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

/* ============================ CARD ============================ */

// Tone presets per priority/stalled — same gradient family as TaskCard,
// but rendered inline so the Draggable owns the DOM node directly. No
// nested Link/anchor → drag handlers stay clean.
type Priority = "critical" | "high" | "medium" | "low";

const TINT: Record<Priority, { bg: string; border: string }> = {
  critical: { bg: "bg-gradient-to-br from-rose-100/80 via-white/70 to-white/60", border: "border-rose-200/70" },
  high:     { bg: "bg-gradient-to-br from-amber-100/80 via-white/70 to-white/60", border: "border-amber-200/70" },
  medium:   { bg: "bg-gradient-to-br from-blue-100/80 via-indigo-50/65 to-white/60", border: "border-blue-200/70" },
  low:      { bg: "bg-gradient-to-br from-slate-100/70 via-white/70 to-white/60", border: "border-slate-200/60" }
};
const STALLED_TINT = {
  bg: "bg-gradient-to-br from-yellow-100/80 via-white/70 to-white/60",
  border: "border-yellow-300/60"
};

// Lazy portal target — renders nothing on SSR, then portals into
// document.body once mounted. Used while dragging so the dragged element
// escapes every parent stacking context.
function PortalToBody({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return <>{children}</>;
  return createPortal(children, document.body);
}

function CardInner({
  task: t, provided: p, isDragging, onOpen
}: {
  task: Task;
  provided: any;
  isDragging: boolean;
  onOpen: () => void;
}) {
  const tint = t.inactiveFlag ? STALLED_TINT : TINT[t.priority as Priority];
  const { userById } = useTeam();
  const assignee = t.assigneeId ? userById(t.assigneeId) : null;
  return (
    <div
      ref={p.innerRef}
      {...p.draggableProps}
      {...p.dragHandleProps}
      // While dragging, force a very high z-index. dnd's default isn't
      // always enough to beat sibling stacking contexts (especially when
      // the destination column is empty and its bg paints at the same
      // layer as the card). 9999 wins.
      style={{
        ...p.draggableProps.style,
        ...(isDragging ? { zIndex: 9999 } : null)
      }}
      className={cn(
        "rounded-2xl border p-3 cursor-pointer transition-shadow",
        tint.bg,
        tint.border,
        isDragging
          ? "ring-2 ring-accent/50 shadow-lift"
          : "hover:shadow-soft"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium leading-snug text-ink flex-1">
          {t.title}
        </div>
        <PriorityBadge priority={t.priority} />
      </div>
      {(t.tags.length > 0 || t.inactiveFlag) && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {t.tags.slice(0, 3).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {t.inactiveFlag && <StalledBadge />}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-between text-xs text-muted">
        <div className="flex items-center gap-1.5 min-w-0">
          {assignee ? (
            <>
              <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl} size={18} />
              <span className="truncate">{assignee.name}</span>
            </>
          ) : (
            <span className="text-muted">Unassigned</span>
          )}
        </div>
        <span className="inline-flex items-center gap-1 shrink-0">
          <Clock className="w-3 h-3" />
          <Countdown iso={t.dueDate} />
        </span>
      </div>
      {/* Tiny "Open" link in the corner for navigation. Decoupled from
          the drag-handle div so it doesn't fight pointer events. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        className="mt-2 text-[11px] text-accent hover:underline"
      >
        Open task →
      </button>
    </div>
  );
}
