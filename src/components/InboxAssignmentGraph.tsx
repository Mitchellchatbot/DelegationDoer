"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Mail, X, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "./Avatar";
import { ROLE_LABELS } from "@/lib/auth";
import type { Department, User } from "@/lib/types";
import type { MissiveAccount } from "@/lib/missive-client";
import type { InboxAssignment } from "@/lib/inbox-access";

// Inbox-assignment graph with two distinct interactions:
//
//   1. DRAG A NODE BODY  → reposition the node on the canvas. New
//      positions persist to localStorage so the layout you arrange
//      sticks across reloads.
//
//   2. DRAG FROM THE PORT (small circle on the side of each node)
//      → draw a connection to another node. Releasing on top of a
//      compatible target toggles the assignment.
//
// Plain rectangles, no idle bobbing — animation is reserved for the
// active drag (dashed flowing line) and hover lifts.

const NODE_W = 200;
const NODE_H = 100;
const ROW_GAP = 24;
const COL_GAP = 240;
const PEOPLE_X = 40;
const INBOX_X = PEOPLE_X + NODE_W + COL_GAP;

const POS_STORAGE_KEY = "dd_inbox_graph_positions_v1";

interface Pos { x: number; y: number }
type PosMap = Record<string, Pos>;

function gridPositions<T extends { id: string }>(items: T[], x: number, paddingTop = 28): PosMap {
  const out: PosMap = {};
  items.forEach((item, i) => {
    out[item.id] = { x, y: paddingTop + i * (NODE_H + ROW_GAP) };
  });
  return out;
}

interface Props {
  users: User[];
  inboxes: MissiveAccount[];
  departments: Department[];
  initialAssignments: InboxAssignment[];
}

export function InboxAssignmentGraph({ users, inboxes, departments, initialAssignments }: Props) {
  const deptById = new Map(departments.map((d) => [d.id, d.name]));
  const containerRef = useRef<HTMLDivElement>(null);
  const draftPathRef = useRef<SVGPathElement>(null);

  const [assignments, setAssignments] = useState(initialAssignments);

  // Combined position map — keyed by node id (user or inbox). Default is a
  // tidy two-column grid; localStorage overrides per-id once the user has
  // moved nodes around.
  const [positions, setPositions] = useState<PosMap>(() => ({
    ...gridPositions(users, PEOPLE_X),
    ...gridPositions(inboxes, INBOX_X)
  }));

  // Load saved positions on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(POS_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as PosMap;
      setPositions((cur) => ({ ...cur, ...saved }));
    } catch { /* ignore corrupt blob */ }
  }, []);

  // Persist on change (debounced via microtask flush).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(positions)); }
    catch { /* quota / private mode — non-fatal */ }
  }, [positions]);

  // Two mutually-exclusive drag modes.
  const [moveDrag, setMoveDrag] = useState<
    | null
    | { id: string; offsetX: number; offsetY: number }
  >(null);
  const [connectDrag, setConnectDrag] = useState<
    | null
    | { kind: "user" | "inbox"; id: string; mouse: Pos }
  >(null);

  // ------------- MOVE PIPELINE -------------
  useEffect(() => {
    if (!moveDrag) return;
    function onMove(e: MouseEvent) {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || !moveDrag) return;
      const x = Math.max(0, e.clientX - box.left - moveDrag.offsetX);
      const y = Math.max(0, e.clientY - box.top - moveDrag.offsetY);
      setPositions((cur) => ({ ...cur, [moveDrag.id]: { x, y } }));
    }
    function onUp() { setMoveDrag(null); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [moveDrag]);

  // ------------- CONNECT PIPELINE -------------
  useEffect(() => {
    if (!connectDrag) return;
    function onMove(e: MouseEvent) {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      setConnectDrag((d) =>
        d ? { ...d, mouse: { x: e.clientX - box.left, y: e.clientY - box.top } } : d
      );
    }
    function onUp(e: MouseEvent) { finishConnect(e); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectDrag]);

  // GSAP-driven flowing dashed stroke on the draft connection line.
  useEffect(() => {
    if (!connectDrag || !draftPathRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        draftPathRef.current,
        { strokeDashoffset: 0 },
        { strokeDashoffset: -16, duration: 0.6, repeat: -1, ease: "none" }
      );
    });
    return () => ctx.revert();
  }, [connectDrag]);

  function startMove(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const p = positions[id];
    if (!p) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    setMoveDrag({
      id,
      offsetX: e.clientX - box.left - p.x,
      offsetY: e.clientY - box.top - p.y
    });
  }

  function startConnect(kind: "user" | "inbox", id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    setConnectDrag({
      kind,
      id,
      mouse: { x: e.clientX - box.left, y: e.clientY - box.top }
    });
  }

  function finishConnect(e: MouseEvent) {
    setConnectDrag((current) => {
      if (!current) return null;
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return null;
      const mx = e.clientX - box.left;
      const my = e.clientY - box.top;
      const idsToCheck = current.kind === "user"
        ? inboxes.map((i) => i.id)
        : users.map((u) => u.id);
      const target = nodeAt(mx, my, idsToCheck);
      if (target) {
        const userId = current.kind === "user" ? current.id : target;
        const accountId = current.kind === "user" ? target : current.id;
        toggleAssignment(userId, accountId);
      }
      return null;
    });
  }

  function nodeAt(mx: number, my: number, ids: string[]): string | null {
    for (const id of ids) {
      const p = positions[id];
      if (!p) continue;
      if (mx >= p.x && mx <= p.x + NODE_W && my >= p.y && my <= p.y + NODE_H) {
        return id;
      }
    }
    return null;
  }

  // ------------- ASSIGNMENT MUTATIONS -------------
  async function toggleAssignment(userId: string, accountId: string) {
    const existing = assignments.find(
      (a) => a.userId === userId && a.missiveAccountId === accountId
    );
    if (existing) return removeAssignment(userId, accountId);
    return addAssignment(userId, accountId);
  }

  async function addAssignment(userId: string, accountId: string) {
    const inbox = inboxes.find((i) => i.id === accountId);
    if (!inbox) return;
    const tempId = `__temp_${Date.now()}`;
    setAssignments((cur) => [
      ...cur,
      {
        id: tempId,
        userId,
        missiveAccountId: accountId,
        inboxEmail: inbox.email,
        inboxLabel: inbox.display_name,
        assignedBy: null,
        createdAt: new Date().toISOString()
      }
    ]);
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
      setAssignments((cur) => cur.map((a) => (a.id === tempId ? {
        id: data.assignment.id,
        userId: data.assignment.user_id,
        missiveAccountId: data.assignment.missive_account_id,
        inboxEmail: data.assignment.inbox_email,
        inboxLabel: data.assignment.inbox_label,
        assignedBy: data.assignment.assigned_by,
        createdAt: data.assignment.created_at
      } : a)));
      toast.success("Assigned");
    } catch (err) {
      setAssignments((cur) => cur.filter((a) => a.id !== tempId));
      toast.error(`Couldn't assign: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async function removeAssignment(userId: string, accountId: string) {
    const before = assignments;
    setAssignments((cur) => cur.filter((a) => !(a.userId === userId && a.missiveAccountId === accountId)));
    try {
      const url = `/api/inbox-assignments?userId=${encodeURIComponent(userId)}&missiveAccountId=${encodeURIComponent(accountId)}`;
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

  // ------------- LAYOUT EXTENTS -------------
  // Canvas grows to fit whichever node has been dragged furthest.
  const allXs = Object.values(positions).map((p) => p.x);
  const allYs = Object.values(positions).map((p) => p.y);
  const maxX = Math.max(INBOX_X + NODE_W + PEOPLE_X, ...allXs.map((x) => x + NODE_W + 40));
  const maxY = Math.max(360, ...allYs.map((y) => y + NODE_H + 40));

  // ------------- LINE GEOMETRY -------------
  const lines = assignments.flatMap((a) => {
    const u = positions[a.userId];
    const i = positions[a.missiveAccountId];
    if (!u || !i) return [];
    return [{
      key: `${a.userId}-${a.missiveAccountId}`,
      x1: u.x + NODE_W,
      y1: u.y + NODE_H / 2,
      x2: i.x,
      y2: i.y + NODE_H / 2,
      userId: a.userId,
      accountId: a.missiveAccountId
    }];
  });

  const draftLine = connectDrag && (() => {
    const src = positions[connectDrag.id];
    if (!src) return null;
    const fromRight = connectDrag.kind === "user";
    return {
      x1: fromRight ? src.x + NODE_W : src.x,
      y1: src.y + NODE_H / 2,
      x2: connectDrag.mouse.x,
      y2: connectDrag.mouse.y
    };
  })();

  function bezier(x1: number, y1: number, x2: number, y2: number) {
    const dx = (x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function resetLayout() {
    if (typeof window !== "undefined") {
      localStorage.removeItem(POS_STORAGE_KEY);
    }
    setPositions({
      ...gridPositions(users, PEOPLE_X),
      ...gridPositions(inboxes, INBOX_X)
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          <span className="font-medium text-ink">Drag a node body</span> to move it ·
          <span className="font-medium text-ink"> drag from the violet handle</span> to draw a connection ·
          click a string's ✕ to remove it
        </span>
        <button onClick={resetLayout} className="text-ink/70 hover:text-accent transition-colors">
          Reset layout
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative rounded-2xl overflow-hidden border border-white/60 select-none"
        style={{
          height: maxY,
          background: "linear-gradient(180deg, #F5F3FF 0%, #EEF2FF 100%)"
        }}
      >
        {/* Strings */}
        <svg
          width={maxX}
          height={maxY}
          className="absolute inset-0 pointer-events-none"
          style={{ overflow: "visible" }}
        >
          <defs>
            <linearGradient id="conn-gradient" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#2563EB" />
              <stop offset="100%" stopColor="#7C3AED" />
            </linearGradient>
          </defs>

          {lines.map((l) => (
            <ConnectionLine
              key={l.key}
              d={bezier(l.x1, l.y1, l.x2, l.y2)}
              midX={(l.x1 + l.x2) / 2}
              midY={(l.y1 + l.y2) / 2}
              onRemove={() => removeAssignment(l.userId, l.accountId)}
            />
          ))}

          {draftLine && (
            <path
              ref={draftPathRef}
              d={bezier(draftLine.x1, draftLine.y1, draftLine.x2, draftLine.y2)}
              stroke="url(#conn-gradient)"
              strokeWidth={2}
              strokeDasharray="6 6"
              fill="none"
              strokeLinecap="round"
            />
          )}
        </svg>

        {/* Person nodes */}
        {users.map((u) => {
          const p = positions[u.id];
          if (!p) return null;
          return (
            <PersonNode
              key={u.id}
              x={p.x}
              y={p.y}
              user={u}
              deptNames={u.departmentIds.map((id) => deptById.get(id)).filter(Boolean) as string[]}
              moving={moveDrag?.id === u.id}
              connecting={connectDrag?.kind === "user" && connectDrag.id === u.id}
              onBodyDown={(e) => startMove(u.id, e)}
              onPortDown={(e) => startConnect("user", u.id, e)}
            />
          );
        })}

        {/* Inbox nodes */}
        {inboxes.map((i) => {
          const p = positions[i.id];
          if (!p) return null;
          return (
            <InboxNode
              key={i.id}
              x={p.x}
              y={p.y}
              inbox={i}
              moving={moveDrag?.id === i.id}
              connecting={connectDrag?.kind === "inbox" && connectDrag.id === i.id}
              onBodyDown={(e) => startMove(i.id, e)}
              onPortDown={(e) => startConnect("inbox", i.id, e)}
            />
          );
        })}
      </div>
    </div>
  );
}

function PersonNode({
  x, y, user, deptNames, moving, connecting, onBodyDown, onPortDown
}: {
  x: number; y: number; user: User; deptNames: string[];
  moving: boolean; connecting: boolean;
  onBodyDown: (e: React.MouseEvent) => void;
  onPortDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onBodyDown}
      className={
        "absolute rounded-2xl bg-white border shadow-sm flex items-center gap-2.5 px-3 cursor-grab active:cursor-grabbing transition-shadow group " +
        (moving || connecting
          ? "ring-2 ring-violet-400 shadow-lift border-violet-300"
          : "border-slate-200 hover:shadow-lift")
      }
      style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
    >
      <Avatar name={user.name} imageUrl={user.avatarUrl} size={40} className="shadow-sm shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink truncate leading-tight">{user.name}</div>
        <div className="text-[10px] text-muted truncate mt-0.5">{ROLE_LABELS[user.role]}</div>
        {deptNames.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-0.5 max-h-5 overflow-hidden">
            {deptNames.slice(0, 2).map((d) => (
              <span
                key={d}
                className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/60 truncate max-w-[80px]"
              >
                {d}
              </span>
            ))}
            {deptNames.length > 2 && (
              <span className="text-[9px] text-muted">+{deptNames.length - 2}</span>
            )}
          </div>
        )}
      </div>
      <ConnectPort side="right" onMouseDown={onPortDown} />
    </div>
  );
}

function InboxNode({
  x, y, inbox, moving, connecting, onBodyDown, onPortDown
}: {
  x: number; y: number; inbox: MissiveAccount;
  moving: boolean; connecting: boolean;
  onBodyDown: (e: React.MouseEvent) => void;
  onPortDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onBodyDown}
      className={
        "absolute rounded-2xl border shadow-sm flex items-center gap-2.5 px-3 cursor-grab active:cursor-grabbing transition-shadow group " +
        (moving || connecting ? "ring-2 ring-violet-400 shadow-lift" : "hover:shadow-lift")
      }
      style={{
        left: x, top: y, width: NODE_W, height: NODE_H,
        background: "linear-gradient(135deg, #DBEAFE 0%, #DDD6FE 100%)",
        borderColor: moving || connecting ? "#A78BFA" : "rgba(124, 58, 237, 0.25)"
      }}
    >
      <ConnectPort side="left" onMouseDown={onPortDown} />
      <div className="w-9 h-9 rounded-xl bg-white/70 border border-white grid place-items-center text-violet-600 shrink-0">
        <Mail className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink truncate leading-tight">
          {inbox.display_name || inbox.email}
        </div>
        <div className="text-[10px] text-ink/60 truncate mt-0.5">{inbox.email}</div>
      </div>
    </div>
  );
}

// Small handle that lets the user start a connection without conflicting
// with the body's move-drag. Sits on the right or left edge of the node.
function ConnectPort({
  side, onMouseDown
}: { side: "left" | "right"; onMouseDown: (e: React.MouseEvent) => void }) {
  const positionClass = side === "right" ? "-right-2" : "-left-2";
  return (
    <button
      onMouseDown={onMouseDown}
      title="Drag to connect"
      className={
        `absolute ${positionClass} top-1/2 -translate-y-1/2 w-5 h-5 rounded-full grid place-items-center cursor-crosshair shadow-sm transition-transform hover:scale-110 ` +
        "bg-gradient-to-br from-blue-500 to-violet-500 text-white border-2 border-white"
      }
    >
      <Link2 className="w-2.5 h-2.5" />
    </button>
  );
}

function ConnectionLine({
  d, midX, midY, onRemove
}: { d: string; midX: number; midY: number; onRemove: () => void }) {
  return (
    <g pointerEvents="auto">
      <path d={d} stroke="transparent" strokeWidth={20} fill="none" style={{ cursor: "pointer" }} onClick={onRemove} />
      <path d={d} stroke="url(#conn-gradient)" strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <g
        transform={`translate(${midX} ${midY})`}
        style={{ cursor: "pointer" }}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      >
        <circle r={11} fill="white" stroke="rgba(220,38,38,0.45)" strokeWidth={1.5} />
        <foreignObject x={-7} y={-7} width={14} height={14}>
          <X className="w-3.5 h-3.5 text-urgent" />
        </foreignObject>
      </g>
    </g>
  );
}
