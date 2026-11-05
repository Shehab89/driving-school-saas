import { expect, test } from "@playwright/test";
import { errorBanner, login, okBanner, sql } from "./helpers";

/**
 * Lesson topics (multi-select), the student's own review of a lesson, and the
 * school's instructor page with rating and pay.
 */
test("instructor picks several topics, student reviews the lesson, the school sees the rating", async ({ page, browser }) => {
  const [lesson] = await sql<{ id: string; student_email: string; instructor_id: string }>(
    `SELECT l.id, s.email AS student_email, l.instructor_id FROM lessons l JOIN instructors i ON i.id = l.instructor_id JOIN users u ON u.id = i.user_id JOIN students s ON s.id = l.student_id
       JOIN users su ON su.id = s.user_id AND su.status = 'active'
      WHERE u.email = 'john@abc.test' AND l.status IN ('scheduled','confirmed') AND s.email <> 'bram@abc.test' ORDER BY l.start_time DESC LIMIT 1`,
  );
  // Completed lesson two days ago, at night (no collisions).
  await sql(
    `UPDATE lessons SET start_time = date_trunc('day', now()) - interval '44 hours', end_time = date_trunc('day', now()) - interval '43 hours', status = 'completed', completed_at = now() WHERE id = $1`,
    [lesson!.id],
  );

  await login(page, "john@abc.test", "instructor");
  await page.goto(`/instructor/feedback/${lesson!.id}`);
  await page.locator("#tp-covered summary").click();
  const boxes = page.locator('#tp-covered input[name="covered"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.locator("#tp-covered summary .tag")).toHaveCount(2);
  await page.fill("#strengths", "E2E topics: good mirror use");
  await page.locator('label[for="r4"]').click();
  await page.locator("form.fb-card button[type=submit]").click();
  await expect(okBanner(page)).toBeVisible();
  const covered = await sql(`SELECT 1 FROM lesson_topics WHERE lesson_id = $1 AND kind = 'covered'`, [lesson!.id]);
  expect(covered).toHaveLength(2);

  const ctx = await browser.newContext();
  const student = await ctx.newPage();
  await login(student, lesson!.student_email, "student");
  await student.goto(`/student/lessons/${lesson!.id}`);
  await expect(student.getByText("E2E topics: good mirror use")).toBeVisible();
  await expect(student.locator(".tag")).toHaveCount(2);
  await student.locator('label[for="rv5"]').click();
  await student.fill("#comment", "E2E review: very patient");
  await student.locator("button[type=submit]").last().click();
  await expect(okBanner(student)).toBeVisible();
  await ctx.close();

  const owner = await (await browser.newContext()).newPage();
  await login(owner, "owner@abc.test");
  await expect(errorBanner(owner)).toHaveCount(0);
  await owner.goto(`/admin/instructors/${lesson!.instructor_id}`);
  await expect(owner.getByText("E2E review: very patient")).toBeVisible();
  await owner.fill("#rate", "30");
  await owner.locator('form:has(#rate) button[type=submit]').click();
  await expect(okBanner(owner)).toBeVisible();
});
