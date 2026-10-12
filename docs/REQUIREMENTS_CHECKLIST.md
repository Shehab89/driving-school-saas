# Requirements → implementation checklist

Maps every requirement in the master prompt to where it lives and its status.

Legend: ✅ implemented and tested · 🟡 partly implemented · 🔒 code done, live activation needs credentials or an external approval · ⚖️ needs professional (legal/tax) review

Status on 12 October 2026 (branch `claude/driving-school-foundation-xdnqhd`): lint clean; 57 unit, 120 integration and 18 browser tests passing; production build passing; load-tested at 50 schools × 250 students. See [TEST_REPORT.md](TEST_REPORT.md).

## 5.1 Platform administration

| Requirement | Status | Where / notes |
|---|---|---|
| Platform admin dashboard | ✅ | `src/app/platform/page.tsx`, `platformOverview()` |
| School registration and onboarding | ✅ | `createSchool()`: school, settings, default levels, subscription, owner invite; setup checklist on the school dashboard |
| Activation, suspension, deactivation | ✅ | `setSchoolStatus()`; suspended/closed schools cannot sign in |
| Subscription and plan configuration | ✅ | `plans`, `school_subscriptions`; plan limits enforced (`plan-limits.ts`) |
| Tenant-level settings | ✅ | `school_settings`, `/admin/settings` |
| Usage and operational statistics | ✅ | platform overview; `/api/health/details` |
| Support workflows with controlled access | ✅ | time-boxed, read-only support grants by the owner; every view audited and visible to the school (`support.test.ts`) |
| Auditable admin actions | ✅ | append-only `audit_logs`; platform audit view |
| No unrestricted PII access for platform admins | ✅ | aggregates only without a grant |

## 5.2 School administration

| Requirement | Status | Where / notes |
|---|---|---|
| Profile, contact, settings | ✅ | `/admin/settings` |
| Branding | 🟡 | school name, contact details and sender name on e-mails and invoices; no logo or colours |
| Students and accounts | ✅ | `/admin/students` (search, pagination), invites |
| Instructors and permissions, team | ✅ | `/admin/instructors`, `/admin/team` (owner-only role changes) |
| Vehicles and availability | ✅ | `/admin/vehicles`, maintenance windows |
| Lesson types, duration, prices, packages | ✅ | Settings → Prices; packages and credits |
| Working hours and leave | ✅ | availability rules and exceptions |
| Booking and cancellation policies | ✅ | notice hours, fees, approval, self-booking switch |
| Payment settings | ✅ | per-lesson / in advance / credits, VAT inclusive or exclusive, Stripe account |
| Communication templates | ✅ | per-school e-mail subject and opening text; WhatsApp template mapping (`/admin/notifications`) |
| Student progress criteria | ✅ | `level_definitions`, `skills` |
| Reports and statistics | ✅ | `/admin/reports`, accountant CSV |

## 5.3 Students

| Requirement | Status | Where / notes |
|---|---|---|
| Registration and invitations | ✅ | `/join`, staff invite, WhatsApp onboarding |
| Authentication and account recovery | ✅ | sign-in, forgot password (single use, 1 hour), rate limits |
| Profile and contact preferences | ✅ | message categories, WhatsApp consent |
| Assigned instructor, school info | ✅ | student app home |
| Booking, rescheduling, history | ✅ | `/student/book`, `/student/lessons` |
| Progress and feedback | ✅ | `/student/feedback`, road journey, printable report |
| Payment history, balance, credits, invoices | ✅ | `/student/payments`, `/invoices/[id]` |
| Privacy workflows | ✅ | data download; staff erasure; access disable |

## 5.4 Instructors

| Requirement | Status |
|---|---|
| Profiles, schedules, breaks, leave, assigned students/vehicles | ✅ |
| Day / week / month calendar | ✅ |
| Upcoming and completed lessons, completion records | ✅ |
| Feedback and progress assessments | ✅ |
| Only their own students | ✅ (`auth.test.ts`) |
| Notifications | ✅ e-mail; WhatsApp 🔒 |

## 5.5 Scheduling engine

| Requirement | Status | Where / notes |
|---|---|---|
| Instructor + vehicle availability, compatibility, buffers, hours, leave | ✅ | `scheduling/engine.ts` (pure, unit tested) |
| Conflicts for instructor, vehicle and student | ✅ | three GiST exclusion constraints |
| Create, cancel, reschedule, statuses, audit | ✅ | `services/lessons.ts`, status-transition trigger |
| Time-zone aware; 24h rule on the backend incl. DST | ✅ | `policies.ts`, database clock |
| No double booking under concurrency | ✅ | constraints; integration test; load test (25 racers → 1 booking) |
| Revalidate the slot at submit | ✅ | inside the booking transaction |

## 5.6 Learning progress

| Requirement | Status |
|---|---|
| Competencies, history, assessments, comments, strengths/improvements, timeline | ✅ |
| Suggested next objectives | ✅ |
| Progress report | ✅ printable (`/progress/[studentId]`) |
| No claim of official CBR certification | ✅ disclaimer on the report |

## 5.7 Billing

| Requirement | Status | Where / notes |
|---|---|---|
| Configurable prices | ✅ | pricing service |
| Packages / prepaid credits | ✅ | `packages.ts`, credit ledger (append-only) |
| Invoices and payment requests | ✅ | numbered invoices, printable, secure pay links |
| Status tracking incl. failed, refunded, disputed | ✅ | |
| Outstanding balance and reminders | ✅ | overdue job and e-mail |
| Refunds | ✅ | owner-only; card refunds wait for Stripe's confirmation |
| Reconciliation and reporting | ✅ | revenue from confirmed payments only; CSV |
| Admin corrections with audit | ✅ | void with reason, credit corrections with note |
| Payment model per school | ✅ | per lesson / in advance / credits |
| Verified webhooks, idempotency, no card data | ✅ | |
| Dutch VAT and invoice requirements | ✅ ⚖️ | VAT split and frozen rate, KvK/BTW/IBAN on invoices; needs an accountant's confirmation |
| Live payments | 🔒 | Stripe keys |

## 5.8 Notifications

| Requirement | Status |
|---|---|
| All event e-mails, password recovery | ✅ |
| Preferences | ✅ |
| Template management | ✅ per-school wording |
| Retry, failure handling, dedupe, outbox | ✅ |
| Delivery status | ✅ signed Resend webhook; bounces suppress the address |
| Log redaction | ✅ |
| Live sending | 🔒 Resend domain and keys |

## 5.9 WhatsApp

| Requirement | Status |
|---|---|
| Webhook verification, messages, routing, conversation state, delivery status, dedupe, handoff | ✅ |
| Opt-in / opt-out | ✅ consent timestamps, STOP/START |
| Templates outside the 24h window | ✅ per-school mapping; e-mail fallback |
| Live activation | 🔒 Meta Business verification, app secret, numbers, approved templates |

## 5.10 AI assistant

| Requirement | Status |
|---|---|
| Scoped tools, identity verification, two-step confirm, prompt-injection resistance, audit | ✅ |
| Real availability, booking, rescheduling, payments lookup, escalation | ✅ |
| Deterministic fallback when the AI provider is down | ✅ |
| Provider abstraction | ✅ |
| Live activation | 🔒 `ANTHROPIC_API_KEY` |

## 5.11 Dashboards and reporting

| Requirement | Status |
|---|---|
| Role dashboards (platform, school, instructor, student) | ✅ |
| Utilisation, revenue from verified payments, trends | ✅ |

## 6 Architecture and database

| Requirement | Status |
|---|---|
| Normalised schema, constraints, indexes, versioned migrations | ✅ (`constraints.test.ts`) |
| RLS, least-privilege roles, server-side authz, validation | ✅ |
| Separate dev/test/prod configuration | ✅ |
| Structured logs with redaction | ✅ |
| Backup/recovery, retention/deletion docs | ✅ [OPERATIONS.md](OPERATIONS.md), [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) |

## 7 UI/UX

Responsive role-based apps in EN/NL/AR (RTL), installable student and instructor web apps, paginated and searchable admin lists, phone layouts covered by browser tests. 🟡 No formal accessibility audit yet.

## 8 Security and GDPR

| Requirement | Status |
|---|---|
| Authentication, authorisation, tenant isolation, validation, webhook verification, encrypted secrets | ✅ |
| Rate limiting (shared across instances, proxy-aware) | ✅ |
| CSP and security headers | ✅ |
| Data export, erasure, retention | ✅ |
| GDPR documentation | ✅ draft, ⚖️ review ([SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md)) |
| Dependency audit in CI | ✅ |
| Two-factor authentication, penetration test | ❌ recommended before scaling ([PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)) |

## 9 Tests (14 mandatory scenarios)

All 14 covered; scenario → test mapping in [TEST_REPORT.md](TEST_REPORT.md). Browser tests (Playwright, desktop + phone) run in CI.

## 10 Performance

✅ Load test at 50 schools × 250 students with 0 errors; capacity report and sizing in [CAPACITY.md](CAPACITY.md).

## 11 DevOps

✅ CI (types, unit, integration, browser, build, audit, Docker), deployment and rollback, backup/restore drill, monitoring, incidents: [OPERATIONS.md](OPERATIONS.md). Costs: [COSTS.md](COSTS.md). 🔒 No public deployment has been made; that needs your hosting account and approval.

## Final deliverables

| Deliverable | Where |
|---|---|
| Working application and source | this repository |
| Architecture and decisions | [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md) |
| Requirements checklist | this file |
| Deployment guide | [PILOT_DEPLOY.md](PILOT_DEPLOY.md), [OPERATIONS.md](OPERATIONS.md) |
| Provider set-up (what needs live credentials) | [PROVIDERS.md](PROVIDERS.md) |
| Security and GDPR | [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) |
| Backup, recovery, rollback, monitoring, incidents | [OPERATIONS.md](OPERATIONS.md) |
| Test report | [TEST_REPORT.md](TEST_REPORT.md) |
| Load test and capacity report | `scripts/load-test.ts`, [CAPACITY.md](CAPACITY.md) |
| Cost estimate | [COSTS.md](COSTS.md) |
| Production-readiness checklist and known limitations | [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) |
| Demo data | `npm run db:seed` (synthetic; never for production) |
