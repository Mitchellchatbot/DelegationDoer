import { PeopleTabs } from "@/components/PeopleTabs";

export default function PeopleViewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <PeopleTabs />
      {children}
    </div>
  );
}
