import { expect, test } from "@playwright/test";
import { login, okBanner, sql } from "./helpers";

test("a student asks to hear about earlier lesson times", async ({ page }) => {
  await login(page, "priya@abc.test", "student");
  await page.goto("/student/book");
  const card = page.getByTestId("slot-alert");
  await card.getByRole("button", { name: "Notify me" }).click();
  await expect(okBanner(page)).toBeVisible();
  await expect(page.getByTestId("slot-alert").getByRole("button", { name: "Turn off" })).toBeVisible();
  const [s] = await sql<{ earlier_slot_alert: boolean }>(`SELECT earlier_slot_alert FROM students WHERE email = 'priya@abc.test'`);
  expect(s!.earlier_slot_alert).toBe(true);
});

test("an instructor makes a calendar link that calendar apps can read", async ({ page, request }) => {
  await login(page, "john@abc.test", "instructor");
  await page.goto("/instructor/profile");
  await page.getByTestId("calendar-sync").getByRole("button", { name: "Make my calendar link" }).click();
  await expect(okBanner(page)).toBeVisible();
  const url = await page.getByTestId("calendar-feed-url").inputValue();
  expect(url).toMatch(/\/api\/calendar\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{32}\.ics$/);
  // No cookie needed: the link itself is the key.
  const res = await request.get(new URL(url).pathname, { headers: { cookie: "" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/calendar");
  expect(await res.text()).toContain("BEGIN:VEVENT");
  // A new link replaces the old one.
  await page.getByTestId("calendar-sync").getByRole("button", { name: "New link" }).click();
  await expect(page.getByTestId("calendar-feed-url")).not.toHaveValue(url);
  expect((await request.get(new URL(url).pathname)).status()).toBe(404);
});

test("an instructor sees which students have no next lesson and plans one", async ({ page }) => {
  await login(page, "john@abc.test", "instructor");
  await page.goto("/instructor/students?show=unplanned");
  const list = page.getByTestId("unplanned-list");
  await expect(list).toBeVisible();
  const plan = list.getByRole("link", { name: "Plan" }).first();
  if (await plan.count()) {
    await plan.click();
    await expect(page).toHaveURL(/\/instructor\/lessons\/new\?student=/);
  }
});
