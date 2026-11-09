import Link from "next/link";
import { FilePen } from "lucide-react";
import { DRAFT_EXISTING, DRAFT_STARTED, OPEN_DRAFT_LINK, draftPrivateRefsText } from "@/lib/exec/chat/copy";
import type { CardView } from "@/lib/exec/chat/view-types";
import { draftPageHref } from "@/lib/exec/drafts-links";

// The card for a draft the assistant started or found (P5b contract §3.19.5,
// C24): "Draft started" or "A draft already exists for this thread", a link
// to P4's draft page, and when the chat read other private material the line
// naming what (P4 then asks for the second confirmation at Save and Send).
// Pure. The link is built here from the draft id (draftPageHref), never taken
// from the payload or from model text.

export function DraftCard({ card }: { card: Extract<CardView, { kind: "draft" }> }) {
  // ui-2: a draft that already existed wasn't started here, so no second confirmation is promised for it.
  const kinds = card.existing ? [] : (card.privateRefKinds ?? []);
  return (
    <div data-draft-card={card.draftId} className="min-w-0 space-y-1 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5">
      <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        <FilePen className="h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
        {card.existing ? DRAFT_EXISTING : DRAFT_STARTED}
      </p>
      {kinds.length > 0 && (
        <p data-draft-private-refs className="text-[12px] leading-relaxed text-amber-800">
          {draftPrivateRefsText(kinds)}
        </p>
      )}
      <Link href={draftPageHref(card.draftId)} prefetch={false} data-open-draft className="inline-flex text-[12px] font-semibold text-indigo-700 hover:text-indigo-900">
        {OPEN_DRAFT_LINK}
      </Link>
    </div>
  );
}
