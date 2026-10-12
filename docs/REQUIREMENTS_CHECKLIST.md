# Requirements → implementation checklist

This maps every requirement in the master prompt to where it lives in the code, and its status. It is kept up to date as work lands.

Legend: ✅ implemented and tested · 🟡 partly implemented · ❌ not started · 🔒 code done, live activation needs credentials or an external approval · ⚖️ needs professional (legal/tax) review

Baseline on 2026-10-12 (branch `claude/wizardly-ride-9bioa7`, 19 commits): lint clean, 37 unit + 55 integration tests passing, production build passing.

## 5.1 Platform administration

| Requirement | Status | Where / notes |
|---|---|---|
| Platform admin dashboard | ✅ | `src/app/platform/page.tsx`, `platformOverview()` |
| School registration and onboarding | ✅ | `createSchool()` creates school, settings, default levels, subscription, owner invite |
| Activation, suspension, deactivation | ✅ | `setSchoolStatus()`; suspended/closed schools cannot log in (`login()`) |
| Subscription and plan configuration | ✅ | `plans`, `school_subscriptions`, `setSchoolPlan()`; plan limits enforced in WS-5 |
| Tenant-level settings | ✅ | `school_settings` + `/admin/settings` |
| Usage and operational statistics | ✅ | platform overview (students, lessons, revenue, WhatsApp volume) |
| Support workflows with controlled access | ❌ → WS-2 | time-boxed support access granted by the school owner, audited |
| Auditable admin actions | ✅ | `audit_logs` (append-only); platform audit view added in WS-2 |
| No unrestricted PII access for platform admins by default | 🟡 → WS-2 | platform console shows aggregates only; support grants make the exception explicit |

## 5.2 School administration

| Requirement | Status | Where / notes |
|---|---|---|
| Profile, contact, branding, settings | 🟡 | profile + settings done; branding (logo colour/name on e-mails) → WS-5 |
| Students and accounts | ✅ | `/admin/students`, `createStudent`, invites |
| Instructors and permissions | ✅ | `/admin/instructors`, roles `school_admin` / `instructor` |
| Vehicles and availability | ✅ | `/admin/vehicles`, `vehicle_unavailability` |
| Lesson categories, duration, prices, packages | 🟡 → WS-5 | per-type prices exist; lesson packages / prepaid credits added |
| Working hours and leave | ✅ | `instructor_availability` + exceptions, `/instructor/availability` |
| Booking and cancellation policies | ✅ | `school_settings` notice hours, fees, approval flag |
| Payment settings | 🟡 → WS-5 | Stripe Connect id; payment model (after lesson / in advance / credits) and VAT added |
| Communication templates | ❌ → WS-6 | per-school overrides of e-mail subject/intro text |
| Student progress criteria | ✅ | `level_definitions`, `skills` |
| Reports and statistics | 🟡 → WS-8 | dashboard charts exist; dedicated reports page added |

## 5.3 Students

| Requirement | Status | Where / notes |
|---|---|---|
| Registration and invitations | ✅ | `/join`, staff invite, WhatsApp onboarding |
| Secure authentication and account recovery | 🟡 → WS-1 | login + rate limit done; self-service "forgot password" added |
| Profile and contact preferences | 🟡 → WS-6 | profile done; notification preferences added |
| Assigned instructor, school info | ✅ | student app home |
| Booking history | ✅ | `/student/lessons` |
| Progress and feedback | ✅ | `/student/feedback`, road journey |
| Payment history and balance | ✅ | `/student/payments` |
| Account deactivation and privacy workflows | ❌ → WS-7 | data export, erasure request, anonymisation |

## 5.4 Instructors

| Requirement | Status |
|---|---|
| Profiles, schedules, breaks, leave, assigned students/vehicles | ✅ |
| Day / week / month calendar | ✅ (`schedule-board.tsx`) |
| Upcoming and completed lessons, completion records | ✅ |
| Feedback and progress assessments | ✅ |
| Notifications | ✅ (e-mail) |

## 5.5 Scheduling engine

| Requirement | Status | Where / notes |
|---|---|---|
| Instructor + vehicle availability, compatibility, buffers, hours, leave | ✅ | `scheduling/engine.ts` (pure, unit tested) |
| Student/instructor conflicts | ✅ | three gist exclusion constraints |
| Create, cancel, reschedule, statuses, audit | ✅ | `services/lessons.ts`, status-transition trigger |
| Timezone-aware | ✅ | Luxon, school IANA zone |
| 24h reschedule rule on backend, school timezone, DST | ✅ | `policies.ts`, DB clock; tests incl. DST |
| No double booking under concurrency | ✅ | exclusion constraints + concurrent test |
| Revalidate slot at submit | ✅ | `revalidateSlot` inside the booking transaction |

## 5.6 Learning progress

| Requirement | Status |
|---|---|
| Configurable competencies, history, assessments, comments, strengths/improvements, timeline | ✅ |
| Suggested next objectives | ✅ (`next_focus`, progress service) |
| School-configurable progress report | 🟡 → WS-8 (printable progress report) |
| No claim of official CBR certification | ✅ (disclaimer added in WS-8 report) |

## 5.7 Billing

| Requirement | Status | Where / notes |
|---|---|---|
| Configurable prices | ✅ | pricing service |
| Packages / prepaid credits | ❌ → WS-5 | |
| Completed-lesson records, invoices, payment requests | ✅ | `completeLesson` → invoice + payment |
| Status tracking pending/paid/failed/refunded | ✅ | |
| Disputed payments | ❌ → WS-5 | `charge.dispute.*` events |
| Outstanding balance, reminders | ✅ | overdue job + e-mail |
| Refunds | 🟡 | refund webhook handled; staff-initiated refund → WS-5 |
| Reconciliation and reporting | 🟡 → WS-8 | |
| Admin corrections with audit | 🟡 → WS-5 | void invoice / waive with audit |
| Payment model per school (per lesson / in advance / credits) | ❌ → WS-5 | |
| Verified webhooks, idempotency, no raw card data | ✅ | Stripe Checkout + `constructEvent` + event-id dedupe |
| Dutch VAT / invoice requirements | ⚖️ → WS-5 | VAT rate + VAT number on invoices; needs an accountant's confirmation |

## 5.8 Notifications

| Requirement | Status |
|---|---|
| All event e-mails (booking, reschedule, cancel, reminder, completion, payment, invites) | ✅ |
| Password recovery e-mail | ❌ → WS-1 |
| Preferences | ❌ → WS-6 |
| Template management | ❌ → WS-6 |
| Retry, failure handling, dedupe, outbox | ✅ |
| Delivery status (provider webhook) | ❌ → WS-6 (Resend webhook, signed) |
| Log redaction | ✅ (one-time secrets scrubbed after send) |

## 5.9 WhatsApp

| Requirement | Status |
|---|---|
| Webhook verification, in/out messages, routing, conversation state, delivery status, dedupe, handoff | ✅ |
| Opt-in / opt-out | ❌ → WS-6 (STOP/START keywords, consent timestamps) |
| Templates outside the 24h window | 🟡 → WS-6 |
| Live activation | 🔒 needs a Meta Business account, verified number and app secret |

## 5.10 AI assistant

| Requirement | Status |
|---|---|
| Scoped tools, identity verification, two-step confirm, prompt-injection resistance, audit | ✅ |
| Real availability, booking, rescheduling, payments lookup, escalation | ✅ |
| Deterministic fallback when the AI provider is down | ❌ → WS-6 |
| Provider abstraction | ✅ (`AgentLlm` interface) |
| Live activation | 🔒 needs `ANTHROPIC_API_KEY` |

## 5.11 Dashboards and reporting

| Requirement | Status |
|---|---|
| Role dashboards (platform, school, instructor, student) | ✅ |
| Utilisation, revenue from verified payments, trends | 🟡 → WS-8 |

## 6 Architecture and database

| Requirement | Status |
|---|---|
| Normalised schema, constraints, indexes, versioned migrations | ✅ |
| RLS, least-privilege roles, server-side authz, validation (zod) | ✅ |
| Separate dev/test/prod config | ✅ (`.env`, test DB, docker) |
| Structured logs | ❌ → WS-3 (JSON logger with redaction) |
| Backup/recovery, retention/deletion docs | ❌ → WS-10 |

## 7 UI/UX

Responsive role-based apps exist (EN/NL/AR, RTL). Gaps: pagination/search on long admin lists → WS-8.

## 8 Security and GDPR

| Requirement | Status |
|---|---|
| AuthN/Z, tenant isolation, validation, webhook verification, encrypted secrets | ✅ |
| Rate limiting | 🟡 → WS-3 (login only, in-memory; move to Postgres, add reset/signup/link-code) |
| CSP header | ❌ → WS-3 |
| Data export / deletion / retention | ❌ → WS-7 |
| GDPR assessment document | ❌ → WS-10 ⚖️ |
| Dependency audit in CI | ❌ → WS-3 |

## 9 Tests (14 mandatory scenarios)

| # | Scenario | Status |
|---|---|---|
| 1 | Admin cannot access another school | ✅ `tenant-isolation.test.ts` |
| 2 | Instructor cannot access unauthorised students | 🟡 → add explicit test |
| 3 | Student cannot see another student | ✅ `student-app.test.ts` |
| 4 | Concurrent double-booking | ✅ `booking.test.ts` |
| 5 | 24h rule across timezones/DST | ✅ unit + `reschedule.test.ts` |
| 6 | Invalid/unauthorised booking rejected | ✅ |
| 7 | Retried payment webhooks don't duplicate | ✅ `payments.test.ts` |
| 8 | Failed payments not marked successful | ✅ |
| 9 | Duplicate notification jobs | 🟡 → add explicit test |
| 10 | AI tools cannot act unauthorised | ✅ `whatsapp-agent.test.ts` |
| 11 | WhatsApp webhook verified | ✅ |
| 12 | Account recovery and permission changes | ❌ → WS-1 |
| 13 | DB constraints under invalid input | 🟡 → add test |
| 14 | Provider outages and failed jobs | ❌ → WS-6 |
| — | End-to-end UI tests | ❌ → WS-9 (Playwright) |

## 10 Performance

Indexes exist. Load test at 50 schools × 250 students and capacity report → WS-9.

## 11 DevOps

CI (lint, unit, integration, build, docker) ✅. Missing: dependency audit, rollback/incident/backup/cost docs, health check that tests the DB → WS-3 / WS-10.
