# DriveDesk – driving school SaaS

A multi-tenant platform for driving schools. It handles students, instructors, cars, lessons and scheduling, student progress and feedback, rescheduling (with a 24-hour rule), automatic payment requests via Stripe, transactional e-mail via Resend, and a WhatsApp AI assistant (Meta Cloud API plus Claude) that answers students, onboards new ones and books lessons.

DriveDesk has **two phone apps** and a school portal:

| App | Sign-in | For | Tabs |
|---|---|---|---|
| **Student app** | `/login/student` | students | Home (next lesson, level, feedback) · Lessons · Book · Payments · Profile |
| **Instructor app** | `/login/instructor` | instructors (and owners who teach) | Today · Calendar (day/week/month) · Students · Hours · Profile |
| School portal | `/login` | owners, admins, platform admin | dashboard, calendar, students, instructors, cars, payments, WhatsApp inbox, settings |

Each app has its own web-app manifest and icon, so both can be installed on a phone's home screen separately. A student account cannot sign in to the instructor app, and the reverse is refused too.

**Languages:** the two apps are fully translated into **English, Dutch and Arabic**, and Arabic switches the layout to right-to-left. The language comes from the user's choice (the switcher in the top bar is saved on the account), then the browser's language, then English. Dates, times and money are formatted per language. School-defined level and skill names can carry their own translations. Translations live in `src/i18n/{en,nl,ar}.ts`; a unit test fails if any language misses a key or a placeholder. The school portal is English-only for now.

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

`npm run db:seed` generates **synthetic demo data**. It is deterministic and dated relative to today, and it goes through the real services, so all business rules apply:
- **ABC Driving School (Amsterdam):** 3 instructors, 4 cars and 30 fictional students (Dutch-, Arabic- and English-speaking).
- **History:** about five months of lessons with feedback written in each student's language, skill progress and levels.
- **Billing:** invoices paid by Stripe-style webhook events or in cash, plus open and overdue ones.
- **Activity:** no-shows, cancellations, student reschedules and a pending approval, upcoming lessons, a realistic "today" for every instructor, WhatsApp chats in all three languages (one handed over to a person), and AI level assessments waiting for review.
- **Rijschool Noord (Rotterdam):** a small second school, to show that schools are isolated from each other.

| Account (password `demo-password-123`) | Opens in |
|---|---|
| Student app: `priya@abc.test` · `anna@abc.test` · `youssef@abc.test` | English · Dutch · Arabic |
| Instructor app: `john@abc.test` · `sanne@abc.test` · `fatima@abc.test` | English · Dutch · Arabic |
| School portal: `owner@abc.test`; platform: `admin@platform.test`; second school: `kees@noord.test` | English |

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

## Deploy

The repo ships a production Docker image (`Dockerfile`, Next.js standalone server) and a `docker-compose.yml` with PostgreSQL, the app, and a job runner that calls `/api/cron/tick` every minute. Migrations run automatically when the app container starts.

```bash
cp .env.example .env        # set APP_URL, secrets, POSTGRES_PASSWORD, APP_DB_PASSWORD, PLATFORM_DB_PASSWORD
docker compose up -d --build
docker compose run --rm seed   # optional demo data
```

Put a TLS reverse proxy (Caddy, nginx, or your platform's load balancer) in front of port 3000. Then register the webhook URLs with Stripe and Meta (see Integrations).

This runs on any host with Docker (a VPS, AWS Lightsail/ECS, Fly.io, Render, Railway). On a managed platform, use its PostgreSQL:
- create the two login roles from `db/init/00-roles.sh`;
- set `DATABASE_URL`, `DATABASE_PLATFORM_URL` and `DATABASE_OWNER_URL`;
- schedule the cron call.

The platform-admin role needs `BYPASSRLS`, which managed Postgres services allow for roles you create as the admin user.

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
