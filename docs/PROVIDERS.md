# Connecting the outside services

DriveDesk works end to end without any outside service: e-mails are printed to
the server log, payments fall back to a bank-transfer page, WhatsApp and the AI
assistant are simply off. Each service below switches on by setting its keys.
The integration code for all four is written and tested against recorded or
signed sample traffic. **None of them has been activated against a live
account yet; that needs your accounts and keys.** Status per service is at the
end of each section.

Set keys as environment variables on the hosting platform, never in the
repository. Use test/sandbox keys on staging and live keys only in production.

---

## 1. E-mail: Resend

Used for invitations, password resets, booking confirmations, reminders,
payment requests and feedback notices.

1. Create an account at resend.com (EU region if offered for your plan).
2. **Domains → Add domain** for the sending address (for example `mail.yourdomain.nl`). Add the DNS records it shows (SPF, DKIM, and a DMARC record such as `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.nl`). Wait until it shows *Verified*.
3. **API keys → Create**, permission *Sending access*, restricted to that domain.
4. **Webhooks → Add endpoint** `https://<APP_URL>/api/webhooks/resend` with events `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`. Copy the signing secret (`whsec_…`).
5. Set:
   ```
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=re_…
   RESEND_WEBHOOK_SECRET=whsec_…
   EMAIL_FROM="Your Brand <no-reply@mail.yourdomain.nl>"
   ```
6. Check: send yourself a password reset, then look at **School → Messages**: the message should move from *sent* to *delivered*.

What the app does with it: signed webhooks only (Svix signature, 5-minute tolerance); a hard bounce or spam complaint puts the address on a suppression list so it is not mailed again; statuses never go backwards (a late *delayed* does not overwrite *delivered*).

**Status:** 🔒 code complete and tested with signed sample events; needs a Resend account, a verified domain and the two keys.

---

## 2. Payments: Stripe

Used for online payment of lessons, packages and invoices (iDEAL, cards, Bancontact, whatever you enable in Stripe). Amounts always come from our database, never from the browser.

1. Create a Stripe account for the platform. Complete business verification (KvK number, bank account) before going live.
2. In **Settings → Payment methods**, enable iDEAL (expected by Dutch students) and cards.
3. **Developers → API keys**: copy the secret key (`sk_test_…` on staging, `sk_live_…` in production). A restricted key with write access to Checkout Sessions, Refunds and read access to Charges is enough.
4. **Developers → Webhooks → Add endpoint** `https://<APP_URL>/api/webhooks/stripe`, with events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`

   If schools use their own Stripe accounts (below), tick **Listen to events on Connected accounts** for this endpoint too.
5. Set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
6. Check on staging with test card `4242 4242 4242 4242` or the iDEAL test bank: the payment should appear as *paid* on **School → Payments** only after the webhook arrives.

**Money to the schools.** Two models are supported:
- *Each school has its own Stripe account (recommended):* the school owner enters its connected account id (`acct_…`) under **Settings → Integrations**. Payments are created on that account, so the money and the payment-provider relationship are the school's own. Setting up Stripe Connect (Standard accounts) for the platform is a one-time step in the Stripe dashboard.
- *Platform collects:* leave the account id empty. You then hold the schools' money and must pay it out, which has licensing and bookkeeping consequences; get advice before choosing this.

What the app does with it: verifies every webhook signature; handles each event id once (retries are harmless); compares the paid amount with the expected amount; refunds started by staff are marked *refund requested* until Stripe confirms them; disputes mark the payment *disputed* and show it on the dashboard.

**Status:** 🔒 code complete; tested with signed sample webhooks and Stripe's API shapes, not against a live account. Needs Stripe keys (test mode first).

---

## 3. WhatsApp: Meta Cloud API

Used for reminders and booking messages to students who opted in, and for the AI assistant that answers students' questions and books or moves lessons.

Platform set-up (once):
1. A **Meta Business account** with business verification completed (takes days to weeks).
2. **developers.facebook.com → Create app** (type *Business*), add the **WhatsApp** product.
3. **App settings → Basic**: copy the **App secret** → `META_APP_SECRET`.
4. Choose a random string → `WHATSAPP_VERIFY_TOKEN`.
5. **WhatsApp → Configuration → Webhook**: callback `https://<APP_URL>/api/webhooks/whatsapp`, verify token as above, subscribe to `messages`.

Per school:
1. Add the school's phone number in WhatsApp Manager (a number not used in the WhatsApp app), verify it, and create a **System user** access token with `whatsapp_business_messaging` permission.
2. The owner enters the phone number ID, the WhatsApp Business Account ID and the token in **Settings → Integrations**. The token is stored encrypted.
3. **Message templates.** WhatsApp only lets a business start a conversation (or write more than 24 hours after the student's last message) with a pre-approved template. Create these in WhatsApp Manager, category *Utility*, in each language you need (Dutch first), then enter each template's name and language under **School → Messages → WhatsApp templates**:

   | Message | Variables, in this order | Example body (Dutch) |
   |---|---|---|
   | Lesson reminder | {{1}} first name, {{2}} date, {{3}} time, {{4}} instructor | Hoi {{1}}, herinnering: je rijles is op {{2}} om {{3}} met {{4}}. Antwoord STOP om geen WhatsApp-berichten meer te ontvangen. |
   | Lesson booked | first name, date, time, instructor | Hoi {{1}}, je rijles op {{2}} om {{3}} met {{4}} staat vast. |
   | Lesson rescheduled | first name, new date, new time, instructor | Hoi {{1}}, je les is verplaatst naar {{2}} om {{3}} met {{4}}. |
   | Lesson cancelled | first name, date, time | Hoi {{1}}, je les op {{2}} om {{3}} is geannuleerd. |
   | Reschedule request received | first name, lesson number | Hoi {{1}}, we hebben je verzoek om les {{2}} te verplaatsen ontvangen. |
   | Feedback received | first name, lesson number | Hoi {{1}}, je instructeur heeft feedback gegeven op les {{2}}. Bekijk het in de app. |

   A message without a configured template is sent by e-mail instead, so nothing is lost while templates wait for approval.

Consent: students opt in on their profile page (or by sending START); STOP opts them out immediately, and both are recorded with a timestamp. WhatsApp is never used for someone who hasn't opted in.

**Status:** 🔒 code complete and tested with signed sample webhooks and a recording sender; needs a verified Meta Business account, app secret, and per school a number, token and approved templates.

---

## 4. AI assistant: Claude (Anthropic)

Answers students on WhatsApp: finds free times, books, moves or cancels within the school's rules, looks up payments, and hands over to staff when unsure. It can only act through the same services and permission checks as the app, for the one verified student it is talking to.

1. Create an organisation at console.anthropic.com, add billing, and set a monthly spend limit.
2. Create an API key → `ANTHROPIC_API_KEY`. Optionally set `AGENT_MODEL` (default `claude-opus-5-5`; a smaller model such as `claude-haiku-5-5` costs less, see [COSTS.md](COSTS.md)).
3. Each school can switch the assistant off in its settings.

If the AI service is down or returns an error, the student gets a fixed reply instead: that the assistant is unavailable, their next lessons and open payments (read-only; nothing is booked or changed), and the conversation is handed to staff to follow up.

**Status:** 🔒 code complete and tested with a scripted model; needs an API key.

---

## Checking what's switched on

`GET /api/health/details` (with the cron secret) reports which providers are configured, under `checks.config`, without revealing any key.
