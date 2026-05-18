"use client";

import Link from "next/link";
import { useState } from "react";
import {
  DragDropContext, Droppable, Draggable, type DropResult
} from "@hello-pangea/dnd";
import { Briefcase, Globe2, GripVertical, Folder, User as UserIcon, Mail } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Client } from "@/lib/clients-data";
import { ClientHealthPill } from "./ClientHealthPill";

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

interface Props {
  initial: Client[];
  openCounts: Record<string, number>;
  canEdit: boolean;
}

export function ClientPriorityList({ initial, openCounts, canEdit }: Props) {
  const [clients, setClients] = useState(initial);

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
    <DragDropContext onDragEnd={onDragEnd}>
      <Droppable droppableId="clients" isDropDisabled={!canEdit}>
        {(prov) => (
          <ol
            ref={prov.innerRef}
            {...prov.droppableProps}
            className="space-y-2.5"
          >
            {clients.map((c, i) => {
              const tone = PALETTE[i % PALETTE.length];
              const openCount = openCounts[c.name] ?? 0;
              return (
                <Draggable key={c.id} draggableId={c.id} index={i} isDragDisabled={!canEdit}>
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
                          {i + 1}
                        </div>

                        {/* Drag handle (only for Leader) */}
                        {canEdit && (
                          <span
                            {...p.dragHandleProps}
                            aria-label="Drag to reorder"
                            role="button"
                            className="shrink-0 text-muted hover:text-ink cursor-grab active:cursor-grabbing transition-colors outline-none focus-visible:text-indigo-600"
                          >
                            <GripVertical className="w-4 h-4" />
                          </span>
                        )}

                        {/* Icon tile */}
                        <div className={`w-10 h-10 rounded-xl shadow-sm grid place-items-center text-white shrink-0 ${tone.iconBg}`}>
                          <Briefcase className="w-5 h-5" />
                        </div>

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
                            {/* Health pill: override label wins over the
                                cron-computed one. Hidden entirely if
                                neither is set so brand-new clients
                                don't show a blank/grey pill. */}
                            <ClientHealthPill
                              label={c.healthOverrideLabel ?? c.healthLabel}
                              overridden={!!c.healthOverrideLabel}
                            />
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
                          {c.contactEmails.length > 0 && (
                            <div className="text-[10px] text-ink/50 truncate inline-flex items-center gap-1 mt-0.5">
                              <Mail className="w-2.5 h-2.5" />
                              {c.contactEmails.slice(0, 2).join(", ")}
                              {c.contactEmails.length > 2 ? ` +${c.contactEmails.length - 2}` : ""}
                            </div>
                          )}
                        </Link>

                        {/* Rank + priority chips */}
                        <div className="flex items-center gap-1.5 shrink-0">
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
  );
}
