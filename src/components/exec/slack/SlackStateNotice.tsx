import { Info } from "lucide-react";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";

// What the Slack surfaces say when the intel state (C1) isn't "ok" (P7b contract §3.12.1, §3.14, UI01): one fixed
// sentence per state, nothing read and nothing else shown. Server and pure. A state this build doesn't know reads as
// not installed (C1 fails closed the same way).

export function slackStateText(state: SlackIntelState): string | null {
  if (state === "ok") return null;
  const copy = SLACK_INTEL_COPY.state as Readonly<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(copy, state) ? copy[state] : SLACK_INTEL_COPY.state.not_installed;
}

export function SlackStateNotice({ state }: { state: SlackIntelState }) {
  const text = slackStateText(state);
  if (text === null) return null;
  return (
    <div
      role="status"
      data-slack-intel-state={state}
      className="flex items-start gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[13px] text-slate-700 shadow-soft"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
