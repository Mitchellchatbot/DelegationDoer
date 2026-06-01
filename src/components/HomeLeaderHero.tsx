"use client";

import { Crown, Users } from "lucide-react";
import { PageHero } from "@/components/PageHero";

export function HomeLeaderHero({
  meName, scopeLabel
}: {
  meName: string;
  scopeLabel?: string;
}) {
  const firstName = meName.split(" ")[0];
  return (
    <PageHero
      eyebrow={scopeLabel ? `${scopeLabel} · today` : "Today"}
      headline={["Good to see you, ", { accent: firstName }]}
      subtitle="Quick read on what's open, who's stuck, and which clients need a nudge."
      icon={scopeLabel ? <Users /> : <Crown />}
      iconTone={scopeLabel ? "emerald" : "indigo"}
    />
  );
}
