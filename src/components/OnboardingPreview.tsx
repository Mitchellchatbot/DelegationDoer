"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import type { OnboardingForm } from "@/lib/client-onboarding-forms";

// Everything a client experiences, in one place: the form they fill in, and the
// email they get for finishing it.
//
// The two live together on purpose. They are one sequence from the client's
// side — nine screens and then a message — and reviewing the copy of one
// without the other is how the form ends up saying "we'll be in touch" while
// the email says something different. Kept behind tabs rather than stacked so
// the form still gets the full width it was designed for.

type View = "form" | "email";

export function OnboardingPreview({
  form,
  initialView
}: {
  form: OnboardingForm;
  initialView: View;
}) {
  const [view, setView] = useState<View>(initialView);

  const tab = (id: View, label: string, Icon: typeof FileText) => (
    <button
      key={id}
      type="button"
      onClick={() => setView(id)}
      aria-pressed={view === id}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12.5px] font-medium transition-colors",
        view === id
          ? "bg-white text-amber-900 border border-amber-300 shadow-sm"
          : "text-amber-900/70 hover:text-amber-900 border border-transparent"
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-bg">
      {/* One bar, carrying both the warning and the switch. Sticky, because the
          form below is nine screens long and somebody who scrolled into the
          middle of it should never be in any doubt that this is a preview. */}
      <div className="sticky top-0 z-40 bg-amber-50 border-b border-amber-200">
        <div className="max-w-[900px] mx-auto px-5 py-2.5 flex items-center gap-3 flex-wrap">
          <Link
            href="/clients/onboarding"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-amber-900/80 hover:text-amber-900 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Link>

          <span className="text-[12.5px] font-semibold text-amber-900">Preview</span>
          <span className="text-[12px] text-amber-800 hidden sm:inline">
            {form.label} — nothing is saved, no files upload, nobody is notified
          </span>

          <div className="ml-auto flex items-center gap-1">
            {tab("form", "The form", FileText)}
            {tab("email", "Their email", Mail)}
          </div>
        </div>
      </div>

      {view === "form" ? (
        <OnboardingFlow
          preview
          token={`preview:${form.key}`}
          clientName="Your client"
          form={form}
          initialAnswers={{}}
          initialDoneSteps={[]}
          initialFiles={[]}
          alreadyCompleted={false}
        />
      ) : (
        <EmailView formKey={form.key} />
      )}
    </div>
  );
}

/**
 * The confirmation email, in an iframe.
 *
 * An iframe and not inlined markup: this is a whole email document with its own
 * inline styles, and dropping it into the page would let those styles and the
 * app's interfere with each other — so what you reviewed would not be what
 * lands in an inbox. Isolated, it renders under the same conditions a mail
 * client gives it.
 */
function EmailView({ formKey }: { formKey: string }) {
  const src = `/api/clients/onboarding-email-preview?formKey=${encodeURIComponent(formKey)}`;
  return (
    <div className="max-w-[900px] mx-auto px-5 py-8 space-y-4">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight text-ink">
          What they get for finishing
        </h2>
        <p className="text-[13.5px] text-ink/65 leading-relaxed pt-1.5 max-w-[62ch]">
          Sent the moment a client presses the last button. It goes from whichever mailbox is set on
          the onboarding page, so replies come back to that inbox rather than to a no-reply address.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-white shadow-soft overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-surface2 space-y-1">
          <Row k="From" v="the mailbox set on /clients/onboarding" />
          <Row k="To" v="the email they gave on the first screen" />
          <Row k="Subject" v="Thanks — we have everything for Acme Recovery" strong />
        </div>
        <iframe
          src={src}
          title="Confirmation email preview"
          className="w-full h-[560px] border-0 bg-white"
        />
      </div>

      <p className="text-[11.5px] text-ink/50">
        &ldquo;Acme Recovery&rdquo; is a stand-in — the real one uses the client&apos;s own name.{" "}
        <a href={`${src}&format=text`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          See the plain-text version
        </a>{" "}
        that text-only mail clients show.
      </p>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex gap-3 text-[12.5px]">
      <span className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold w-14 shrink-0 pt-0.5">
        {k}
      </span>
      <span className={strong ? "text-ink font-medium" : "text-ink/65"}>{v}</span>
    </div>
  );
}
