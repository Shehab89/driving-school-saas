# Operations: deploy, roll back, back up, monitor

This is the runbook for whoever operates DriveDesk in production. The step-by-step
first deployment is in [PILOT_DEPLOY.md](PILOT_DEPLOY.md); this document covers
running it afterwards. Provider set-up (Stripe, Resend, WhatsApp, Claude) is in
[PROVIDERS.md](PROVIDERS.md).

## 1. Environments

| Environment | Database | Providers | Who uses it |
|---|---|---|---|
| Local development | `driving_school` on your machine, seeded with demo data | console e-mail, Stripe test keys optional | developers |
| Automated tests | `driving_school_test` / `_e2e` / `_load`, recreated on every run | none (recording fakes) | CI and developers |
| Staging (recommended) | its own database, synthetic data only | Stripe **test mode**, Resend sandbox, WhatsApp test number | release checks |
| Production | its own database, real data | live keys | schools and students |

Rules:
- Every environment has its own secrets. Never copy `SESSION_SECRET`, `ENCRYPTION_KEY` or provider keys between them.
- Production data is never copied to staging or a laptop. Use `npm run db:seed` or the load-test generator for realistic data.
- `scripts/fresh-db.ts` refuses to recreate any database whose name doesn't end in `_test`, `_e2e` or `_load`.
- The demo seed (`npm run db:seed`) creates accounts with a known password. Never run it against production. The seed is only reachable through the `seed` compose service or by hand; the app has no route that seeds or exposes test accounts.

## 2. Configuration

All configuration is environment variables; see `.env.example` for the full list with comments. The app refuses to start a request that needs a missing variable (for example `SESSION_SECRET` shorter than 32 characters) rather than falling back to a default.

Variables worth knowing in production:

| Variable | Notes |
|---|---|
| `APP_URL` | Public `https://` URL. Used in e-mail links and to decide secure cookies. |
| `DATABASE_POOL_MAX` | Connections per app process (default 10). See [CAPACITY.md](CAPACITY.md). |
| `TRUSTED_PROXY_HOPS` | Number of proxies in front of the app (default 1). Wrong values let clients dodge per-address rate limits. |
| `LOG_LEVEL` | `info` (default), `warn`, `debug`. Logs are JSON, one line per event, personal data redacted. |
| `CRON_SECRET` | Protects `/api/cron/tick` and `/api/health/details`. |

## 3. Releasing a new version

1. Merge to the release branch only with CI green (lint, unit, integration, browser tests, build, dependency audit, Docker build).
2. **Take a backup or confirm the provider's point-in-time recovery is on** (section 5) if the release contains a migration.
3. Deploy. The container runs pending migrations on start (`scripts/migrate.ts`): each file runs in its own transaction and is recorded in `schema_migrations`, so a failed migration leaves the database as it was and the new version does not start.
4. Watch `/api/health` and `/api/health/details` and the error logs for 15 minutes.

### Migration rules

Migrations in `db/migrations/` are forward-only and numbered. To keep a rollback of the *code* possible without rolling back the *database*:

- **Expand, then contract.** Add new columns/tables in one release (nullable or with defaults), switch the code over, and remove old columns only in a later release once nothing reads them.
- Never rename or drop a column in the same release that stops using it.
- Long-running data rewrites (large `UPDATE`s) go in a script run separately, in batches, not in a migration that blocks start-up.
- Destructive migrations (dropping data) need written approval, a fresh backup and a tested restore before they run.

## 4. Rolling back

| Situation | What to do |
|---|---|
| New version misbehaves, no migration in the release | Redeploy the previous image/commit. Railway and Render both keep previous deploys one click away. |
| New version misbehaves, release added only columns/tables (expand step) | Redeploy the previous version. The old code ignores the new columns. |
| A migration damaged data | Stop the app (scale to 0) so nothing writes. Restore to a point just before the deploy (section 5) into a **new** database, check it, then switch `DATABASE_*` URLs to it and start the previous version. Payments that arrived during the gap are replayed from Stripe's dashboard (Developers → Webhooks → resend), which is safe because webhook handling is idempotent. |

Sessions survive a rollback as long as `SESSION_SECRET` is unchanged.

## 5. Backups and recovery

**Targets:** lose at most 5 minutes of data (RPO) and be back within 4 hours (RTO) after a database loss.

- **Managed Postgres (recommended):** turn on the provider's daily backups *and* point-in-time recovery with at least 7 days of retention. Railway, Render (paid plans), Neon, Supabase, RDS and Cloud SQL all offer this.
- **Self-hosted (docker compose):** run `scripts/backup-db.sh` from cron at least daily, writing to storage on a different machine (an encrypted bucket). Without WAL archiving this only gives a 24-hour RPO; add WAL archiving (for example pgBackRest or WAL-G) to reach the 5-minute target.
- **Restore drill, monthly:** `scripts/restore-drill.sh <dump>` restores into a new database and prints row counts and the latest timestamps. Compare them with production, write the date in your operations log, then drop the drill database. An untested backup does not count.
- Backups contain personal data. They're covered by the same access rules as the database and expire after 30 days (`KEEP_DAYS`). A student erased in production remains in older backups until those expire; if a backup is ever restored, re-run the erasures logged in `audit_logs` (`action = 'student.erased'`) since the backup date.

Secrets are not in the database backups except per-school WhatsApp tokens, which are encrypted with `ENCRYPTION_KEY`. Keep `ENCRYPTION_KEY` in a password manager or secret store separate from the backups; without it those tokens must be re-entered.

## 6. Background jobs

Call `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` every minute (the compose file's `cron` service does this; on Railway/Render use their cron feature or an external scheduler). Each tick runs reminders, overdue payments, WhatsApp retries, the e-mail/WhatsApp outbox, rate-limit clean-up and the GDPR retention job. Jobs are idempotent and isolated: one failing job does not stop the others, and the tick returns HTTP 500 with the failing job's name.

## 7. Monitoring and alerts

| Check | How | Alert when |
|---|---|---|
| Up | `GET /api/health` (no secret; checks the database) every minute | 2 failures in a row |
| Working | `GET /api/health/details` with the cron secret every 5 minutes | HTTP 503 (stuck e-mails, unprocessed payment webhooks, stuck WhatsApp messages) |
| Jobs | cron tick HTTP status | HTTP 500 three times in a row |
| Errors | JSON logs, level `error` | any `job.failed`, `webhook.*.failed`, or a rate above normal |
| Payments | Stripe dashboard → Webhooks | failed deliveries |
| E-mail | Resend dashboard | bounce rate above 4% or complaints |

Any uptime checker works (Better Stack, UptimeRobot, the platform's own). Logs go to the platform's log view; to keep them longer, forward them to a log service in the EU.

## 8. Incidents

1. **Acknowledge** in the team channel and note the start time.
2. **Assess:** `/api/health/details`, recent deploys, logs. Is it everyone, one school, or one feature?
3. **Mitigate first:** roll back (section 4), or switch a feature off (a school's AI assistant can be turned off in its settings; WhatsApp falls back to the deterministic replies when the AI provider fails).
4. **Communicate** to affected schools if it lasts more than 30 minutes or affects payments or bookings.
5. **Personal-data breach:** if personal data may have been exposed, the school (as controller) must be told without delay so it can decide about notifying the Autoriteit Persoonsgegevens within 72 hours. Keep a record of what, who, when.
6. **Afterwards:** a short write-up (what happened, impact, cause, what changes), and a test that would have caught it.

## 9. Routine tasks

| Task | How |
|---|---|
| Rotate `CRON_SECRET`, provider keys | Set the new value, redeploy, update the scheduler / provider dashboard. |
| Rotate `SESSION_SECRET` | Redeploy with a new value; everyone is signed out. |
| Rotate `ENCRYPTION_KEY` | Not supported in place: schools re-enter their WhatsApp tokens after the change. |
| Revoke one user's sessions | Disable and re-enable the user (bumps `token_version`). |
| Add a school | Platform console → New school; the owner gets an activation e-mail. |
| Suspend a school | Platform console → school → Suspend; its users can no longer sign in. Data is kept. |
| A student asks for their data or erasure | School owner: student page → Privacy and access. |
