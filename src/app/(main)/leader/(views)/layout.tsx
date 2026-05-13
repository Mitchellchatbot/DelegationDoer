import { ManageTabs } from "@/components/ManageTabs";

export default function LeaderViewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <ManageTabs />
      {children}
    </div>
  );
}
