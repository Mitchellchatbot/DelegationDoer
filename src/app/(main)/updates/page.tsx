import { redirect } from "next/navigation";

// /updates used to land on EOD. Now EOD is its own top-level route
// (/eod) and /updates/eod is just a redirect — so the old chain
// bounced people right off the Updates surface to the EOD form.
// Land on /updates/recommendations instead: visible to every role
// and matches the "team feed" feel of the remaining UpdatesTabs.
export default function UpdatesIndex() {
  redirect("/updates/recommendations");
}
