import Link from "next/link";
import type { SlackPageView } from "@/lib/exec/slack-page";
import { cn } from "@/lib/utils";

// The digests' day picker (P7b contract §3.12.1, UI07): today, yesterday and the 5 local days before them, each a plain
// link to /executive/slack?date=<value> (no script needed); the chosen day is the current one. Server. Wraps on a phone.

export const slackDayHref = (value: string): string => `/executive/slack?date=${encodeURIComponent(value)}`;

export function DigestDayNav({ date }: { date: SlackPageView["date"] }) {
  return (
    <nav aria-label="Digest day" data-digest-days className="flex flex-wrap gap-1.5">
      {date.options.map((o) => {
        const current = o.value === date.selected;
        return (
          <Link
            key={o.value}
            href={slackDayHref(o.value)}
            prefetch={false}
            aria-current={current ? "page" : undefined}
            data-digest-day={o.value}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors",
              current ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-ink"
            )}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}
