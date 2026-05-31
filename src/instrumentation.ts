// Runs once when the Node.js server starts (enabled via
// experimental.instrumentationHook in next.config.mjs). Boots email-intake
// listeners so routing works on Railway (and any non-Vercel host) without
// relying on vercel.json crons.
//
// Wrapped in try/catch: a bootstrap failure must surface in logs but must
// never prevent the server from starting.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { bootstrapEmailIntake } = await import("@/lib/email-intake-bootstrap");
    bootstrapEmailIntake();
  } catch (err) {
    console.error("[instrumentation] email-intake bootstrap failed to load:", err);
  }
}
