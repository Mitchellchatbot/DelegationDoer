import { ExternalLink } from "lucide-react";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { SlackItemKind } from "@/lib/exec/slack-intel-types";

// Small shared pieces of the Slack surfaces (P7b contract §3.12, §3.14). Server and pure: the copy, the kind labels and
// the one link these surfaces render to Slack. Every piece of Slack-derived text is rendered as a React text node (plain
// text: no markdown, no links, no images, UI06); the only link to Slack is "Open in Slack", and only for a permalink
// isAllowedLinkUrl passes (P3's allow-list: a slack.com message or channel shape, https only).

/** A {name} template filled with plain values (never Slack text). */
export const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), template);

/** The item kind's label; "Digest" for a digest row; a kind this build doesn't know reads as a request. */
export function kindLabel(kind: SlackItemKind | "digest"): string {
  if (kind === "digest") return "Digest";
  const kinds = SLACK_INTEL_COPY.kinds as Readonly<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(kinds, kind) ? kinds[kind] : SLACK_INTEL_COPY.kinds.request;
}

/** "Open in Slack" for an allowed permalink (re-checked here, whatever the view says), else nothing. */
export function OpenInSlack({ permalink }: { permalink: string | null }) {
  if (typeof permalink !== "string" || !isAllowedLinkUrl(permalink)) return null;
  return (
    <a
      href={new URL(permalink).href}
      target="_blank"
      rel="noopener noreferrer"
      data-open-in-slack
      className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-indigo-700 hover:text-indigo-900"
    >
      {SLACK_INTEL_COPY.openInSlack}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}
