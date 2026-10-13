# Test report

Run on 12 October 2026 on branch `claude/driving-school-foundation-xdnqhd`. Every
suite below also runs in CI on each push (`.github/workflows`).

| Suite | Command | Result |
|---|---|---|
| Type check | `npm run lint` | clean |
| Unit (no database) | `npm test` | **57 passed**, 12 files |
| Integration (real PostgreSQL 16, fresh database, RLS on) | `npm run test:integration` | **120 passed**, 19 files |
| End-to-end (Chromium against the production build; desktop and a Pixel 7 phone) | `npm run build && npm run e2e` | **18 passed** |
| Dependency audit (production, high severity) | `npm audit --omit=dev --audit-level=high` | no findings (CI) |
| Load and capacity (50 schools × 250 students) | `npm run load:test` | 0 errors; see [CAPACITY.md](CAPACITY.md) |

No test is skipped or marked flaky. Provider calls (Stripe, Resend, Meta,
Anthropic) are exercised with signed sample payloads, a recording sender and a
scripted model. **No test talks to a live provider**, because no live
credentials exist yet.

## The 14 mandatory scenarios

| # | Scenario | Tests (file › test) |
|---|---|---|
| 1 | A school admin cannot access another school | `tenant-isolation` › a tenant only sees its own rows; cannot write rows for another school; cannot reference another school's student even with a valid id; forgetting the tenant context returns nothing. `invoices` › is invisible from another school. E2E `staff` › one school can never see another school's students |
| 2 | An instructor cannot access unauthorised students | `auth` › an instructor cannot open a student they do not teach. `privacy` › refuses another student's data and instructors. `feedback` › students and other instructors cannot write feedback. `payments` › students and other instructors cannot complete lessons |
| 3 | A student cannot see another student | `booking` › a student cannot book for another student. `reschedule` › another student cannot reschedule someone else's lesson. `reschedule-grid` › a student cannot open another student's lesson. `invoices` › hides it from other students. `notifications` › students cannot change another student's preferences. E2E `student` › not someone else's invoice |
| 4 | Concurrent double booking | `booking` › only one of two concurrent bookings for the same instructor slot succeeds; the database blocks double booking even when availability checks are bypassed. `scheduling-engine` › never double-books instructor, vehicle or student. Load test: 25 simultaneous attempts, exactly 1 succeeds |
| 5 | 24-hour rule across time zones and DST | `policies` › the deadline exactly, one second after, and across a DST change in the school's time zone; configurable notice. `reschedule` › refuses a student reschedule less than 24h before (server-side). `whatsapp-agent` › the agent cannot reschedule within 24 hours. `zone-cache` › offsets exact minute by minute across DST changes |
| 6 | Invalid or unauthorised bookings rejected | `booking`, `student-app` › self-booking switched off is refused on the server. `reschedule-grid` › a time taken meanwhile is refused. `billing-models` › a student without credit cannot book. `support` › plan limits |
| 7 | Retried payment webhooks don't duplicate | `payments` › a verified webhook marks the payment paid exactly once. `stripe-webhook` › signature checks |
| 8 | Failed payments are not marked successful | `payments` › refuses to mark paid when the amount does not match. `stripe-webhook` › an unpaid completed session is not a success. `invoices` › the bank-transfer fallback never marks anything paid. `billing-models` › a card refund waits for the provider's confirmation; disputes |
| 9 | Duplicate notification jobs | `jobs` › the same event enqueued twice produces one e-mail, even with two workers racing |
| 10 | AI tools cannot act unauthorised | `whatsapp-agent` › an unknown number cannot act as a student; books only after confirmation in a later message; cannot reschedule within 24h |
| 11 | WhatsApp webhook verified | `whatsapp-webhook` › verifies the X-Hub-Signature-256 header. `notifications` › Svix signatures for Resend (tampering, replays) |
| 12 | Account recovery and permission changes | `auth` › does not reveal whether an e-mail exists; one-time reset link revokes sessions; newer link supersedes older; expired links refused; a reset link cannot activate or reactivate a disabled account; changing the password needs the current one; only the owner manages staff, and changes revoke sessions at once. `support` › owner recovery link. E2E `auth` › forgot password end to end, used link shows "expired" |
| 13 | Database constraints under invalid input | `constraints` › impossible times, over-long lessons, negative prices, illegal status changes, missing cancel/complete timestamps, malformed phone numbers, unknown statuses, dangling references. `tenant-isolation` › audit log cannot be changed. `billing-models` › the credit ledger cannot be edited |
| 14 | Provider outages and failed jobs | `jobs` › a provider outage leaves e-mails queued with back-off, then marks them failed after 5 attempts. `notifications` › when the AI model fails, the student gets real lesson data and the chat goes to a person; WhatsApp without consent or template falls back to e-mail. `invoices` › payment provider not configured shows a bank-transfer page |

## Other areas covered

- **GDPR:** export contents and logging, owner-only erasure with a reason, refusal while lessons or money are open, anonymisation that keeps the books, audit details blanked, retention job (`privacy`).
- **Billing:** VAT inclusive/exclusive and frozen rates, per-lesson, advance and credit models, packages, refunds, disputes, voids (`billing-models`, `vat`, `pricing`, `invoices`, `reports`).
- **Reports:** only confirmed money counts; refunds subtracted; utilisation; CSV formula-injection safety (`reports`, `csv`).
- **Notifications:** preferences, WhatsApp consent and STOP/START, suppression after bounces, wording overrides (`notifications`).
- **Security headers and sessions:** CSP with nonces, no framing, role areas, client-IP handling behind proxies, log redaction (E2E `auth`, `client-ip`, `log`).
- **Languages:** every key in EN/NL/AR with matching placeholders; RTL (`i18n`).
- **Phones:** student and instructor apps have no horizontal scroll at phone width (E2E `mobile`).

## Not tested (and why)

- **Live providers.** Live Stripe, Resend, Meta and Anthropic accounts don't exist yet. Before launch, run the staging checks in [PROVIDERS.md](PROVIDERS.md) with test-mode keys.
- **Browsers other than Chromium.** Firefox and Safari share the same server-rendered HTML; add them to `playwright.config.ts` when a staging environment exists.
- **Accessibility audit.** Form fields have labels and charts have table views, but no automated (axe) or manual screen-reader audit has been done.
- **Penetration test.** See [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) §5.
