"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, X, Send, Pencil, CalendarPlus } from "lucide-react";
import type { Priority, Ticket, TicketStatus } from "@/lib/types";

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "pending",            label: "Pending" },
  { value: "in_progress",        label: "In progress" },
  { value: "urgent",             label: "Urgent" },
  { value: "waiting_on_client",  label: "Waiting on client" },
  { value: "done",               label: "Done" }
];

const PRIORITIES: Priority[] = ["low", "medium", "high", "critical"];

export function TicketActions({ ticket }: { ticket: Ticket }) {
  return (
    <div className="flex items-center gap-2">
      <ExtendButton ticket={ticket} />
      <EditButton ticket={ticket} />
      <MoveStatus ticket={ticket} />
    </div>
  );
}

/* ---------- Move status ---------- */

function MoveStatus({ ticket }: { ticket: Ticket }) {
  const router = useRouter();
  const [pending, setPending] = useState<TicketStatus | null>(null);

  async function setStatus(status: TicketStatus) {
    if (status === ticket.status) return;
    setPending(status);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      if (res.ok) router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="btn-primary">
          {pending ? "Saving…" : "Move status"}
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="z-50 min-w-[200px] card p-1" sideOffset={6} align="end">
          {STATUS_OPTIONS.map((s) => (
            <DropdownMenu.Item
              key={s.value}
              onSelect={() => setStatus(s.value)}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-ink hover:bg-surface2 cursor-pointer outline-none data-[highlighted]:bg-surface2"
            >
              {s.value === ticket.status ? <Check className="w-3.5 h-3.5 text-accent" /> : <span className="w-3.5" />}
              <span>{s.label}</span>
              {s.value === ticket.status && <span className="text-[10px] text-muted ml-auto">current</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/* ---------- Edit dialog ---------- */

function EditButton({ ticket }: { ticket: Ticket }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description ?? "");
  const [priority, setPriority] = useState<Priority>(ticket.priority);
  const [estimate, setEstimate] = useState<number>(ticket.estimatedHours);
  const [clientName, setClientName] = useState(ticket.clientName ?? "");
  const [website, setWebsite] = useState(ticket.website ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title, description, priority,
          estimatedHours: Number(estimate),
          clientName: clientName.trim() || null,
          website: website.trim() || null
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `Failed (${res.status})`);
        return;
      }
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
        <button className="btn"><Pencil className="w-3.5 h-3.5" /> Edit</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[560px] max-w-[calc(100vw-2rem)] card p-5">
          <div className="flex items-start justify-between mb-3">
            <Dialog.Title className="text-base font-medium">Edit ticket</Dialog.Title>
            <Dialog.Close className="btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
          </div>
          <div className="space-y-3">
            <div>
              <label className="label">Title</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea className="input min-h-[100px]" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Priority</label>
                <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Estimate (hrs)</label>
                <input type="number" min={0.5} step={0.5} className="input" value={estimate} onChange={(e) => setEstimate(Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Client</label>
                <input className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="(internal)" />
              </div>
              <div>
                <label className="label">Website</label>
                <input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="—" />
              </div>
            </div>
          </div>
          {error && <div className="mt-3 text-sm text-urgent">⚠ {error}</div>}
          <div className="mt-5 flex items-center justify-end gap-2">
            <Dialog.Close className="btn">Cancel</Dialog.Close>
            <button className="btn-primary disabled:opacity-50" disabled={saving || !title.trim()} onClick={save}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------- Extend dialog ---------- */

const QUICK_HOURS = [
  { label: "+1h",   hours: 1 },
  { label: "+3h",   hours: 3 },
  { label: "+1d",   hours: 24 },
  { label: "+3d",   hours: 72 },
  { label: "+1wk",  hours: 168 }
];

function ExtendButton({ ticket }: { ticket: Ticket }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<number>(24);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function reset() {
    setHours(24); setReason(""); setError(null);
  }

  async function submit() {
    if (submitting || hours <= 0) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}/extend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours, reason })
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error ?? `Failed (${res.status})`); return; }
      reset();
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) reset(); setOpen(v); }}>
      <Dialog.Trigger asChild>
        <button className="btn"><CalendarPlus className="w-3.5 h-3.5" /> Extend</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[520px] max-w-[calc(100vw-2rem)] card p-5">
          <div className="flex items-start justify-between mb-3">
            <div>
              <Dialog.Title className="text-base font-medium">Extend deadline</Dialog.Title>
              <Dialog.Description className="text-xs text-muted mt-0.5">
                You can self-extend, but your dept head and the CEO can see every extension and the reason.
              </Dialog.Description>
            </div>
            <Dialog.Close className="btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label">By how much</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {QUICK_HOURS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => setHours(q.hours)}
                    className={"badge cursor-pointer " + (hours === q.hours ? "badge-medium" : "badge-tag")}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  className="input"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                />
                <span className="text-xs text-muted">hours</span>
              </div>
            </div>
            <div>
              <label className="label">Reason</label>
              <textarea
                className="input min-h-[80px]"
                placeholder="What blocked you? (visible to your dept head + CEO)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="text-[11px] text-muted">
              Current due: {ticket.dueDate ? new Date(ticket.dueDate).toLocaleString() : "no date"}
              {hours > 0 && ticket.dueDate && (
                <> → <span className="text-ink">{new Date(Math.max(Date.now(), new Date(ticket.dueDate).getTime()) + hours * 36e5).toLocaleString()}</span></>
              )}
            </div>
          </div>

          {error && <div className="mt-3 text-sm text-urgent">⚠ {error}</div>}

          <div className="mt-5 flex items-center justify-end gap-2">
            <Dialog.Close className="btn">Cancel</Dialog.Close>
            <button
              onClick={submit}
              disabled={submitting || hours <= 0}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CalendarPlus className="w-4 h-4" /> {submitting ? "Extending…" : `Extend by ${hours}h`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------- Comment form ---------- */

export function CommentForm({ ticketId }: { ticketId: string }) {
  const [content, setContent] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function post() {
    if (!content.trim() || posting) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error ?? `Failed (${res.status})`); return; }
      setContent("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="mt-4 pt-3 border-t border-border">
      <textarea
        className="input min-h-[72px]"
        placeholder="Leave a comment…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post();
        }}
      />
      <div className="flex items-center justify-between mt-2">
        {error ? <span className="text-xs text-urgent">⚠ {error}</span>
               : <span className="text-[11px] text-muted">⌘↵ to post</span>}
        <button className="btn-primary disabled:opacity-50" disabled={!content.trim() || posting} onClick={post}>
          <Send className="w-3.5 h-3.5" /> {posting ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
