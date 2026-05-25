"use client";

import { useEffect, useRef, useState } from "react";
import {
  Newspaper, RefreshCw, AlertTriangle, CheckCircle2, Pencil, Loader2, Globe2, X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Props {
  clientId: string;
  // Effective URL to display in the header — the override if set,
  // otherwise the fallback (websites[0] or legacy website).
  initialWpUrl: string | null;
  fallbackUrl: string | null;
  initialBlogPostsCount: number | null;
  initialUpdatedAt: string | null;
  initialError: string | null;
}

// SEO-only panel on the client detail page. Shows the latest blog post
// count for the client's WordPress site, when it was last refreshed,
// and any error from the most recent attempt. Has a manual "Refresh"
// button (immediate sync) and an inline editor for overriding which URL
// to query — useful when the WordPress site lives at a different domain
// than the marketing site recorded in `clients.websites`.
export function ClientWordPressCard({
  clientId,
  initialWpUrl,
  fallbackUrl,
  initialBlogPostsCount,
  initialUpdatedAt,
  initialError
}: Props) {
  const [wpUrlOverride, setWpUrlOverride] = useState<string | null>(initialWpUrl);
  const [blogPosts, setBlogPosts] = useState<number | null>(initialBlogPostsCount);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initialUpdatedAt);
  const [error, setError] = useState<string | null>(initialError);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState<string>(initialWpUrl ?? "");

  const effectiveUrl = wpUrlOverride ?? fallbackUrl;

  async function refresh(opts: { url?: string | null; silent?: boolean } = {}) {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/wp-refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          opts.url !== undefined
            ? JSON.stringify({ url: opts.url ?? "" })
            : JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        const message = data.error || `status ${res.status}`;
        setError(message);
        setUpdatedAt(new Date().toISOString());
        // Errors always surface — silent mode is only about success noise.
        toast.error(`Couldn't reach WordPress: ${message}`);
        return false;
      }
      setBlogPosts(data.blogPostsCount ?? null);
      setUpdatedAt(data.updatedAt ?? new Date().toISOString());
      setError(null);
      if (!opts.silent) {
        toast.success(`Synced — ${data.blogPostsCount ?? 0} blog posts`);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      setError(message);
      if (!opts.silent) toast.error(`Couldn't refresh: ${message}`);
      return false;
    } finally {
      setRefreshing(false);
    }
  }

  // TTL-on-mount: if the stored counts are missing or older than 14 days,
  // kick a refresh in the background the first time the card is rendered.
  // Silent so the SEO team isn't toasted on every page load — they only
  // ever see "Synced …" toasts when they themselves clicked Refresh.
  // Errors still surface so a permanently-broken site is visible.
  const STALE_MS = 14 * 24 * 60 * 60 * 1000;
  const autoRefreshTriggered = useRef(false);
  useEffect(() => {
    if (autoRefreshTriggered.current) return;
    if (!effectiveUrl) return;
    const updatedMs = initialUpdatedAt ? new Date(initialUpdatedAt).getTime() : 0;
    const stale = !updatedMs || Date.now() - updatedMs > STALE_MS;
    if (!stale) return;
    autoRefreshTriggered.current = true;
    void refresh({ silent: true });
    // Only ever fires once per mount; no dependency on state we mutate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveUrl() {
    const next = draftUrl.trim();
    const ok = await refresh({ url: next });
    if (ok) {
      setWpUrlOverride(next === "" ? null : next);
      setEditing(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-violet-50/60 to-white p-4 space-y-3">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full bg-violet-500" />
          <div className="text-sm font-semibold inline-flex items-center gap-1.5">
            <Newspaper className="w-3.5 h-3.5 text-violet-600" />
            WordPress
          </div>
          <span className="text-[10px] uppercase tracking-wide font-semibold text-violet-700/70 bg-violet-100/70 border border-violet-200/70 rounded-full px-1.5 py-0.5">
            SEO
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => refresh()}
            disabled={refreshing || !effectiveUrl}
            className={cn(
              "inline-flex items-center gap-1 text-[11px] font-medium text-ink/65 hover:text-accent px-2 py-1 rounded-lg border border-slate-200/70 bg-white",
              (refreshing || !effectiveUrl) && "opacity-50 cursor-not-allowed"
            )}
            title={!effectiveUrl ? "Set a WordPress URL first" : "Refresh now"}
          >
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
        </div>
      </header>

      {!editing ? (
        <div className="flex items-center justify-between gap-2 text-[11px] text-ink/65 flex-wrap">
          <div className="inline-flex items-center gap-1.5 min-w-0">
            <Globe2 className="w-3 h-3 text-ink/45 shrink-0" />
            {effectiveUrl ? (
              <a
                href={effectiveUrl.startsWith("http") ? effectiveUrl : `https://${effectiveUrl}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink/75 hover:text-accent truncate"
              >
                {effectiveUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")}
              </a>
            ) : (
              <span className="text-ink/45 italic">No WordPress URL set</span>
            )}
            {wpUrlOverride && (
              <span className="text-[10px] text-ink/45">(override)</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setDraftUrl(wpUrlOverride ?? ""); setEditing(true); }}
            className="inline-flex items-center gap-1 text-[11px] text-ink/55 hover:text-accent"
          >
            <Pencil className="w-3 h-3" />
            {wpUrlOverride ? "Change" : "Set URL"}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <input
            type="url"
            placeholder={fallbackUrl ?? "https://clientsite.com"}
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            className="flex-1 min-w-[180px] text-[12px] border border-slate-200/70 rounded-lg px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40 bg-white"
          />
          <button
            type="button"
            onClick={saveUrl}
            disabled={refreshing}
            className={cn(
              "inline-flex items-center gap-1 text-[11px] font-semibold text-white px-2.5 py-1.5 rounded-lg shadow-sm",
              refreshing && "opacity-60 cursor-not-allowed"
            )}
            style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
          >
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Save & sync
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setDraftUrl(wpUrlOverride ?? ""); }}
            className="text-ink/55 hover:text-ink p-1.5"
            aria-label="Cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Tile
          label="Service pages"
          value="—"
          hint="Awaiting setup"
          muted
        />
        <Tile
          label="Blog posts"
          value={blogPosts === null ? "—" : blogPosts.toLocaleString()}
          hint={
            error
              ? "Last sync failed"
              : updatedAt
              ? `Updated ${formatRelative(updatedAt)}`
              : effectiveUrl
              ? "Not synced yet — click Refresh"
              : "Set a WordPress URL"
          }
        />
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200/70 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-800 inline-flex items-start gap-1.5 w-full">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}
    </section>
  );
}

function Tile({
  label, value, hint, muted = false
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className={cn(
      "rounded-xl border bg-white/80 p-3",
      muted ? "border-slate-200/60" : "border-violet-200/60"
    )}>
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/50">
        {label}
      </div>
      <div className={cn(
        "text-2xl font-semibold mt-0.5 tabular-nums",
        muted ? "text-ink/30" : "text-violet-700"
      )}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-ink/45 mt-0.5">{hint}</div>}
    </div>
  );
}

function formatRelative(iso: string): string {
  // Hydration-safe: render the absolute date on first paint, then swap to
  // relative on the client effect below. Avoids server/client mismatch.
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
