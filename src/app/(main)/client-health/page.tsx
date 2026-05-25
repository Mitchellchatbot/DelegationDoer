import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, Send, ArrowRight, Brain } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { getClients } from "@/lib/clients-data";
import { ClientFollowUpWidget } from "@/components/ClientFollowUpWidget";
import { TouchpointPill } from "@/components/TouchpointPill";
import {
  TOUCHPOINT_META, computeTouchpointLabel, daysSince,
  effectiveTouchpoint, type TouchpointLabel
} from "@/lib/client-touchpoint";

export const dynamic = "force-dynamic";

// /client-health — dedicated dashboard that consolidates touchpoint
// health across every client. Three slabs:
//   1. Top tallies (Green / Yellow / Red counts)
//   2. Follow-up widget (top urgent clients)
//   3. Full grid grouped by health band
export default async function ClientHealthPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const clients = await getClients();

  // Decorate every client with its effective band so the page renders
  // tallies + groups in O(n).
  const decorated = clients.map((c) => {
    const eff = effectiveTouchpoint(c.touchpointOverrideLabel, c.lastOutboundEmailAt);
    return {
      client: c,
      label: eff.label,
      isOverride: eff.isOverride,
      days: daysSince(c.lastOutboundEmailAt)
    };
  });

  const tallies: Record<TouchpointLabel, number> = { green: 0, yellow: 0, red: 0 };
  for (const d of decorated) tallies[d.label] += 1;

  const grouped: Record<TouchpointLabel, typeof decorated> = {
    red: decorated
      .filter((d) => d.label === "red")
      .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999)),
    yellow: decorated
      .filter((d) => d.label === "yellow")
      .sort((a, b) => (b.days ?? 0) - (a.days ?? 0)),
    green: decorated
      .filter((d) => d.label === "green")
      .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))
  };

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      <PageHero
        eyebrow="Client health"
        headline={["Touchpoint ", { accent: "tracker" }]}
        subtitle="Color-coded by the freshness of outbound email. Green within 3 days, yellow under 10, red after that."
        icon={<Activity />}
        iconTone="rose"
        trailing={
          <div className="flex items-center gap-2 flex-wrap">
            {isLeader(me) && (
              <Link
                href="/admin/mail-satisfaction"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-50 transition-colors"
              >
                <Brain className="w-3.5 h-3.5" />
                Run satisfaction scan
              </Link>
            )}
            <Link
              href="/clients"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
            >
              All clients <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        }
      />

      {/* Top tallies */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(["green", "yellow", "red"] as const).map((band) => {
          const meta = TOUCHPOINT_META[band];
          return (
            <div
              key={band}
              className={`rounded-2xl border ${meta.border} ${meta.bg} p-4 flex items-center gap-3`}
            >
              <div className={`w-10 h-10 rounded-xl ${meta.solidBg} ${meta.solidText} grid place-items-center shrink-0`}>
                <Send className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className={`text-xs font-semibold uppercase tracking-wide ${meta.text}`}>
                  {meta.label}
                </div>
                <div className="text-2xl font-bold text-ink tabular-nums">{tallies[band]}</div>
                <div className="text-[11px] text-ink/55">{meta.description}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Follow-up widget — top urgent */}
      <ClientFollowUpWidget
        clients={clients.map((c) => ({
          id: c.id,
          name: c.name,
          lastOutboundEmailAt: c.lastOutboundEmailAt,
          touchpointOverrideLabel: c.touchpointOverrideLabel,
          touchpointSummary: c.touchpointSummary,
          contactName: c.contactName
        }))}
        limit={8}
      />

      {/* Per-band breakdown */}
      {(["red", "yellow", "green"] as const).map((band) => {
        const rows = grouped[band];
        if (rows.length === 0) return null;
        const meta = TOUCHPOINT_META[band];
        return (
          <section
            key={band}
            className="rounded-2xl border border-white/60 shadow-soft bg-white p-4 space-y-2.5"
          >
            <header className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
              <div className="text-sm font-semibold">{meta.label}</div>
              <span className="text-xs text-ink/55">· {rows.length}</span>
              <span className="text-[11px] text-ink/45 ml-1 italic">{meta.description}</span>
            </header>
            <ul className="space-y-1.5">
              {rows.map(({ client: c, label, isOverride, days }) => (
                <li key={c.id}>
                  <Link
                    href={`/clients/${encodeURIComponent(c.id)}`}
                    className="group grid grid-cols-[1fr_auto_auto] sm:grid-cols-[2fr_3fr_auto_auto] items-center gap-3 p-2.5 rounded-xl bg-white border border-slate-200/60 hover:border-accent/30 hover:shadow-soft transition-all"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate group-hover:text-accent">
                        {c.name}
                      </div>
                      {c.contactName && (
                        <div className="text-[10px] text-ink/50 truncate">{c.contactName}</div>
                      )}
                    </div>
                    <div className="hidden sm:block text-[11px] text-ink/65 truncate">
                      {c.touchpointSummary
                        ? <span className="italic">&ldquo;{c.touchpointSummary}&rdquo;</span>
                        : c.lastOutboundSubject
                          ? <span className="text-ink/55">Re: {c.lastOutboundSubject}</span>
                          : <span className="text-ink/40 italic">no summary</span>}
                    </div>
                    <div className="text-[11px] text-ink/55 tabular-nums shrink-0">
                      {days === null
                        ? "never"
                        : days === 0
                          ? "today"
                          : days === 1 ? "1d ago" : `${days}d ago`}
                    </div>
                    <TouchpointPill label={label} isOverride={isOverride} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {decorated.length === 0 && (
        <div className="card p-10 text-center text-sm text-muted">
          No clients on file yet — add one from <Link href="/clients" className="text-accent hover:underline">Clients</Link>.
        </div>
      )}
    </div>
  );
}
