"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  CartesianGrid, Cell
} from "recharts";
import { FileText, Hourglass, ArrowRight } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";

export interface PostsPerClientRow {
  clientId: string;
  clientName: string;
  postsCount: number;
}

// Two-up at-a-glance row on the leader home: a bar chart of posts
// shipped per client + a stalled-work tile. Lives in one strip so
// the dashboard reads "what we've made vs. what's stuck" at a glance.
//
// Why bars instead of multi-line: we don't have a posts time-series
// table yet (clients.wp_blog_posts_count is a refreshed snapshot, not
// a per-day series). Bars sorted desc still tell the leader "where is
// the team putting volume" in one sweep. Promote to a line chart once
// we land a posts_history table.

export function HomeChartsRow({
  postsPerClient,
  stalledCount
}: {
  postsPerClient: PostsPerClientRow[];
  stalledCount: number;
}) {
  // Cap to top 10 for the bar chart — beyond that the labels get
  // illegible at the 280px height we render at.
  const topPosts = useMemo(
    () => postsPerClient.slice(0, 10).map((r) => ({
      ...r,
      // Shorten labels so x-axis stays readable at the dashboard width.
      short: r.clientName.length > 14 ? r.clientName.slice(0, 13) + "…" : r.clientName
    })),
    [postsPerClient]
  );
  const totalPosts = postsPerClient.reduce((acc, r) => acc + r.postsCount, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Posts-per-client — spans 2/3 on lg */}
      <section className="lg:col-span-2 rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-[13px] font-semibold inline-flex items-center gap-2">
            <FileText className="w-4 h-4 text-indigo-500" />
            Posts shipped per client
            <Tooltip label="Current count of blog posts on each active client's WordPress site. Snapshot, not a trend — we'll wire a per-day series once a history table lands.">
              <span className="text-[11px] text-ink/55 font-normal tabular-nums">
                · {totalPosts.toLocaleString()} total
              </span>
            </Tooltip>
          </div>
          <Link
            href="/clients"
            className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
          >
            All clients <ArrowRight className="w-3 h-3" />
          </Link>
        </header>
        <div className="p-3">
          {topPosts.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-ink/55">
              No post counts on file. Wire WordPress on clients to populate this.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={topPosts} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="short"
                  tick={{ fontSize: 10, fill: "#475569" }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  angle={-20}
                  height={50}
                  textAnchor="end"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#475569" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  width={28}
                />
                <RTooltip
                  cursor={{ fill: "rgba(99,102,241,0.06)" }}
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid #e2e8f0",
                    boxShadow: "0 8px 20px -8px rgba(15,23,42,0.18)",
                    fontSize: 11
                  }}
                  formatter={(v) => [`${v as number} posts`, "Posts"]}
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as { clientName?: string } | undefined;
                    return p?.clientName ?? "";
                  }}
                />
                <Bar dataKey="postsCount" radius={[6, 6, 0, 0]}>
                  {topPosts.map((entry, idx) => (
                    <Cell key={entry.clientId} fill={GRADIENT_COLORS[idx % GRADIENT_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Stalled tile — single big stat */}
      <section className="rounded-2xl border border-slate-200/70 bg-gradient-to-br from-slate-50 via-white to-white shadow-soft overflow-hidden flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-[13px] font-semibold inline-flex items-center gap-2">
            <Hourglass className="w-4 h-4 text-slate-500" />
            Stalled work
          </div>
          <Link
            href="/tasks/board"
            className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
          >
            Board <ArrowRight className="w-3 h-3" />
          </Link>
        </header>
        <div className="flex-1 grid place-items-center p-4">
          <div className="text-center">
            <div className="text-5xl font-bold text-slate-800 tabular-nums leading-tight">
              {stalledCount}
            </div>
            <div className="text-[11px] text-ink/60 mt-1.5">
              assigned tasks with no activity in 7+ days
            </div>
            <Tooltip label="Each row in this count appears individually under What's moving → Tasks → Stalled.">
              <Link
                href="/tasks/board?filter=stalled"
                className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
              >
                See the list <ArrowRight className="w-3 h-3" />
              </Link>
            </Tooltip>
          </div>
        </div>
      </section>
    </div>
  );
}

// A small palette that gives the bar chart a calm rainbow — same family
// as the rest of the dashboard, just rotated so adjacent bars don't
// blur together.
const GRADIENT_COLORS = [
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#0ea5e9", // sky
  "#14b8a6", // teal
  "#10b981", // emerald
  "#84cc16", // lime
  "#eab308", // amber-ish
  "#f59e0b", // amber
  "#f97316", // orange
  "#a855f7"  // purple
];
