# DriveDesk – driving school SaaS

A multi-tenant platform for driving schools. It handles students, instructors, cars, lessons and scheduling, student progress and feedback, rescheduling (with a 24-hour rule), automatic payment requests via Stripe, transactional e-mail via Resend, and a WhatsApp AI assistant (Meta Cloud API plus Claude) that answers students, onboards new ones and books lessons.

- **Student:** a simple dashboard showing level and progress, latest feedback, next lesson with a *Reschedule* button, lesson history and payments with *Pay now*.
- **Instructor:** a mobile-first day/week/month calendar. A lesson page lets them start, complete (feedback, skills, level, payment request), cancel, reschedule or mark a no-show.
- **Owner/admin:** a dashboard with KPIs and an attention queue, plus calendar, students, instructors, vehicles, booking, payments, settings (policies, hours, levels, integrations) and the WhatsApp inbox.
- **SaaS admin:** schools, subscriptions and platform stats.

Design decisions, the ERD and the security model are in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Quick start

Requirements: Node 20+ and PostgreSQL 14+ (with the `btree_gist`, `citext` and `pgcrypto` extensions, all of which ship with PostgreSQL).

```bash
npm install
cp .env.example .env            # then fill in the secrets (see below)
./scripts/setup-dev-db.sh       # creates DB + app roles (dsa_app_login, dsa_platform_login)
set -a; . ./.env; set +a
npm run db:migrate
npm run db:seed                 # demo school + accounts (password: demo-password-123)
npm run dev                     # http://localhost:3000
```

Demo logins: `admin@platform.test` (SaaS admin), `owner@abc.test`, `john@abc.test` (instructor), `anna@abc.test`, `bram@abc.test` (students).

Generate secrets with `openssl rand -base64 32` for `SESSION_SECRET` and `ENCRYPTION_KEY`.

### Database roles

| Env var | Role | Used for |
|---|---|---|
| `DATABASE_URL` | member of `dsa_app` (RLS enforced, not owner, not superuser) | all user requests |
| `DATABASE_PLATFORM_URL` | `BYPASSRLS` | SaaS admin, login lookup, webhook routing, jobs |
| `DATABASE_OWNER_URL` | table owner | migrations only |

### Integrations

| What | Setup |
|---|---|
| E-mail | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (verified domain). `console` logs e-mails in dev. |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Webhook endpoint `/api/webhooks/stripe` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`. Schools can add a Stripe Connect account (`acct_…`) in Settings → Integrations. |
| WhatsApp | Meta app with WhatsApp product: `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`. Webhook `/api/webhooks/whatsapp` (subscribe to `messages`). Each school enters its phone number ID, WABA ID and access token in Settings → Integrations (stored encrypted). |
| AI assistant | `ANTHROPIC_API_KEY`; `AGENT_MODEL` (default `claude-opus-5`). Can be switched off per school. |
| Jobs | Call `GET /api/cron/tick` every minute with `Authorization: Bearer $CRON_SECRET` (e.g. Vercel Cron), or run `npm run jobs:run` from cron. |

## Tests

```bash
npm test                  # unit: scheduling engine, 24h rule (incl. DST), assessment scoring, webhook parsing/signatures
npm run test:integration  # real PostgreSQL: tenant isolation (RLS), double-booking races, rescheduling rules,
                          # completion → invoice/payment/e-mail, webhook idempotency, WhatsApp agent flows
npm run lint              # tsc --noEmit
```

Integration tests create a fresh `driving_school_test` database. They expect a local PostgreSQL superuser `postgres/postgres`; override the connection with `TEST_DB_HOST` or `TEST_DATABASE_OWNER_URL`. The WhatsApp agent tests use a scripted model and a recording sender, so they need no API keys.

## Project layout

```
db/migrations/        schema: tables, constraints, RLS policies, grants
src/lib/              db (withTenant/withPlatform), rbac, crypto, time, env, errors
src/server/           services, scheduling, payments, email, whatsapp, agent, jobs, auth
src/app/              Next.js pages, server actions, route handlers
tests/                unit + integration
scripts/              migrate, seed, run-jobs, setup-dev-db.sh
```
