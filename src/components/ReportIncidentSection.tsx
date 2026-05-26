"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ReportIncidentDialog } from "./ReportIncidentDialog";

// Settings-page entry point for the incident reporter. Used to live as
// a permanent button in the sidebar, but that put a rose-toned alert
// chip next to the calm primary nav — too loud for something most
// people use a few times a month. Lives under Settings now so it's
// reachable in two clicks, with the rest of the org admin tooling.
export function ReportIncidentSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50/70 to-white shadow-soft p-5 space-y-3">
      <header className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-xl bg-white grid place-items-center text-rose-600 shadow-sm">
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div>
          <div className="text-sm font-semibold text-ink">Report an incident</div>
          <div className="text-[12px] text-ink/65">
            Site down, malware, broken form, anything urgent. We'll route it to the right person automatically.
          </div>
        </div>
      </header>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
        style={{ background: "linear-gradient(135deg, #f43f5e 0%, #e11d48 100%)" }}
      >
        <AlertTriangle className="w-4 h-4" />
        Open incident form
      </button>
      <ReportIncidentDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}
