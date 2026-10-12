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
  await expect(okBanner(page)).toContainText("Student created");
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
  await expect(page.getByRole("heading", { name: "Money received" })).toBeVisible();
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
  // Lessons can only be completed once they have started.
  await sql(`UPDATE lessons SET start_time = now() - interval '2 hours', end_time = now() - interval '1 hour' WHERE id = $1`, [lesson!.id]);
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
