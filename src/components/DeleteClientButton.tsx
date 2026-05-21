"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function DeleteClientButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    const confirmed = window.confirm(
      `Delete "${clientName}"? This removes the client folder, meeting links, documents, and notes. Tasks tied to this name stay put.`
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, {
        method: "DELETE"
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success("Client removed.");
      router.push("/clients");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "delete failed");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white/85 border border-rose-200/80 text-rose-700 hover:bg-rose-50 hover:border-rose-300 transition-colors disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
      Remove client
    </button>
  );
}
