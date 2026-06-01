// Runs once when the Node.js server starts (enabled via
// experimental.instrumentationHook in next.config.mjs). Boots the in-process
// schedulers so jobs that vercel.json drives on Vercel still run on Railway
// (and any non-Vercel host) without relying on vercel.json crons.
//
// Each bootstrap is wrapped in its own try/catch: a failure must surface in
// logs but must never prevent the server from starting, and one subsystem
// failing to load must not stop the others.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { bootstrapEmailIntake } = await import("@/lib/email-intake-bootstrap");
    bootstrapEmailIntake();
  } catch (err) {
    console.error("[instrumentation] email-intake bootstrap failed to load:", err);
  }
  try {
    const { bootstrapTaskArchive } = await import("@/lib/task-archive-bootstrap");
    bootstrapTaskArchive();
  } catch (err) {
    console.error("[instrumentation] task-archive bootstrap failed to load:", err);
  }
  try {
    const { bootstrapEmailNotifications } = await import("@/lib/email-notifications-bootstrap");
    bootstrapEmailNotifications();
  } catch (err) {
    console.error("[instrumentation] email-notifications bootstrap failed to load:", err);
  }
}
