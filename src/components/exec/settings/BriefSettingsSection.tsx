import { Newspaper } from "lucide-react";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import type { BriefSettingsView } from "@/lib/exec/brief-settings";
import { SectionCard } from "../SectionCard";
import { BriefSettingsForm } from "./BriefSettingsForm";

// The Settings page's Brief section (P8 contract §3.17.5, C22; replaces P5a's read-only "Morning brief: Not set up yet"
// row, AM-P8-15): the five controls in their own card, saved through their own route. A server component holding the
// frame-guarded client form; `initialConfirm` exists for static renders only (tests and screenshots).

export function BriefSettingsSection({ view, initialConfirm = false }: { view: BriefSettingsView; initialConfirm?: boolean }) {
  return (
    <SectionCard title={BRIEF_COPY.settings.title} icon={Newspaper} padded={false}>
      <div data-brief-settings className="px-4 pb-1">
        <BriefSettingsForm view={view} initialConfirm={initialConfirm} />
      </div>
    </SectionCard>
  );
}
