# Architecture decisions

The master prompt suggests a default stack (Supabase Auth, Tailwind + shadcn/ui, Vercel). The repository already contained a working, tested application built on a slightly different stack. The prompt says to use its stack "if no existing architectural decision prevents it" and to "preserve working code", so each difference was evaluated below. Short version: **keep what exists**, because rewriting it would cost weeks and remove protections that are already tested, without a concrete benefit.

## D1. Database and tenant isolation: plain PostgreSQL + RLS (keep)

The app talks to PostgreSQL directly (`pg`, hand-written SQL) with Row Level Security forced on every tenant table, composite foreign keys, and exclusion constraints against double booking.

- Supabase **is** PostgreSQL. The schema, RLS policies and roles work unchanged on a Supabase project, so Supabase remains a valid *host* (see `docs/PILOT_DEPLOY.md`). Nothing here locks Supabase out.
- What we do not adopt is the Supabase client-side data API (PostgREST from the browser). Our rules (24-hour notice, slot revalidation, invoice creation) live in server transactions; exposing tables to the browser would put more weight on RLS alone. Server-only access is the safer model for booking and money.

## D2. Authentication: own session layer (keep), not Supabase Auth

Existing: scrypt password hashes, httpOnly signed session cookie, user row re-read on every request (instant revocation via `token_version`), single-use hashed invite/reset tokens, login rate limiting.

Switching to Supabase Auth would mean migrating users, rewriting RLS around `auth.uid()` and JWT claims, and adding a second identity store. The current layer already meets the requirements (recovery, revocation, rate limits). The `users.auth_provider` column leaves room for Google/Microsoft sign-in later.

Trade-off accepted: we own password-reset and session code, so it is covered by tests (`tests/integration/auth.test.ts`).

## D3. UI: hand-written CSS design system (keep), not Tailwind/shadcn

The UI already has a consistent token-based design system (`globals.css`, `components/ui.tsx`) in three languages including right-to-left Arabic. Moving to Tailwind/shadcn would restyle every screen for no functional gain. New screens reuse the existing components.

## D4. Hosting: Docker image (keep), Vercel optional

The repo ships a standalone Next.js Docker image, a compose stack and Railway/Render configs. This keeps the app portable and lets the job runner live next to the app. Vercel also works (cron calls `/api/cron/tick`); the only caveat is that the in-process rate limiter was per-instance, which is fixed by moving it into PostgreSQL (WS-3).

Cost comparison is in `docs/COSTS.md`.

## D5. Payments: Stripe Checkout with iDEAL (keep), Mollie as a documented alternative

Dutch customers mostly pay with iDEAL. Stripe Checkout supports iDEAL, cards, Bancontact and SEPA, handles PCI scope (we never see card data), and Stripe Connect lets money go straight to each school. Mollie is a strong Dutch alternative with similar per-transaction pricing; the `PaymentProvider` interface keeps that switch contained to one file.

Payment models supported per school (WS-5): pay after each completed lesson (default), pay in advance at booking, or prepaid lesson packages (credits).

## D6. Background jobs: PostgreSQL outbox + minute cron (keep)

Jobs are rows in PostgreSQL (`notifications`, pending WhatsApp messages) claimed with `FOR UPDATE SKIP LOCKED`, retried with backoff, and deduplicated by unique keys. A cron tick drives them. This is durable (survives restarts), needs no extra paid service, and is easily enough for 50 schools. A dedicated queue (e.g. pg-boss, Inngest) becomes worth it only if job volume grows by orders of magnitude.

## D7. AI: Claude behind an `AgentLlm` interface, with a deterministic fallback

The model only chooses which narrowly scoped tool to call; identity, permissions and business rules are enforced in the tools. When the provider is down, a rule-based fallback answers common questions and hands over to a human instead of failing silently (WS-6).

## D8. Rate limiting and shared state in PostgreSQL

To stay correct when the app runs on more than one instance, rate-limit counters move from process memory into an unlogged PostgreSQL table (WS-3). No Redis needed at this scale.
