import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { SlackPrivacy } from "@/lib/exec/slack-intel-types";
import { cn } from "@/lib/utils";

// The privacy chip on every Slack row and card (P7b contract §3.12.1, P7-3, N10): Public, Private, Group DM, DM,
// Slack Connect (external) or Finance (a finance channel by class or name, or a finance item). Server and pure.
// A value this build doesn't know shows as Private (fail closed: never as Public).

// Literal class strings: Tailwind only emits classes it can read in source.
const TONE: Readonly<Record<SlackPrivacy, string>> = {
  public: "border-emerald-200 bg-emerald-50 text-emerald-800",
  private: "border-slate-200 bg-slate-50 text-slate-700",
  group_dm: "border-slate-200 bg-slate-50 text-slate-700",
  dm: "border-slate-200 bg-slate-50 text-slate-700",
  external: "border-indigo-200 bg-indigo-50 text-indigo-700",
  finance: "border-amber-200 bg-amber-50 text-amber-800"
};

export function privacyLabel(privacy: SlackPrivacy): string {
  const labels = SLACK_INTEL_COPY.privacy as Readonly<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(labels, privacy) ? labels[privacy] : SLACK_INTEL_COPY.privacy.private;
}

export function SlackPrivacyChip({ privacy }: { privacy: SlackPrivacy }) {
  const known = Object.prototype.hasOwnProperty.call(TONE, privacy);
  return (
    <span
      data-privacy-chip={known ? privacy : "private"}
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold leading-none",
        known ? TONE[privacy] : TONE.private
      )}
    >
      {privacyLabel(privacy)}
    </span>
  );
}
