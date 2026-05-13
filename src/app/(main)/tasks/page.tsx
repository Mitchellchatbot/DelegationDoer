import { redirect } from "next/navigation";

export default function TasksIndex() {
  redirect("/tasks/mine");
}
