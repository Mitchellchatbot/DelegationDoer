import { Bot, Paperclip } from "lucide-react";
import type { MessageView } from "@/lib/exec/email-view";
import type { ParsedAddress } from "@/lib/exec/email-types";
import { formatInZone } from "@/lib/exec/format";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";
import { EmailFrame } from "./EmailFrame";
import { SUBJECT_FALLBACK, personLabel, sizeLabel } from "./labels";
import { Chip } from "./parts";

// One of his messages on the thread page: who, when, to whom, its
// attachments (names and sizes only; nothing is downloadable here), and its
// body. An HTML body goes into the sandboxed EmailFrame; a plain-text one is
// React text. Everything on the card is the message as stored (record).

const MAX_RECIPIENTS = 6;

function addressLabel(a: ParsedAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function Recipients({ label, list }: { label: string; list: readonly ParsedAddress[] }) {
  if (list.length === 0) return null;
  const shown = list.slice(0, MAX_RECIPIENTS).map(addressLabel).join(", ");
  const more = list.length - MAX_RECIPIENTS;
  return (
    <div className="min-w-0 break-words text-[12px] text-slate-600">
      <span className="font-medium text-slate-500">{`${label}: `}</span>
      {shown}
      {more > 0 ? <span className="text-muted">{` +${more} more`}</span> : null}
    </div>
  );
}

export function MessageCard({ message, tz, now }: { message: MessageView; tz: string; now: string }) {
  const outbound = message.direction === "outbound";
  const who = message.from ? personLabel(message.from.name, message.from.email) : "Unknown sender";
  const when = formatInZone(message.sentAt, tz, "datetime", now);
  const body = message.body;
  return (
    <article
      className={cn(
        "min-w-0 rounded-2xl border bg-white shadow-soft",
        outbound ? "border-l-4 border-slate-200/70 border-l-sky-300" : "border-l-4 border-slate-200/70 border-l-indigo-300"
      )}
    >
      <header className="border-b border-slate-100 px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip tone={outbound ? "sky" : "indigo"}>{outbound ? "Sent" : "Received"}</Chip>
            <span className="min-w-0 break-words text-[13px] font-semibold text-ink">{who}</span>
            {message.from && message.from.name ? <span className="min-w-0 break-all text-[12px] text-muted">{message.from.email}</span> : null}
            {message.isAutomated && (
              <Chip title="The mail service marked it as sent by an automated system">
                <Bot className="mr-1 inline h-3 w-3" aria-hidden />
                Automated
              </Chip>
            )}
            {message.isJunk && <Chip tone="amber">In Junk</Chip>}
          </div>
          <div className="flex items-center gap-1.5">
            <BasisLabel basis="record" />
            <time dateTime={message.sentAt} className="text-[11.5px] tabular-nums text-muted">
              {when}
            </time>
          </div>
        </div>
        <div className="mt-1 space-y-0.5">
          <Recipients label="To" list={message.to} />
          <Recipients label="Cc" list={message.cc} />
          <div className="min-w-0 break-words text-[12px] text-slate-600">
            <span className="font-medium text-slate-500">Subject: </span>
            {message.subject.trim() !== "" ? message.subject : SUBJECT_FALLBACK}
          </div>
        </div>
        {message.attachments.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Attachments">
            {message.attachments.map((a, i) => (
              <li key={`${a.filename}:${i}`}>
                <Chip title={a.contentType ?? undefined}>
                  <Paperclip className="mr-1 inline h-3 w-3" aria-hidden />
                  {[a.filename, sizeLabel(a.size), a.inline ? "inline" : null].filter(Boolean).join(" · ")}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </header>
      <div className="px-3 py-3">
        {body.kind === "html" ? (
          <>
            <EmailFrame srcdoc={body.srcdoc} imagesSrcdoc={body.imagesSrcdoc} remoteImages={body.remoteImages} title={`Message from ${who}, ${when}`} />
            {body.inlineImages > 0 && (
              <p className="mt-1.5 text-[11.5px] text-muted">Inline images aren&apos;t shown here; open the message in Outlook to see them.</p>
            )}
            {body.truncated && <p className="mt-1.5 text-[11.5px] text-amber-800">This message is very long; only its first part is shown.</p>}
          </>
        ) : body.kind === "text" ? (
          <>
            <pre className="max-h-[48rem] overflow-auto whitespace-pre-wrap break-words px-1 font-sans text-[13px] leading-relaxed text-slate-800">
              {body.text}
            </pre>
            {body.truncated && <p className="mt-1.5 text-[11.5px] text-amber-800">This message is very long; only its first part is shown.</p>}
          </>
        ) : body.kind === "empty" ? (
          <p className="px-1 text-[12.5px] text-muted">This message has no text.</p>
        ) : (
          <p className="px-1 text-[12.5px] text-muted">The text of this message isn&apos;t loaded here. Open it in Outlook to read it.</p>
        )}
      </div>
    </article>
  );
}
