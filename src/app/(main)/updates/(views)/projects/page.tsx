"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  FolderKanban, ListChecks, GitBranch, Sparkles, Loader2, ShieldAlert
} from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";

interface ProjectEvent {
  kind: "task" | "stage" | "project";
  at: string;
  projectId: string;
  projectName: string;
  title: string;
  detail: string;
  taskId?: string;
}

// Projects activity feed inside /updates. Leader-only. Rolls up
// recent task changes, stage transitions, and new projects into a
// single time-sorted list so the leader can scan what's moving
// without bouncing between project detail pages.
//
// Visiting this page marks "seen now" — which drops the unseen
// badge on the tab + sidebar to 0 until new activity happens.
export default function ProjectsUpdatesPage() {
  const me = useCurrentUser();
  const [events, setEvents] = useState<ProjectEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenAt, setSeenAt] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/projects/updates?limit=40", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `failed (${res.status})`);
        return;
      }
      setEvents(data.events ?? []);
      setSeenAt(data.seenAt ?? null);
      // Mark seen on first successful load so the badge clears.
      void fetch("/api/projects/updates/seen", { method: "PUT" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    }
  }

  useEffect(() => { load(); }, []);

  if (me.role !== "leader") {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Leader only</div>
        <div className="text-sm text-muted mt-1">
          This activity feed is restricted to the Leader role.
        </div>
      </div>
    );
  }

  const seenMs = seenAt ? new Date(seenAt).getTime() : 0;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHero
        eyebrow="Projects"
        headline={["What ", { accent: "moved" }]}
        subtitle="Recent stage advances, task changes, and new projects — across the whole org."
        icon={<FolderKanban />}
        iconTone="indigo"
      />

      {error && (
        <div className="rounded-2xl border border-urgent/30 bg-urgent/5 p-4 text-sm text-urgent">
          {error}
        </div>
      )}

      {events === null && !error && (
        <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-sm text-ink/55 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading activity…
        </div>
      )}

      {events && events.length === 0 && (
        <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-sm text-ink/55">
          Nothing's happened on any project yet. Once you spin a project up, every
          stage advance and task change will land here.
        </div>
      )}

      {events && events.length > 0 && (
        <ul className="space-y-1.5">
          {events.map((e, i) => {
            const Icon = e.kind === "stage"
              ? GitBranch
              : e.kind === "project"
                ? Sparkles
                : ListChecks;
            const tone =
              e.kind === "stage"
                ? "bg-indigo-50 text-indigo-700 border-indigo-200/60"
                : e.kind === "project"
                  ? "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/60"
                  : "bg-blue-50 text-blue-700 border-blue-200/60";
            const isUnseen = new Date(e.at).getTime() > seenMs;
            const href = e.taskId
              ? `/tasks/${e.taskId}`
              : `/projects/${e.projectId}`;
            return (
              <li key={i}>
                <Link
                  href={href}
                  className={cn(
                    "relative flex items-center gap-3 rounded-2xl border bg-white pl-3 pr-4 py-3 transition-all hover:-translate-y-0.5 hover:shadow-soft overflow-hidden",
                    isUnseen ? "border-rose-200/70" : "border-slate-200/70"
                  )}
                >
                  {isUnseen && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-0 bottom-0 w-1 bg-rose-500"
                    />
                  )}
                  <span className={cn(
                    "w-8 h-8 rounded-xl border grid place-items-center shrink-0",
                    tone
                  )}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-semibold text-ink truncate">
                      {e.title}
                    </div>
                    <div className="text-[11px] text-ink/55 mt-0.5 inline-flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 truncate max-w-[180px]">
                        {e.projectName}
                      </span>
                      <span>· {e.detail}</span>
                    </div>
                  </div>
                  <div className="text-[11px] text-ink/55 shrink-0 tabular-nums">
                    {timeAgo(e.at)}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
