import { expect, type Page } from "@playwright/test";
import pg from "pg";

export const PASSWORD = "demo-password-123";

let clientNo = 0;
export async function login(page: Page, email: string, app: "" | "student" | "instructor" = "", password = PASSWORD) {
  // Each sign-in comes from its own client address, as real users do: the suite signs in more
  // often per minute than the per-IP login limit allows one address (CI runs fast).
  clientNo += 1;
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.77.${Math.floor(clientNo / 250)}.${(clientNo % 250) + 1}` });
  await page.goto(app ? `/login/${app}` : "/login");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("button[type=submit]");
  // Wait until the sign-in finished: either we left the login page or an error is shown.
  await Promise.race([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.locator(".flash.error").waitFor({ timeout: 15_000 }),
  ]);
}

export async function sql<T extends Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.E2E_DB_URL });
  await c.connect();
  try {
    return (await c.query<T>(query, params)).rows;
  } finally {
    await c.end();
  }
}

/** The page never scrolls sideways (mobile layout check). */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/** The app's own error banner (Next.js also renders an empty role=alert route announcer). */
export const errorBanner = (page: Page) => page.locator(".flash.error");
export const okBanner = (page: Page) => page.locator(".flash.ok");

/** Latest link of the given kind in e-mails "sent" by the console e-mail provider (server log). */
export async function linkFromMail(kind: "reset" | "activate", to: string): Promise<string | null> {
  const { readFileSync } = await import("node:fs");
  const log = readFileSync(process.env.E2E_SERVER_LOG!, "utf8");
  const mails = log.split("[email] ").filter((m) => m.startsWith(`to=${to} `));
  const m = mails.at(-1)?.match(new RegExp(`https?://[^\\s]+/${kind}/[A-Za-z0-9_-]+`));
  return m?.[0] ?? null;
}
