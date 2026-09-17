"use client";

import { useState } from "react";
import { Linkedin, Copy, Check, ArrowUpRight, Users, Sparkles, RefreshCw } from "lucide-react";
import type { LinkedInTarget } from "@/lib/scale-actions";

// LinkedIn card for the Scale Room:
//  - You type a TOPIC, the brain drafts a post in your voice, and you can give
//    feedback to revise it (topic → draft → feedback → revise).
//  - The 5 ICP people to DM today, from the live pipeline (LinkedIn's API can't
//    send DMs/invites, so you work these by hand or via Dripify).

const TOPIC_IDEAS = [
  "our Facebook ads offer for treatment centers",
  "why follow-up beats ad budget",
  "a recent client win",
  "SEO for behavioral health",
  "the biggest mistake treatment centers make with marketing"
];

function stageChip(stage: string): { label: string; cls: string } {
  if (stage === "booked" || stage === "proposal") return { label: "booked", cls: "text-emerald-700 bg-emerald-100" };
  if (stage === "no_response") return { label: "no reply", cls: "text-amber-700 bg-amber-100" };
  return { label: "new", cls: "text-sky-700 bg-sky-100" };
}

export function LinkedInModule({ targets }: { targets: LinkedInTarget[] }) {
  const [topic, setTopic] = useState("");
  const [post, setPost] = useState("");
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function draft(revise: boolean) {
    const t = topic.trim();
    if (!t && !post) { setError("Type a topic first."); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/brain/linkedin/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: t,
          instruction: revise ? instruction.trim() : "",
          current: revise ? post : ""
        })
      });
      const j = await res.json();
      if (res.ok && j.post) {
        setPost(j.post);
        setInstruction("");
      } else {
        setError(j.error || "draft failed");
      }
    } catch {
      setError("draft failed");
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(post);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — text still selectable */
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
          <div className="text-[11px] text-muted leading-tight">Write a post from your topic. Message 5 ICP people a day.</div>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Topic → draft */}
        <div>
          <label className="text-[12px] font-semibold text-ink">What do you want to post about?</label>
          <div className="flex items-center gap-2 mt-1.5">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !loading) draft(false); }}
              placeholder="e.g. our Facebook ads offer for treatment centers"
              className="flex-1 min-w-0 text-[13px] rounded-lg border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:border-sky-300"
            />
            <button type="button" onClick={() => draft(false)} disabled={loading || !topic.trim()}
              className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-sky-600 rounded-lg px-3 py-2 hover:bg-sky-700 disabled:opacity-50 shrink-0">
              {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {loading ? "Writing…" : "Write it"}
            </button>
          </div>
          {!post && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {TOPIC_IDEAS.map((t) => (
                <button key={t} type="button" onClick={() => setTopic(t)}
                  className="text-[11px] text-sky-700 bg-sky-50 hover:bg-sky-100 rounded-full px-2 py-1">{t}</button>
              ))}
            </div>
          )}
          {error && <div className="text-[12px] text-rose-600 mt-1.5">{error}</div>}
        </div>

        {/* Draft + feedback loop */}
        {post && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-ink">Your post</span>
              <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:bg-sky-50 rounded-lg px-2 py-1">
                {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
              </button>
            </div>
            <textarea
              value={post}
              onChange={(e) => setPost(e.target.value)}
              rows={Math.min(20, Math.max(8, post.split("\n").length + 1))}
              className="w-full text-[12.5px] leading-relaxed rounded-xl border border-slate-200 p-3 bg-slate-50/50 focus:outline-none focus:border-sky-300 resize-y"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !loading && instruction.trim()) draft(true); }}
                placeholder="Give feedback (e.g. 'shorter, more aggressive, add a stat')"
                className="flex-1 min-w-[200px] text-[12px] rounded-lg border border-slate-200 px-2.5 py-1.5 bg-white focus:outline-none focus:border-sky-300"
              />
              <button type="button" onClick={() => draft(true)} disabled={loading || !instruction.trim()}
                className="flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:bg-sky-50 rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                <RefreshCw className={"w-3.5 h-3.5 " + (loading ? "animate-spin" : "")} /> Revise
              </button>
            </div>
            <div className="text-[11px] text-muted">
              Edit it, then say <span className="font-medium text-ink">&ldquo;post it&rdquo;</span> to your brain and it publishes to your LinkedIn — or copy and paste it yourself.
            </div>
          </div>
        )}

        {/* 5 to DM today */}
        <div className="pt-1 border-t border-slate-100">
          <div className="flex items-center gap-1.5 mb-1.5 mt-3">
            <Users className="w-3.5 h-3.5 text-sky-600" />
            <span className="text-[12px] font-semibold text-ink">5 to DM today ({targets.length})</span>
          </div>
          {targets.length === 0 ? (
            <div className="text-[12px] text-muted px-1">No ICP contacts in the pipeline right now — pull a fresh Apollo list, or the ads dashboard is down.</div>
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
            LinkedIn&apos;s API can&apos;t send DMs or invites, so these are yours to DM (or run through Dripify) per the outreach SOP.
          </div>
        </div>
      </div>
    </div>
  );
}
