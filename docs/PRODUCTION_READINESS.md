# Production readiness

Where DriveDesk stands against what a production launch for 50 schools needs,
and what is still open. Legend: ✅ done and tested · 🔒 code done, needs your
account/keys · ⚖️ needs a professional's review · ⬜ an operator task before
launch.

## Checklist

### Product
| Item | Status |
|---|---|
| Platform admin, school admin, instructor and student apps (EN/NL/AR, RTL, phone-friendly) | ✅ |
| Scheduling with availability, vehicles, buffers, closures, DST-safe 24-hour rule, race-proof bookings | ✅ |
| Progress tracking, feedback, printable report with CBR disclaimer | ✅ |
| Billing: per-lesson, in advance, packages/credits; VAT; invoices; refunds; disputes; reconciliation CSV | ✅ (VAT ⚖️) |
| Notifications: e-mail outbox with retries, preferences, wording per school, delivery tracking | ✅ |
| WhatsApp with consent, STOP/START, templates; AI assistant with safe tools and fallback | ✅ code, 🔒 activation |
| Dashboards and reports | ✅ |

### Security and privacy
| Item | Status |
|---|---|
| Tenant isolation in the database (RLS, composite keys), least-privilege roles | ✅ |
| Server-side permissions on every action, owner-only sensitive actions | ✅ |
| Sessions, password reset, rate limits (shared, proxy-aware), CSP and security headers | ✅ |
| Signed webhooks, idempotent processing, no card data | ✅ |
| Encrypted per-school secrets, redacted logs, append-only audit log | ✅ |
| GDPR export, erasure, retention | ✅ |
| Data processing agreement, privacy notice, DPIA, records of processing | ⚖️ ([SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)) |
| Two-factor sign-in for owners and platform admins | ⬜ not built, recommended |
| Penetration test | ⬜ |

### Operations
| Item | Status |
|---|---|
| CI: types, unit, integration, browser tests, build, dependency audit, Docker | ✅ |
| Docker image, compose file, Railway/Render configs, migration on start | ✅ |
| Health checks for uptime and for stuck jobs/webhooks | ✅ |
| Backup and restore-drill scripts; rollback and incident runbook | ✅ ([OPERATIONS.md](OPERATIONS.md)) |
| Load-tested at the target size; sizing advice | ✅ ([CAPACITY.md](CAPACITY.md)) |
| Choose hosting, create production database with PITR, set secrets | ⬜ needs your decision and accounts ([COSTS.md](COSTS.md)) |
| Staging environment with test-mode providers | ⬜ |
| Uptime monitor and alerts wired to a person | ⬜ |
| First restore drill on the real backup set-up | ⬜ |

### Providers (each needs your account; see [PROVIDERS.md](PROVIDERS.md))
| Item | Status |
|---|---|
| Resend: verified domain, API key, webhook secret | 🔒 |
| Stripe: account, keys, webhook; each school's connected account | 🔒 |
| Meta WhatsApp: verified business, app secret, per-school number, token, approved templates | 🔒 |
| Anthropic: API key and spend limit | 🔒 |

### Business
| Item | Status |
|---|---|
| Accountant confirms invoice fields and VAT treatment of driving lessons | ⚖️ |
| Terms of service for schools, and the platform's own pricing | ⬜ |
| Support process (who answers schools, response times) | ⬜ |

## Launch order that keeps risk low

1. Staging on the chosen host with Stripe test mode and the Resend sandbox; run the staging checks in [PROVIDERS.md](PROVIDERS.md).
2. Production with e-mail and Stripe live, WhatsApp and AI off, for 1–3 pilot schools ([PILOT_DEPLOY.md](PILOT_DEPLOY.md)).
3. Add WhatsApp reminders once templates are approved; then the AI assistant per school.
4. Grow to 50 schools, watching the health checks and the numbers in [CAPACITY.md](CAPACITY.md).

## Known limitations

**Not activated**
- Live e-mail, payments, WhatsApp and AI have never run against real accounts. All four are built and tested with signed sample traffic and fakes. Expect small fixes when connecting the real services, for example template wording that Meta rejects, or a Stripe setting.

**Not built**
- Two-factor authentication.
- Single sign-on (Google/Microsoft). The database has columns for it, but there is no sign-in flow.
- Stripe Connect onboarding from inside the app. School owners create or connect their Stripe account in Stripe and paste the account id.
- Other payment providers (for example Mollie, which is common in the Netherlands) and other e-mail providers (for example Amazon SES). Both have a provider interface, so this is a contained addition.
- Calendar export (iCal) and push notifications. The apps are installable web apps without push.
- Self-service sign-up for *schools*. The platform admin creates schools; students can sign up themselves.

**Limits to know**
- E-mail outbox: up to 50 messages per minute per job tick (3,000 an hour), and Resend sends are paced to 2 per second per process. Enough for the target size; raise both for more schools.
- `ENCRYPTION_KEY` cannot be rotated in place. Schools re-enter WhatsApp tokens after a change.
- Self-hosted backups give a 24-hour recovery point unless WAL archiving is added. Managed Postgres with PITR avoids this.
- History lists are capped (latest 50 lessons, latest 60 feedback notes on the student app). Full history stays in the data export.
- The load test ran on one machine. Production adds network latency (see [CAPACITY.md](CAPACITY.md)).
- The requirements document supplied for this build ended partway through section 15 (WhatsApp lesson availability). Anything specified after that point has not been seen; see `docs/ARCHITECTURE.md` §17.

**Needs professional review**
- Dutch VAT treatment and invoice fields (accountant).
- GDPR documents (privacy lawyer/DPO).
- AI level suggestions are guidance for instructors, not an official CBR assessment. They are stored as unconfirmed until staff confirm them, and the progress report carries a CBR disclaimer.
