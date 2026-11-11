import { describe, expect, it } from "vitest";
import { readableOn } from "@/lib/color";
import { flashUrl } from "@/lib/flash";

process.env.SESSION_SECRET ??= "unit-test-secret-unit-test-secret-1234";
import { journalCsv, type JournalRow } from "@/server/services/bookkeeping";
import { mileageTotals } from "@/server/services/mileage";

describe("school colour", () => {
  it("picks black text on light colours and white text on dark ones", () => {
    expect(readableOn("#f5b000")).toBe("#16181d");
    expect(readableOn("#ffffff")).toBe("#16181d");
    expect(readableOn("#1a237e")).toBe("#ffffff");
    expect(readableOn("#00897b")).toBe("#ffffff");
  });
});

describe("banner after saving", () => {
  it("keeps the #section of the page", () => {
    expect(flashUrl("/admin/settings#brand", "ok", "Saved")).toMatch(/^\/admin\/settings\?ok=Saved&fs=[^#]+#brand$/);
  });
});

describe("mileage totals", () => {
  it("adds up per kind of trip", () => {
    expect(mileageTotals([{ km: 10, purpose: "business" }, { km: 5, purpose: "private" }, { km: 7, purpose: "business" }])).toEqual({ business: 17, commute: 0, private: 5, total: 22 });
  });
});

describe("bookkeeping file", () => {
  const row: JournalRow = {
    invoice_date: "2026-11-02", invoice_number: "2026-0001", customer_number: "S-001", customer_name: "Anna; de Vries", description: "=Driving lesson",
    net_cents: 5000, vat_rate_bps: 2100, vat_cents: 1050, gross_cents: 6050, currency: "EUR", status: "paid", paid_date: "2026-11-03", method: "ideal",
  };
  it("uses semicolons and decimal commas for Dutch programs, and quotes cells that contain a semicolon", () => {
    const line = journalCsv([row], "8000", "nl").split("\r\n")[1];
    expect(line).toBe(`2026-11-02;2026-0001;S-001;"Anna; de Vries";'=Driving lesson;50,00;21;10,50;60,50;EUR;8000;betaald;2026-11-03;ideal`);
  });
});
