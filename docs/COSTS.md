# Running costs at 50 schools × 250 students

**Estimates, not quotes.** Prices are list prices as known in 2026 and change
often. Check each provider's pricing page before committing. Amounts exclude
VAT. Usage volumes are derived in [CAPACITY.md](CAPACITY.md) ("Expected load").
Nothing has been purchased; every line below needs your decision and account.

## Summary (per month)

| Item | Lean | Comfortable | Notes |
|---|---|---|---|
| App hosting (2 instances) | €15 | €60 | VPS vs PaaS |
| Database (managed, backups + PITR) | €20 | €80 | |
| E-mail (about 130,000/month) | €15 | €130 | Amazon SES vs Resend |
| Monitoring, logs, uptime | €0 | €40 | free tiers vs paid |
| Domain, backups storage | €3 | €10 | |
| **Platform subtotal** | **≈ €55** | **≈ €320** | |
| WhatsApp templates (optional) | €0 | €400–1,200 | depends on opt-in and how many message types use WhatsApp |
| AI assistant (optional) | €0 | €100–600 | depends on model and conversations |
| **With WhatsApp and AI** | | **≈ €800–2,100** | |

For comparison, 50 schools on the current plans bring in €1,450 a month (all
*Starter*), €3,950 (all *Team*) or €9,950 (all *Business*). See `db/migrations/002_plans.sql`.

Card and iDEAL fees are paid by the schools from their own Stripe accounts and
are not a platform cost (below).

## Details

### Hosting

| Option | What | Approx. per month |
|---|---|---|
| Lean: one VPS (e.g. Hetzner, EU) | 4 vCPU / 8 GB running Docker Compose (app ×2, Postgres, cron) + off-site backup storage | €15–25. You run Postgres, backups and updates yourself (see [OPERATIONS.md](OPERATIONS.md)). |
| PaaS (Railway or Render, EU region) | 2 × app instances (1 vCPU / 1–2 GB) | €30–60 |
| Managed Postgres | 2 vCPU / 4 GB / 20 GB, daily backups + point-in-time recovery | €40–80 (Render, Neon, Supabase, Railway with backups) |

The load test showed one small instance covers the estimated peak several
times over, so start at the small end and scale on measured usage.

### E-mail

About 4 e-mails per active student per week (booking confirmation, reminder,
feedback, payment). That's roughly 130,000 a month with 60% of students active.

| Provider | Approx. per month |
|---|---|
| Resend Scale (100k included, then pay per 1,000) | about €90–130 |
| Amazon SES ($0.10 per 1,000) | about €15. Needs an SES provider class; the e-mail code has a provider interface, but only Resend is implemented. |

### Payments (paid by the schools)

With each school's own Stripe account, Stripe charges the school, not the platform:
- iDEAL: about €0.29 per payment.
- Cards: about 1.5% + €0.25 (EEA cards).

At one payment per active student per month (about 7,500), iDEAL fees across all schools come to about €2,200 a month, roughly 0.5% of a €62 lesson. Stripe Connect *Standard* accounts carry no platform fee. If the platform collected payments itself instead, these fees would land on the platform, along with payout and licensing obligations.

### WhatsApp (optional)

Meta charges per *template* message delivered (messages that start a
conversation or arrive more than 24 hours after the student last wrote).
Replies inside a conversation the student started are free. That covers most
AI-assistant traffic.

- Utility template rate for the Netherlands: roughly €0.03–0.06 per message. Check Meta's current rate card.
- If 30% of active students opt in (about 2,250), each template message type costs about €300–550 a month at weekly frequency.
- Reminders only on WhatsApp: about €300–550 a month. All four lesson messages: about €1,200 or more.

Recommendation: use WhatsApp for reminders only and keep the rest on e-mail.
The template configuration is per message type, so this is a setting, not code.

### AI assistant (optional)

A typical WhatsApp conversation (find a time, confirm, book) is about 6–8 model
calls. That's about 60,000 input tokens, most of them cached system prompt and
tools, and about 2,000 output tokens.

| Model class | Assumed price per million tokens (input / cached input / output) | Per conversation | 4,500 conversations a month* |
|---|---|---|---|
| Opus-class (default `claude-opus-5-5`) | $5 / $0.50 / $25 | about $0.13 | about $600 |
| Haiku-class (`claude-haiku-5-5`) | $1 / $0.10 / $5 | about $0.03 | about $120 |

\* About one conversation per WhatsApp-enabled student every two weeks.

The prices in this table are assumptions to verify on anthropic.com/pricing.
Set a monthly spend limit in the Anthropic console; when it is reached, the
assistant's deterministic fallback takes over and staff are notified.

### One-off costs to budget

| Item | Rough market range |
|---|---|
| Privacy lawyer: DPA template, privacy notice, DPIA review | €1,500–5,000 |
| Penetration test before scaling | €4,000–10,000 |
| Accountant check of invoice/VAT set-up | €300–1,000 |
| Meta business verification, Stripe and KvK registrations | no fee, but takes time |
