import { expect, test } from "@playwright/test";
import { login, okBanner, sql } from "./helpers";

test("an instructor writes down a trip and downloads the mileage log", async ({ page }) => {
  await login(page, "john@abc.test", "instructor");
  await page.goto("/instructor/mileage");
  const form = page.getByTestId("mileage-form");
  const start = 20000 + Math.floor(Math.random() * 100000) * 10;
  await form.getByLabel("Odometer at start (km)").fill(String(start));
  await form.getByLabel("Odometer at end (km)").fill(String(start + 42));
  await form.getByLabel("Note (optional)").fill("Lessons");
  await form.getByRole("button", { name: "Save trip" }).click();
  await expect(okBanner(page)).toContainText("42 km");
  await expect(page.getByTestId("mileage-row").first()).toContainText("42 km");
  const res = await page.request.get("/api/reports/mileage");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain(`${start},${start + 42},42`);
});

test("the owner messages the students with a lesson soon", async ({ page }) => {
  await login(page, "owner@abc.test");
  await page.goto("/admin/messages");
  await page.getByLabel("Title").fill("Closed because of snow");
  await page.getByLabel("Message").fill("No lessons today. We will call you to plan a new time.");
  await page.getByLabel("All active students").check();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(okBanner(page)).toContainText("Sent to");
  const rows = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE type = 'announcement'`);
  expect(rows[0]!.n).toBeGreaterThan(0);
});

test("the owner picks the school colour; the students' app shows it; bookkeeping files download", async ({ page, browser }) => {
  await login(page, "owner@abc.test");
  await page.goto("/admin/settings#brand");
  await page.locator('#brand input[name="color"][value="#00897b"]').check({ force: true });
  await page.getByRole("button", { name: "Save logo and colour" }).click();
  await expect(okBanner(page)).toBeVisible();
  const journal = await page.request.get("/api/reports/bookkeeping?kind=journal");
  expect(journal.status()).toBe(200);
  expect(await journal.text()).toContain("Factuurdatum;Factuurnummer");

  const ctx = await browser.newContext();
  const student = await ctx.newPage();
  await login(student, "anna@abc.test", "student");
  const accent = await student.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).toBe("#00897b");
  await ctx.close();
  await sql(`UPDATE schools SET brand_color = NULL WHERE brand_color = '#00897b'`);
});
