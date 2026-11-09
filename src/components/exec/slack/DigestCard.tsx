import { Hash, Lock, Users } from "lucide-react";
import { formatCount } from "@/lib/exec/format";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { DigestCardView } from "@/lib/exec/slack-page";
import { BasisLabel } from "../BasisLabel";
import { BuildDigestButton } from "./BuildDigestButton";
import { fill } from "./parts";
import { SlackPrivacyChip } from "./SlackPrivacyChip";

// One conversation's daily digest (P7b contract §3.12.1, N19, C6, C12–C15, UI04, UI06). Server, except the build button.
// The status decides the body: a built digest shows the AI summary and its highlights, decisions and open questions (all
// labelled AI-assessed, all plain text: no markdown, no links, no images), the partial line on a busy day, and the counts
// line (people, bots and DD, threads: never a name, never a per-person count); every other status shows its one sentence.
// Finance and Slack Connect conversations carry their chips; a client tag shows the client's name (from his tag, a
// record). The card's id is "ch-<channel id>", the anchor the digest refs of chat and the brief link to.

// The three line headings (not in the frozen §3.14 copy, which has no words for them; plain labels for his lists).
const LINE_HEADINGS = { highlights: "Highlights", decisions: "Decisions", openQuestions: "Open questions" } as const;

/** The sentence for a status that isn't "built" (null for built). A stale digest inside the rebuild window says it will
 *  be rebuilt; the page shows only the last 7 days, all inside it. */
export function digestStatusText(status: DigestCardView["status"], staleRebuilds = true): string | null {
  switch (status) {
    case "built":
      return null;
    case "building":
      return SLACK_INTEL_COPY.digestBuilding;
    case "empty":
      return SLACK_INTEL_COPY.digestEmpty;
    case "stale":
      return staleRebuilds ? SLACK_INTEL_COPY.digestStale : SLACK_INTEL_COPY.digestStaleOld;
    case "failed":
      return SLACK_INTEL_COPY.digestFailed;
    case "skipped_cap":
      return SLACK_INTEL_COPY.digestSkippedCap;
    default:
      return SLACK_INTEL_COPY.digestNotBuilt;
  }
}

/** The counts line: people (internal and Slack Connect), bots and DD's own posts, threads. */
export function digestCountsText(counts: NonNullable<DigestCardView["counts"]>): string {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return fill(SLACK_INTEL_COPY.digestCounts, {
    human: formatCount(n(counts.human) + n(counts.external)),
    bots: formatCount(n(counts.bot) + n(counts.ddPost)),
    threads: formatCount(n(counts.threads))
  });
}

function Lines({ name, lines }: { name: keyof typeof LINE_HEADINGS; lines: DigestCardView["highlights"] }) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return (
    <div data-digest-lines={name} className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{LINE_HEADINGS[name]}</p>
      <ul className="space-y-0.5 text-[12.5px] leading-relaxed text-slate-700">
        {lines.map((l, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-hidden className="text-slate-300">
              •
            </span>
            <span className="min-w-0 break-words">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DigestCard({ card, staleRebuilds = true }: { card: DigestCardView; staleRebuilds?: boolean }) {
  const Icon = card.privacy === "group_dm" ? Users : card.privacy === "private" ? Lock : Hash;
  const statusText = digestStatusText(card.status, staleRebuilds);
  const built = card.status === "built" && typeof card.summary === "string" && card.summary.length > 0;
  return (
    <article
      id={`ch-${card.channelId}`}
      data-digest-card={card.channelId}
      data-digest-status={card.status}
      className="min-w-0 space-y-2.5 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-soft"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-ink">
          <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          <span className="min-w-0 break-all">{card.channelLabel}</span>
        </h3>
        <SlackPrivacyChip privacy={card.privacy} />
        {card.clientName !== null && card.clientName.length > 0 && (
          <span data-digest-client className="inline-flex min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-slate-700">
            <span className="min-w-0 break-words">{card.clientName}</span>
          </span>
        )}
      </header>
      {built ? (
        <div className="space-y-2.5">
          <p className="flex flex-wrap items-start gap-2 text-[13px] leading-relaxed text-ink">
            <span data-digest-summary className="min-w-0 flex-1 basis-48 break-words">
              {card.summary}
            </span>
            <BasisLabel basis="ai" />
          </p>
          <Lines name="highlights" lines={card.highlights} />
          <Lines name="decisions" lines={card.decisions} />
          <Lines name="openQuestions" lines={card.openQuestions} />
        </div>
      ) : (
        <p data-digest-status-text className="text-[12.5px] text-slate-600">
          {statusText ?? SLACK_INTEL_COPY.digestNotBuilt}
        </p>
      )}
      {card.partial && (
        <p data-digest-partial className="text-[12px] text-amber-800">
          {SLACK_INTEL_COPY.digestPartial}
        </p>
      )}
      {card.counts !== null && (card.status === "built" || card.status === "empty") && (
        <p data-digest-counts className="text-[11.5px] tabular-nums text-muted">
          {digestCountsText(card.counts)}
        </p>
      )}
      <BuildDigestButton channelId={card.channelId} canBuild={card.canBuild} />
    </article>
  );
}
