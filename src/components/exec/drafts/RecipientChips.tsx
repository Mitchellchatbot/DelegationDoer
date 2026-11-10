import { X } from "lucide-react";
import type { DraftAddress, DraftKind, RecipientBadge, RecipientSuggestion, RecipientView, ReplyCandidates } from "@/lib/exec/drafts-types";
import { cn } from "@/lib/utils";

// The recipients of a draft (P4 contract §3.13.3, C75): every chip shows the
// address first and the display name second, muted, in parentheses; a name
// from a mail header is data, never the thing he reads first. Badges say what
// the server found about an address (outside the company, a role mailbox,
// not on the thread, added in Outlook).
//
// Editable (a `draft` / `saved` row in a top-level window, or a draft not
// created yet): a reply offers only Reply / Reply all. Its To and Cc come
// from the email it answers (the server derives them, L8), so there is
// nothing to type. A new email takes To / Cc / Bcc from the allowed set
// (suggestions) or a typed address, which the server checks again. No
// hooks: the add box is a small form read on submit, so this renders on the
// server for tests.

const BADGE: Readonly<Record<RecipientBadge, { label: string; className: string }>> = {
  external: { label: "External", className: "border-amber-200 bg-amber-50 text-amber-800" },
  role: { label: "Role address", className: "border-slate-200 bg-slate-100 text-slate-700" },
  not_in_thread: { label: "Not on the thread", className: "border-rose-200 bg-rose-50 text-rose-700" },
  added_in_outlook: { label: "Added in Outlook", className: "border-indigo-200 bg-indigo-50 text-indigo-700" }
};

export type RecipientField = "to" | "cc" | "bcc";

export interface RecipientChange {
  to: DraftAddress[];
  cc: DraftAddress[];
  bcc: DraftAddress[];
  replyAll?: boolean;
}

const stripBadges = (list: readonly (RecipientView | DraftAddress)[]): DraftAddress[] => list.map((r) => ({ address: r.address, name: r.name }));

/** A chip's text: the address, then the name muted in parentheses (C75). */
export function RecipientChip({ recipient, onRemove }: { recipient: RecipientView | DraftAddress; onRemove?: () => void }) {
  const badges = "badges" in recipient ? recipient.badges : [];
  return (
    <span
      data-recipient={recipient.address}
      className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-slate-200 bg-white py-0.5 pl-2.5 pr-1.5 text-[12px] text-slate-800"
    >
      <span data-recipient-primary className="break-all font-medium">
        {recipient.address}
      </span>
      {recipient.name && recipient.name.toLowerCase() !== recipient.address && <span className="break-all text-muted">{`(${recipient.name})`}</span>}
      {badges.map((b) => (
        <span key={b} className={cn("rounded-full border px-1.5 py-px text-[10px] font-medium", BADGE[b]?.className ?? BADGE.role.className)}>
          {BADGE[b]?.label ?? String(b)}
        </span>
      ))}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${recipient.address}`} className="-my-2 ml-0.5 grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-slate-100 hover:text-ink sm:my-0 sm:h-auto sm:w-auto sm:p-0.5">
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : (
        <span className="w-0.5" />
      )}
    </span>
  );
}

function AddBox({ field, suggestions, onAdd }: { field: RecipientField; suggestions: readonly RecipientSuggestion[]; onAdd: (a: DraftAddress) => void }) {
  const listId = `draft-suggestions-${field}`;
  const label = field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc";
  return (
    <form
      className="inline-flex max-w-full items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const input = form.elements.namedItem("address") as HTMLInputElement | null;
        const raw = input?.value.trim().toLowerCase() ?? "";
        if (raw === "") return;
        const known = suggestions.find((s) => s.address === raw);
        onAdd({ address: raw, name: known?.name ?? null });
        form.reset();
      }}
    >
      <input
        name="address"
        type="email"
        list={listId}
        placeholder={`Add ${label}`}
        aria-label={`Add a ${label} recipient`}
        className="w-48 min-w-0 max-w-full rounded-md border border-slate-200 px-2 py-0.5 text-[12px] outline-none focus:border-indigo-400"
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.address} value={s.address}>
            {s.name ? `${s.address} (${s.name})` : s.address}
          </option>
        ))}
      </datalist>
      <button type="submit" className="rounded-md border border-slate-200 px-2 py-0.5 text-[11.5px] font-semibold text-slate-700 hover:border-slate-300">
        Add
      </button>
    </form>
  );
}

/** A reply's Cc under Reply all, from the parent's addresses (his own already removed), minus the To list. */
export function replyAllCc(candidates: ReplyCandidates | null, to: readonly DraftAddress[]): DraftAddress[] {
  if (candidates === null) return [];
  const taken = new Set(to.map((a) => a.address));
  const out: DraftAddress[] = [];
  for (const a of [...candidates.to, ...candidates.cc]) {
    if (taken.has(a.address)) continue;
    taken.add(a.address);
    out.push({ address: a.address, name: a.name });
  }
  return out;
}

export function RecipientChips({
  kind,
  to,
  cc,
  bcc,
  candidates,
  suggestions,
  editable,
  onChange,
  replyAll
}: {
  kind: DraftKind;
  to: RecipientView[];
  cc: RecipientView[];
  bcc: RecipientView[];
  candidates: ReplyCandidates | null;
  suggestions: RecipientSuggestion[];
  editable: boolean;
  onChange: (next: RecipientChange) => void;
  /** A reply's mode (additive): Reply all is on. Absent, it reads as on while the reply has a Cc. */
  replyAll?: boolean;
}) {
  const current = (): RecipientChange => ({ to: stripBadges(to), cc: stripBadges(cc), bcc: stripBadges(bcc) });
  const addTo = (field: RecipientField, a: DraftAddress) => {
    const next = current();
    const all = [...next.to, ...next.cc, ...next.bcc].map((r) => r.address);
    if (all.includes(a.address)) return;
    next[field] = [...next[field], a];
    onChange(next);
  };
  const removeFrom = (field: RecipientField, address: string) => {
    const next = current();
    next[field] = next[field].filter((r) => r.address !== address);
    onChange(next);
  };
  const replyAllNow = replyAll ?? cc.length > 0;
  const canReplyAll = kind === "reply" && candidates !== null && replyAllCc(candidates, to).length + cc.length > 0;
  const rows: { field: RecipientField; label: string; list: RecipientView[] }[] = [
    { field: "to", label: "To", list: to },
    { field: "cc", label: "Cc", list: cc }
  ];
  if (kind === "new") rows.push({ field: "bcc", label: "Bcc", list: bcc });

  return (
    <div data-recipients={kind} className="space-y-1.5">
      {rows.map(({ field, label, list }) => {
        const canEditField = editable && kind === "new";
        if (!canEditField && list.length === 0 && field !== "to") return null;
        return (
          <div key={field} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[12.5px]">
            <span className="w-8 shrink-0 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {list.length === 0 && <span className="text-muted">{field === "to" ? "No one yet" : "None"}</span>}
              {list.map((r) => (
                <RecipientChip key={r.address} recipient={r} onRemove={canEditField ? () => removeFrom(field, r.address) : undefined} />
              ))}
              {canEditField && <AddBox field={field} suggestions={suggestions} onAdd={(a) => addTo(field, a)} />}
            </div>
          </div>
        );
      })}
      {editable && canReplyAll && (
        <fieldset className="flex flex-wrap items-center gap-3 pl-10 text-[12px] text-slate-600">
          <legend className="sr-only">Reply or reply all</legend>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name="reply-mode"
              checked={!replyAllNow}
              onChange={() => onChange({ ...current(), cc: [], replyAll: false })}
              className="h-3.5 w-3.5"
            />
            Reply
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name="reply-mode"
              checked={replyAllNow}
              onChange={() => onChange({ ...current(), cc: replyAllCc(candidates, stripBadges(to)), replyAll: true })}
              className="h-3.5 w-3.5"
            />
            Reply all
          </label>
        </fieldset>
      )}
    </div>
  );
}
