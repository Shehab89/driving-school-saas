import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, many, one, withPlatform, withTenant } from "@/lib/db";
import { bookLesson, completeLesson } from "@/server/services/lessons";
import { addMileage, deleteMileage, listMileage, mileageScope, mileageSuggestion, mileageTotals } from "@/server/services/mileage";
import { audienceCounts, MAX_ANNOUNCEMENTS_PER_DAY, sendAnnouncement } from "@/server/services/announcements";
import { loadLogo, removeLogo, setBrandColor, setLogo } from "@/server/services/branding";
import { customersCsv, journalCsv, journalCustomers, salesJournal } from "@/server/services/bookkeeping";
import { parseRange } from "@/server/services/reports";
import { renderEmail } from "@/server/email/templates";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
const TZ = "Europe/Amsterdam";
const today = () => DateTime.now().setZone(TZ).toISODate()!;
const daysAgo = (n: number) => DateTime.now().setZone(TZ).minus({ days: n }).toISODate()!;

beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

describe("mileage log", () => {
  it("an instructor writes down trips; the next trip starts where the last one ended", async () => {
    const me = asUser(f.instructorActor);
    const r = await withTenant(f.schoolId, (tx) =>
      addMileage(tx, me, { date: daysAgo(2), vehicleId: f.vehicleId, startKm: 10000, endKm: 10085, fromPlace: "Home", toPlace: "School", purpose: "business" }, TZ),
    );
    expect(r.km).toBe(85);
    await withTenant(f.schoolId, (tx) => addMileage(tx, me, { date: daysAgo(1), vehicleId: f.vehicleId, startKm: 10085, endKm: 10097, purpose: "private" }, TZ));
    const hint = await withTenant(f.schoolId, (tx) => mileageSuggestion(tx, f.instructorId, today(), TZ));
    expect(hint).toMatchObject({ vehicleId: f.vehicleId, startKm: 10097 });
    const rows = await withTenant(f.schoolId, (tx) => listMileage(tx, f.instructorId, daysAgo(10), today()));
    expect(mileageTotals(rows)).toEqual({ business: 85, commute: 0, private: 12, total: 97 });
  });

  it("refuses kilometres written down twice, readings going backwards and trips in the future", async () => {
    const me = asUser(f.instructorActor);
    await expect(withTenant(f.schoolId, (tx) => addMileage(tx, me, { date: today(), vehicleId: f.vehicleId, startKm: 10050, endKm: 10120 }, TZ))).rejects.toMatchObject({ code: "mileage_overlap" });
    await expect(withTenant(f.schoolId, (tx) => addMileage(tx, me, { date: today(), startKm: 500, endKm: 400 }, TZ))).rejects.toMatchObject({ code: "mileage_backwards" });
    const tomorrow = DateTime.now().setZone(TZ).plus({ days: 2 }).toISODate()!;
    await expect(withTenant(f.schoolId, (tx) => addMileage(tx, me, { date: tomorrow, startKm: 1, endKm: 2 }, TZ))).rejects.toMatchObject({ code: "mileage_future" });
  });

  it("only the instructor can change their log; the owner can read everyone's, a student nothing", async () => {
    const [row] = await withTenant(f.schoolId, (tx) => listMileage(tx, f.instructorId, daysAgo(10), today()));
    await expect(withTenant(f.schoolId, (tx) => deleteMileage(tx, f.owner, row!.id))).rejects.toMatchObject({ code: "forbidden" });
    expect(mileageScope(f.owner, null)).toBeNull();
    expect(mileageScope(asUser(f.instructorActor), null)).toBe(f.instructorId);
    expect(() => mileageScope(asUser(f.instructorActor), "00000000-0000-4000-8000-000000000000")).toThrow();
    expect(() => mileageScope(asUser(f.studentActor), null)).toThrow();
    await withTenant(f.schoolId, (tx) => deleteMileage(tx, asUser(f.instructorActor), row!.id));
  });

  it("another school cannot see the trips", async () => {
    const other = await createFixture();
    const rows = await withTenant(other.schoolId, (tx) => many(tx, `SELECT 1 FROM mileage_entries`));
    expect(rows).toEqual([]);
  });
});

describe("message all students", () => {
  it("goes to the students with a lesson in the next days, on their own channel", async () => {
    await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 1, 10), bookedVia: "staff" }));
    const counts = await withTenant(f.schoolId, (tx) => audienceCounts(tx, 2));
    expect(counts.upcoming).toBe(1);
    const r = await withTenant(f.schoolId, (tx) =>
      sendAnnouncement(tx, f.owner, { audience: "upcoming", days: 2, subject: "Closed because of snow", body: "No lessons today.\n\nWe will call you." }),
    );
    expect(r.recipients).toBe(1);
    const sent = await withPlatform((tx) =>
      many<{ recipient_student_id: string; payload: { subject: string } }>(tx, `SELECT recipient_student_id, payload FROM notifications WHERE school_id = $1 AND type = 'announcement'`, [f.schoolId]),
    );
    expect(sent).toEqual([expect.objectContaining({ recipient_student_id: f.studentId, payload: expect.objectContaining({ subject: "Closed because of snow" }) })]);
  });

  it("an instructor without office rights cannot send it, and a school can send at most a few a day", async () => {
    await expect(withTenant(f.schoolId, (tx) => sendAnnouncement(tx, asUser(f.instructorActor), { audience: "all", subject: "x", body: "y" }))).rejects.toMatchObject({ code: "forbidden" });
    for (let i = 1; i < MAX_ANNOUNCEMENTS_PER_DAY; i++) {
      await withTenant(f.schoolId, (tx) => sendAnnouncement(tx, f.owner, { audience: "all", subject: `News ${i}`, body: "Hello" }));
    }
    await expect(withTenant(f.schoolId, (tx) => sendAnnouncement(tx, f.owner, { audience: "all", subject: "One too many", body: "Hello" }))).rejects.toMatchObject({ code: "announcement_limit" });
  });

  it("the e-mail keeps the paragraphs", () => {
    const school = { name: "Rijschool Test", timezone: TZ, currency: "EUR", locale: "en", email: null, phone: null, address: null };
    const m = renderEmail("announcement", { name: "Anna", subject: "Closed", body: "First.\n\nSecond <b>." }, school);
    expect(m.subject).toBe("Closed – Rijschool Test");
    expect(m.html).toContain("Second &lt;b&gt;.");
    expect(m.text).toContain("Hi Anna,");
  });
});

describe("logo and colour", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it("the owner sets a colour and a logo; others cannot", async () => {
    expect(await withTenant(f.schoolId, (tx) => setBrandColor(tx, f.owner, "1E88E5"))).toBe("#1e88e5");
    expect(await withTenant(f.schoolId, (tx) => setBrandColor(tx, f.owner, "#abc"))).toBe("#aabbcc");
    await expect(withTenant(f.schoolId, (tx) => setBrandColor(tx, f.owner, "blue"))).rejects.toMatchObject({ code: "brand_color_invalid" });
    await expect(withTenant(f.schoolId, (tx) => setBrandColor(tx, asUser(f.instructorActor), "#000000"))).rejects.toMatchObject({ code: "forbidden" });

    await expect(withTenant(f.schoolId, (tx) => setLogo(tx, f.owner, new TextEncoder().encode("<svg onload=alert(1)>")))).rejects.toMatchObject({ code: "logo_type" });
    await withTenant(f.schoolId, (tx) => setLogo(tx, f.owner, png));
    expect((await loadLogo(f.schoolId))?.content_type).toBe("image/png");
    expect(await loadLogo("not-a-uuid")).toBeNull();
    await withTenant(f.schoolId, (tx) => removeLogo(tx, f.owner));
    expect(await loadLogo(f.schoolId)).toBeNull();
  });

  it("e-mail buttons use the school colour with readable text", () => {
    const base = { name: "S", timezone: TZ, currency: "EUR", locale: "en", email: null, phone: null, address: null };
    const dark = renderEmail("password_changed", {}, { ...base, brand_color: "#16181d", logo_url: "https://example.com/logo.png" });
    expect(dark.html).toContain('<img src="https://example.com/logo.png"');
    const welcome = renderEmail("student_welcome", { name: "A", activation_url: "https://x" }, { ...base, brand_color: "#f5b000" });
    expect(welcome.html).toContain("background:#f5b000;color:#16181d");
    const navy = renderEmail("student_welcome", { name: "A", activation_url: "https://x" }, { ...base, brand_color: "#1a237e" });
    expect(navy.html).toContain("background:#1a237e;color:#ffffff");
  });
});

describe("bookkeeping export", () => {
  it("lists each invoice once, with Dutch decimals, and the customers to import first", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 25, 9), bookedVia: "staff" }));
    const start = DateTime.now().minus({ days: 1 }).startOf("hour");
    await setLessonTime(f, lesson.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
    await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, lesson.id));
    const inv = await withTenant(f.schoolId, (tx) => one<{ invoice_number: string; total_cents: number }>(tx, `SELECT invoice_number, total_cents FROM invoices ORDER BY issued_at DESC LIMIT 1`));
    const range = parseRange(daysAgo(3), today(), TZ);
    const { rows, customers } = await withTenant(f.schoolId, async (tx) => ({ rows: await salesJournal(tx, range), customers: await journalCustomers(tx, range) }));
    expect(rows.map((r) => r.invoice_number)).toEqual([inv!.invoice_number]);
    const nl = journalCsv(rows, "8000", "nl");
    expect(nl.startsWith("﻿Factuurdatum;Factuurnummer;")).toBe(true);
    expect(nl).toContain(`;${(inv!.total_cents / 100).toFixed(2).replace(".", ",")};EUR;8000;`);
    expect(journalCsv(rows, "8000", "en").split("\r\n")[0]).toBe("invoice_date,invoice_number,customer_number,customer_name,description,net,vat_rate,vat,gross,currency,revenue_account,status,paid_date,payment_method");
    expect(customers).toHaveLength(1);
    expect(customersCsv(customers, "nl")).toContain("Relatiecode;Naam;E-mail");
  });
});
