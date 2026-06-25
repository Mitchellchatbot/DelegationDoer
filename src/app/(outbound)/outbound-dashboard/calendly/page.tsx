import { CalendarClock } from "lucide-react";
import { getCalendlySummary } from "@/lib/calendly";
import { PageHero } from "@/components/PageHero";
import { CalendlyContent } from "@/components/CalendlyContent";

// Calendly — booking volume, no-show / cancel rate, top event types,
// recent bookings. Wired to the Calendly v2 API via the Personal Access
// Token in CALENDLY_API_TOKEN (server env). Defaults to a 30-day window.
// Without the token, renders a soft error panel telling you what to set.

export const revalidate = 60;
export const dynamic = "force-dynamic";

export default async function OutboundCalendlyPage() {
  const result = await getCalendlySummary({ days: 30 });
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        density="compact"
        eyebrow="Channel · Meetings"
        headline={["Calend", { accent: "ly" }]}
        subtitle="Booking volume, cancellation rate, and event-type breakdown — sourced live from the Calendly v2 API."
        icon={<CalendarClock />}
        iconTone="rose"
      />
      <CalendlyContent result={result} />
    </div>
  );
}
