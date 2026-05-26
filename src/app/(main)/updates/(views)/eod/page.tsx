import { redirect } from "next/navigation";

// EOD moved out of the Updates tab bar — it's a first-class daily
// ritual now with its own primary sidebar entry. Old /updates/eod
// URL stays alive as a redirect so any deep-link / bookmark survives.
export default function EodUpdatesRedirect() {
  redirect("/eod");
}
