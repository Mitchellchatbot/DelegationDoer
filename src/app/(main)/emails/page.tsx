import { redirect } from "next/navigation";

// /emails used to be a parallel "outbound client emails" surface that
// listed the same drafts /approvals already shows. Two entry points
// for the same queue caused "which one do I use?" confusion, so the
// nav entry was removed. Old bookmarks still land here — we just
// punt them over to the canonical Approvals page.
export default function OutboundEmailsRedirect() {
  redirect("/approvals");
}
