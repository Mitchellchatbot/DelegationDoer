import { TasksTabs } from "@/components/TasksTabs";

export default function TasksViewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <TasksTabs />
      {children}
    </div>
  );
}
