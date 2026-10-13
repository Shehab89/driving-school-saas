import { expect, test } from "@playwright/test";
import { errorBanner, linkFromMail, login, okBanner, sql } from "./helpers";

test("wrong password is refused without saying whether the account exists", async ({ page }) => {
  await login(page, "priya@abc.test", "student", "not-the-password");
  await expect(errorBanner(page)).toBeVisible();
  await expect(page).toHaveURL(/\/login\/student/);
  const known = await errorBanner(page).textContent();
  await login(page, "nobody-here@abc.test", "student", "not-the-password");
  expect(await errorBanner(page).textContent()).toBe(known);
});

test("pages need a session, and roles stay in their own area", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/);
  await login(page, "priya@abc.test", "student");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/admin/payments");
  await expect(page).not.toHaveURL(/\/admin\/payments/);
});

test("responses carry a nonce-based CSP and no framing", async ({ request }) => {
  const r = await request.get("/login");
  const csp = r.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src[^;]*'nonce-/);
  expect(csp).toMatch(/frame-ancestors 'none'/);
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
});

test("forgot password: link by e-mail, new password works, old one does not", async ({ page }) => {
  await page.goto("/forgot");
  await page.fill("#email", "bram@abc.test");
  await page.click("button[type=submit]");
  await expect(okBanner(page)).toBeVisible();
  // Read the link from the e-mail (the console e-mail provider writes it to the server log).
  await expect.poll(() => linkFromMail("reset", "bram@abc.test")).not.toBeNull();
  const resetUrl = (await linkFromMail("reset", "bram@abc.test"))!;
  await page.goto(new URL(resetUrl).pathname);
  await page.fill("#password", "brand-new-password-1");
  await page.fill("#confirm", "brand-new-password-1");
  await page.click("button[type=submit]");
  await login(page, "bram@abc.test", "student");
  await expect(errorBanner(page)).toBeVisible();
  await login(page, "bram@abc.test", "student", "brand-new-password-1");
  await expect(page).toHaveURL(/\/student$/);
  // The link works only once.
  await page.goto(new URL(resetUrl).pathname);
  await expect(page.locator("#password")).toHaveCount(0);
});
