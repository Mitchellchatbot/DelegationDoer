"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SCALE_SOURCE_KEYS, SCALE_SOURCE_LABELS, type ScaleSourceFlags, type ScaleSourceKey, type ScaleSources } from "@/lib/scale-sources-types";

// The owner's on/off for the Scale Room's two outside sources. Off means the
// page doesn't call that app, shows no card for it, and the Growth Brain's
// next brief leaves it out. Saving refreshes the page so the cards follow.

export function ScaleSourceSwitches({ initial }: { initial: ScaleSources }) {
  const router = useRouter();
  const [flags, setFlags] = useState<ScaleSourceFlags>({ facebook: initial.facebook, outbound: initial.outbound });
  const [saving, setSaving] = useState<ScaleSourceKey | null>(null);

  async function flip(key: ScaleSourceKey) {
    const next = !flags[key];
    const before = flags;
    setFlags({ ...flags, [key]: next });
    setSaving(key);
    try {
      const res = await fetch("/api/scale/sources", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.sources) {
        setFlags(before);
        toast.error(data.error ?? "couldn't save");
        return;
      }
      setFlags({ facebook: data.sources.facebook, outbound: data.sources.outbound });
      toast.success(`${SCALE_SOURCE_LABELS[key]} ${next ? "on" : "off"}`);
      router.refresh();
    } catch (err) {
      setFlags(before);
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-soft">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Sources</div>
        {SCALE_SOURCE_KEYS.map((key) => {
          const on = flags[key];
          return (
            <div key={key} className="flex items-center gap-2 text-[13px] text-ink">
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={SCALE_SOURCE_LABELS[key]}
                disabled={saving !== null}
                onClick={() => flip(key)}
                className={
                  "relative inline-flex items-center w-9 h-5 rounded-full border transition-colors disabled:opacity-60 " +
                  (on
                    ? "bg-emerald-500 border-emerald-600 hover:bg-emerald-600"
                    : "bg-slate-200 border-slate-300 hover:bg-slate-300")
                }
              >
                <span
                  className={
                    "absolute top-[1px] w-[16px] h-[16px] rounded-full bg-white shadow-sm transition-transform " +
                    (on ? "translate-x-[17px]" : "translate-x-[1px]")
                  }
                />
              </button>
              {SCALE_SOURCE_LABELS[key]}
            </div>
          );
        })}
      </div>
      {initial.readError && (
        <div className="mt-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          Couldn&apos;t read source settings — both sources are off until they can be read: {initial.readError}
        </div>
      )}
    </div>
  );
}
