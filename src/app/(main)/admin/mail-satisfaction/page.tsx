import { redirect } from "next/navigation";
import { Brain } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { MailSatisfactionScanner } from "@/components/MailSatisfactionScanner";

export const dynamic = "force-dynamic";

// /admin/mail-satisfaction — leader-only kickoff for the one-time
// historical scan + scoring pass. The client component handles the
// poll loop; this page just gates on permission and renders the hero.
export default async function MailSatisfactionPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");
  if (!isLeader(me)) redirect("/");

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <PageHero
        eyebrow="Admin · Backfill"
        headline={["Mail ", { accent: "satisfaction" }, " scan"]}
        subtitle="One-time pass over every client's email history. Each message gets a 0-100 satisfaction score from Claude; the median drives the client's overall health badge."
        icon={<Brain />}
        iconTone="fuchsia"
      />
      <MailSatisfactionScanner />
    </div>
  );
}
