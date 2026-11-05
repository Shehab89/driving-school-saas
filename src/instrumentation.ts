/** Runs once when the Next.js server starts. */
export async function register() {
  // Written as one `if` so the edge bundle drops the import (Next.js replaces NEXT_RUNTIME at build time).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSchedulerIfEnabled } = await import("./server/jobs/scheduler");
    startSchedulerIfEnabled();
  }
}
