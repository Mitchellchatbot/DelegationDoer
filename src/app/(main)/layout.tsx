import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell flex">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Topbar />
        <main className="p-6 anim-fade-in-up">{children}</main>
      </div>
    </div>
  );
}
