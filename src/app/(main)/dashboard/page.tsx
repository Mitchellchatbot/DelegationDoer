import Link from "next/link";
import { redirect } from "next/navigation";
import {
  LayoutDashboard, ListTodo, Briefcase, Trophy, Camera, ArrowRight,
  Clock, CheckCircle2, Crown, Mail, TrendingUp, TrendingDown, Minus
} from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllTasks } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClients, type Client } from "@/lib/clients-data";
import { PersonAvatar } from "@/components/PersonAvatar";
import { ClientHealthPill } from "@/components/ClientHealthPill";
import { TouchpointPill } from "@/components/TouchpointPill";
import { ClientFollowUpWidget } from "@/components/ClientFollowUpWidget";
import { effectiveTouchpoint } from "@/lib/client-touchpoint";
import { PriorityBadge } from "@/components/Badges";
import { Countdown } from "@/components/Countdown";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// /dashboard — worker-first landing surface. Four compact cards in
// a 2x2 grid so the most-checked-on information is one screen, no
// scrolling. Each card has a "View all" link to the full page.
//
// Cards:
//   - My tasks (top 6 open, sorted by due-date then priority)
//   - Top clients (top 10 by priority rank, with health pill)
//   - Leaderboard (top 5 by completed-this-month — same window the
//     full /updates/leaderboard uses, just compact)
//   - Recent moments (6 thumbnails)
export default async function DashboardPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  const supabase = getSupabaseAdmin();

  const monthKey = currentMonthKey();
  const monthStart = `${monthKey}-01T00:00:00.000Z`;

  // Two windows for the client-updates trend arrow:
  //   this week = last 7 days
  //   prev week = the 7 days before that
  // Counted server-side so the dashboard renders the result without
  // any client-side fetch flicker.
  const now = Date.now();
  const weekAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgoIso = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [allTasks, clients, allUsersRes, momentsRes, eomRes, thisWkRes, prevWkRes] = await Promise.all([
    getAllTasks(),
    getClients(),
    supabase.from("users").select("id, name, avatar_url, role"),
    supabase
      .from("moments")
      .select("id, user_id, image_url, caption, created_at")
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("employee_of_month")
      .select("user_id")
      .eq("month", monthKey)
      .maybeSingle(),
    supabase
      .from("eod_client_updates")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("sent_at", weekAgoIso),
    supabase
      .from("eod_client_updates")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("sent_at", twoWeeksAgoIso)
      .lt("sent_at", weekAgoIso)
  ]);

  // Hide the stat when the column doesn't exist yet (migration not
  // applied) so the dashboard doesn't crash.
  const clientUpdatesThisWeek = thisWkRes.error ? null : (thisWkRes.count ?? 0);
  const clientUpdatesPrevWeek = prevWkRes.error ? null : (prevWkRes.count ?? 0);
  const showClientUpdatesStat =
    (me.departmentIds ?? []).includes("dep_web") && clientUpdatesThisWeek !== null;

  // My tasks — top 6 open, due-date ascending (no-due-date last),
  // then priority. Mirrors the /tasks/mine sort.
  const PRI: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const myTasks = allTasks
    .filter((t) => t.assigneeId === userId && t.status !== "done")
    .sort((a, b) => {
      const da = a.dueDate ? +new Date(a.dueDate) : Infinity;
      const db = b.dueDate ? +new Date(b.dueDate) : Infinity;
      if (da !== db) return da - db;
      return (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9);
    })
    .slice(0, 6);

  // Top clients — already sorted by display_order ascending.
  const topClients = clients.slice(0, 10);

  // Leaderboard — completed-this-month per user, top 5. Lightweight
  // version of /api/performance; full page has accuracy / kudos /
  // hold-time composite.
  const usersById = new Map(
    ((allUsersRes.data ?? []) as Array<{ id: string; name: string; avatar_url: string | null; role: string }>)
      .map((u) => [u.id, u])
  );
  const completedByUser = new Map<string, number>();
  for (const t of allTasks) {
    if (t.status !== "done" || !t.assigneeId) continue;
    if (t.lastActivityAt < monthStart) continue;
    completedByUser.set(t.assigneeId, (completedByUser.get(t.assigneeId) ?? 0) + 1);
  }
  const leaderboard = Array.from(completedByUser.entries())
    .map(([uid, count]) => {
      const u = usersById.get(uid);
      return u
        ? { userId: uid, name: u.name, avatarUrl: u.avatar_url, role: u.role, count }
        : null;
    })
    .filter((x): x is { userId: string; name: string; avatarUrl: string | null; role: string; count: number } => x !== null)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const eomUserId = (eomRes.data?.user_id as string | undefined) ?? null;

  const recentMoments = (momentsRes.data ?? []) as Array<{
    id: string; user_id: string; image_url: string; caption: string | null; created_at: string;
  }>;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <header className="rounded-2xl border border-white/60 shadow-soft p-5 bg-gradient-to-r from-blue-50/80 via-white to-indigo-50/80">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-white/70 grid place-items-center text-accent shrink-0 shadow-sm">
              <LayoutDashboard className="w-6 h-6" />
            </div>
            <div>
              <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
                Dashboard
              </div>
              <h1 className="text-[24px] font-bold text-ink leading-tight">
                Good to see you, {me.name.split(" ")[0]}
              </h1>
            </div>
          </div>
          {showClientUpdatesStat && (
            <ClientUpdatesStat
              thisWeek={clientUpdatesThisWeek ?? 0}
              prevWeek={clientUpdatesPrevWeek ?? 0}
            />
          )}
        </div>
      </header>

      {clients.length > 0 && (
        <ClientFollowUpWidget
          clients={clients.map((c) => ({
            id: c.id,
            name: c.name,
            lastOutboundEmailAt: c.lastOutboundEmailAt,
            touchpointOverrideLabel: c.touchpointOverrideLabel,
            touchpointSummary: c.touchpointSummary,
            contactName: c.contactName
          }))}
          limit={5}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MyTasksCard tasks={myTasks} />
        <TopClientsCard clients={topClients} />
        <LeaderboardCard rows={leaderboard} meId={userId} eomUserId={eomUserId} />
        <MomentsCard moments={recentMoments} />
      </div>
    </div>
  );
}

// ============================ CARDS ============================

function CardShell({
  title, icon, viewAllHref, children
}: {
  title: string;
  icon: React.ReactNode;
  viewAllHref: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold text-ink inline-flex items-center gap-2">
          {icon}
          {title}
        </div>
        <Link
          href={viewAllHref}
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          View all <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

interface MyTask {
  id: string;
  title: string;
  priority: string;
  status: string;
  dueDate: string | null;
}

function MyTasksCard({ tasks }: { tasks: MyTask[] }) {
  return (
    <CardShell
      title={`My tasks (${tasks.length})`}
      icon={<ListTodo className="w-4 h-4 text-indigo-500" />}
      viewAllHref="/tasks/mine"
    >
      {tasks.length === 0 ? (
        <EmptyRow icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} message="All clear — nothing assigned right now." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tasks/${t.id}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink truncate">{t.title}</div>
                  <div className="flex items-center gap-2 text-[11px] text-ink/55 mt-0.5">
                    <PriorityBadge priority={t.priority as "critical" | "high" | "medium" | "low"} />
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {t.dueDate ? <Countdown iso={t.dueDate} /> : <span className="text-muted">no deadline</span>}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

function TopClientsCard({ clients }: { clients: Client[] }) {
  return (
    <CardShell
      title={`Top clients (${clients.length})`}
      icon={<Briefcase className="w-4 h-4 text-amber-500" />}
      viewAllHref="/clients"
    >
      {clients.length === 0 ? (
        <EmptyRow icon={<Briefcase className="w-4 h-4 text-muted" />} message="No clients yet." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {clients.map((c, i) => (
            <li key={c.id}>
              <Link
                href={`/clients/${c.id}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="text-[10px] font-bold tabular-nums text-ink/45 w-5 shrink-0">{i + 1}.</span>
                  <span className="text-[13px] font-medium text-ink truncate">{c.name}</span>
                  {(() => {
                    const { label, isOverride } = effectiveTouchpoint(
                      c.touchpointOverrideLabel, c.lastOutboundEmailAt
                    );
                    return (
                      <TouchpointPill
                        label={label}
                        lastSentAt={c.lastOutboundEmailAt}
                        isOverride={isOverride}
                        showAge
                      />
                    );
                  })()}
                  <ClientHealthPill
                    label={c.healthOverrideLabel ?? c.healthLabel}
                    overridden={!!c.healthOverrideLabel}
                  />
                </div>
                {c.contactName && (
                  <span className="text-[11px] text-ink/55 truncate shrink-0 hidden sm:inline">
                    {c.contactName}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

function LeaderboardCard({
  rows, meId, eomUserId
}: {
  rows: Array<{ userId: string; name: string; avatarUrl: string | null; role: string; count: number }>;
  meId: string;
  eomUserId: string | null;
}) {
  return (
    <CardShell
      title="Leaderboard"
      icon={<Trophy className="w-4 h-4 text-amber-500" />}
      viewAllHref="/updates/leaderboard"
    >
      {rows.length === 0 ? (
        <EmptyRow icon={<Trophy className="w-4 h-4 text-muted" />} message="Nobody has closed a task this month yet." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r, i) => {
            const isMe = r.userId === meId;
            const isEom = r.userId === eomUserId;
            const rankColor = i === 0
              ? "bg-gradient-to-br from-amber-400 to-orange-500 text-white"
              : i === 1
                ? "bg-gradient-to-br from-slate-300 to-slate-400 text-white"
                : i === 2
                  ? "bg-gradient-to-br from-amber-700 to-amber-800 text-white"
                  : "bg-slate-100 text-ink/70";
            return (
              <li
                key={r.userId}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5",
                  isMe && "bg-accent/5"
                )}
              >
                <span className={cn(
                  "inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold tabular-nums shrink-0",
                  rankColor
                )}>
                  {i + 1}
                </span>
                <PersonAvatar
                  userId={r.userId}
                  name={r.name}
                  imageUrl={r.avatarUrl}
                  size={24}
                />
                <div className="text-[13px] font-medium text-ink flex-1 truncate inline-flex items-center gap-1.5">
                  {r.name}
                  {isEom && <Crown className="w-3 h-3 text-amber-500" />}
                  {isMe && <span className="text-[10px] text-accent">you</span>}
                </div>
                <span className="text-[12px] tabular-nums font-semibold text-ink/75 shrink-0">
                  {r.count}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </CardShell>
  );
}

function MomentsCard({
  moments
}: {
  moments: Array<{ id: string; user_id: string; image_url: string; caption: string | null }>;
}) {
  return (
    <CardShell
      title="Recent moments"
      icon={<Camera className="w-4 h-4 text-fuchsia-500" />}
      viewAllHref="/updates/moments"
    >
      {moments.length === 0 ? (
        <EmptyRow icon={<Camera className="w-4 h-4 text-muted" />} message="No moments shared yet — be the first." />
      ) : (
        <div className="grid grid-cols-3 gap-1.5 p-3">
          {moments.map((m) => (
            <Link
              key={m.id}
              href="/updates/moments"
              className="relative aspect-square rounded-lg overflow-hidden bg-slate-900 group"
              title={m.caption ?? "moment"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.image_url}
                alt={m.caption ?? ""}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            </Link>
          ))}
        </div>
      )}
    </CardShell>
  );
}

function EmptyRow({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="px-4 py-8 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
      {icon}
      {message}
    </div>
  );
}

// "2026-05" — current UTC month, used for the leaderboard window
// and the EOM lookup.
function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Header stat for the Website team's mandatory client-update flow.
// Shows the rolling 7-day count + a delta vs. the prior 7 days, so
// workers can see at a glance whether they're trending up or down on
// client touches without leaving the dashboard.
function ClientUpdatesStat({ thisWeek, prevWeek }: { thisWeek: number; prevWeek: number }) {
  const delta = thisWeek - prevWeek;
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const tone =
    trend === "up" ? "text-emerald-700 bg-emerald-50 border-emerald-200/60"
    : trend === "down" ? "text-rose-700 bg-rose-50 border-rose-200/60"
    : "text-ink/60 bg-slate-50 border-slate-200/60";
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  return (
    <Link
      href="/updates/eod"
      className="rounded-2xl border border-white/60 bg-white/70 px-3 py-2 inline-flex items-center gap-3 hover:bg-white transition-colors"
      title="Open today's EOD to log a client update"
    >
      <Mail className="w-4 h-4 text-sky-600 shrink-0" />
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Client updates · 7d
        </div>
        <div className="text-[18px] font-bold text-ink tabular-nums">
          {thisWeek}
        </div>
      </div>
      <span className={"inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border tabular-nums " + tone}>
        <TrendIcon className="w-3 h-3" />
        {delta > 0 ? `+${delta}` : delta}
      </span>
    </Link>
  );
}
