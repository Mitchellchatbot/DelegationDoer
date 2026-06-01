"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, Pencil, Save, X, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Leader-set SEO brief on the client detail page.
//
// Edit-only when canEdit (leader / admin / SEO head). Everyone else
// gets a read view. Empty state for editors prompts them to add one;
// empty state for readers hides the card entirely so a client without
// a brief doesn't waste vertical space.

interface Props {
  clientId: string;
  brief: string | null;
  briefAt: string | null;
  briefByName: string | null; // pre-resolved on the server
  canEdit: boolean;
}

export function ClientSeoBriefCard({
  clientId, brief, briefAt, briefByName, canEdit
}: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [draft, setDraft] = useState<string>(brief ?? "");

  if (!brief && !canEdit) return null;

  async function enhance() {
    if (busy || enhancing) return;
    const seed = draft.trim();
    if (!seed) {
      toast.error("Jot a few notes first — even rough ones.");
      return;
    }
    setEnhancing(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/seo-brief/enhance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: seed })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.brief !== "string") {
        throw new Error(data?.error ?? `failed (${res.status})`);
      }
      setDraft(data.brief);
      toast.success("Tightened — review before saving.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "rewrite failed");
    } finally {
      setEnhancing(false);
    }
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/seo-brief`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: draft.trim() || null })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(draft.trim() ? "SEO brief saved." : "SEO brief cleared.");
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setDraft(brief ?? "");
    setEditing(false);
  }

  return (
    <section className="rounded-2xl border border-emerald-200/60 shadow-soft bg-gradient-to-br from-emerald-50/70 via-white to-white p-4 space-y-2.5">
      <header className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-emerald-600" />
        <div className="text-sm font-semibold">SEO brief</div>
        <span className="text-[10px] text-ink/50 hidden sm:inline">
          — target services + leadership focus for this account
        </span>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => { setEditing(true); setDraft(brief ?? ""); }}
            className="ml-auto text-[10px] text-emerald-700/80 hover:text-emerald-800 inline-flex items-center gap-1 font-medium"
          >
            <Pencil className="w-3 h-3" /> {brief ? "Edit" : "Add"}
          </button>
        )}
      </header>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              "What should the SEO team focus on for this client?\n\n" +
              "Examples:\n" +
              "• Target services: paid search, GMB, local listings\n" +
              "• This quarter: prioritize blog content around recovery family terms\n" +
              "• Avoid: aggressive PPC ad spend until tracking is clean"
            }
            maxLength={4000}
            rows={8}
            disabled={busy || enhancing}
            className="block w-full rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-[12.5px] outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 leading-relaxed"
          />
          <div className="flex items-center justify-between gap-2 text-[10px] text-ink/55">
            <span>
              Visible to anyone viewing this client; pinned on /home for the SEO team.
            </span>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                onClick={enhance}
                disabled={busy || enhancing || !draft.trim()}
                title="Rewrite your notes as a tighter brief"
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 transition-colors",
                  (busy || enhancing || !draft.trim()) && "opacity-60 cursor-not-allowed"
                )}
              >
                {enhancing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                {enhancing ? "Rewriting…" : "Write with AI"}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={busy || enhancing}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium text-ink/65 hover:text-ink"
              >
                <X className="w-3 h-3" /> Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || enhancing}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all",
                  (busy || enhancing) && "opacity-60 cursor-not-allowed"
                )}
                style={{ background: "linear-gradient(135deg, #059669 0%, #047857 100%)" }}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save brief
              </button>
            </div>
          </div>
        </div>
      ) : brief ? (
        <>
          {/* Preserve user's line breaks / bullets without going full
              markdown — leaders often just paste a list. */}
          <div className="rounded-xl bg-white/80 border border-white/70 p-3 text-[13px] text-ink/85 leading-relaxed whitespace-pre-wrap">
            {brief}
          </div>
          {(briefAt || briefByName) && (
            <div className="text-[10px] text-ink/50 tabular-nums">
              {briefByName ? <>updated by <span className="text-ink/70 font-medium">{briefByName}</span></> : "updated"}
              {briefAt && (
                <>
                  {" · "}
                  {new Date(briefAt).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric"
                  })}
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="text-[12px] text-ink/55 italic rounded-xl bg-white/70 border border-emerald-200/40 p-3">
          No brief yet — click <strong className="not-italic text-emerald-700">Add</strong> to tell the SEO team what to focus on for this client.
        </div>
      )}
    </section>
  );
}
