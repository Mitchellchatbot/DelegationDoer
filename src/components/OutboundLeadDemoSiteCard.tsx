"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Globe, ExternalLink, Loader2, Sparkles, RotateCcw, XCircle,
  CheckCircle2, AlertTriangle, Clock
} from "lucide-react";
import type { WebsiteBuildStatus } from "@/lib/outbound-leads";
import { cn } from "@/lib/utils";

// Demo Site card — sits inside the lead detail page between the action
// buttons and the messages/timeline grid. Tracks the Website-Builder
// pipeline state for a lead: shows the URL we're scraping (rep can
// override), the current build status, and primary actions
// (Generate / Re-generate / Cancel / Open demo).
//
// All state mutations POST to /api/outbound/leads/[id]/{generate-site,
// cancel-site-build} and trigger router.refresh() — the page is server-
// rendered, so a refresh pulls the new wb_* columns out of Postgres.

interface Props {
  leadId: string;
  websiteUrl: string | null;
  buildStatus: WebsiteBuildStatus | null;
  demoUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface StatusMeta {
  label: string;
  tone: string;
  icon: typeof Sparkles;
  spinning?: boolean;
}

const STATUS_META: Record<WebsiteBuildStatus, StatusMeta> = {
  pending:           { label: "Queued",           tone: "bg-slate-50 text-slate-600 border-slate-200",   icon: Clock },
  scraping:          { label: "Scraping site",    tone: "bg-amber-50 text-amber-700 border-amber-200",   icon: Loader2, spinning: true },
  generating:        { label: "Generating HTML",  tone: "bg-amber-50 text-amber-700 border-amber-200",   icon: Loader2, spinning: true },
  awaiting_approval: { label: "Preparing deploy", tone: "bg-amber-50 text-amber-700 border-amber-200",   icon: Loader2, spinning: true },
  deploying:         { label: "Deploying",        tone: "bg-amber-50 text-amber-700 border-amber-200",   icon: Loader2, spinning: true },
  completed:         { label: "Live",             tone: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  failed:            { label: "Failed",           tone: "bg-rose-50 text-rose-700 border-rose-200",       icon: AlertTriangle },
  cancelled:         { label: "Cancelled",        tone: "bg-slate-100 text-slate-600 border-slate-300",   icon: XCircle },
  skipped:           { label: "Skipped",          tone: "bg-slate-100 text-slate-600 border-slate-300",   icon: XCircle }
};

const TERMINAL = new Set<WebsiteBuildStatus>([
  "completed", "failed", "cancelled", "skipped"
]);

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });
}

export function OutboundLeadDemoSiteCard({
  leadId, websiteUrl, buildStatus, demoUrl, startedAt, completedAt
}: Props) {
  const router = useRouter();
  const [urlDraft, setUrlDraft] = useState(websiteUrl ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"generate" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const isInFlight = buildStatus !== null && !TERMINAL.has(buildStatus);
  const isCompleted = buildStatus === "completed";
  const meta = buildStatus ? STATUS_META[buildStatus] : null;

  async function fire(action: "generate" | "cancel") {
    setBusy(action);
    setError(null);
    try {
      const path = action === "generate"
        ? `/api/outbound/leads/${encodeURIComponent(leadId)}/generate-site`
        : `/api/outbound/leads/${encodeURIComponent(leadId)}/cancel-site-build`;
      const body = action === "generate" && urlDraft.trim() && urlDraft.trim() !== (websiteUrl ?? "")
        ? JSON.stringify({ companyWebsiteUrl: urlDraft.trim() })
        : undefined;
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : {},
        body
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `request failed (${res.status})`);
      }
      setEditing(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const hasUrl = urlDraft.trim().length > 0;
  const canGenerate = hasUrl && !isInFlight && busy === null;
  const canCancel = isInFlight && busy === null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
            Website Builder
          </div>
          <h2 className="text-[18px] font-semibold text-ink mt-0.5 inline-flex items-center gap-2">
            <Globe className="w-4 h-4 text-ink/60" />
            Demo site
          </h2>
        </div>
        {meta && (
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11.5px] font-semibold",
            meta.tone
          )}>
            <meta.icon className={cn("w-3.5 h-3.5", meta.spinning && "animate-spin")} />
            {meta.label}
          </span>
        )}
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* URL row — editable when not in flight, read-only while building. */}
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide font-semibold text-ink/45">
            Source URL
          </div>
          {editing && !isInFlight ? (
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 text-[13px] border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent/30"
                disabled={busy !== null}
              />
              <button
                type="button"
                onClick={() => { setUrlDraft(websiteUrl ?? ""); setEditing(false); }}
                className="text-[12px] text-ink/55 hover:text-ink"
                disabled={busy !== null}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => !isInFlight && setEditing(true)}
              disabled={isInFlight}
              className={cn(
                "w-full text-left text-[13px] px-3 py-2 rounded-lg border transition-colors",
                websiteUrl
                  ? "border-slate-200 text-ink hover:border-accent/40"
                  : "border-dashed border-slate-300 text-ink/45 hover:border-accent/40",
                isInFlight && "cursor-not-allowed opacity-60"
              )}
            >
              {websiteUrl ?? "Add a website URL to generate a demo"}
            </button>
          )}
        </div>

        {/* Status timestamps + outcome link. */}
        {(startedAt || completedAt || demoUrl) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
            {startedAt && (
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45">Started</div>
                <div className="text-ink mt-0.5">{fmtTimestamp(startedAt)}</div>
              </div>
            )}
            {completedAt && (
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45">
                  {isCompleted ? "Completed" : "Ended"}
                </div>
                <div className="text-ink mt-0.5">{fmtTimestamp(completedAt)}</div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200/70 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* Primary action row. Open demo (when ready) sits inline with
            Generate / Re-generate / Cancel so they read as one toolbar. */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isCompleted && demoUrl && (
            <a
              href={demoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open demo
            </a>
          )}
          {!isInFlight && (
            <button
              type="button"
              onClick={() => void fire("generate")}
              disabled={!canGenerate}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors",
                canGenerate
                  ? "bg-accent text-white hover:bg-accent/90"
                  : "bg-slate-100 text-ink/45 cursor-not-allowed"
              )}
            >
              {busy === "generate"
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : isCompleted || buildStatus === "failed" || buildStatus === "cancelled"
                  ? <RotateCcw className="w-4 h-4" />
                  : <Sparkles className="w-4 h-4" />}
              {isCompleted ? "Re-generate"
                : buildStatus === "failed" ? "Retry"
                : buildStatus === "cancelled" ? "Re-generate"
                : "Generate demo site"}
            </button>
          )}
          {isInFlight && (
            <button
              type="button"
              onClick={() => void fire("cancel")}
              disabled={!canCancel}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold border border-rose-200 text-rose-700 bg-white hover:bg-rose-50 transition-colors"
            >
              {busy === "cancel"
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <XCircle className="w-4 h-4" />}
              Cancel build
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
