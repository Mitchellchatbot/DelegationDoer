import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Briefcase, Globe2, Calendar, FileText, Lightbulb, ExternalLink, ListChecks,
  Mail, User as UserIcon, Server, KeyRound, MessageSquare,
  Hash, CalendarClock, Send
} from "lucide-react";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getClient, getResourcesForClient, type ClientResource } from "@/lib/clients-data";
import { BackPill } from "@/components/BackPill";
import { ClientHealthCard } from "@/components/ClientHealthCard";
import { ClientSeoBriefCard } from "@/components/ClientSeoBriefCard";
import { ClientWordPressCard } from "@/components/ClientWordPressCard";
import { ClientTouchpointCard } from "@/components/ClientTouchpointCard";
import { DeleteClientButton } from "@/components/DeleteClientButton";
import { ContentPlanComposerCollapsible } from "@/components/ContentPlanComposerCollapsible";
import { ClientEmailLog } from "@/components/ClientEmailLog";
import { listEmailDrafts } from "@/lib/email-drafts-data";
import { isLeader } from "@/lib/auth";
import { AddResourceForm, DeleteResourceButton } from "@/components/AddResourceForm";
import { ClientKnowledgeBase, type CompletedTaskRow } from "@/components/ClientKnowledgeBase";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccounts, listThreads } from "@/lib/missive-client";
import { buildClientSignals, threadMatchesClient } from "@/lib/client-thread-match";

export const dynamic = "force-dynamic";

const PRIORITY_TONES = {
  high:   "bg-blue-100 text-blue-700 border-blue-200/60",
  medium: "bg-indigo-100 text-indigo-700 border-indigo-200/60",
  low:    "bg-slate-100 text-slate-600 border-slate-200/60"
} as const;

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const client = await getClient(params.id);
  if (!client) notFound();

  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  // Build the match signals once. Catches emails to/from:
  //   - any of client.contactEmails (exact addresses), and
  //   - any @<domain> for client.website + client.websites.
  // So a client like Hopeful Estates with no website but a known
  // contact at cmackey@villarecoverynetwork.com still surfaces threads.
  const signals = buildClientSignals({
    website: client.website,
    websites: client.websites,
    contactEmails: client.contactEmails
  });
  const canMatchByEmail = signals.emailSet.size > 0 || signals.domainSet.size > 0;

  const supabase = getSupabaseAdmin();
  const [resources, openTasksRes, doneTasksRes, visibleIds, recentScoresRes] = await Promise.all([
    getResourcesForClient(client.id),
    // Open tasks for this client — by free-text name match (legacy linkage).
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("client_name", client.name)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .limit(20)
      .then((r) => r.data ?? []),
    // Completed-tasks knowledge base. Selects description + tags so
    // the page renders the actual record of what was done (not just
    // titles) and the list_client_completed_tasks AI tool has the
    // same content to summarize from. Bumped 20 → 100 so a year of
    // history is visible without paginating.
    supabase
      .from("tasks")
      .select("id, title, description, status, priority, last_activity_at, tags")
      .eq("client_name", client.name)
      .eq("status", "done")
      .order("last_activity_at", { ascending: false })
      .limit(100)
      .then((r) => r.data ?? []),
    me ? visibleAccountIdsFor(me) : Promise.resolve(new Set<string>()),
    // Latest 8 per-message scores for this client. Surfaced under
    // "Show per-message scores" so a leader can see *why* the median
    // landed where it did. Wrapped via .then so a missing table
    // (migration not yet applied) just renders an empty list.
    supabase
      .from("email_satisfaction_scores")
      .select("satisfaction_score, reason, delivered_at, direction, subject")
      .eq("client_id", client.id)
      .order("delivered_at", { ascending: false })
      .limit(8)
      .then((r) => (r.error ? [] : (r.data ?? [])))
  ]);

  // EOD client updates filed against this client. Joins the author's
  // name in the same shot so a row can render "Talha — emailed about X".
  // Wrapped in try/catch so the page still renders if the migration
  // hasn't been applied yet.
  type ClientUpdateRow = {
    id: string;
    message: string;
    slack_ts: string | null;
    sent_at: string | null;
    created_at: string;
    note_date: string;
    user_id: string;
    users: { name: string | null }[] | { name: string | null } | null;
  };
  let clientUpdatesRes: ClientUpdateRow[] = [];
  try {
    const { data } = await supabase
      .from("eod_client_updates")
      .select("id, message, slack_ts, sent_at, created_at, note_date, user_id, users(name)")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false })
      .limit(30);
    clientUpdatesRes = (data ?? []) as ClientUpdateRow[];
  } catch {
    clientUpdatesRes = [];
  }

  // Email history — pulls every recent thread from Missive once, then
  // applies the per-client signals. Scoped to the user's visible
  // inboxes via account_emails so workers don't see threads from
  // inboxes they couldn't otherwise reach.
  let clientThreads: {
    id: string;
    subject: string;
    accountId: string;
    lastAt: string;
    participants: string[];
    status: string;
  }[] = [];
  if (canMatchByEmail) {
    try {
      const [allThreads, accounts] = await Promise.all([
        // Bumped from 400 → 1000 so older client threads still surface
        // on the page without needing pagination.
        listThreads({ folder: "INBOX", limit: 1000 }),
        listAccounts()
      ]);
      const accountIdByEmail = new Map(
        accounts.map((a) => [a.email.toLowerCase(), a.id])
      );

      clientThreads = allThreads
        .map((t) => {
          // Pick the first connected-account email that the user can see
          // for the deep-link. Without one, the user can't navigate to
          // the thread anyway, so skip it.
          const visibleAccountEmail = (t.account_emails ?? []).find((ae) => {
            const accId = accountIdByEmail.get(ae.email.toLowerCase());
            if (!accId) return false;
            return visibleIds === null || visibleIds.has(accId);
          });
          if (!visibleAccountEmail) return null;
          const accountId = accountIdByEmail.get(
            visibleAccountEmail.email.toLowerCase()
          )!;

          if (!threadMatchesClient(t.participants, signals)) return null;

          // Wordfence security alerts (WordPress plugin) are pure noise
          // on the client email-history surface — they're sent BY the
          // plugin TO the client, but they come from wordfence.com, so
          // they don't say anything about how the client/team relationship
          // is going. Filter by sender domain + subject prefix.
          const isWordfence =
            (t.participants ?? []).some((p) => /@wordfence\.com\b/i.test(p)) ||
            /^wordfence\b/i.test(t.subject ?? "");
          if (isWordfence) return null;

          return {
            id: t.id,
            subject: t.subject || "(no subject)",
            accountId,
            lastAt: t.last_message_at,
            participants: t.participants ?? [],
            status: t.status as string
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .sort(
          (a, b) =>
            new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
        )
        .slice(0, 50);
    } catch {
      // missive clone down / unreachable — surface a softer empty state.
      clientThreads = [];
    }
  }

  const meetings    = resources.filter((r) => r.kind === "meeting");
  const documents   = resources.filter((r) => r.kind === "document");
  const suggestions = resources.filter((r) => r.kind === "suggestion");

  // Outbound email log for this client — drafts + sent + everything in
  // between. Wrapped in try/catch so the page still renders if the
  // scheduled_for migration hasn't been applied yet.
  let clientEmailDrafts: Awaited<ReturnType<typeof listEmailDrafts>> = [];
  try {
    clientEmailDrafts = await listEmailDrafts({ clientId: client.id, limit: 30 });
  } catch {
    clientEmailDrafts = [];
  }

  // Who can compose a Content Plan? SEO dept members + leaders/admins.
  // Heads of any dept can also use it — they're the ones most likely
  // to author plans on behalf of a worker.
  const canComposeContentPlan = !!me && (
    isLeader(me) ||
    !!me.isAdmin ||
    (me.departmentIds ?? []).includes("dep_seo") ||
    me.role === "department_head"
  );

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <BackPill href="/clients" label="Clients" />

      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="w-12 h-12 rounded-xl bg-white/70 border border-white/80 grid place-items-center text-indigo-600 shadow-sm shrink-0">
              <Briefcase className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold">{client.name}</h1>
                {client.priorityRank !== null && (
                  <span className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-md bg-white/80 text-ink/75 border border-white/80">
                    Rank #{client.priorityRank}
                  </span>
                )}
                <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${PRIORITY_TONES[client.priority]}`}>
                  {client.priority} priority
                </span>
                {client.status && client.status !== "active" && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full border capitalize bg-amber-100 text-amber-700 border-amber-200/70">
                    {client.status}
                  </span>
                )}
              </div>
              {client.contactName && (
                <div className="text-xs text-ink/70 inline-flex items-center gap-1 mt-1.5">
                  <UserIcon className="w-3 h-3" /> {client.contactName}
                </div>
              )}
              {client.contactEmails.length > 0 && (
                <div className="text-xs text-ink/60 flex items-center gap-1.5 flex-wrap mt-1">
                  <Mail className="w-3 h-3 shrink-0" />
                  {client.contactEmails.map((e) => (
                    <a
                      key={e}
                      href={`mailto:${e}`}
                      className="hover:text-accent underline-offset-2 hover:underline"
                    >
                      {e}
                    </a>
                  ))}
                </div>
              )}
              {client.notes && (
                <p className="text-sm text-ink/70 mt-2 max-w-2xl">{client.notes}</p>
              )}
            </div>
          </div>
          {me && (me.role === "leader" || me.isAdmin) && (
            <div className="shrink-0">
              <DeleteClientButton clientId={client.id} clientName={client.name} />
            </div>
          )}
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      {/* SEO brief — leader/admin/SEO-head sets it; everyone viewing
          the client sees it. Hidden entirely when no brief exists
          and viewer can't edit, so accounts that don't need SEO
          attention don't show empty chrome. */}
      <ClientSeoBriefCard
        clientId={client.id}
        brief={client.seoBrief}
        briefAt={client.seoBriefAt}
        briefByName={
          client.seoBriefBy
            ? (await getUserById(client.seoBriefBy))?.name ?? null
            : null
        }
        canEdit={
          !!(me && (
            me.role === "leader"
            || me.isAdmin
            || (me.role === "department_head" && (me.departmentIds ?? []).includes("dep_seo"))
          ))
        }
      />

      <ClientTouchpointCard
        clientId={client.id}
        lastOutboundEmailAt={client.lastOutboundEmailAt}
        lastOutboundSubject={client.lastOutboundSubject}
        touchpointOverrideLabel={client.touchpointOverrideLabel}
        touchpointOverrideNote={client.touchpointOverrideNote}
        touchpointOverrideAt={client.touchpointOverrideAt}
        touchpointSummary={client.touchpointSummary}
        touchpointSummaryAt={client.touchpointSummaryAt}
        encourageEmails={client.encourageEmails}
        canEdit={!!(me && (me.role === "leader" || me.isAdmin))}
      />

      <ClientHealthCard
        clientId={client.id}
        healthLabel={client.healthLabel}
        healthScore={client.healthScore}
        healthSampleSize={client.healthSampleSize}
        healthSummary={client.healthSummary}
        healthComputedAt={client.healthComputedAt}
        healthOverrideLabel={client.healthOverrideLabel}
        healthOverrideNote={client.healthOverrideNote}
        healthOverrideAt={client.healthOverrideAt}
        recentScores={recentScoresRes as Array<{
          satisfaction_score: number;
          reason: string | null;
          delivered_at: string | null;
          direction: "inbound" | "outbound";
          subject: string | null;
        }>}
        canEdit={!!(me && (me.role === "leader" || me.isAdmin))}
      />

      {/* WordPress panel — SEO team + leaders/admins only. Falls back to
          the first listed website (or the legacy single website column)
          when no explicit wp_url override is set on the client. */}
      {me && (me.isAdmin || me.role === "leader" || me.departmentIds.includes("dep_seo")) && (
        <ClientWordPressCard
          clientId={client.id}
          initialWpUrl={client.wpUrl}
          fallbackUrl={client.websites[0] ?? client.website ?? null}
          initialBlogPostsCount={client.wpBlogPostsCount}
          initialUpdatedAt={client.wpCountsUpdatedAt}
          initialError={client.wpLastError}
        />
      )}

      {/* Service / integration metadata — collapsed into a single card
          so the operator can scan the wiring (where the domain lives,
          whether Tawk is in, what the start date was) in one glance. */}
      {(client.websites.length > 0 || client.startDate || client.subscriptionDate || client.domainLocation || client.hostingLocation || client.didBuildWebsite !== null || client.tawkInstalled !== null || client.googleProfileAutomation !== null) && (
        <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-blue-50/60 to-white p-4 space-y-3">
          <header className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <div className="text-sm font-semibold">Client info</div>
          </header>

          {/* Multi-website list. Lists every site the client runs;
              clickable links open in a new tab. */}
          {client.websites.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5">
                Websites · {client.websites.length}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {client.websites.map((w) => (
                  <a
                    key={w}
                    href={w.startsWith("http") ? w : `https://${w}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/85 border border-blue-200/70 text-xs text-ink hover:text-accent hover:border-accent/40 transition-colors"
                  >
                    <Globe2 className="w-3 h-3 text-blue-600" />
                    {w.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")}
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2.5 text-xs">
            {client.startDate && (
              <InfoCell icon={<CalendarClock className="w-3 h-3" />} label="Start date">
                {new Date(client.startDate).toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric"
                })}
              </InfoCell>
            )}
            {client.subscriptionDate && (
              <InfoCell icon={<Hash className="w-3 h-3" />} label="Subscription day">
                {client.subscriptionDate}
              </InfoCell>
            )}
            {client.domainLocation && (
              <InfoCell icon={<Server className="w-3 h-3" />} label="Domain">
                {client.domainLocation}
              </InfoCell>
            )}
            {client.hostingLocation && (
              <InfoCell icon={<KeyRound className="w-3 h-3" />} label="Hosting">
                {client.hostingLocation}
              </InfoCell>
            )}
            {client.didBuildWebsite !== null && (
              <InfoCell icon={<MessageSquare className="w-3 h-3" />} label="We built site">
                {client.didBuildWebsite ? "Yes" : "No"}
              </InfoCell>
            )}
            {client.tawkInstalled !== null && (
              <InfoCell icon={<MessageSquare className="w-3 h-3" />} label="Tawk chat">
                {client.tawkInstalled ? "Installed" : "Not installed"}
              </InfoCell>
            )}
            {client.googleProfileAutomation !== null && (
              <InfoCell icon={<MessageSquare className="w-3 h-3" />} label="GBP automation">
                {client.googleProfileAutomation ? "On" : "Off"}
              </InfoCell>
            )}
          </div>
        </section>
      )}

      {canComposeContentPlan && (
        <ContentPlanComposerCollapsible
          lockedClient={{
            id: client.id,
            name: client.name,
            contactEmails: client.contactEmails
          }}
        />
      )}

      <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-slate-50/60 to-white p-4 space-y-3">
        <header className="flex items-center gap-2">
          <Send className="w-4 h-4 text-blue-600" />
          <div className="text-sm font-semibold">Client emails</div>
          <span className="text-[10px] text-ink/50 ml-1">
            Outbound drafts + sent — content plans, EOD updates, custom.
          </span>
        </header>
        <ClientEmailLog rows={clientEmailDrafts} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section
          title="Meeting links"
          icon={<Calendar className="w-4 h-4" />}
          tone="blue"
          empty="No meeting links yet."
          add={<AddResourceForm clientId={client.id} kind="meeting" />}
          items={meetings}
          renderItem={(r) => (
            <ResourceRow
              key={r.id}
              clientId={client.id}
              resource={r}
              icon={<Calendar className="w-3.5 h-3.5 text-blue-600" />}
              tone="blue"
            />
          )}
        />

        <Section
          title="Documents"
          icon={<FileText className="w-4 h-4" />}
          tone="indigo"
          empty="No documents yet."
          add={<AddResourceForm clientId={client.id} kind="document" />}
          items={documents}
          renderItem={(r) => (
            <ResourceRow
              key={r.id}
              clientId={client.id}
              resource={r}
              icon={<FileText className="w-3.5 h-3.5 text-indigo-600" />}
              tone="indigo"
            />
          )}
        />
      </div>

      <Section
        title="Client updates"
        icon={<Send className="w-4 h-4" />}
        tone="blue"
        empty="No updates filed for this client yet."
        items={clientUpdatesRes}
        renderItem={(u) => {
          const authorName = Array.isArray(u.users)
            ? (u.users[0]?.name ?? "Someone")
            : (u.users?.name ?? "Someone");
          return (
          <div
            key={u.id}
            className="flex items-start gap-2.5 p-2.5 rounded-xl bg-white/80 border border-white/70"
          >
            <Send className="w-3.5 h-3.5 text-sky-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <div className="text-[12px] font-semibold text-ink">
                  {authorName}
                </div>
                <div className="text-[10px] text-ink/55 tabular-nums">
                  {new Date(u.created_at).toLocaleDateString(undefined, {
                    month: "short", day: "numeric"
                  })}
                </div>
                {u.slack_ts ? (
                  <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/60">
                    Slack ✓
                  </span>
                ) : (
                  <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/60">
                    Saved
                  </span>
                )}
              </div>
              <div className="text-[13px] text-ink/80 mt-1 whitespace-pre-wrap leading-snug">
                {u.message}
              </div>
            </div>
          </div>
          );
        }}
      />

      <Section
        title="Team notes"
        icon={<Lightbulb className="w-4 h-4" />}
        tone="violet"
        empty="No team notes yet."
        add={<AddResourceForm clientId={client.id} kind="suggestion" />}
        items={suggestions}
        renderItem={(r) => (
          <SuggestionRow
            key={r.id}
            clientId={client.id}
            resource={r}
          />
        )}
      />

      <Section
        title="Open tasks"
        icon={<ListChecks className="w-4 h-4" />}
        tone="purple"
        empty="No open tasks linked to this client."
        items={openTasksRes as { id: string; title: string; status: string; priority: string; due_date: string | null }[]}
        renderItem={(t) => (
          <Link
            key={t.id}
            href={`/tasks/${t.id}`}
            className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-blue-200 hover:bg-blue-50/40 transition-colors"
          >
            <div className="text-sm flex-1 truncate group-hover:text-accent">{t.title}</div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/60 capitalize">
              {t.status.replace("_", " ")}
            </span>
          </Link>
        )}
      />

      <Section
        title="Email history"
        icon={<Mail className="w-4 h-4" />}
        tone="blue"
        empty={
          canMatchByEmail
            ? "No threads from this client in any inbox you can see yet."
            : "Add a website or a contact email to this client to surface their email history here."
        }
        items={clientThreads}
        renderItem={(t) => (
          <Link
            key={t.id}
            href={`/inboxes/${t.accountId}/threads/${t.id}`}
            className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-blue-200 hover:bg-blue-50/40 transition-colors"
          >
            <Mail className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate group-hover:text-accent">{t.subject}</div>
              <div className="text-[10px] text-ink/55 truncate">
                {t.participants.slice(0, 2).join(", ")}
                {t.participants.length > 2 ? ` +${t.participants.length - 2}` : ""}
              </div>
            </div>
            <div className="text-[10px] text-ink/55 shrink-0 tabular-nums">
              {new Date(t.lastAt).toLocaleDateString(undefined, {
                month: "short", day: "numeric"
              })}
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200/60 capitalize shrink-0">
              {t.status}
            </span>
          </Link>
        )}
      />

      <ClientKnowledgeBase tasks={doneTasksRes as CompletedTaskRow[]} />
    </div>
  );
}

// Generic colored section card. Each tone matches one of our four
// blue→purple flavors; passing different tones differentiates the
// resource categories visually.
function Section<T>({
  title, icon, tone, empty, items, add, renderItem
}: {
  title: string;
  icon: React.ReactNode;
  tone: "blue" | "indigo" | "violet" | "purple";
  empty: string;
  items: T[];
  add?: React.ReactNode;
  renderItem: (item: T) => React.ReactNode;
}) {
  const TONES = {
    blue:   { bg: "from-blue-50/60 to-white",     dot: "bg-blue-500" },
    indigo: { bg: "from-indigo-50/60 to-white",   dot: "bg-indigo-500" },
    violet: { bg: "from-indigo-50/60 to-white",   dot: "bg-indigo-500" },
    purple: { bg: "from-blue-50/60 to-white",   dot: "bg-blue-500" }
  } as const;
  const t = TONES[tone];
  return (
    <section className={`rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br ${t.bg} p-4 space-y-3`}>
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${t.dot}`} />
          <div className="text-sm font-semibold inline-flex items-center gap-1.5">
            {icon} {title}
          </div>
          <span className="text-xs text-muted">· {items.length}</span>
        </div>
        {add}
      </header>
      {items.length === 0 ? (
        <div className="text-xs text-muted italic px-1">{empty}</div>
      ) : (
        <div className="space-y-1.5">
          {items.map(renderItem)}
        </div>
      )}
    </section>
  );
}

function ResourceRow({
  clientId, resource, icon
}: {
  clientId: string;
  resource: ClientResource;
  icon: React.ReactNode;
  tone: "blue" | "indigo";
}) {
  return (
    <div className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-indigo-200 transition-colors">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{resource.title}</div>
        {resource.url && (
          <a
            href={resource.url.startsWith("http") ? resource.url : `https://${resource.url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-ink/60 truncate inline-flex items-center gap-1 hover:text-accent"
          >
            <ExternalLink className="w-3 h-3" /> {resource.url}
          </a>
        )}
      </div>
      <DeleteResourceButton clientId={clientId} resourceId={resource.id} />
    </div>
  );
}

function InfoCell({
  icon, label, children
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold inline-flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-ink/85 truncate mt-0.5">{children}</div>
    </div>
  );
}

function SuggestionRow({
  clientId, resource
}: { clientId: string; resource: ClientResource }) {
  return (
    <div className="group rounded-xl bg-white/80 border border-white/70 p-3 hover:border-indigo-200 transition-colors">
      <div className="flex items-start gap-2">
        <Lightbulb className="w-3.5 h-3.5 text-indigo-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{resource.title}</div>
          {resource.body && (
            <div className="text-xs text-ink/60 mt-1 whitespace-pre-wrap">{resource.body}</div>
          )}
        </div>
        <DeleteResourceButton clientId={clientId} resourceId={resource.id} />
      </div>
    </div>
  );
}
