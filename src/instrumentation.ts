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
  try {
    const { bootstrapClientEmailSlack } = await import("@/lib/client-email-slack-bootstrap");
    bootstrapClientEmailSlack();
  } catch (err) {
    console.error("[instrumentation] client-email-slack bootstrap failed to load:", err);
  }
  try {
    const { bootstrapScheduledCrons } = await import("@/lib/cron-bootstrap");
    bootstrapScheduledCrons();
  } catch (err) {
    console.error("[instrumentation] scheduled-crons bootstrap failed to load:", err);
  }
  // P9 F19: on SIGTERM (a Railway deploy or restart) the exec job runner stops claiming and the in-process loops stop
  // scheduling ticks. Inert until NEXT_MANUAL_SIG_HANDLE is set: Next's own handler still closes the server and exits.
  // With NEXT_MANUAL_SIG_HANDLE=true the handler waits (bounded by RAILWAY_DEPLOYMENT_DRAINING_SECONDS) for the
  // assistant's in-flight job runs, then exits. Its own try/catch, and the Node-only branch keeps it out of the Edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { installShutdownDrain } = await import("@/lib/cron-bootstrap");
      installShutdownDrain();
    } catch (err) {
      console.error("[instrumentation] shutdown drain failed to install:", err);
    }
  }
}
