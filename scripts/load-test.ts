/**
 * Load and capacity test at the target size: 50 schools × 250 students.
 *
 *   npm run build && npm run load:test                 # full run (seeds a fresh driving_school_load DB)
 *   npm run load:test -- --skip-seed                   # reuse the last seeded database
 *   npm run load:test -- --schools 5 --students 50     # quick smoke run
 *   options: --duration 30 (seconds per step)  --concurrency 10,25,50,100  --port 3400  --pool 20
 *            --servers 1 (app processes on consecutive ports; requests are spread round-robin,
 *            like instances behind a load balancer)
 *
 * What it does, all against a throw-away database on this machine:
 *  1. Seeds through the real services (schools, instructors, cars, students
 *     with logins, a paid or open package invoice each) plus ~4 months of
 *     lesson history per instructor inserted in bulk.
 *  2. Books one upcoming lesson for every student through bookLesson (the
 *     same code the booking pages use), one worker per school in parallel,
 *     and reports booking latency.
 *  3. Races: many students grab the same instructor slot at once, and one
 *     student books two instructors at the same time; exactly one may win.
 *  4. Starts the production server and drives a mix of student, instructor
 *     and office pages at rising concurrency, with signed session cookies
 *     (password hashing is deliberately slow and logins are rate-limited per
 *     address, so a load test cannot log in thousands of users from one machine).
 *  5. Times one background-job tick (reminders etc.) on the full data set.
 *
 * Results go to load-results/<timestamp>.json and a summary is printed.
 * Nothing leaves this machine; no external provider is called.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DateTime } from "luxon";
import { SignJWT } from "jose";
import pg from "pg";
import { freshDatabase } from "./fresh-db";

const root = path.resolve(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    schools: { type: "string", default: "50" },
    students: { type: "string", default: "250" },
    instructors: { type: "string", default: "5" },
    duration: { type: "string", default: "30" },
    concurrency: { type: "string", default: "10,25,50,100" },
    port: { type: "string", default: "3400" },
    pool: { type: "string", default: "20" },
    servers: { type: "string", default: "1" },
    "skip-seed": { type: "boolean", default: false },
  },
});
const SCHOOLS = Number(args.schools);
const STUDENTS = Number(args.students);
const INSTRUCTORS = Number(args.instructors);
const DURATION_S = Number(args.duration);
const LEVELS = args.concurrency!.split(",").map(Number);
const PORT = Number(args.port);
const SERVERS = Number(args.servers);
const DB_NAME = "driving_school_load";
const ZONE = "Europe/Amsterdam";
const host = process.env.TEST_DB_HOST ?? "localhost:5432";
const superPassword = process.env.PGPASSWORD ?? "postgres";

// Fixed per database so --skip-seed runs can still sign sessions; stored in the DB itself.
let SESSION_SECRET = randomBytes(32).toString("base64");

// ---- small stats helpers ---------------------------------------------------------
function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function summary(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 10) / 10;
  return { n: s.length, p50: r(pct(s, 50)), p95: r(pct(s, 95)), p99: r(pct(s, 99)), max: r(s.at(-1) ?? 0) };
}
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// ---- 1. seed -------------------------------------------------------------------------
interface SchoolSeed {
  id: string;
  ownerUserId: string;
  instructors: { id: string; userId: string; vehicleId: string }[];
  students: { id: string; userId: string; instructorIdx: number }[];
}

async function seed(ownerUrl: string): Promise<{ bookingMs: number[]; bookingFailures: string[]; seconds: number }> {
  const started = Date.now();
  // Imported after the environment points at the load database (the pools read it lazily).
  const { withTenant, one, closePools } = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/crypto");
  const { createSchool } = await import("../src/server/services/schools");
  const { createInstructor, createVehicle, addAvailabilityRule } = await import("../src/server/services/staff");
  const { createStudent } = await import("../src/server/services/students");
  const { createPackage, purchasePackage } = await import("../src/server/services/packages");
  const { recordManualPayment } = await import("../src/server/services/billing");
  const { bookLesson } = await import("../src/server/services/lessons");
  type Principal = import("../src/server/principal").Principal;

  const passwordHash = await hashPassword("load-test-password-1");
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const schools: SchoolSeed[] = [];

  log(`Seeding ${SCHOOLS} schools × ${STUDENTS} students (${INSTRUCTORS} instructors each)…`);
  await inBatches(
    Array.from({ length: SCHOOLS }, (_, i) => i),
    10,
    async (i) => {
      const school = await createSchool(
        { name: `Load School ${i + 1}`, slug: `load-${i + 1}`, timezone: ZONE, currency: "EUR", ownerEmail: `owner-${i + 1}@load.test`, ownerName: "Owner", planCode: "business" },
        null,
      );
      const schoolId = school.id;
      const ownerUser = await withTenant(schoolId, (tx) => one<{ id: string; email: string }>(tx, `SELECT id, email FROM users WHERE role = 'school_owner'`));
      await withTenant(schoolId, (tx) => tx.query(`UPDATE users SET status = 'active', password_hash = $1`, [passwordHash]));
      const p: Principal = {
        type: "user",
        schoolId,
        actor: { userId: ownerUser!.id, role: "school_owner", schoolId, email: ownerUser!.email, instructorId: null, studentId: null },
      };
      const s: SchoolSeed = { id: schoolId, ownerUserId: ownerUser!.id, instructors: [], students: [] };
      await withTenant(schoolId, async (tx) => {
        await tx.query(`DELETE FROM school_opening_hours`);
        for (let d = 1; d <= 7; d++) await tx.query(`INSERT INTO school_opening_hours (school_id, weekday, opens_at, closes_at) VALUES ($1,$2,'08:00','18:00')`, [schoolId, d]);
        for (let k = 0; k < INSTRUCTORS; k++) {
          const v = await createVehicle(tx, p, { registrationNumber: `LD-${i + 1}-${k + 1}`, brand: "Volkswagen", model: "Polo", transmission: "manual" });
          const ins = await createInstructor(tx, p, { firstName: `Instructor${k + 1}`, lastName: `School${i + 1}`, email: `i${k + 1}-${i + 1}@load.test`, defaultVehicleId: v.id });
          for (let d = 1; d <= 7; d++) await addAvailabilityRule(tx, p, { instructorId: ins.id, isRecurring: true, weekday: d, start: "08:00", end: "18:00" });
          const u = await one<{ user_id: string }>(tx, `SELECT user_id FROM instructors WHERE id = $1`, [ins.id]);
          s.instructors.push({ id: ins.id, userId: u!.user_id, vehicleId: v.id });
        }
      });
      for (let j = 0; j < STUDENTS; j++) {
        const k = j % INSTRUCTORS;
        const st = await withTenant(schoolId, (tx) =>
          createStudent(tx, p, {
            firstName: `Student${j + 1}`,
            lastName: `School${i + 1}`,
            email: `s${j + 1}-${i + 1}@load.test`,
            phone: `+316${String(i + 1).padStart(2, "0")}${String(j + 1).padStart(6, "0")}`,
            primaryInstructorId: s.instructors[k]!.id,
            createLogin: true,
          }),
        );
        s.students.push({ id: st.id, userId: "", instructorIdx: k });
      }
      await withTenant(schoolId, (tx) => tx.query(`UPDATE users SET status = 'active', password_hash = $1`, [passwordHash]));
      const users = await withTenant(schoolId, (tx) => tx.query<{ id: string; user_id: string }>(`SELECT id, user_id FROM students`));
      const byId = new Map(users.rows.map((r) => [r.id, r.user_id]));
      for (const st of s.students) st.userId = byId.get(st.id)!;

      // Billing through the real path: one 10-lesson package each; 80% paid at the desk, the rest still open.
      const pkg = await withTenant(schoolId, (tx) => createPackage(tx, p, { name: "Ten lessons", lessonCount: 10, priceCents: 62000 }));
      for (const [j, st] of s.students.entries()) {
        await withTenant(schoolId, async (tx) => {
          const r = await purchasePackage(tx, p, { studentId: st.id, packageId: pkg.id });
          if (j % 5 !== 0) await recordManualPayment(tx, p, r.paymentId, "load test");
        });
      }
      schools.push(s);
      log(`  school ${i + 1}/${SCHOOLS} done`);
    },
  );

  // ~4 months of history, inserted in bulk (you cannot book the past through the services).
  // Each instructor taught 8 one-hour slots a day; slots rotate through their students,
  // so no instructor, car or student is ever double-booked.
  log("Inserting lesson history…");
  for (const s of schools) {
    for (const [k, ins] of s.instructors.entries()) {
      const mine = s.students.filter((x) => x.instructorIdx === k).map((x) => x.id);
      await owner.query(
        `WITH slots AS (
           SELECT (date_trunc('day', now() AT TIME ZONE $5) - make_interval(days => d) + make_interval(hours => 9 + h)) AT TIME ZONE $5 AS start_time,
                  ($4::uuid[])[1 + ((d * 8 + h) % array_length($4::uuid[], 1))] AS student_id, d, h
             FROM generate_series(1, 120) d, generate_series(0, 7) h
         )
         INSERT INTO lessons (school_id, student_id, instructor_id, vehicle_id, start_time, end_time, status, lesson_number, price_cents, currency,
                              payment_status, completed_at, booked_via, reminder_handled_at)
         SELECT $1, student_id, $2, $3, start_time, start_time + interval '1 hour',
                CASE WHEN (d + h) % 19 = 0 THEN 'no_show' ELSE 'completed' END,
                row_number() OVER (PARTITION BY student_id ORDER BY start_time) + 1000, 6200, 'EUR', 'paid',
                CASE WHEN (d + h) % 19 = 0 THEN NULL ELSE start_time + interval '1 hour' END, 'import', start_time
           FROM slots`,
        [s.id, ins.id, ins.vehicleId, mine, ZONE],
      );
      // Feedback on every completed lesson, as instructors would write it.
      await owner.query(
        `INSERT INTO lesson_feedback (school_id, lesson_id, student_id, instructor_id, overall_rating, strengths, weaknesses, practice_items, next_focus)
         SELECT school_id, id, student_id, instructor_id, 3 + (lesson_number % 3), 'Good mirror checks', 'Roundabout lane choice', 'Merging', 'Highway entry'
           FROM lessons WHERE instructor_id = $1 AND status = 'completed'`,
        [ins.id],
      );
    }
  }
  // The services number lessons from 1; history used 1001+, so renumber per student so new bookings continue the count.
  await owner.query(
    `UPDATE lessons l SET lesson_number = x.n FROM (SELECT id, row_number() OVER (PARTITION BY student_id ORDER BY start_time) AS n FROM lessons) x WHERE x.id = l.id`,
  );
  // Setup e-mails (welcome links) are not part of the test; mark them handled so the job tick measures steady state.
  await owner.query(`UPDATE notifications SET status = 'sent', sent_at = now() WHERE status = 'queued'`);
  await owner.query(`ANALYZE`);

  // Upcoming lessons, booked through the real booking code: one per student, all schools in parallel.
  log("Booking one upcoming lesson per student through bookLesson…");
  const bookingMs: number[] = [];
  const bookingFailures: string[] = [];
  const today = DateTime.now().setZone(ZONE).startOf("day");
  await inBatches(schools, SCHOOLS, async (s) => {
    const p: Principal = { type: "user", schoolId: s.id, actor: { userId: s.ownerUserId, role: "school_owner", schoolId: s.id, email: "", instructorId: null, studentId: null } };
    const perInstructor = new Map<number, number>();
    for (const st of s.students) {
      const m = perInstructor.get(st.instructorIdx) ?? 0;
      perInstructor.set(st.instructorIdx, m + 1);
      const start = today.plus({ days: 2 + Math.floor(m / 8) }).set({ hour: 9 + (m % 8) });
      const ins = s.instructors[st.instructorIdx]!;
      const t0 = performance.now();
      try {
        await withTenant(s.id, (tx) =>
          bookLesson(tx, p, { studentId: st.id, slot: { start: start.toJSDate(), end: start.plus({ hours: 1 }).toJSDate(), instructorId: ins.id, vehicleId: ins.vehicleId }, bookedVia: "staff" }),
        );
        bookingMs.push(performance.now() - t0);
      } catch (err) {
        bookingFailures.push(err instanceof Error ? err.message : String(err));
      }
    }
  });

  writeFileSync(path.join(root, "load-results/.seed.json"), JSON.stringify({ sessionSecret: SESSION_SECRET, schools }));
  await owner.end();
  await closePools();
  return { bookingMs, bookingFailures, seconds: Math.round((Date.now() - started) / 1000) };
}

// ---- 3. races --------------------------------------------------------------------------
async function races(schools: SchoolSeed[]) {
  const { withTenant, closePools } = await import("../src/lib/db");
  const { bookLesson } = await import("../src/server/services/lessons");
  type Principal = import("../src/server/principal").Principal;
  const s = schools[0]!;
  const p: Principal = { type: "user", schoolId: s.id, actor: { userId: s.ownerUserId, role: "school_owner", schoolId: s.id, email: "", instructorId: null, studentId: null } };
  // A random time after the seeded bookings and inside the booking horizon, so re-runs against the same database race for a still-free slot.
  const start = DateTime.now().setZone(ZONE).startOf("day").plus({ days: 12 + Math.floor(Math.random() * 15) }).set({ hour: 8 + Math.floor(Math.random() * 9) });
  const slot = (k: number) => ({ start: start.toJSDate(), end: start.plus({ hours: 1 }).toJSDate(), instructorId: s.instructors[k]!.id, vehicleId: s.instructors[k]!.vehicleId });

  // 25 different students try to take the same instructor's 10:00 slot at the same moment.
  const contenders = s.students.slice(0, 25);
  const sameSlot = await Promise.allSettled(contenders.map((st) => withTenant(s.id, (tx) => bookLesson(tx, p, { studentId: st.id, slot: slot(0), bookedVia: "staff" }))));
  // One student taps "book" with five instructors at the same time (double-click / two tabs).
  const st = s.students.at(-1)!;
  const sameStudent = await Promise.allSettled(s.instructors.map((_, k) => withTenant(s.id, (tx) => bookLesson(tx, p, { studentId: st.id, slot: { ...slot(k), start: start.plus({ days: 1 }).toJSDate(), end: start.plus({ days: 1, hours: 1 }).toJSDate() }, bookedVia: "staff" }))));
  await closePools();
  const tally = (rs: PromiseSettledResult<unknown>[]) => ({
    attempts: rs.length,
    succeeded: rs.filter((r) => r.status === "fulfilled").length,
    rejectedWith: [...new Set(rs.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as Error).constructor.name + ": " + (r.reason as Error).message))],
  });
  return { sameInstructorSlot: tally(sameSlot), sameStudentTwoInstructors: tally(sameStudent) };
}

// ---- 4. HTTP -------------------------------------------------------------------------------
async function startServer(env: NodeJS.ProcessEnv, port: number): Promise<ChildProcess> {
  mkdirSync(path.join(root, "load-results"), { recursive: true });
  const out = openSync(path.join(root, `load-results/server-${port}.log`), "w");
  const server = spawn(path.join(root, "node_modules/.bin/next"), ["start", "-p", String(port)], { cwd: root, env, stdio: ["ignore", out, out] });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok, () => false)) return server;
    await new Promise((r) => setTimeout(r, 1000));
  }
  server.kill();
  throw new Error(`Server did not start; see load-results/server-${port}.log`);
}

async function cookieFor(sub: string, sid: string, role: string) {
  const jwt = await new SignJWT({ sid, role, tv: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(SESSION_SECRET));
  return `dsa_session=${jwt}`;
}

const STUDENT_PAGES = ["/student", "/student/lessons", "/student/book", "/student/payments", "/student/feedback"];
const INSTRUCTOR_PAGES = ["/instructor", "/instructor/calendar", "/instructor/students"];
const OFFICE_PAGES = ["/admin", "/admin/students", "/admin/payments", "/admin/calendar", "/admin/reports"];

interface Persona {
  cookie: string;
  pages: string[];
}

async function personas(schools: SchoolSeed[]) {
  // Weighted like a real day: mostly students, some instructors, a few office users.
  const list: { weight: number; who: Persona }[] = [];
  for (const s of schools) {
    list.push({ weight: 3, who: { cookie: await cookieFor(s.ownerUserId, s.id, "school_owner"), pages: OFFICE_PAGES } });
    for (const i of s.instructors) list.push({ weight: 5, who: { cookie: await cookieFor(i.userId, s.id, "instructor"), pages: INSTRUCTOR_PAGES } });
    for (const st of s.students.slice(0, 20)) list.push({ weight: 3, who: { cookie: await cookieFor(st.userId, s.id, "student"), pages: STUDENT_PAGES } });
  }
  const total = list.reduce((a, b) => a + b.weight, 0);
  return () => {
    let r = Math.random() * total;
    for (const x of list) if ((r -= x.weight) < 0) return x.who;
    return list[0]!.who;
  };
}

async function httpStep(pickPersona: () => Persona, concurrency: number) {
  let rr = 0;
  const base = () => `http://localhost:${PORT + (rr++ % SERVERS)}`;
  const byPage = new Map<string, number[]>();
  const errors = new Map<string, number>();
  const all: number[] = [];
  const until = Date.now() + DURATION_S * 1000;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < until) {
        const who = pickPersona();
        const page = who.pages[Math.floor(Math.random() * who.pages.length)]!;
        const t0 = performance.now();
        try {
          const res = await fetch(base() + page, { headers: { cookie: who.cookie }, redirect: "manual" });
          await res.arrayBuffer();
          const ms = performance.now() - t0;
          if (res.status !== 200) errors.set(`${res.status} ${page}`, (errors.get(`${res.status} ${page}`) ?? 0) + 1);
          else {
            all.push(ms);
            (byPage.get(page) ?? byPage.set(page, []).get(page)!).push(ms);
          }
        } catch (err) {
          const k = `network ${(err as Error).message}`;
          errors.set(k, (errors.get(k) ?? 0) + 1);
        }
      }
    }),
  );
  const errorCount = [...errors.values()].reduce((a, b) => a + b, 0);
  return {
    concurrency,
    seconds: DURATION_S,
    requests: all.length + errorCount,
    rps: Math.round(((all.length + errorCount) / DURATION_S) * 10) / 10,
    errorRate: Math.round((errorCount / Math.max(1, all.length + errorCount)) * 10000) / 100,
    errors: Object.fromEntries(errors),
    latency: summary(all),
    pages: Object.fromEntries([...byPage].sort().map(([k, v]) => [k, summary(v)])),
  };
}

async function jobTick(cronSecret: string) {
  const t0 = performance.now();
  const res = await fetch(`http://localhost:${PORT}/api/cron/tick`, { method: "POST", headers: { authorization: `Bearer ${cronSecret}` } });
  const body = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t0), body: body.slice(0, 2000) };
}

// ---- main ----------------------------------------------------------------------------------
async function main() {
  if (!existsSync(path.join(root, ".next/BUILD_ID"))) throw new Error("Run `npm run build` first.");
  mkdirSync(path.join(root, "load-results"), { recursive: true });
  const appUrl = `postgres://dsa_app_login:dsa_app_dev@${host}/${DB_NAME}`;
  const platformUrl = `postgres://dsa_platform_login:dsa_platform_dev@${host}/${DB_NAME}`;
  const ownerUrl = `postgres://postgres:${superPassword}@${host}/${DB_NAME}`;
  const cronSecret = randomBytes(16).toString("hex");
  Object.assign(process.env, {
    DATABASE_URL: appUrl,
    DATABASE_PLATFORM_URL: platformUrl,
    DATABASE_OWNER_URL: ownerUrl,
    DATABASE_POOL_MAX: "30",
    EMAIL_PROVIDER: "console",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString("base64"),
  });

  const result: Record<string, unknown> = {
    when: new Date().toISOString(),
    machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.platform()} ${os.release()}` },
    size: { schools: SCHOOLS, studentsPerSchool: STUDENTS, instructorsPerSchool: INSTRUCTORS },
    serverPoolMax: Number(args.pool),
    appServers: SERVERS,
  };

  let schools: SchoolSeed[];
  if (!args["skip-seed"]) {
    await freshDatabase(DB_NAME, host, superPassword);
    const seeded = await seed(ownerUrl);
    result.seed = { seconds: seeded.seconds, bookingLatencyMs: summary(seeded.bookingMs), bookingFailures: seeded.bookingFailures.length, bookingFailureSamples: seeded.bookingFailures.slice(0, 5) };
    log("Bookings:", JSON.stringify(result.seed));
  }
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(path.join(root, "load-results/.seed.json"), "utf8")) as { sessionSecret: string; schools: SchoolSeed[] };
  SESSION_SECRET = saved.sessionSecret;
  schools = saved.schools;

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const counts = await owner.query(
    `SELECT (SELECT count(*) FROM schools)::int AS schools, (SELECT count(*) FROM students)::int AS students, (SELECT count(*) FROM users)::int AS users,
            (SELECT count(*) FROM lessons)::int AS lessons, (SELECT count(*) FROM lesson_feedback)::int AS feedback,
            (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM payments)::int AS payments,
            (SELECT count(*) FROM audit_logs)::int AS audit_logs, pg_size_pretty(pg_database_size(current_database())) AS db_size`,
  );
  result.data = counts.rows[0];
  log("Data:", JSON.stringify(result.data));

  log("Racing bookings for the same slot…");
  result.races = await races(schools);
  log("Races:", JSON.stringify(result.races));

  const servers = await Promise.all(
    Array.from({ length: SERVERS }, (_, n) =>
      startServer(
        {
          ...process.env,
          NODE_ENV: "production",
          APP_URL: `http://localhost:${PORT}`,
          SESSION_SECRET,
          CRON_SECRET: cronSecret,
          DATABASE_POOL_MAX: String(args.pool),
          LOG_LEVEL: "warn",
        },
        PORT + n,
      ),
    ),
  );
  try {
    const pick = await personas(schools);
    // Warm-up: first hits compile nothing in production, but fill caches and the connection pool.
    await httpStep(pick, 5).catch(() => undefined);
    const steps = [];
    for (const c of LEVELS) {
      log(`HTTP: ${c} concurrent users for ${DURATION_S}s…`);
      const step = await httpStep(pick, c);
      log(`  ${step.rps} req/s, p50 ${step.latency.p50} ms, p95 ${step.latency.p95} ms, p99 ${step.latency.p99} ms, errors ${step.errorRate}%`);
      steps.push(step);
    }
    result.http = steps;
    log("Background job tick on the full data set…");
    result.jobTick = await jobTick(cronSecret);
    log("  ", JSON.stringify(result.jobTick).slice(0, 300));
  } finally {
    for (const s of servers) s.kill();
    await owner.end();
  }
  const file = path.join(root, `load-results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`Results written to ${path.relative(root, file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
