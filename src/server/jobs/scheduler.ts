/**
 * Built-in job scheduler: the web server itself runs the background jobs
 * (lesson reminders, overdue payments, the e-mail/WhatsApp outbox, clean-ups)
 * once a minute, so they work on any host without a separate cron service.
 *
 * Several app instances may run this; a Postgres advisory lock makes sure only
 * one of them does a given tick. An external caller of /api/cron/tick takes the
 * same lock, so both can be used together safely.
 *
 * Turn it off with INTERNAL_SCHEDULER=0 (e.g. when only an external cron should run jobs).
 */
import { withExclusiveLock } from "@/lib/db";
import { log } from "@/lib/log";
import { runAllJobs } from "./index";

export const JOBS_LOCK_KEY = 727275;
const INTERVAL_MS = 60_000;

const g = globalThis as unknown as { __dsaScheduler?: NodeJS.Timeout };

/** One tick guarded by the shared lock; `skipped` when another process is already running jobs. */
export async function runJobsTick() {
  const r = await withExclusiveLock(JOBS_LOCK_KEY, runAllJobs);
  return r.ran ? r.result : { ok: true as const, skipped: true };
}

/** On by default in production (not during `next build`), off in dev and tests unless INTERNAL_SCHEDULER=1. */
export function startSchedulerIfEnabled() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const enabled = process.env.INTERNAL_SCHEDULER ?? (process.env.NODE_ENV === "production" ? "1" : "0");
  if (enabled === "1") startScheduler();
}

export function startScheduler() {
  if (g.__dsaScheduler) return;
  const tick = () =>
    runJobsTick().catch((err) => log.error("scheduler.tick_failed", { err }));
  // First tick shortly after start-up (migrations have run by then), then every minute.
  g.__dsaScheduler = setInterval(tick, INTERVAL_MS);
  g.__dsaScheduler.unref?.();
  setTimeout(tick, 15_000).unref?.();
  log.info("scheduler.started", { intervalMs: INTERVAL_MS });
}
