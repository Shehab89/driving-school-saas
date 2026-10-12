import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";
import { audit } from "@/server/services/audit";
import { userPrincipal } from "@/server/principal";
import { parseRange, reconciliationRows, toCsv } from "@/server/services/reports";

export const dynamic = "force-dynamic";

/** GET /api/reports/payments?from=&to= — payments and refunds in the period, as CSV for the accountant. */
export async function GET(req: Request) {
  let csv: string | null = null;
  let name = "";
  const err = await jsonRoute(async () => {
    const actor = await requireSchoolActor("payments:read_all");
    const school = await schoolHeader(actor.schoolId);
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined, school.timezone);
    const rows = await withTenant(actor.schoolId, async (tx) => {
      await audit(tx, userPrincipal(actor), "report.payments_exported", "school", actor.schoolId, { from: range.from, to: range.to });
      return reconciliationRows(tx, range);
    });
    csv = toCsv(
      ["date", "event", "invoice", "student_number", "billed_to", "gross", "vat", "currency", "method", "provider_payment_id", "reference", "status_now"],
      rows.map((r) => [
        r.at.toISOString(), r.event, r.invoice_number, r.student_number, r.bill_to, (r.gross_cents / 100).toFixed(2), (r.vat_cents / 100).toFixed(2),
        r.currency, r.method, r.provider_payment_id, r.reference, r.status_now,
      ]),
    );
    name = `payments-${range.from}-${range.to}.csv`;
    return {};
  });
  if (csv === null) return err;
  return new NextResponse(csv as string, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}
