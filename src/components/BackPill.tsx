import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Highlighted, rounded back-link used at the top of detail pages. Pops a
// little (gradient bg + chip shape) so it reads as a navigational anchor
// rather than a faint breadcrumb.

export function BackPill({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-gradient-to-r from-blue-100 to-violet-100 text-violet-700 border border-violet-200/60 shadow-sm transition-all hover:-translate-x-0.5 hover:shadow-md hover:from-blue-200 hover:to-violet-200"
    >
      <ArrowLeft className="w-3.5 h-3.5" /> {label}
    </Link>
  );
}
