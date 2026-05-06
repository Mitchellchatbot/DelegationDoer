// Bare layout for /login and /signup — no sidebar, no topbar.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
