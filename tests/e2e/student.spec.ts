import { expect, test } from "@playwright/test";
import { errorBanner, linkFromMail, login, okBanner, sql } from "./helpers";

test("a student books a free time and sees it in their lessons", async ({ page }) => {
  const before = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM lessons l JOIN students s ON s.id = l.student_id WHERE s.email = 'priya@abc.test' AND l.status = 'scheduled'`);
  await login(page, "priya@abc.test", "student");
  await page.goto("/student/book");
  // Find a week with free time (at most 4 weeks ahead).
  for (let i = 0; i < 4 && (await page.locator(".scal-hit input[type=radio]").count()) === 0; i++) {
    await page.getByRole("button", { name: "Next week" }).click();
    await page.waitForTimeout(500);
  }
  const slot = page.locator(".scal-hit input[type=radio]").first();
  await slot.check({ force: true });
  await page.getByRole("button", { name: "Book this time" }).click();
  await expect(page).toHaveURL(/\/student\?ok=/, { timeout: 10_000 });
  const after = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM lessons l JOIN students s ON s.id = l.student_id WHERE s.email = 'priya@abc.test' AND l.status = 'scheduled'`);
  expect(after[0]!.n).toBe(before[0]!.n + 1);
});

test("a student sees their payments, credits and invoices, but not someone else's invoice", async ({ page }) => {
  await login(page, "anna@abc.test", "student");
  await page.goto("/student/payments");
  await expect(page.getByRole("heading", { name: "Betalingen" })).toBeVisible();
  const [foreign] = await sql<{ id: string }>(
    `SELECT i.id FROM invoices i JOIN students s ON s.id = i.student_id WHERE s.email <> 'anna@abc.test' LIMIT 1`,
  );
  await page.goto(`/invoices/${foreign!.id}`);
  await expect(page.getByText("Invoice not found.")).toBeVisible();
});

test("progress report says it is not an official CBR result", async ({ page }) => {
  await login(page, "priya@abc.test", "student");
  await page.goto("/student/profile");
  await page.getByRole("link", { name: "Progress report" }).click();
  await expect(page.getByText(/not an official CBR exam result/)).toBeVisible();
});

test("message preferences are saved", async ({ page }) => {
  await login(page, "priya@abc.test", "student");
  await page.goto("/student/profile");
  await page.locator("input[name=reminders_email]").uncheck();
  await page.locator("form:has(input[name=reminders_email]) button[type=submit]").click();
  await expect(okBanner(page)).toContainText("Message settings saved");
  await expect(page.locator("input[name=reminders_email]")).not.toBeChecked();
});
