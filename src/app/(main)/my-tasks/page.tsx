import { redirect } from "next/navigation";

export default function MyTasksRedirect() {
  redirect("/tasks/mine");
}
