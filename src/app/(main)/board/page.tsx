import { redirect } from "next/navigation";

export default function BoardRedirect({
  searchParams
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Preserve query params (leader console deep links use ?dept=...).
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") qs.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
  }
  const s = qs.toString();
  redirect(s ? `/tasks/board?${s}` : "/tasks/board");
}
