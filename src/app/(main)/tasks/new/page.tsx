"use client";

import { useRouter } from "next/navigation";
import { NewTaskForm } from "@/components/NewTaskForm";

// Thin shell: the actual form lives in NewTaskForm so the same component
// can be embedded inline (here) or in the Topbar's popdown dialog. On
// create here we navigate to the new task's detail page; the popdown
// version just closes itself.
export default function NewTaskPage() {
  const router = useRouter();
  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-lg font-medium">New task</h1>
      <NewTaskForm
        onCreated={(taskId) => {
          router.push(`/tasks/${taskId}`);
          router.refresh();
        }}
        onCancel={() => router.back()}
      />
    </div>
  );
}
