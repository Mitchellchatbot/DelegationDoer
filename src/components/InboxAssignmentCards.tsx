"use client";

// Card-game UI for managing inbox membership. One tab per inbox; the
// active tab shows a "hand" of currently assigned people on top and a
// "deck" of everyone else underneath. Drag from deck → hand to assign;
// hand → deck to remove. Drops are zone-based (rect intersect on
// dragEnd), so the target doesn't need pixel-perfect aim.
//
// State is local + optimistic; writes hit /api/inbox-assignments and
// reconcile from the server response. Same endpoints the old free-form
// graph used, so nothing on the server changes.

import * as Tabs from "@radix-ui/react-tabs";
import { motion, AnimatePresence, useAnimation, type PanInfo } from "framer-motion";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, UserPlus, Users as UsersIcon, Inbox as InboxIcon } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";
import { InviteToInboxDialog } from "./InviteToInboxDialog";
import { ROLE_LABELS } from "@/lib/auth";
import type { User } from "@/lib/types";
import type { InboxAssignment } from "@/lib/inbox-access";

interface InboxLite {
  id: string;
  email: string;
  display_name: string | null;
}

interface Props {
  inboxes: InboxLite[];
  users: User[];
  initialAssignments: InboxAssignment[];
}

type Zone = "hand" | "deck";

export function InboxAssignmentCards({ inboxes, users, initialAssignments }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [assignments, setAssignments] = useState<InboxAssignment[]>(initialAssignments);
  const [activeId, setActiveId] = useState<string>(() => {
    // Deep-link from the Microsoft OAuth callback: if the URL points us
    // at a freshly-connected account, open its tab on first render
    // instead of defaulting to the first inbox.
    const connected = searchParams?.get("connectedAccount");
    if (connected && inboxes.some((i) => i.id === connected)) return connected;
    return inboxes[0]?.id ?? "";
  });

  // Clear the OAuth query params after the deep-link has been honored so
  // a refresh doesn't keep snapping back to that tab — and toast the
  // success once.
  useEffect(() => {
    const oauth = searchParams?.get("oauth");
    const connected = searchParams?.get("connectedAccount");
    const email = searchParams?.get("connectedEmail");
    if (oauth === "microsoft_ok" && connected) {
      toast.success(email ? `Connected ${email}` : "Inbox connected");
      router.replace("/inboxes/manage", { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Index assignments by inbox once; cheap re-derive on mutations.
  const memberIdsByInbox = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of assignments) {
      const s = m.get(a.missiveAccountId) ?? new Set<string>();
      s.add(a.userId);
      m.set(a.missiveAccountId, s);
    }
    return m;
  }, [assignments]);

  const userById = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  // ----- Assignment mutations (optimistic; reconcile on response) -----

  async function addAssignment(userId: string, accountId: string) {
    const inbox = inboxes.find((i) => i.id === accountId);
    if (!inbox) return;
    const tempId = `__temp_${Date.now()}`;
    const optimistic: InboxAssignment = {
      id: tempId,
      userId,
      missiveAccountId: accountId,
      inboxEmail: inbox.email,
      inboxLabel: inbox.display_name,
      assignedBy: null,
      createdAt: new Date().toISOString()
    };
    setAssignments((cur) => [...cur, optimistic]);
    try {
      const res = await fetch("/api/inbox-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          missiveAccountId: accountId,
          inboxEmail: inbox.email,
          inboxLabel: inbox.display_name
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "failed");
      setAssignments((cur) =>
        cur.map((a) =>
          a.id === tempId
            ? {
                id: data.assignment.id,
                userId: data.assignment.user_id,
                missiveAccountId: data.assignment.missive_account_id,
                inboxEmail: data.assignment.inbox_email,
                inboxLabel: data.assignment.inbox_label,
                assignedBy: data.assignment.assigned_by,
                createdAt: data.assignment.created_at
              }
            : a
        )
      );
      toast.success("Dealt in");
    } catch (err) {
      setAssignments((cur) => cur.filter((a) => a.id !== tempId));
      toast.error(`Couldn't add: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async function removeAssignment(userId: string, accountId: string) {
    const before = assignments;
    setAssignments((cur) =>
      cur.filter((a) => !(a.userId === userId && a.missiveAccountId === accountId))
    );
    try {
      const url =
        `/api/inbox-assignments?userId=${encodeURIComponent(userId)}` +
        `&missiveAccountId=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "failed");
      }
      toast.success("Removed");
    } catch (err) {
      setAssignments(before);
      toast.error(`Couldn't remove: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return (
    <Tabs.Root value={activeId} onValueChange={setActiveId} className="card p-0 overflow-hidden">
      {/* ----- TAB STRIP ----- */}
      <Tabs.List
        className="flex items-end gap-1 px-3 pt-3 border-b border-slate-200/60 bg-gradient-to-b from-slate-50/80 to-white overflow-x-auto"
        aria-label="Inboxes"
      >
        {inboxes.map((inb) => {
          const count = memberIdsByInbox.get(inb.id)?.size ?? 0;
          return (
            <Tabs.Trigger
              key={inb.id}
              value={inb.id}
              className={
                "group relative shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-t-xl border border-b-0 text-[12px] font-medium transition-all " +
                "data-[state=active]:bg-white data-[state=active]:border-slate-200 data-[state=active]:text-ink data-[state=active]:shadow-[0_-2px_0_0_#2563EB_inset] " +
                "data-[state=inactive]:bg-transparent data-[state=inactive]:border-transparent data-[state=inactive]:text-ink/55 hover:data-[state=inactive]:text-ink"
              }
            >
              <Mail className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[180px]">
                {inb.display_name || inb.email}
              </span>
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-slate-100 text-slate-600 text-[10px] tabular-nums group-data-[state=active]:bg-blue-100 group-data-[state=active]:text-blue-700">
                {count}
              </span>
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>

      {/* ----- TAB CONTENT ----- */}
      {inboxes.map((inb) => (
        <Tabs.Content key={inb.id} value={inb.id} className="focus:outline-none">
          <InboxTabPanel
            inbox={inb}
            users={users}
            assignments={assignments.filter((a) => a.missiveAccountId === inb.id)}
            allAssignmentsForInbox={assignments.filter((a) => a.missiveAccountId === inb.id)}
            memberIds={memberIdsByInbox.get(inb.id) ?? new Set()}
            userById={userById}
            onAssign={(uid) => addAssignment(uid, inb.id)}
            onRemove={(uid) => removeAssignment(uid, inb.id)}
          />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

// ============================================================
// Per-inbox tab content: header + hand zone + deck zone
// ============================================================

function InboxTabPanel({
  inbox, users, assignments, memberIds, userById, onAssign, onRemove
}: {
  inbox: InboxLite;
  users: User[];
  assignments: InboxAssignment[];
  allAssignmentsForInbox: InboxAssignment[];
  memberIds: Set<string>;
  userById: Map<string, User>;
  onAssign: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  // Hand = current members. Deck = everyone else, in stable name order.
  const handUsers = useMemo(
    () =>
      assignments
        .map((a) => userById.get(a.userId))
        .filter((u): u is User => !!u)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [assignments, userById]
  );
  const handIds = useMemo(() => new Set(handUsers.map((u) => u.id)), [handUsers]);
  const deckUsers = useMemo(
    () =>
      users
        .filter((u) => !handIds.has(u.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [users, handIds]
  );

  // Refs to the two drop zones — we measure their bounding rects on
  // dragEnd to decide where a card landed. Done with refs (not state)
  // so we never re-render the panel just to track drag.
  const handRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const [hoverZone, setHoverZone] = useState<Zone | null>(null);

  function zoneAtPoint(x: number, y: number): Zone | null {
    const hit = (el: HTMLElement | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    if (hit(handRef.current)) return "hand";
    if (hit(deckRef.current)) return "deck";
    return null;
  }

  function handleDragOver(_e: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) {
    setHoverZone(zoneAtPoint(info.point.x, info.point.y));
  }

  function handleDrop(userId: string, currentlyAssigned: boolean, info: PanInfo) {
    setHoverZone(null);
    const dropped = zoneAtPoint(info.point.x, info.point.y);
    if (!dropped) return; // off-target → motion snaps the card back
    if (dropped === "hand" && !currentlyAssigned) onAssign(userId);
    else if (dropped === "deck" && currentlyAssigned) onRemove(userId);
  }

  return (
    <div className="p-5 space-y-4">
      {/* Inbox header */}
      <div
        className="rounded-2xl p-4 border border-blue-200/50 flex items-center gap-3"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
      >
        <div className="w-11 h-11 rounded-xl bg-white/80 border border-white text-blue-700 grid place-items-center shrink-0 shadow-sm">
          <InboxIcon className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">
            {inbox.display_name || inbox.email}
          </div>
          {inbox.display_name && inbox.display_name !== inbox.email && (
            <div className="text-[12px] text-ink/60 truncate">{inbox.email}</div>
          )}
        </div>
        <InviteToInboxDialog
          inboxId={inbox.id}
          inboxEmail={inbox.email}
          inboxLabel={inbox.display_name || inbox.email}
          users={users}
          assignments={assignments}
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              <UserPlus className="w-3.5 h-3.5" /> Invite by email
            </button>
          }
        />
      </div>

      {/* HAND zone */}
      <DropZone
        ref={handRef}
        title="Hand · currently has access"
        subtitle="Drag cards down to remove."
        empty="No one's been dealt in yet — drag a card up from the deck."
        accent="hand"
        active={hoverZone === "hand"}
        count={handUsers.length}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {handUsers.map((u, i) => (
            <PersonCard
              key={u.id}
              user={u}
              variant="hand"
              fanIndex={i}
              fanLength={handUsers.length}
              onDragMove={handleDragOver}
              onDrop={(info) => handleDrop(u.id, true, info)}
            />
          ))}
        </AnimatePresence>
      </DropZone>

      {/* DECK zone */}
      <DropZone
        ref={deckRef}
        title="Deck · available to deal"
        subtitle="Drag cards up to give them access."
        empty="Everyone's already on this inbox."
        accent="deck"
        active={hoverZone === "deck"}
        count={deckUsers.length}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {deckUsers.map((u) => (
            <PersonCard
              key={u.id}
              user={u}
              variant="deck"
              onDragMove={handleDragOver}
              onDrop={(info) => handleDrop(u.id, false, info)}
            />
          ))}
        </AnimatePresence>
      </DropZone>
    </div>
  );
}

// ============================================================
// Drop zone shell — large bounded rectangle with a subtle highlight
// when the dragged card is hovering inside it.
// ============================================================

interface DropZoneProps {
  title: string;
  subtitle: string;
  empty: string;
  accent: Zone;
  active: boolean;
  count: number;
  children: React.ReactNode;
}

const DropZone = forwardRef<HTMLDivElement, DropZoneProps>(function DropZone(
  { title, subtitle, empty, accent, active, count, children },
  ref
) {
  const isHand = accent === "hand";
  return (
    <div
      ref={ref}
      className={
        "rounded-2xl border-2 transition-colors p-4 min-h-[180px] " +
        (active
          ? "border-blue-500/70 bg-blue-50/60"
          : isHand
          ? "border-dashed border-blue-300/60 bg-blue-50/30"
          : "border-dashed border-slate-200 bg-slate-50/30")
      }
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-ink/55">
            {title}
          </div>
          <div className="text-[12px] text-ink/55">{subtitle}</div>
        </div>
        <span className="text-[11px] text-ink/55 tabular-nums">{count}</span>
      </div>
      {count === 0 ? (
        <div className="h-[100px] grid place-items-center text-[12px] text-ink/45">
          {empty}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 items-start">{children}</div>
      )}
    </div>
  );
});

// ============================================================
// Person card — draggable. Snaps back to origin on a missed drop;
// layout animation handles the slide when it moves between zones.
// ============================================================

function PersonCard({
  user, variant, fanIndex = 0, fanLength = 1, onDragMove, onDrop
}: {
  user: User;
  variant: "hand" | "deck";
  fanIndex?: number;
  fanLength?: number;
  onDragMove: (e: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => void;
  onDrop: (info: PanInfo) => void;
}) {
  const controls = useAnimation();
  // Slight rotation for visual "deal" feel — hand cards fan, deck cards
  // tilt randomly but deterministically by id so re-renders don't
  // shuffle them.
  const baseRotation =
    variant === "hand"
      ? fanLength > 1
        ? (fanIndex - (fanLength - 1) / 2) * 2.5
        : 0
      : deterministicTilt(user.id);

  return (
    <motion.div
      layout
      drag
      dragSnapToOrigin
      whileDrag={{ scale: 1.06, rotate: 0, zIndex: 50, cursor: "grabbing" }}
      onDrag={onDragMove}
      onDragEnd={(_, info) => onDrop(info)}
      animate={controls}
      initial={{ opacity: 0, scale: 0.9, rotate: baseRotation }}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      style={{ rotate: baseRotation }}
      className={
        "relative select-none cursor-grab rounded-2xl border bg-white shadow-soft " +
        (variant === "hand"
          ? "w-[150px] h-[200px] border-blue-200/70"
          : "w-[120px] h-[160px] border-slate-200")
      }
      whileHover={{ y: -4, scale: 1.02 }}
    >
      {/* Decorative gradient corner */}
      <div
        className="absolute inset-x-0 top-0 h-[60%] rounded-t-2xl"
        style={{
          background:
            variant === "hand"
              ? "linear-gradient(155deg, #DBEAFE 0%, #EEF2FF 60%, transparent 100%)"
              : "linear-gradient(155deg, #F1F5F9 0%, #FFFFFF 60%, transparent 100%)"
        }}
      />
      <div className="relative h-full flex flex-col items-center pt-4 px-3 pb-3">
        <PersonAvatar
          userId={user.id}
          name={user.name}
          imageUrl={user.avatarUrl}
          size={variant === "hand" ? 64 : 52}
          className="ring-2 ring-white shadow-sm pointer-events-none"
        />
        <div className="mt-2 text-[12px] font-semibold text-center line-clamp-1">
          {user.name}
        </div>
        <div className="text-[10px] text-ink/55 mt-0.5 line-clamp-1">
          {ROLE_LABELS[user.role]}
        </div>
        <div className="mt-auto text-[9px] tracking-widest uppercase font-semibold text-ink/30">
          {variant === "hand" ? "in play" : "draw"}
        </div>
      </div>
    </motion.div>
  );
}

function deterministicTilt(id: string): number {
  // Hash → −4°..+4° based on the id so each card has a stable but
  // distinct tilt without re-shuffling on every render.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 9) - 4) * 0.6;
}
