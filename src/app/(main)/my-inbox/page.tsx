import { redirect } from "next/navigation";

// My Inbox was folded into the Scale Room (one owner command center).
export default function MyInboxPage() {
  redirect("/scale");
}
