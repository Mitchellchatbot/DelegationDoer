import { redirect } from "next/navigation";

export default function TeamRedirect() {
  redirect("/people/list");
}
