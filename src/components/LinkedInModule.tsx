"use client";

import { useState } from "react";
import { Linkedin, Copy, Check, ArrowUpRight, Users } from "lucide-react";
import type { LinkedInTarget } from "@/lib/scale-actions";

// LinkedIn card for the Scale Room: a ready-to-post idea for today (copy or ask
// the brain to publish) + the 5 ICP people to message today from the live
// pipeline. LinkedIn's API can't send DMs/connection requests, so the 5 are a
// surfaced list you (or Dripify) work by hand.

// A few on-brand drafts (value-first, Mitchell's voice, no dashes). Rotates by
// day so there's a fresh angle each morning. Ask the brain to publish, or copy.
const POSTS: { angle: string; text: string }[] = [
  {
    angle: "Facebook offer",
    text: `Most treatment centers are lighting money on fire with Facebook ads.

They boost a post, run a generic "we can help" ad, point it at a homepage, and wonder why nothing happens.

Here's what actually works for behavioral health. You don't sell treatment in the ad. You lead with value, capture with a simple form, then get them on a call.

The mistakes I see every week:
1. Sending ad traffic to a homepage instead of a dedicated page
2. Asking for a call before giving any value
3. Never following up with people who filled the form but didn't book

That third one is where the money is. Most leads don't book on day one. The centers that win follow up for 30 days, not 3.

If your Meta ads aren't producing booked admits, it's almost never the budget. It's the funnel.

Happy to break down what's working right now. Message me.`
  },
  {
    angle: "SEO authority",
    text: `A family looking for treatment at 2am isn't scrolling. They search, they call the top 3 on the map, and they go with whoever shows up first.

If you're not there, you don't exist to them.

We run SEO for 50+ treatment centers and haven't lost one in 8 months. The pattern is always the same: fix the foundation, show up when families search, and the calls come without paying per click.

If you're spending on ads but invisible on search, you're paying to be someone's second choice. Fix the foundation first.`
  },
  {
    angle: "Follow-up discipline",
    text: `The best marketing channel in treatment isn't a channel. It's follow-up.

We watch centers spend thousands to generate a lead, then quit after two texts. Meanwhile the family was overwhelmed, not uninterested.

Every lead that fills a form is a person who raised their hand. Follow up for 30 days, not 3. Call, text, email. Lead with help, not a pitch.

The centers that do this quietly outgrow the ones with bigger budgets. Every time.`
  }
];

function stageChip(stage: string): { label: string; cls: string } {
  if (stage === "booked" || stage === "proposal") return { label: "booked", cls: "text-emerald-700 bg-emerald-100" };
  if (stage === "no_response") return { label: "no reply", cls: "text-amber-700 bg-amber-100" };
  return { label: "new", cls: "text-sky-700 bg-sky-100" };
}

export function LinkedInModule({ targets }: { targets: LinkedInTarget[] }) {
  const idx = Math.floor(Date.now() / 86_400_000) % POSTS.length;
  const [post, setPost] = useState(POSTS[idx].text);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(post);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is still selectable in the box */
    }
  }

  return (
    <div className="rounded-2xl border border-sky-200 bg-white shadow-soft overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-sky-50 to-white">
        <div className="w-7 h-7 rounded-lg bg-sky-100 text-sky-700 grid place-items-center shrink-0">
          <Linkedin className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink leading-tight">LinkedIn</div>
          <div className="text-[11px] text-muted leading-tight">Post 2–3×/week, value first. Message 5 ICP people a day.</div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Today's post */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[12px] font-semibold text-ink">Today&apos;s post · {POSTS[idx].angle}</span>
            <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:bg-sky-50 rounded-lg px-2 py-1">
              {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
            </button>
          </div>
          <textarea
            value={post}
            onChange={(e) => setPost(e.target.value)}
            rows={Math.min(18, Math.max(8, post.split("\n").length + 1))}
            className="w-full text-[12.5px] leading-relaxed rounded-xl border border-slate-200 p-3 bg-slate-50/50 focus:outline-none focus:border-sky-300 resize-y"
          />
          <div className="text-[11px] text-muted mt-1.5">
            Edit it, then say <span className="font-medium text-ink">&ldquo;post it&rdquo;</span> to your brain and it publishes to your LinkedIn — or copy and paste it yourself.
          </div>
        </div>

        {/* 5 to message today */}
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Users className="w-3.5 h-3.5 text-sky-600" />
            <span className="text-[12px] font-semibold text-ink">Message today ({targets.length})</span>
          </div>
          {targets.length === 0 ? (
            <div className="text-[12px] text-muted px-1">No ICP contacts in the pipeline right now — pull a fresh Apollo list.</div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
              {targets.map((t, i) => {
                const chip = stageChip(t.stage);
                return (
                  <div key={i} className="flex items-center gap-2.5 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ink truncate">{t.contact}</span>
                        <span className={"text-[9px] uppercase tracking-wide rounded px-1 py-0.5 shrink-0 " + chip.cls}>{chip.label}</span>
                      </div>
                      <div className="text-[11.5px] text-muted truncate">{[t.role, t.facility].filter(Boolean).join(" · ")}</div>
                    </div>
                    <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${t.contact} ${t.facility}`)}`}
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:bg-sky-50 rounded-lg px-2 py-1 shrink-0">
                      Find <ArrowUpRight className="w-3 h-3" />
                    </a>
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-[11px] text-muted mt-1.5">
            LinkedIn&apos;s API can&apos;t send DMs or invites, so these are yours to message (or run through Dripify) per the outreach SOP.
          </div>
        </div>
      </div>
    </div>
  );
}
