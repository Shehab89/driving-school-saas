import { expect, test } from "@playwright/test";
import { errorBanner, linkFromMail, login, okBanner, sql } from "./helpers";

test("the office adds a student and records a cash payment", async ({ page }) => {
  await login(page, "owner@abc.test");
  await expect(page).toHaveURL(/\/admin/);
  await page.goto("/admin/students");
  await page.locator("summary", { hasText: "Add student" }).click();
  const email = `e2e-${Date.now()}@example.com`;
  await page.fill("input[name=firstName]", "Eva");
  await page.fill("input[name=lastName]", "Tweede");
  await page.fill("input[name=email]", email);
  await page.locator("form:has(input[name=firstName])").getByRole("button", { name: "Add student" }).click();
  await expect(okBanner(page)).toContainText("Student added");
  expect((await sql(`SELECT 1 FROM students WHERE email = $1`, [email])).length).toBe(1);

  await page.goto("/admin/payments?status=open");
  const row = page.locator("tbody tr", { has: page.getByRole("button", { name: "Mark paid" }) }).first();
  await row.locator("input[name=note]").fill("cash at the desk");
  await row.getByRole("button", { name: "Mark paid" }).click();
  await expect(okBanner(page)).toContainText("Payment recorded");
  const [audit] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'payment.%' AND changes::text LIKE '%cash at the desk%'`);
  expect(audit!.n).toBeGreaterThan(0);
});

test("reports and the accountant CSV are available to the office", async ({ page }) => {
  await login(page, "owner@abc.test");
  await page.goto("/admin/reports");
  await expect(page.getByRole("heading", { name: "Money", exact: true })).toBeVisible();
  const csv = await page.request.get("/api/reports/payments");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect((await csv.text()).split("\r\n")[0]).toBe("date,event,invoice,student_number,billed_to,gross,vat,currency,method,provider_payment_id,reference,status_now");
});

test("one school can never see another school's students", async ({ page }) => {
  const [noord] = await sql<{ id: string }>(`SELECT s.id FROM students s JOIN schools sc ON sc.id = s.school_id WHERE sc.slug = 'noord' LIMIT 1`);
  await login(page, "owner@abc.test");
  await page.goto(`/students/${noord!.id}`);
  await expect(page.getByText(/not found/i)).toBeVisible();
  const r = await page.request.get(`/api/students/${noord!.id}/export`);
  expect(r.status()).toBe(404);
});

test("an instructor completes a lesson with feedback and the student sees it", async ({ page, browser }) => {
  const [lesson] = await sql<{ id: string; student_email: string }>(
    `SELECT l.id, s.email AS student_email FROM lessons l JOIN instructors i ON i.id = l.instructor_id JOIN users u ON u.id = i.user_id JOIN students s ON s.id = l.student_id
       JOIN users su ON su.id = s.user_id AND su.status = 'active'
      -- bram's password is changed by the reset test, so his demo password no longer works.
      WHERE u.email = 'john@abc.test' AND l.status IN ('scheduled','confirmed') AND s.email <> 'bram@abc.test' ORDER BY l.start_time LIMIT 1`,
  );
  // Lessons can only be completed once they have started. Move it into the past at a
  // time of night nobody is booked (02:00-03:00 UTC two days ago), so the move can
  // never collide with another lesson of this instructor, car or student.
  await sql(
    `UPDATE lessons SET start_time = date_trunc('day', now()) - interval '46 hours', end_time = date_trunc('day', now()) - interval '45 hours' WHERE id = $1`,
    [lesson!.id],
  );
  await login(page, "john@abc.test", "instructor");
  const r = await page.request.post(`/api/lessons/${lesson!.id}/complete`, {
    data: { feedback: { strengths: "E2E: smooth roundabouts", nextFocus: "E2E: motorway merging", visibleToStudent: true }, paymentRequired: false },
  });
  expect(r.status()).toBe(200);
  const ctx = await browser.newContext();
  const student = await ctx.newPage();
  await login(student, lesson!.student_email, "student");
  await student.goto("/student/feedback");
  await expect(student.getByText("E2E: smooth roundabouts")).toBeVisible();
  await ctx.close();
});

test("the school cancels a lesson from the calendar pop-up", async ({ page }) => {
  const [lesson] = await sql<{ id: string; day: string }>(
    `SELECT l.id, to_char(l.start_time AT TIME ZONE sc.timezone, 'YYYY-MM-DD') AS day
       FROM lessons l JOIN schools sc ON sc.id = l.school_id
      WHERE sc.slug = 'abc-driving' AND l.status IN ('scheduled','confirmed') AND l.start_time > now() + interval '2 days'
      ORDER BY l.start_time DESC LIMIT 1`,
  );
  await login(page, "owner@abc.test");
  await page.goto(`/admin/calendar?view=day&date=${lesson!.day}`);
  await page.locator(`button[popovertarget="lp-${lesson!.id}"]`).first().click();
  const pop = page.locator(`#lp-${lesson!.id}`);
  await expect(pop.getByRole("link", { name: "Edit" })).toHaveAttribute("href", `/lessons/${lesson!.id}/edit`);
  await pop.getByRole("button", { name: "Cancel lesson" }).click();
  const confirm = page.locator(`#lc-${lesson!.id}`);
  await confirm.locator("textarea[name=reason]").fill("instructor ill");
  await confirm.getByRole("button", { name: "Cancel lesson" }).click();
  await expect(okBanner(page)).toContainText("Lesson cancelled");
  await expect(page).toHaveURL(/\/admin\/calendar\?view=day/);
  const [row] = await sql<{ status: string }>(`SELECT status FROM lessons WHERE id = $1`, [lesson!.id]);
  expect(row!.status).toBe("cancelled");
});

test("an instructor adds time off with the date picker and a time", async ({ page }) => {
  await login(page, "john@abc.test", "instructor");
  await page.goto("/instructor/availability");
  const pick = async (id: string, time: string) => {
    await page.locator(`#${id}`).click();
    const pop = page.locator(".dp-pop:popover-open");
    await pop.locator(".dp-arrow").last().click();
    await pop.locator(".dp-day:not([disabled])").filter({ hasText: /^15$/ }).click();
    await page.locator(`#${id}`).locator("xpath=..").locator("input[type=time]").fill(time);
  };
  await pick("from", "09:00");
  await pick("until", "12:00");
  await page.fill("#reason", "dentist e2e");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(okBanner(page)).toBeVisible();
  const [row] = await sql<{ h: number }>(`SELECT extract(hour FROM ends_at - starts_at)::int AS h FROM instructor_availability_exceptions WHERE reason = 'dentist e2e'`);
  expect(row!.h).toBe(3);
});

test("the school calendar filters apply right away and the day shows one column per instructor", async ({ page }) => {
  await login(page, "owner@abc.test");
  await page.goto("/admin/calendar?view=day");
  expect(await page.locator(".cb-colhead.who").count()).toBeGreaterThan(1);
  await page.locator("select[name=instructor]").selectOption({ index: 1 });
  await expect(page).toHaveURL(/instructor=[0-9a-f-]{36}/);
  await expect(page.locator(".cb-colhead.who")).toHaveCount(0);
});

test("an instructor edits a planned lesson: new time and topics in one go", async ({ page }) => {
  const [lesson] = await sql<{ id: string; day: string; hhmm: string }>(
    `SELECT l.id, to_char(l.start_time AT TIME ZONE sc.timezone, 'YYYY-MM-DD') AS day, to_char(l.start_time AT TIME ZONE sc.timezone, 'HH24:MI') AS hhmm
       FROM lessons l JOIN schools sc ON sc.id = l.school_id JOIN instructors i ON i.id = l.instructor_id
      WHERE i.email = 'john@abc.test' AND l.status IN ('scheduled','confirmed') AND l.start_time > now() + interval '3 days'
      ORDER BY l.start_time ASC LIMIT 1`, // not the latest lesson: other specs pick that one
  );
  await login(page, "john@abc.test", "instructor");
  await page.goto(`/lessons/${lesson!.id}/edit`);
  // An evening time well clear of the usual day plan.
  await page.selectOption("#time", "21:00");
  await page.locator("details:has(.ms-panel) summary").click();
  await page.locator(".ms-panel input[type=checkbox]").nth(0).check();
  await page.locator(".ms-panel input[type=checkbox]").nth(1).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(okBanner(page)).toContainText("Lesson updated");
  const [moved] = await sql<{ id: string; n: number }>(
    `SELECT l.id, (SELECT count(*)::int FROM lesson_topics lt WHERE lt.lesson_id = l.id AND lt.kind = 'planned') AS n
       FROM lessons l WHERE l.rescheduled_from_id = $1`,
    [lesson!.id],
  );
  expect(moved!.n).toBeGreaterThanOrEqual(2);
  await expect(page).toHaveURL(new RegExp(`/lessons/${moved!.id}$|/lessons/${moved!.id}\\?`));
});
