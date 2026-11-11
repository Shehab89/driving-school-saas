import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";
import { userPrincipal } from "@/server/principal";
import { audit } from "@/server/services/audit";
import { listMileage, mileageScope } from "@/server/services/mileage";
import { parseRange, toCsv } from "@/server/services/reports";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/mileage?from=&to=[&instructor=] — the mileage log as CSV
 * (kilometerregistratie). An instructor gets their own trips; the school
 * owner or office can get everyone's, or one instructor's.
 */
export async function GET(req: Request) {
  let csv: string | null = null;
  let name = "";
  const err = await jsonRoute(async () => {
    const actor = await requireSchoolActor("lessons:operate_own");
    const school = await schoolHeader(actor.schoolId);
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined, school.timezone);
    const rows = await withTenant(actor.schoolId, async (tx) => {
      const p = userPrincipal(actor);
      const scope = mileageScope(p, url.searchParams.get("instructor") || null);
      await audit(tx, p, "report.mileage_exported", "school", actor.schoolId, { from: range.from, to: range.to, instructor: scope });
      return listMileage(tx, scope, range.from, range.to);
    });
    const ordered = [...rows].reverse(); // oldest first, as on paper
    csv = toCsv(
      ["date", "instructor", "vehicle", "registration", "start_km", "end_km", "km", "from", "to", "purpose", "note"],
      ordered.map((r) => [r.trip_date, r.instructor, r.vehicle, r.registration_number, r.start_km, r.end_km, r.km, r.from_place, r.to_place, r.purpose, r.note]),
    );
    name = `mileage-${range.from}-${range.to}.csv`;
    return {};
  });
  if (csv === null) return err;
  return new NextResponse(csv as string, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}
