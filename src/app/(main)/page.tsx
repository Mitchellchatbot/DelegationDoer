import { redirect } from "next/navigation";

// Default landing page: bounce everyone to /home, the new calm
// landing surface. /home branches on role internally (workers see
// today's tasks + clock; leaders see needs-you + team status).
export default function RootRedirect() {
  redirect("/home");
}
