import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";
import { audit } from "@/server/services/audit";
import { userPrincipal } from "@/server/principal";
import { parseRange } from "@/server/services/reports";
import { customersCsv, journalCsv, journalCustomers, revenueAccount, salesJournal, type JournalFormat } from "@/server/services/bookkeeping";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/bookkeeping?from=&to=&kind=journal|customers&format=nl|en
 * Sales journal (one line per invoice) or customer list, to import into
 * Moneybird, e-Boekhouden, Exact or a spreadsheet.
 */
export async function GET(req: Request) {
  let body: string | null = null;
  let name = "";
  const err = await jsonRoute(async () => {
    const actor = await requireSchoolActor("payments:read_all");
    const school = await schoolHeader(actor.schoolId);
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined, school.timezone);
    const kind = url.searchParams.get("kind") === "customers" ? "customers" : "journal";
    const format: JournalFormat = url.searchParams.get("format") === "en" ? "en" : "nl";
    body = await withTenant(actor.schoolId, async (tx) => {
      await audit(tx, userPrincipal(actor), "report.bookkeeping_exported", "school", actor.schoolId, { from: range.from, to: range.to, kind, format });
      return kind === "customers"
        ? customersCsv(await journalCustomers(tx, range), format)
        : journalCsv(await salesJournal(tx, range), await revenueAccount(tx), format);
    });
    name = `${kind === "customers" ? (format === "nl" ? "relaties" : "customers") : format === "nl" ? "verkoopboek" : "sales-journal"}-${range.from}-${range.to}.csv`;
    return {};
  });
  if (body === null) return err;
  return new NextResponse(body as string, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}
