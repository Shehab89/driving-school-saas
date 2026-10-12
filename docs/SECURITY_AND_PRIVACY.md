# Security and privacy (GDPR / AVG)

This describes how DriveDesk protects data and how it supports the GDPR. It is
a technical basis for the schools' and the platform's own privacy
documentation. **It is not legal advice:** the items marked ⚖️ need review by a
privacy lawyer or DPO before production use.

## 1. Roles under the GDPR

- **Each driving school is the controller** for its students', instructors' and staff's data. It decides why and how the data is used.
- **The platform operator is a processor** for the schools. A data processing agreement (verwerkersovereenkomst) between operator and each school is needed. ⚖️
- **Sub-processors** (only when switched on): the hosting provider and its database, Resend (e-mail), Stripe (payments; Stripe is also an independent controller for payment data), Meta (WhatsApp), Anthropic (AI assistant). Each needs a DPA and, where data leaves the EEA, a transfer basis (EU-US Data Privacy Framework or standard contractual clauses). Choose EU hosting regions where offered. ⚖️

## 2. What personal data is held

| Who | Data | Why | Kept |
|---|---|---|---|
| Students | name, e-mail, phone, date of birth (optional), licence category, preferred transmission, preferred times | to schedule and teach lessons | until erased; automatically erased a set time after archiving (default 24 months, school setting 12–120 or off) |
| Students | lessons, progress, skills, instructor feedback, self-assessment answers | the lessons themselves | as above |
| Students | invoices (with billed name), payments | bookkeeping | 7 years (Dutch tax law); the billed name stays on issued invoices after erasure |
| Students | WhatsApp messages | conversation with the school and assistant | 24 months, then deleted |
| Students | sent-message log (e-mail/WhatsApp) | delivery tracking, support | 13 months, then deleted |
| Staff, instructors | name, e-mail, phone, role, sign-in times | accounts and access control | while employed; disable the account when they leave |
| Everyone | audit log of actions | accountability, security | kept; details about an erased student are blanked |
| Everyone | activation and reset links | sign-in | deleted 30 days after use or expiry |

No special-category data (health, etc.) is requested. Schools should not write medical information in free-text notes; if a student's eyesight or health matters for lessons, that stays with the CBR process. ⚖️

Lawful bases (for the school's privacy notice, ⚖️): contract (lessons, payments), legal obligation (invoices), legitimate interest (reminders, security logs), consent (WhatsApp messages, which can be withdrawn by sending STOP or on the profile page).

## 3. Data subject rights: how they work in the app

| Right | How |
|---|---|
| Access and portability (art. 15, 20) | Student: **Profile → Your data → Download**. Staff: student page → **Privacy and access → Download data**. A JSON file with profile, lessons, feedback, progress, invoices, payments, messages and WhatsApp history. Each download is logged; limited to 10 per hour. |
| Rectification (art. 16) | Students edit their contact details; staff edit the rest. Changes are audited. |
| Erasure (art. 17) | Owner only: student page → **Erase personal data**, with a reason and the student number typed to confirm. Refused while lessons are still planned or money is open, so nothing the school still needs is lost. Personal fields are cleared, WhatsApp chats deleted, the sign-in disabled, and audit details about the person blanked. Lessons and invoices remain without identity, except the billed name on issued invoices (tax law). |
| Restriction / objection | Staff can disable a student's sign-in without erasing; students can switch off message categories and WhatsApp. |
| Storage limitation (art. 5) | The nightly retention job (section 2). |

Backups: an erased person remains in backups until they expire (30 days). See [OPERATIONS.md](OPERATIONS.md) §5 for what to do if a backup is restored.

## 4. Security measures

**Tenant isolation.** Every school's data is separated in the database itself: row-level security on every tenant table (forced, so even the table owner's queries are filtered), composite foreign keys so a row can never point at another school's row, and the application connects as a role that cannot bypass these rules. A bug in a page cannot show another school's data. Tested in `tenant-isolation.test.ts` and in the browser tests.

**Access control.** Roles: platform admin, school owner, school admin, instructor, student. Every server action and service checks permissions on the server; the UI hiding a button is never the only control. Instructors see only their own students; students only themselves. Platform admins see aggregates only, unless a school owner grants time-limited, read-only support access, and every support view is logged and visible to the school.

**Authentication.** Passwords hashed with scrypt, minimum 10 characters. Sessions are signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookies, revoked on password change, role change or account disable. Password reset and activation links are single-use, expire (1 hour for resets), and are stored only as hashes. No account enumeration on login or reset. Rate limits (in the database, so they hold across servers): login per address and per e-mail, password reset, sign-up, data export.

**Web.** Content-Security-Policy with per-request nonces (no inline scripts), HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`, `Referrer-Policy`, COOP. Next.js server actions reject cross-origin posts. All input is validated with schemas on the server. CSV exports are protected against spreadsheet formula injection.

**Webhooks.** Stripe, Resend and Meta webhooks are verified by signature against the raw body; unsigned or stale requests are refused. Each event is processed once.

**Payments.** No card data touches the app (Stripe Checkout). Amounts come from the database, and webhook amounts are compared with them.

**Secrets.** All keys are environment variables; none are in the repository. Per-school WhatsApp tokens are encrypted at rest (AES-256-GCM). Logs are JSON with personal data (e-mail, phone, tokens) redacted, and one-time links are scrubbed from the message log after sending.

**AI assistant.** It can only call a fixed set of tools that go through the same permission checks, for the single student it verified; changes need the student's explicit confirmation; it cannot see other students or staff data. Prompt-injection text in messages cannot widen what the tools allow. Tested in `whatsapp-agent.test.ts`.

**Audit.** An append-only audit log (the application role cannot update or delete it) records who did what: bookings, cancellations, price changes, payments, refunds, settings, team changes, support access, exports and erasures.

**Supply chain.** `npm audit` (production dependencies, high severity) runs in CI; the Docker image is built from the official Node 22 Alpine image; pin it by digest for production builds.

## 5. Known gaps and recommendations

- **Two-factor authentication** is not built. Recommended for school owners and platform admins before scaling beyond a pilot.
- **Penetration test:** none has been done. Commission one before handling many schools' data.
- **DPIA:** a data protection impact assessment is advisable (students may be under 18, and the platform processes data for many schools at once). ⚖️
- **Privacy notice, DPA template, cookie statement** (the app only sets functional cookies: session and language): to be written with a lawyer. ⚖️
- **Records of processing** (art. 30): the table in section 2 is a starting point. ⚖️
- **Breach procedure:** see [OPERATIONS.md](OPERATIONS.md) §8.
