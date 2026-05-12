"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PersonAvatar } from "./PersonAvatar";
import { ArrowRight, UserPlus, Clock as ClockIcon } from "lucide-react";
import { toast } from "sonner";
import type { User } from "@/lib/types";

interface HandoffRow {
  id: string;
  task_id: string;
  from_user_id: string | null;
  to_user_id: string | null;
  stage: string | null;
  reason: string | null;
  held_minutes: number | null;
  created_at: string;
}

// Hand-off panel for a task. Two surfaces:
//   1. Button + dialog to hand the task to another user (writes to
//      PATCH /api/tasks/[id] with assigneeId + handoffStage + handoffReason).
//   2. Timeline of past handoffs with how long each person held it,
//      rendered as a vertical "person → person" chain — same shape as
//      ClickUp's task-history widget.

export function HandoffButton({
  taskId, currentAssigneeId, users
}: {
  taskId: string;
  currentAssigneeId: string | null;
  users: User[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState<string>(
    users.find((u) => u.id !== currentAssigneeId)?.id ?? ""
  );
  const [stage, setStage] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!toUserId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assigneeId: toUserId,
          handoffStage: stage.trim() || null,
          handoffReason: reason.trim() || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const target = users.find((u) => u.id === toUserId);
      toast.success(target ? `Handed off to ${target.name}` : "Handoff saved");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="btn">
          <UserPlus className="w-3.5 h-3.5" />
          Hand off
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[440px] card p-5 space-y-4">
          <div>
            <Dialog.Title className="text-base font-semibold">Hand off task</Dialog.Title>
            <Dialog.Description className="text-xs text-muted mt-0.5">
              Assign to someone else and capture what stage you're handing off at —
              the next person sees the note, and the Leader sees the timing.
            </Dialog.Description>
          </div>

          <label className="block">
            <span className="label">To</span>
            <select
              className="input"
              value={toUserId}
              onChange={(e) => setToUserId(e.target.value)}
            >
              {users
                .filter((u) => u.id !== currentAssigneeId)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>

          <label className="block">
            <span className="label">Stage you're at</span>
            <input
              type="text"
              className="input"
              placeholder="e.g. design done, ready for build"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="label">Reason (optional)</span>
            <textarea
              className="input"
              rows={3}
              placeholder="Why are you handing this off?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          {error && <div className="text-xs text-urgent">{error}</div>}

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="btn">Cancel</button>
            </Dialog.Close>
            <button className="btn-primary" onClick={submit} disabled={saving || !toUserId}>
              {saving ? "Handing off…" : "Hand off"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function HandoffTimeline({
  taskId, users
}: {
  taskId: string;
  users: User[];
}) {
  const [rows, setRows] = useState<HandoffRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${taskId}/handoffs`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setRows(d.handoffs ?? []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (rows === null) {
    return <div className="text-xs text-muted">Loading handoff history…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="text-xs text-muted italic">
        No handoffs yet — when this task changes hands, you'll see the chain here.
      </div>
    );
  }

  const userOf = (id: string | null) => (id ? users.find((u) => u.id === id) ?? null : null);

  return (
    <ul className="space-y-3">
      {rows.map((h, i) => {
        const from = userOf(h.from_user_id);
        const to = userOf(h.to_user_id);
        return (
          <li key={h.id} className="rounded-xl border border-white/60 bg-white/55 backdrop-blur-sm p-3 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              {from ? (
                <span className="inline-flex items-center gap-1.5">
                  <PersonAvatar userId={from.id} name={from.name} imageUrl={from.avatarUrl} size={20} />
                  <span className="font-medium">{from.name}</span>
                </span>
              ) : (
                <span className="text-muted">unassigned</span>
              )}
              <ArrowRight className="w-3.5 h-3.5 text-muted" />
              {to ? (
                <span className="inline-flex items-center gap-1.5">
                  <PersonAvatar userId={to.id} name={to.name} imageUrl={to.avatarUrl} size={20} />
                  <span className="font-medium">{to.name}</span>
                </span>
              ) : (
                <span className="text-muted">unassigned</span>
              )}
              {h.held_minutes !== null && from && (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted">
                  <ClockIcon className="w-3 h-3" />
                  held {formatMinutes(h.held_minutes)}
                </span>
              )}
            </div>
            {(h.stage || h.reason) && (
              <div className="mt-2 text-xs text-ink/80 space-y-1">
                {h.stage && (
                  <div>
                    <span className="text-muted">Stage:</span>{" "}
                    <span className="font-medium">{h.stage}</span>
                  </div>
                )}
                {h.reason && <div className="text-ink/70 whitespace-pre-wrap">{h.reason}</div>}
              </div>
            )}
            <div className="mt-1.5 text-[10px] text-muted">
              {new Date(h.created_at).toLocaleString()}
              {i === 0 && from === null && " · initial assignment"}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}
