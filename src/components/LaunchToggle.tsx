"use client";

import { useState } from "react";
import { Rocket, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { LAUNCHED_KEY } from "@/lib/fb-onboarding";

// "Campaigns are live for this client." Hand-flipped on the onboarding list,
// because whether the ads are actually running is not something the checklist
// can know. Writes the same { v, by, at } state key everything else uses.
export function LaunchToggle({
  taskId, initialLaunched, canEdit, size = "md"
}: {
  taskId: string;
  initialLaunched: boolean;
  canEdit: boolean;
  size?: "sm" | "md";
}) {
  const [on, setOn] = useState(initialLaunched);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    if (!canEdit || saving) return;
    const next = !on;
    setOn(next);           // optimistic — the page re-renders from state anyway
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/fb-onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: LAUNCHED_KEY, value: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(next ? "Marked as launched" : "Marked as not launched");
    } catch (err) {
      setOn(!next);
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!canEdit || saving}
      aria-pressed={on}
      title={on ? "Campaigns are live — click to unmark" : "Mark campaigns as launched"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-semibold transition-colors",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs",
        on
          ? "border-ok/40 bg-ok/15 text-ok hover:bg-ok/25"
          : "border-border bg-surface text-muted hover:text-ink hover:bg-surface2",
        !canEdit && "cursor-default"
      )}
    >
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
      {on ? "Launched" : "Not launched"}
    </button>
  );
}
