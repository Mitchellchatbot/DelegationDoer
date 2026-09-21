"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SERVICE_LINES, type ServiceLine } from "@/lib/client-service-lines";

// Which tab(s) a client lives under on /clients. Toggle chips; can't drop to
// zero lines. PATCHes /api/clients/[id] { serviceLines }.
export function ClientServiceLines({
  clientId, initial, canEdit
}: {
  clientId: string;
  initial: ServiceLine[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<ServiceLine[]>(initial);
  const [saving, setSaving] = useState(false);

  async function toggle(id: ServiceLine) {
    const on = lines.includes(id);
    if (on && lines.length === 1) {
      toast.error("A client needs at least one service line");
      return;
    }
    const next = on ? lines.filter((l) => l !== id) : [...lines, id];
    const prev = lines;
    setLines(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceLines: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      router.refresh();
    } catch (err) {
      setLines(prev);
      toast.error(err instanceof Error ? err.message : "Couldn't update service line");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">Service line</span>
      {SERVICE_LINES.filter((l) => canEdit || lines.includes(l.id)).map((l) => {
        const on = lines.includes(l.id);
        return (
          <button
            key={l.id}
            type="button"
            disabled={!canEdit || saving}
            onClick={() => toggle(l.id)}
            className={cn(
              "px-2.5 py-0.5 rounded-full border transition-colors",
              on ? "border-accent/40 bg-accent/10 text-accent font-medium" : "border-dashed border-border text-muted hover:bg-surface2",
              !canEdit && "cursor-default"
            )}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
