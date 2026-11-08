import { expect, test, type Page } from "@playwright/test";
import { login, sql } from "./helpers";

/**
 * Walks every screen of the three apps on a phone-sized window and checks that each one
 * loads, throws no browser errors, does not scroll sideways and shows no raw translation keys.
 * TOUR_SHOTS=dir also saves a screenshot of each screen (for a human review).
 */
const SHOTS = process.env.TOUR_SHOTS;

async function check(page: Page, path: string, tag: string) {
  const errors: string[] = [];
  const onErr = (e: Error) => errors.push(e.message);
  page.on("pageerror", onErr);
  const res = await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  page.off("pageerror", onErr);
  const status = res?.status() ?? 0;
  const info = await page.evaluate(() => {
    const doc = document.documentElement;
    const text = document.body.innerText;
    // Raw keys look like "instructor.plan.title" or "student.home.x" written into the page.
    const keys = text.match(/\b(?:student|instructor|common|auth|portal|nav|admin)\.[a-z][A-Za-z]+(?:\.[A-Za-z]+)+\b/g) ?? [];
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > doc.clientWidth + 2 && getComputedStyle(el).position !== "fixed"; })
      .filter((el) => !el.closest("[data-scroll-x], .table-wrap, .scroll-x, table, pre, .board, .week-strip, .chips"))
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
    return { overflow: doc.scrollWidth > doc.clientWidth + 2, wide, keys: [...new Set(keys)] };
  });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${tag}${path.replace(/[/?=&]+/g, "_")}.png`, fullPage: true });
  return { path, status, errors, ...info };
}

type Row = Awaited<ReturnType<typeof check>>;
const problems = (rows: Row[]) =>
  rows.filter((r) => r.status >= 400 || r.errors.length || r.overflow || r.keys.length).map((r) => JSON.stringify(r));

test.use({ viewport: { width: 390, height: 844 } });

test("student app: every screen works on a phone (Arabic)", async ({ page }) => {
  await login(page, "youssef@abc.test", "student");
  const [l] = await sql<{ id: string }>(`SELECT l.id FROM lessons l JOIN students s ON s.id = l.student_id WHERE s.email = 'youssef@abc.test' ORDER BY l.start_time DESC LIMIT 1`);
  const rows: Row[] = [];
  for (const p of ["/student", "/student/book", "/student/lessons", `/student/lessons/${l!.id}`, "/student/payments", "/student/feedback", "/student/profile", "/account"]) rows.push(await check(page, p, "student-ar"));
  expect(problems(rows)).toEqual([]);
});

test("student app: every screen works on a phone (Dutch)", async ({ page }) => {
  await login(page, "anna@abc.test", "student");
  const rows: Row[] = [];
  for (const p of ["/student", "/student/book", "/student/lessons", "/student/payments", "/student/feedback", "/student/profile"]) rows.push(await check(page, p, "student-nl"));
  expect(problems(rows)).toEqual([]);
});

test("instructor app: every screen works on a phone (Arabic)", async ({ page }) => {
  await login(page, "fatima@abc.test", "instructor");
  const [s] = await sql<{ id: string }>(`SELECT s.id FROM students s JOIN instructors i ON i.id = s.primary_instructor_id JOIN users u ON u.id = i.user_id WHERE u.email = 'fatima@abc.test' LIMIT 1`);
  const [l] = await sql<{ id: string }>(`SELECT l.id FROM lessons l JOIN instructors i ON i.id = l.instructor_id JOIN users u ON u.id = i.user_id WHERE u.email = 'fatima@abc.test' ORDER BY l.start_time DESC LIMIT 1`);
  const rows: Row[] = [];
  for (const p of ["/instructor", "/instructor/calendar", "/instructor/calendar?view=week", "/instructor/calendar?view=month", "/instructor/students", "/instructor/lessons/new", "/instructor/feedback", "/instructor/availability", "/instructor/profile", "/instructor/more", `/students/${s!.id}`, `/lessons/${l!.id}`, `/lessons/${l!.id}/edit`])
    rows.push(await check(page, p, "instructor-ar"));
  expect(problems(rows)).toEqual([]);
});

test("one-person school app: every screen works on a phone (Dutch)", async ({ page }) => {
  await sql(`UPDATE users SET locale = 'nl' WHERE email = 'kees@noord.test'`);
  await login(page, "kees@noord.test");
  const rows: Row[] = [];
  for (const p of ["/instructor", "/instructor/students", "/instructor/students/new", "/instructor/lessons/new", "/instructor/money", "/instructor/more", "/instructor/calendar", "/admin/students/import", "/admin/settings", "/admin/billing", "/admin/exams"])
    rows.push(await check(page, p, "solo-nl"));
  expect(problems(rows)).toEqual([]);
});

test("school portal: every screen works on a phone (Arabic)", async ({ page }) => {
  await sql(`UPDATE users SET locale = 'ar' WHERE email = 'owner@abc.test'`);
  await login(page, "owner@abc.test");
  await page.context().addCookies([{ name: "locale", value: "ar", url: page.url() }]);
  const [s] = await sql<{ id: string }>(`SELECT id FROM students WHERE email = 'priya@abc.test'`);
  const [i] = await sql<{ id: string }>(`SELECT id FROM instructors LIMIT 1`);
  const [l] = await sql<{ id: string }>(`SELECT id FROM lessons WHERE status = 'scheduled' ORDER BY start_time LIMIT 1`);
  const rows: Row[] = [];
  for (const p of ["/admin", "/admin/calendar", "/admin/calendar?view=week", "/admin/students", "/admin/students/import", `/students/${s!.id}`, "/admin/instructors", `/admin/instructors/${i!.id}`, "/admin/lessons/new", `/lessons/${l!.id}`, "/admin/exams", "/admin/payments", "/admin/reports", "/admin/vehicles", "/admin/team", "/admin/settings", "/admin/billing", "/admin/notifications", "/admin/whatsapp", "/admin/support", "/account"])
    rows.push(await check(page, p, "portal-ar"));
  expect(problems(rows)).toEqual([]);
});
