// Same gradient as the main app, so /login and /signup feel like the same
// product instead of a bare auth page.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell relative min-h-screen flex items-center justify-center p-6 overflow-hidden">
      <div className="relative z-10 w-full max-w-sm">{children}</div>
    </div>
  );
}
