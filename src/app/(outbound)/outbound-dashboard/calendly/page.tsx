import { CalendarClock } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { EmptyChannelPanel } from "@/components/EmptyChannelPanel";

// Calendly channel — placeholder for now. Drop in the Calendly v2 API
// client once we have a token: bookings/created, no-shows, scheduled
// vs cancelled rate, top hosts.

export default function OutboundCalendlyPage() {
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Channel · Meetings"
        headline={["Calend", { accent: "ly" }]}
        subtitle="Booking volume, no-show rate, and top hosts — wired to the Calendly v2 API."
        icon={<CalendarClock />}
        iconTone="rose"
      />
      <EmptyChannelPanel
        title="Calendly hookup pending"
        body="Add a Calendly personal-access token to the server env (CALENDLY_API_TOKEN) and this surface lights up with bookings, cancellations, and host leaderboards. No client work needed — it'll mirror the Facebook Ads tile layout."
        next="Set CALENDLY_API_TOKEN → restart → refresh."
      />
    </div>
  );
}
