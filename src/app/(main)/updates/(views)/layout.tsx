import { UpdatesTabs } from "@/components/UpdatesTabs";

export default function UpdatesViewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <UpdatesTabs />
      {children}
    </div>
  );
}
