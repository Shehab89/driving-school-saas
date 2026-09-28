# Deploying a client pilot (Railway or Render)

This is the concrete, step-by-step version of the README's "Deploy" section,
for putting a single real driving school in front of the app to get
feedback — test-mode payments, no live money, WhatsApp left off for now.

Nothing here can be done by an AI session on your behalf: it needs your own
provider account, billing, and API keys. This is the checklist to work
through yourself (or hand to whoever is setting it up).

## 0. Before you start

Have ready:
- A GitHub account with this repo pushed (it already is, on `claude/wizardly-ride-9bioa7`).
- A [Railway](https://railway.app) or [Render](https://render.com) account.
- A [Stripe](https://dashboard.stripe.com/register) account — **stay in Test mode** (the toggle top-left of the Stripe dashboard). No real cards will be charged.
- A [Resend](https://resend.com) account (free tier: 100 emails/day, enough for a small pilot). You can send from their shared sandbox address (`onboarding@resend.dev`) without verifying your own domain, or verify a domain you own for a real "from" address.
- Skip WhatsApp for this pilot — it needs a verified Meta Business account, which takes longer to set up than a first pilot needs. The web app (booking, scheduling, payments, feedback) works fully without it; add it later by filling in `META_APP_SECRET`/`WHATSAPP_VERIFY_TOKEN` and pointing Meta's webhook at `/api/webhooks/whatsapp`.

## 1. Pick Railway or Render

**Railway is the simpler choice for this app specifically.** Its "Add Postgres"
plugin deploys a real, unrestricted `postgres:16` container — full superuser
on the connection string it gives you — which is what this app needs to
create its own two extra database roles (one RLS-enforced, one with
`BYPASSRLS`; see `docs/ARCHITECTURE.md` §1–2).

Render's managed Postgres is a proprietary service that may not let its admin
user grant `BYPASSRLS` to a role it creates. `render.yaml` is provided and
works if that grant succeeds — try step 3 below first — but if it's refused,
deploy Postgres from `Dockerfile.postgres` as a second Render service instead
(same idea as Railway: a real Postgres container you control, with a
persistent disk). Either provider works once the roles exist; Railway just
gets there in fewer steps.

## 2. Create the web service

**Railway:** New Project → Deploy from GitHub repo → pick this repo. Railway
detects the `Dockerfile` automatically; `railway.toml` sets the health check.

**Render:** New → Blueprint → pick this repo → it reads `render.yaml` and
proposes the web service + a managed Postgres. Apply it.

Don't let it deploy successfully yet — it will fail without the database
roles and secrets from the next two steps. That's expected.

## 3. Database: create the two login roles

Add Postgres (Railway: "+ New" → Database → Postgres; Render: already
proposed by the blueprint, or add one manually). Copy its admin connection
string — Railway calls it `DATABASE_URL` on the Postgres service itself
(confusingly the same name the *app* also uses for something else — copy the
value, not the variable reference); Render calls it "Internal Connection
String" on the database's page.

Run the bootstrap script once, from your own machine (needs `psql` and
`openssl`) or a Railway/Render one-off shell:

```bash
DATABASE_OWNER_URL="<the admin connection string you just copied>" \
  ./scripts/setup-prod-roles.sh
```

It prints two generated passwords. From the same admin connection string,
build two more by swapping only the user and password (same host/port/database):

```
DATABASE_URL          = postgres://dsa_app_login:<app password>@<same host>:<port>/<same db>
DATABASE_PLATFORM_URL = postgres://dsa_platform_login:<platform password>@<same host>:<port>/<same db>
DATABASE_OWNER_URL     = <the original admin connection string, unchanged>
```

Postgres roles belong to the whole server, not one database: if the server is
shared with another copy of this app (say, a staging database), re-running the
script resets `dsa_app_login`/`dsa_platform_login` passwords for both. Give
each environment its own Postgres server.

If `setup-prod-roles.sh` fails on the `BYPASSRLS` grant specifically, that
provider's managed Postgres doesn't allow it — switch to `Dockerfile.postgres`
as its own service (full superuser, same script works unmodified there) and
redo this step against that service instead.

## 4. Set the app's environment variables

On the web service (Railway: Variables tab; Render: Environment tab), set:

| Variable | Value |
|---|---|
| `APP_URL` | the public URL the platform gives you, e.g. `https://drivedesk-pilot.up.railway.app` |
| `DATABASE_URL`, `DATABASE_PLATFORM_URL`, `DATABASE_OWNER_URL` | from step 3 |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `CRON_SECRET` | `openssl rand -base64 24` |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | from the Resend dashboard (API Keys) |
| `EMAIL_FROM` | `DriveDesk Pilot <onboarding@resend.dev>` (or your verified domain) |
| `PAYMENT_PROVIDER` | `stripe` |
| `STRIPE_SECRET_KEY` | Test-mode secret key from Stripe (Developers → API keys), starts `sk_test_` |
| `STRIPE_WEBHOOK_SECRET` | from step 5 below |

Redeploy. Migrations run automatically on boot (`scripts/docker-entrypoint.sh`);
watch the deploy log for `applying 00X_....sql` then `migrations up to date`.
Check `https://<your-app-url>/api/health` returns `{"ok":true}`.

## 5. Stripe test-mode webhook

Stripe dashboard (Test mode) → Developers → Webhooks → Add endpoint:

- URL: `https://<your-app-url>/api/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded` (or "select all" if unsure)

Copy the endpoint's **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`
and redeploy. Test it by clicking "Send test webhook" — the app should
respond 200 (check the deploy log for `[webhook] stripe processed` or
similar; a 400 usually means the secret doesn't match).

## 6. The cron ticker (reminders, overdue payments, outbox)

`/api/cron/tick` needs to be called roughly every minute.

- **Railway:** add a second service, same repo/Dockerfile, but override its
  start command to loop and curl the endpoint (or use Railway's Cron Job
  feature if enabled on your plan) — mirrors the `cron` service in
  `docker-compose.yml`.
- **Render:** uncomment the `jobs:` block in `render.yaml` (Render's Cron
  Jobs need at least the Starter plan for reliable per-minute runs).

For a short pilot this can also be triggered manually or skipped briefly —
nothing breaks without it, reminders and payment-status refreshes just don't
fire until it runs.

## 7. Create the real school and its owner

Nothing seeds a real school automatically (the demo data script is for local
testing only). From your own machine, pointed at the production database:

```bash
DATABASE_URL=... DATABASE_PLATFORM_URL=... DATABASE_OWNER_URL=... \
  npx tsx -e '
    import { createSchool } from "./src/server/services/schools";
    createSchool({
      name: "Their Driving School", slug: "their-slug",
      timezone: "Europe/Amsterdam", currency: "EUR",
      ownerEmail: "owner@theirschool.example", ownerName: "Owner Name",
    }, null).then((s) => console.log(s));
  '
```

This e-mails the owner an activation link (via Resend) to set their password
and sign in at `/login`. From there they add instructors, vehicles, opening
hours, and turn on **Settings → Student self-booking** plus set their real
lesson price (**Settings → Prices**) before sharing the sign-up link.

## 8. Share the sign-up link

Once the owner has set things up, the link to hand their students is:

```
https://<your-app-url>/join/their-slug
```

That's the survey this session built: contact details, a short driving
self-assessment, the real price from their settings, a password, then
straight into the booking calendar for their first lesson. New sign-ups show
up on the owner's dashboard under "AI level suggestion to review".

## 9. Watching the pilot

- `/api/health` for a liveness check.
- The platform's log viewer for errors (`console.error` lines are tagged,
  e.g. `[action]`, `[webhook]`).
- Stripe's dashboard (Test mode → Payments) mirrors every simulated charge.
- There's no error-monitoring service (Sentry etc.) wired up yet — for a
  short pilot, watching logs is enough; add one before a longer or larger
  rollout.
