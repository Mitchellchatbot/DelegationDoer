"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Calendar, FileText, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import type { ResourceKind } from "@/lib/clients-data";

// Inline "+ Add" form for each section (meeting / document / suggestion).
// Renders a button that expands into a small form. Submits to the
// /api/clients/[id]/resources endpoint.

const KIND_META: Record<
  ResourceKind,
  { label: string; placeholder: string; bodyLabel: string | null; icon: typeof Calendar }
> = {
  meeting:    { label: "Meeting link",  placeholder: "Kickoff with Acme",     bodyLabel: null,          icon: Calendar },
  document:   { label: "Document",      placeholder: "Brand guide",            bodyLabel: null,          icon: FileText },
  suggestion: { label: "Suggestion",    placeholder: "Pitch new content angle",bodyLabel: "Details",     icon: Lightbulb }
};

export function AddResourceForm({
  clientId,
  kind
}: { clientId: string; kind: ResourceKind }) {
  const router = useRouter();
  const meta = KIND_META[kind];
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTitle(""); setUrl(""); setBody("");
  }

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, title, url, body })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "failed");
      toast.success(`Added ${meta.label.toLowerCase()}`);
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't add: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-ink/70 hover:text-accent transition-colors"
      >
        <Plus className="w-3.5 h-3.5" /> Add {meta.label.toLowerCase()}
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-indigo-200/60 bg-indigo-50/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-ink/80">New {meta.label.toLowerCase()}</div>
        <button onClick={() => { setOpen(false); reset(); }} className="text-muted hover:text-ink">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={meta.placeholder}
        className="input bg-white"
      />
      {kind !== "suggestion" && (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="input bg-white"
        />
      )}
      {meta.bodyLabel && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={meta.bodyLabel}
          className="input bg-white min-h-[64px]"
        />
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => { setOpen(false); reset(); }}
          className="text-xs px-3 py-1.5 rounded-full text-muted hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting || !title.trim()}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full font-medium text-white shadow-sm disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          {submitting ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}

// Tiny client-side "x" button to delete a resource without leaving the page.
export function DeleteResourceButton({
  clientId,
  resourceId
}: { clientId: string; resourceId: string }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function remove() {
    if (working) return;
    setWorking(true);
    try {
      const res = await fetch(
        `/api/clients/${encodeURIComponent(clientId)}/resources?resourceId=${encodeURIComponent(resourceId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? "failed");
      }
      toast.success("Removed");
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't remove: ${err instanceof Error ? err.message : "unknown"}`);
      setWorking(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={working}
      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted hover:text-urgent shrink-0"
      title="Remove"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  );
}
