"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sunrise, Sparkles, History, Loader2, Check, X } from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { useCurrentUser } from "@/lib/user-context";
import { SodFlow } from "@/components/SodFlow";

// Start-of-day page. Surfaces:
//   - The Simulate button (opens the SOD flow regardless of shift state)
//   - Today's SOD status (filed / not filed)
//   - Link to history
//
// Most users won't actually visit this page — they'll see the SOD
// modal pop on whatever page they land on first thing in the morning.
// This page exists as a manual entry-point + testing surface, mirroring
// the EOD page.

interface TodayResp {
  eligible: boolean;
  alreadySubmitted: boolean;
  shiftDate: string;
  shiftStart: string | null;
  shiftEnd: string | null;
  departmentKey: string | null;
  motivationalLine: string;
  userName: string | null;
  reason: string;
}

export default function SodPage() {
  const me = useCurrentUser();
  const [info, setInfo] = useState<TodayResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [flowOpen, setFlowOpen] = useState(false);
  const [simulate, setSimulate] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/sod/today", { cache: "no-store" });
      const d = (await r.json()) as TodayResp;
      setInfo(d);
    } catch (err) {
      toast.error(`Couldn't load SOD status: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  function openFlow(sim: boolean) {
    setSimulate(sim);
    setFlowOpen(true);
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHero
        eyebrow="Start of Day"
        headline={["Set the ", { accent: "tone for today" }]}
        subtitle="A two-minute check-in: today's top priority, what's on your plate, anything in the way."
        icon={<Sunrise />}
        iconTone="amber"
      />

      <section className="card p-4 space-y-3">
        {loading ? (
          <div className="text-sm text-ink/55 inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : info?.alreadySubmitted ? (
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-600 grid place-items-center shrink-0">
              <Check className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-base font-semibold">SOD filed for today ({info.shiftDate})</div>
              <div className="text-sm text-ink/65 mt-0.5">
                You're set. Have a great shift, {me.name?.split(" ")[0] ?? "team"}.
              </div>
            </div>
          </div>
        ) : info?.eligible ? (
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-600 grid place-items-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-base font-semibold">Today's SOD is open</div>
              <div className="text-sm text-ink/65 mt-0.5">
                {info.motivationalLine}
              </div>
              <button
                type="button"
                onClick={() => openFlow(false)}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
                style={{ background: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)" }}
              >
                <Sunrise className="w-3.5 h-3.5" />
                Start your day
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-slate-100 text-slate-500 grid place-items-center shrink-0">
              <X className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="text-base font-semibold">SOD isn't due right now</div>
              <div className="text-sm text-ink/65 mt-0.5">
                {info?.shiftStart
                  ? `Your shift starts at ${info.shiftStart}. The SOD modal will pop when you're in-shift on a fresh day.`
                  : "We couldn't find an active shift window for you right now."}
              </div>
              <div className="text-[11px] text-ink/45 mt-1">reason: {info?.reason}</div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-slate-200/50">
          <button
            type="button"
            onClick={() => openFlow(true)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink/65 hover:text-accent px-2.5 py-1 rounded-lg border border-slate-200/70 bg-white"
            title="Force the SOD flow to open for testing"
          >
            <Sparkles className="w-3 h-3" /> Simulate SOD start
          </button>
          <Link
            href="/sod/history"
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink/65 hover:text-accent px-2.5 py-1 rounded-lg border border-slate-200/70 bg-white"
          >
            <History className="w-3 h-3" /> History
          </Link>
        </div>
      </section>

      <SodFlow
        open={flowOpen}
        simulate={simulate}
        onClose={() => setFlowOpen(false)}
        onComplete={() => void load()}
      />
    </div>
  );
}
