# Capacity report: 50 schools × 250 students

**Short answer:** the target size runs comfortably on modest hardware. Peak traffic
at this size is estimated at roughly 10 page requests per second. One app process
on one CPU core served 37 per second; two small app instances (for redundancy)
plus a 2-vCPU database leave a margin of 5–7× over the estimated peak. The
database was never the bottleneck. Double bookings stayed impossible under
concurrent load.

All numbers come from `scripts/load-test.ts`, run on 12 October 2026 against a
production build. Reproduce with `npm run build && npm run load:test`. Raw
results are written to `load-results/*.json`, which is not committed.

## Test set-up

| | |
|---|---|
| Machine | 4 vCPU (Intel Xeon 2.1 GHz), 16 GB RAM, shared by Postgres 16, the app and the load generator |
| Data | 50 schools, 12,500 students with logins, 250 instructors, 250 cars, 252,500 lessons (about 4 months of history plus one upcoming lesson per student), 228,000 feedback notes, 12,500 invoices and payments (80% paid, 20% open), 60,000 audit entries. Database size: 543 MB. |
| How the data was made | Schools, staff, students, packages, invoices, payments and upcoming bookings go through the real services, with all rules and the audit log. Lesson history and feedback are bulk-inserted, because past lessons cannot be booked. |
| Traffic mix | Random signed-in users from all 50 schools: about 68% student pages, 28% instructor pages, 3% office pages (dashboard, students, payments, calendar, reports). Each simulated user requests the next page immediately, with no thinking time. That is far harsher than real use. |
| App settings | `DATABASE_POOL_MAX=20` for 1 process; 15 per process with 3 processes |

## Results

### Pages

| App processes | Simultaneous users | Pages/second | Median | 95th percentile | 99th percentile | Errors |
|---|---|---|---|---|---|---|
| 1 | 10 | 37 | 262 ms | 406 ms | 518 ms | 0% |
| 1 | 25 | 37 | 677 ms | 1.0 s | 1.2 s | 0% |
| 1 | 50 | 38 | 1.36 s | 1.9 s | 2.3 s | 0% |
| 3 | 10 | 63 | 132 ms | 364 ms | 526 ms | 0% |
| 3 | 25 | 61 | 355 ms | 956 ms | 1.4 s | 0% |
| 3 | 50 | 65 | 730 ms | 1.5 s | 1.8 s | 0% |
| 3 | 100 | 68 | 1.41 s | 2.6 s | 2.8 s | 0% |

How to read this: each app process can do about 37 pages per second, using one
CPU core. Past that point, extra users wait in line: throughput stays flat and
response times grow, but nothing fails. With 3 processes the 4-core machine was
saturated by the app, Postgres and the load generator together, so 3 processes
gave 1.8× rather than 3×. On separate machines, instances scale close to
linearly, because the database had plenty of headroom (about 10% CPU).

Typical times per page with 3 processes and 10 simultaneous users (median / 95th percentile):

| Page | Median | p95 |
|---|---|---|
| Student home | 200 ms | 484 ms |
| Student lessons | 177 ms | 394 ms |
| Student booking calendar | 151 ms | 363 ms |
| Student payments | 103 ms | 265 ms |
| Student feedback | 92 ms | 290 ms |
| Instructor home | 101 ms | 281 ms |
| Instructor calendar | 134 ms | 283 ms |
| Office dashboard | 222 ms | 504 ms |
| Office calendar (month) | 401 ms | 466 ms |
| Office students list | 90 ms | 259 ms |
| Office payments list | 189 ms | 414 ms |
| Office reports | 68 ms | 147 ms |

### Bookings

| Test | Result |
|---|---|
| 12,500 bookings through the real booking code, 50 schools in parallel | 0 failures; 223 bookings per second; median 222 ms, p95 276 ms, p99 307 ms (each one checks availability, policies, the price, and writes the audit log) |
| 25 students try to book the same instructor at the same moment | exactly 1 succeeds; 24 get "this time slot is no longer available" |
| One student books 5 different instructors at the same moment (double-click, two tabs) | exactly 1 succeeds |

The database's exclusion constraints make double bookings impossible however
many app instances run. The same race is also covered by
`tests/integration/booking.test.ts`.

### Background jobs

| Test | Result |
|---|---|
| Full job tick (reminders, overdue, WhatsApp, outbox, retention) on the full data set | 230–290 ms |
| A whole day of reminders becoming due at once (2,000 lessons) | queued in 7 s (4 job runs of up to 500) |
| Outbox | up to 50 messages per tick (per minute), so 3,000 per hour. E-mail sends are paced to 2 per second per process (`EMAIL_MAX_PER_SECOND`, Resend's default API limit), so a batch takes about 25 s. |

## Expected load at the target size

These are estimates, not measurements:

- **Students:** 12,500. If 30% open the app on a busy day, with about 8 page views each, and 15% of that happens in the busiest hour, that's about 4,500 views in that hour, or 1.3 per second.
- **Instructors:** 250 working instructors at about 40 views a day, mostly between lessons; with 20% in the busiest hour, about 0.6 per second.
- **Office staff:** 50–100 people at about 150 views a day; about 1 per second at peak.
- **Bursts:** reminder or marketing moments can multiply this several times over. Planning for **about 10 pages per second at peak** leaves room for that.
- **E-mail:** about 1–2 bookings or changes per active student per week, plus reminders and payment mails. That's about 4,000–8,000 e-mails a day, and the outbox can handle 3,000 an hour.

## Recommended production size

| Part | Size | Why |
|---|---|---|
| App | 2 instances × 1 vCPU / 1 GB, `DATABASE_POOL_MAX=10` | One instance covers the estimated peak about 4×; two keep the service up during deploys and failures. Add instances for more schools. |
| Database | Managed Postgres 16, 2 vCPU / 4 GB / 20 GB SSD, daily backups and point-in-time recovery | Under 10% CPU in this test. 543 MB of data after 4 months; expect about 1.5–2 GB a year at this size. |
| Cron | 1 call per minute to `/api/cron/tick` | Built into the compose file; on a PaaS use its scheduler. |

Connection budget: instances × (`DATABASE_POOL_MAX` + platform pool) must stay
under the database's `max_connections` (100 on most small plans). Two
instances with a pool of 10 use at most about 30 connections.

## Scaling beyond 50 schools

- **App:** stateless. Sessions are signed cookies and rate limits live in Postgres, so add instances behind the load balancer.
- **Database:** the first limits are likely the audit log and lesson history tables. Both have the indexes their queries use, and history pages are capped (50 lessons, 60 feedback notes, paginated lists). Around 500 schools, consider partitioning `audit_logs` and `notifications` by month and adding a read replica for reports.
- **Outbox:** run the tick more often or raise the batch size, and ask Resend for a higher API limit.
- **Booking calendar:** the costliest page, because it searches every instructor and car for a week. It's computed once per request. It could be cached per school for a few seconds if needed, with the database constraint still guarding correctness.

## Changes made because of this test

- **Time-zone conversions are cached** (`src/lib/zone-cache.ts`). They were about 30% of CPU time. Offsets are cached per 15 minutes and never across a DST change, so results are exact.
- **Repeated work within one page is computed once:** calendars, the school header and the session check. Together with the cache, pages per second per process went from 27 to 37.
- **The student feedback list is capped** at the 60 most recent notes.
- **The database pool size is configurable** (`DATABASE_POOL_MAX`).
- **E-mail sends are paced** to the provider's rate limit.

## Not covered by this test

- Real network latency and TLS between users, the app and the database. The test ran on one machine, so expect +20–60 ms per page in production.
- Live providers (Stripe, Resend, Meta, Anthropic). Their calls happen in background jobs or webhooks, not in page loads.
- Real login traffic. Password hashing is deliberately slow (tens of milliseconds of CPU per login), and logins are rate-limited per address, so the test signed sessions directly. Logins are a small share of requests.
- Very long-running schools (years of history). History queries are capped and indexed, but a 3-year data set has not been tested.
