import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, login } from "./helpers";

for (const path of ["/student", "/student/lessons", "/student/book", "/student/payments", "/student/profile"]) {
  test(`student app fits a phone screen: ${path}`, async ({ page }) => {
    await login(page, "anna@abc.test", "student");
    await page.goto(path);
    await expect(page.locator("main, body").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}

test("instructor app fits a phone screen", async ({ page }) => {
  await login(page, "john@abc.test", "instructor");
  await expect(page).toHaveURL(/\/instructor/);
  await expectNoHorizontalScroll(page);
});
