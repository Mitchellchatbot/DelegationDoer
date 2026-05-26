import { redirect } from "next/navigation";

// SOD moved out of the Updates tab bar — it's a first-class daily
// ritual now with its own primary sidebar entry. Old /updates/sod
// URL stays alive as a redirect so any deep-link / bookmark survives.
export default function SodUpdatesRedirect() {
  redirect("/sod");
}
