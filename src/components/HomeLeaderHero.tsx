"use client";

import { Crown, Users } from "lucide-react";
import { PageHero, type HeroMetaItem } from "@/components/PageHero";

export function HomeLeaderHero({
  meName, scopeLabel, stalled, todos, briefs, sitesAtRisk
}: {
  meName: string;
  scopeLabel?: string;
  // Optional counts rendered as an "On the plate:" summary row under
  // the headline, AA-style. Each item that has a non-zero count and a
  // matching surface link becomes a clickable chip.
  stalled?: number;
  todos?: number;
  briefs?: number;
  sitesAtRisk?: number;
}) {
  const firstName = meName.split(" ")[0];
  // Build the meta row from whichever counts the page chose to pass in.
  // Zeros are dropped so the row doesn't read as "0 stalled · 0 todos".
  const meta: HeroMetaItem[] = [];
  if (todos && todos > 0) meta.push({ count: todos, label: "open tasks", href: "/tasks", tone: "indigo" });
  if (stalled && stalled > 0) meta.push({ count: stalled, label: "stalled", href: "/tasks?filter=stalled", tone: "amber" });
  if (sitesAtRisk && sitesAtRisk > 0) meta.push({ count: sitesAtRisk, label: "sites at risk", href: "/clients", tone: "rose" });
  if (briefs && briefs > 0) meta.push({ count: briefs, label: "open briefs", href: "/seo-reports", tone: "teal" });

  return (
    <PageHero
      eyebrow={scopeLabel ? `${scopeLabel} · today` : "Today"}
      headline={["Good to see you, ", { accent: firstName }]}
      subtitle="Quick read on what's open, who's stuck, and which clients need a nudge."
      icon={scopeLabel ? <Users /> : <Crown />}
      iconTone={scopeLabel ? "emerald" : "indigo"}
      meta={meta.length > 0 ? meta : undefined}
    />
  );
}
