"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  X, Search, BarChart3, MapPin, MousePointerClick, Award, Link as LinkIcon, Sparkles, FileText
} from "lucide-react";
import { toast } from "sonner";

// Predefined focus areas. Tags get attached to the task so we can later
// filter by "all rankings reports" etc., and the SEO head sees them on
// the task description.
const REPORT_TYPES: { value: string; label: string; icon: React.ComponentType<{ className?: string }>; }[] = [
  { value: "rankings",       label: "Keyword rankings",   icon: Award          },
  { value: "traffic",        label: "Organic traffic",    icon: BarChart3      },
  { value: "local",          label: "Local pack",         icon: MapPin         },
  { value: "conversions",    label: "Conversions/CTR",    icon: MousePointerClick },
  { value: "backlinks",      label: "Backlink profile",   icon: LinkIcon       },
  { value: "competitor",     label: "Competitor delta",   icon: Search         },
  { value: "content-audit",  label: "Content audit",      icon: FileText       }
];

const URGENCIES: { value: string; label: string; deltaDays: string }[] = [
  { value: "low",    label: "Whenever",  deltaDays: "~1 wk"  },
  { value: "normal", label: "Normal",    deltaDays: "~4 days" },
  { value: "high",   label: "High",      deltaDays: "~2 days" },
  { value: "asap",   label: "ASAP",      deltaDays: "tomorrow" }
];

export function SeoReportRequestDialog({
  trigger, defaultClientName, defaultWebsite, onCreated
}: {
  trigger: React.ReactNode;
  defaultClientName?: string;
  defaultWebsite?: string;
  onCreated?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [clientName, setClientName] = useState(defaultClientName ?? "");
  const [website, setWebsite] = useState(defaultWebsite ?? "");
  const [reportTypes, setReportTypes] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [urgency, setUrgency] = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when reopening with new defaults.
  useEffect(() => {
    if (open) {
      setClientName(defaultClientName ?? "");
      setWebsite(defaultWebsite ?? "");
      setReportTypes([]);
      setNotes("");
      setUrgency("normal");
      setError(null);
    }
  }, [open, defaultClientName, defaultWebsite]);

  function toggleType(v: string) {
    setReportTypes((cur) => cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  }

  async function submit() {
    if (submitting) return;
    if (!clientName.trim()) { setError("Client name is required."); return; }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/seo-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: clientName.trim(),
          website: website.trim() || null,
          reportTypes,
          notes: notes.trim(),
          urgency
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);

      const routed = data.routedTo?.name ?? "the SEO head";
      const fyi = data.teamFyi;
      const fyiLine =
        fyi && fyi.total > 0
          ? ` · FYI sent to ${fyi.sent}/${fyi.total} teammates`
          : "";
      toast.success(`SEO report routed to ${routed}${fyiLine}`, {
        action: data.task?.id ? {
          label: "Open",
          onClick: () => router.push(`/tasks/${data.task.id}`)
        } : undefined
      });

      setOpen(false);
      router.refresh();
      onCreated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 anim-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-20 px-4 lg:pl-[264px]"
        >
          <div className="pointer-events-auto w-full max-w-[760px] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-3xl border border-slate-200/70 bg-white shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] anim-fade-in-up">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200/70 sticky top-0 bg-white/95 backdrop-blur-sm z-10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-fuchsia-50 ring-1 ring-fuchsia-200/60 grid place-items-center text-fuchsia-600">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <Dialog.Title className="text-lg font-semibold">Request SEO report</Dialog.Title>
                  <Dialog.Description className="text-xs text-muted">
                    Auto-routes to the SEO department head; the rest of the team gets a Slack FYI.
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <button className="w-8 h-8 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-slate-100 transition-colors" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Client</label>
                  <input
                    className="input"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g. Acme Recovery"
                  />
                </div>
                <div>
                  <label className="label">Website</label>
                  <input
                    className="input"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="acme-recovery.com"
                  />
                </div>
              </div>

              <div>
                <label className="label">Focus areas</label>
                <div className="flex flex-wrap gap-2">
                  {REPORT_TYPES.map((t) => {
                    const Icon = t.icon;
                    const on = reportTypes.includes(t.value);
                    return (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => toggleType(t.value)}
                        className={
                          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] border transition-colors " +
                          (on
                            ? "bg-accent text-white border-accent"
                            : "bg-white border-slate-200 text-ink hover:border-accent/40")
                        }
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="label">Notes (optional)</label>
                <textarea
                  className="input min-h-[100px]"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any specific keywords, geos, or context the SEO team should know?"
                />
              </div>

              <div>
                <label className="label">Urgency</label>
                <div className="grid grid-cols-4 gap-2">
                  {URGENCIES.map((u) => (
                    <button
                      key={u.value}
                      type="button"
                      onClick={() => setUrgency(u.value)}
                      className={
                        "rounded-xl px-3 py-2.5 border text-left transition-colors " +
                        (urgency === u.value
                          ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                          : "border-slate-200 bg-white hover:border-slate-300")
                      }
                    >
                      <div className="text-[13px] font-medium text-ink">{u.label}</div>
                      <div className="text-[11px] text-muted">{u.deltaDays}</div>
                    </button>
                  ))}
                </div>
              </div>

              {error && <div className="text-sm text-urgent">⚠ {error}</div>}

              <div className="flex justify-end gap-2 pt-1">
                <Dialog.Close asChild>
                  <button className="btn">Cancel</button>
                </Dialog.Close>
                <button
                  onClick={submit}
                  disabled={submitting || !clientName.trim()}
                  className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? "Sending…" : "Send request"}
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
