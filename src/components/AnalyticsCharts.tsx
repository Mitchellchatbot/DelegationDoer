"use client";

import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";

type DayPoint = { date: string; label: string; count: number };
type StatusSlice = { status: string; count: number };

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  urgent: "Urgent",
  waiting_on_client: "Waiting on client"
};

// Brand-adjacent palette, picked to read well against the white-glass cards.
const STATUS_COLORS: Record<string, string> = {
  pending: "#94a3b8",
  in_progress: "#3b82f6",
  urgent: "#ef4444",
  waiting_on_client: "#f59e0b"
};

const FALLBACK_COLOR = "#6366f1";

export function CompletionsTrendChart({ data }: { data: DayPoint[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) {
    return (
      <div className="text-center text-sm text-muted py-10">
        Nothing completed in the last 30 days — finish a task and it'll show up here.
      </div>
    );
  }
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="completionFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval={Math.ceil(data.length / 6)}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={28}
          />
          <Tooltip
            cursor={{ stroke: "#94a3b8", strokeWidth: 1, strokeDasharray: "3 3" }}
            contentStyle={{
              borderRadius: 10,
              border: "1px solid #e2e8f0",
              fontSize: 12,
              boxShadow: "0 8px 24px -12px rgba(15,23,42,0.18)"
            }}
            labelFormatter={(label) => `Day ${label}`}
            formatter={(v) => {
              const n = Number(v);
              return [`${n} task${n === 1 ? "" : "s"}`, "Completed"] as [string, string];
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke="#10b981"
            strokeWidth={2}
            fill="url(#completionFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusDistributionChart({ data }: { data: StatusSlice[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) {
    return (
      <div className="text-center text-sm text-muted py-10">
        No open tasks — inbox zero across the team.
      </div>
    );
  }
  const rows = data.map((d) => ({
    name: STATUS_LABELS[d.status] ?? d.status,
    value: d.count,
    fill: STATUS_COLORS[d.status] ?? FALLBACK_COLOR
  }));

  return (
    <div className="flex items-center gap-4">
      <div className="w-44 h-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip
              contentStyle={{
                borderRadius: 10,
                border: "1px solid #e2e8f0",
                fontSize: 12,
                boxShadow: "0 8px 24px -12px rgba(15,23,42,0.18)"
              }}
              formatter={(v, _n, p) => {
                const n = Number(v);
                const label = (p as { payload?: { name?: string } } | undefined)?.payload?.name ?? "";
                return [`${n} task${n === 1 ? "" : "s"}`, label] as [string, string];
              }}
            />
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius={48}
              outerRadius={78}
              paddingAngle={2}
              stroke="none"
            >
              {rows.map((r) => <Cell key={r.name} fill={r.fill} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex-1 space-y-1.5 text-sm">
        {rows.map((r) => {
          const pct = Math.round((r.value / total) * 100);
          return (
            <li key={r.name} className="flex items-center gap-2.5">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: r.fill }}
              />
              <span className="text-ink/80 flex-1 truncate">{r.name}</span>
              <span className="text-muted tabular-nums text-xs">
                {r.value} · {pct}%
              </span>
            </li>
          );
        })}
        <li className="pt-1.5 mt-1.5 border-t border-slate-100 flex items-center gap-2.5">
          <span className="text-ink/70 flex-1">Total open</span>
          <span className="text-ink font-semibold tabular-nums">{total}</span>
        </li>
      </ul>
    </div>
  );
}
