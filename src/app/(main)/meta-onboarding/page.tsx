import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Workflow } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { NewMetaOnboardingButton } from "@/components/NewMetaOnboardingButton";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getAllUsers } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { canSeeFbOnboarding, FB_DEPT } from "@/lib/fb-onboarding-data";
import { listMetaOnboardings, type MetaOnboardingSummary } from "@/lib/meta-onboarding-data";
import { cn, formatDate, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Every client's Meta onboarding: Meta Instant Form leads through one Zap into
// Scaled Sync and the Scaled Admissions AI. Same audience as FB Onboarding.
export default async function MetaOnboardingListPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!canSeeFbOnboarding(me)) return notFound();

  const [{ ready, items }, users, { data: fbTasks }] = await Promise.all([
    listMetaOnboardings(),
    getAllUsers(),
    getSupabaseAdmin()
      .from("tasks")
      .select("id, title")
      .eq("department_id", FB_DEPT)
      .is("deleted_at", null)
      .is("archived_at", null)
      .neq("status", "done")
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  const started = new Set(items.map((o) => o.taskId));
  const unstartedTasks = (fbTasks ?? [])
    .filter((t) => !started.has(t.id as string))
    .map((t) => ({ id: t.id as string, title: t.title as string }));
  const fbPeople = users
    .filter((u) => (u.departmentIds ?? []).includes(FB_DEPT))
    .map((u) => ({ id: u.id, name: u.name }));
  const people = new Map(users.map((u) => [u.id, u]));

  // Longest-running first while in progress; newest finish first once done.
  const inProgress = items.filter((o) => !o.completedAt);
  const complete = items
    .filter((o) => o.completedAt)
    .sort((a, b) => ((b.completedAt ?? "") < (a.completedAt ?? "") ? -1 : 1));

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Facebook"
        headline={["Meta ", { accent: "onboarding" }]}
        subtitle="Meta Instant Form leads through one Zap into Scaled Sync and the Scaled Admissions AI: the SOP and its go-live checklist for each client."
        icon={<Workflow />}
        iconTone="teal"
        density="compact"
        metaLabel="On the plate:"
        meta={[
          { count: inProgress.length, label: "in progress" },
          { count: complete.length, label: "live", tone: "emerald" as const }
        ].filter((m) => m.count > 0)}
        trailing={<NewMetaOnboardingButton people={fbPeople} existingTasks={unstartedTasks} disabled={!ready} />}
      />

      {!ready ? (
        <div className="card p-6 text-sm">
          <div className="font-medium">Waiting for its database table</div>
          <p className="text-muted mt-1">
            Apply <code className="font-mono text-xs px-1 rounded bg-surface2 border border-border">supabase/migrations/20261119140000_meta_onboarding.sql</code>{" "}
            in the Supabase SQL editor, then reload this page.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          No Meta onboardings yet. Start one with <span className="font-medium text-ink">New Meta onboarding</span>: each
          client gets the SOP and its 32-box go-live checklist.
        </div>
      ) : (
        <>
          <Section title="In progress" items={inProgress} people={people} empty="Nothing in progress." />
          {complete.length > 0 && <Section title="Live" items={complete} people={people} />}
        </>
      )}
    </div>
  );
}

function Section({ title, items, people, empty }: {
  title: string;
  items: MetaOnboardingSummary[];
  people: Map<string, { id: string; name: string; avatarUrl?: string | null }>;
  empty?: string;
}) {
  return (
    <section className="space-y-2">
      <div className="label px-1">{title} · {items.length}</div>
      {items.length === 0 ? (
        <div className="card p-4 text-xs text-muted">{empty}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((o) => <OnboardingCard key={o.taskId} o={o} assignee={o.assigneeId ? people.get(o.assigneeId) ?? null : null} />)}
        </div>
      )}
    </section>
  );
}

function OnboardingCard({ o, assignee }: {
  o: MetaOnboardingSummary;
  assignee: { id: string; name: string; avatarUrl?: string | null } | null;
}) {
  const { done, total, next } = o.progress;
  const finished = !!o.completedAt;
  return (
    <Link href={`/meta-onboarding/${o.taskId}`} className="card card-hover p-4 block space-y-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{o.client}</div>
          <div className={cn("text-[11px] truncate", finished ? "text-ok" : "text-muted")}>
            {finished
              ? `Complete · ${relativeTime(o.completedAt as string)}`
              : next
                ? `Next: ${next.title} · ${next.done}/${next.total}`
                : "Every box ticked"}
          </div>
        </div>
        {assignee && (
          <span title={assignee.name} className="shrink-0">
            <PersonAvatar userId={assignee.id} name={assignee.name} imageUrl={assignee.avatarUrl ?? null} size={22} />
          </span>
        )}
      </div>
      <div>
        <div className="flex justify-between text-[11px] text-muted">
          <span>Go-live checklist</span>
          <span className="tabular-nums">{done}/{total}</span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-surface2 overflow-hidden">
          <div className={cn("h-full rounded-full", finished ? "bg-ok" : "bg-accent")} style={{ width: `${(done / Math.max(total, 1)) * 100}%` }} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>Started {relativeTime(o.startedAt)}</span>
        {o.dueDate && !finished && <span>Go-live {formatDate(o.dueDate)}</span>}
      </div>
    </Link>
  );
}
