import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardCheck, Mail, Video, Inbox, ShieldAlert } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { PageHero } from "@/components/PageHero";
import { RoutingReviewBoard } from "@/components/RoutingReviewBoard";
import { MeetingApprovalsList } from "@/components/MeetingApprovalsList";
import { EmailApprovalsTab } from "./EmailApprovalsTab";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// /approvals — single landing surface for everything awaiting your eye.
// Three tabs:
//   • Emails    — drafted outbound emails (kind ∈ client_update / content_plan
//                 / custom / auto_reply). Anyone who's an author sees their
//                 own; approvers see the queue.
//   • Meetings  — tl;dv-extracted action items grouped per meeting. Leaders +
//                 admins see everything; dept heads scoped to their dept.
//   • Routing   — email-intake draft tasks awaiting routing confirmation.
//                 Leaders + admins + dept heads.
//
// Old surfaces still work — /updates/approvals and /routing-review redirect
// here with the right ?tab=.

type Tab = "emails" | "meetings" | "routing";
const VALID_TABS: Tab[] = ["emails", "meetings", "routing"];

interface PageProps {
  searchParams?: { tab?: string };
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const isLeaderLike = me.role === "leader" || me.isAdmin === true;
  const isHead = me.role === "department_head";
  // Meetings + routing surfaces are leader/head/admin only (matches the
  // old standalone pages). Everyone sees Emails — authors get their own
  // drafts, approvers get the queue.
  const canSeeMeetings = isLeaderLike || isHead;
  const canSeeRouting = isLeaderLike || isHead;

  // Resolve the active tab. Default to Emails. Falls back if the
  // requested tab isn't visible to this caller (e.g. a worker
  // bookmarked /approvals?tab=routing).
  const requested = (searchParams?.tab ?? "").toLowerCase();
  let tab: Tab = VALID_TABS.includes(requested as Tab) ? (requested as Tab) : "emails";
  if (tab === "meetings" && !canSeeMeetings) tab = "emails";
  if (tab === "routing" && !canSeeRouting) tab = "emails";

  const subtitle =
    tab === "emails"
      ? "Outbound client emails route through here before they hit the wire."
      : tab === "meetings"
        ? "Action items extracted from your tl;dv meetings, grouped per meeting."
        : "AI-routed tasks from inbox auto-intake. Confirm the routing before tasks go live.";

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Approvals"
        headline={["What needs ", { accent: "your eye" }]}
        subtitle={subtitle}
        icon={<ClipboardCheck />}
        iconTone="indigo"
      />

      <ApprovalsTabBar
        active={tab}
        canSeeMeetings={canSeeMeetings}
        canSeeRouting={canSeeRouting}
      />

      {tab === "emails" && <EmailApprovalsTab />}

      {tab === "meetings" && (
        canSeeMeetings
          ? <MeetingApprovalsList />
          : <ForbiddenCard label="meetings" />
      )}

      {tab === "routing" && (
        canSeeRouting
          ? <RoutingReviewBoard
              initialUser={{
                id: me.id,
                name: me.name,
                role: me.role,
                isAdmin: !!me.isAdmin,
                departmentIds: me.departmentIds ?? [],
                isLeader: isLeaderLike
              }}
            />
          : <ForbiddenCard label="routing" />
      )}
    </div>
  );
}

function ApprovalsTabBar({
  active, canSeeMeetings, canSeeRouting
}: { active: Tab; canSeeMeetings: boolean; canSeeRouting: boolean }) {
  const tabs: Array<{ id: Tab; label: string; icon: typeof Mail; visible: boolean }> = [
    { id: "emails",   label: "Emails",   icon: Mail,  visible: true },
    { id: "meetings", label: "Meetings", icon: Video, visible: canSeeMeetings },
    { id: "routing",  label: "Routing",  icon: Inbox, visible: canSeeRouting }
  ];
  return (
    <div className="inline-flex items-center rounded-2xl border border-slate-200/70 bg-white p-1 shadow-soft">
      {tabs.filter((t) => t.visible).map((t) => {
        const Icon = t.icon;
        const isActive = t.id === active;
        return (
          <Link
            key={t.id}
            href={`/approvals?tab=${t.id}`}
            className={cn(
              "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-[12px] font-medium transition-colors whitespace-nowrap",
              isActive
                ? "bg-accent/10 text-accent"
                : "text-ink/65 hover:text-ink hover:bg-slate-50"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

function ForbiddenCard({ label }: { label: string }) {
  return (
    <div className="card p-6 max-w-lg mx-auto mt-6 text-center">
      <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
      <div className="text-base font-medium">Approvers only</div>
      <div className="text-sm text-muted mt-1">
        The {label} tab is scoped to leaders + dept heads.
      </div>
    </div>
  );
}
