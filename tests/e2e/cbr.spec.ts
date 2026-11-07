import { expect, test } from "@playwright/test";
import { errorBanner, login, okBanner, sql } from "./helpers";

/** The school notes a CBR exam on the student's profile; it shows in the exam overview and in the student app. */
test("school records a CBR exam; overview and student app show it with the CBR checklist", async ({ page, browser }) => {
  const [s] = await sql<{ id: string; email: string; first_name: string }>(
    `SELECT s.id, s.email, s.first_name FROM students s JOIN users u ON u.id = s.user_id AND u.status = 'active' WHERE s.email <> 'bram@abc.test' ORDER BY s.created_at LIMIT 1`,
  );
  await login(page, "owner@abc.test");
  await page.goto(`/students/${s!.id}`);
  await expect(page.locator("#cbr")).toContainText("Health declaration not yet approved");

  // Checklist: theory passed, health approved, school authorised.
  await page.locator("#cbr details.small summary").click();
  await page.locator('select[name="health"]').selectOption("approved");
  await page.locator("#cbr form").first().locator("button[type=submit]").click();
  await expect(okBanner(page)).toBeVisible();
  await expect(page.locator("#cbr")).toContainText("Health declaration approved");

  // A reserved practical exam in 6 weeks.
  const day = new Date(Date.now() + 42 * 86_400_000).toISOString().slice(0, 10);
  await page.locator("#cbr summary.btn").click();
  const form = page.locator("#cbr details:has(> summary.btn) form");
  await form.locator('input[name="examAt"]').evaluate((el, v) => ((el as HTMLInputElement).value = v), `${day}T09:30`);
  await form.locator('input[name="location"]').fill("CBR Utrecht");
  await form.locator('input[name="reservationNumber"]').fill("E2E-4711");
  await form.locator("button[type=submit]").click();
  await expect(errorBanner(page)).toHaveCount(0);
  await expect(okBanner(page)).toBeVisible();
  await expect(page.locator("#cbr")).toContainText("CBR Utrecht");

  await page.goto("/admin/exams");
  await expect(page.locator("table").first()).toContainText("E2E-4711");

  const ctx = await browser.newContext();
  const student = await ctx.newPage();
  await login(student, s!.email, "student");
  await student.goto("/student");
  // This student uses the app in Dutch.
  await expect(student.locator("#cbr")).toContainText("Praktijkexamen");
  await expect(student.locator("#cbr")).toContainText("Reservering E2E-4711");
  await expect(student.locator("#cbr")).toContainText("Gezondheidsverklaring goedgekeurd");
  await expect(student.locator('#cbr a[href="https://mijn.cbr.nl"]')).toBeVisible();
  await ctx.close();
});
