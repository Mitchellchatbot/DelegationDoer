import { PageHero } from "@/components/PageHero";
import { MeetingApprovalsList } from "@/components/MeetingApprovalsList";
import { Video } from "lucide-react";

// /updates/approvals
//
// Per-meeting batch approval surface for tl;dv drafts. Each card shows
// all action items the AI pulled out of a meeting so the reviewer can
// approve them together — avoids the per-task Slack-DM bombardment that
// the old single-item draft surface produced when a meeting spawned 5+
// tasks at once.
export default function ApprovalsPage() {
  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHero
        eyebrow="tl;dv meetings"
        headline={["Approve ", { accent: "meeting tasks" }]}
        subtitle="Action items extracted from your tl;dv meetings, grouped per meeting. Approve once and every task in the batch becomes live + DMs its assignee."
        icon={<Video />}
        iconTone="indigo"
      />
      <MeetingApprovalsList />
    </div>
  );
}
