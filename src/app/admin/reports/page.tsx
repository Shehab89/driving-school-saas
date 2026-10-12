import { withTenant } from "@/lib/db";
import { formatMoney } from "@/lib/time";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";
import { instructorUtilisation, lessonSummary, parseRange, revenueSummary, studentSummary } from "@/server/services/reports";

export const metadata = { title: "Reports" };

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("payments:read_all");
  const school = await schoolHeader(actor.schoolId);
  let range;
  let error: string | null = null;
  try {
    range = parseRange(q.from, q.to, school.timezone);
  } catch (e) {
    error = (e as Error).message;
    range = parseRange(undefined, undefined, school.timezone);
  }
  const d = await withTenant(actor.schoolId, async (tx) => ({
    lessons: (await lessonSummary(tx, range))!,
    instructors: await instructorUtilisation(tx, range),
    revenue: await revenueSummary(tx, range),
    students: (await studentSummary(tx, range))!,
  }));
  const money = (c: number) => formatMoney(c, school.currency, school.locale);
  const r = d.revenue;
  return (
    <>
      <h1>Reports</h1>
      <Flash searchParams={error ? { ...q, error } : q} />
      <form className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="from" className="small">From</label>
        <input id="from" name="from" type="date" defaultValue={range.from} style={{ width: 170 }} />
        <label htmlFor="to" className="small">to</label>
        <input id="to" name="to" type="date" defaultValue={range.to} style={{ width: 170 }} />
        <button>Show</button>
        <a className="btn" href={`/api/reports/payments?from=${range.from}&to=${range.to}`}>Download payments CSV</a>
      </form>

      <h2>Money received</h2>
      <div className="grid four" style={{ gap: 12, marginBottom: 16 }}>
        <Stat label="Received" value={money(r.gross_cents)} hint={`${r.payments} payments · VAT ${money(r.vat_cents)}`} />
        <Stat label="Refunded" value={money(r.refunded_cents)} hint={`${r.refunds} refunds`} />
        <Stat label="Net received" value={money(r.net_cents)} hint={`online ${money(r.online_cents)} · cash/bank ${money(r.manual_cents)}`} />
        <Stat label="Still to receive (today)" value={money(r.open_cents + r.overdue_cents)} hint={`overdue ${money(r.overdue_cents)}${r.disputed_cents ? ` · disputed ${money(r.disputed_cents)}` : ""}`} />
      </div>
      <p className="small muted">
        Only payments confirmed by the payment provider or recorded by staff are counted, on the day they were paid. Prepaid lessons not yet used: {r.prepaid_lessons_outstanding}.
        This overview helps you follow your income; your accountant remains responsible for the VAT return.
      </p>

      <h2>Lessons</h2>
      <div className="grid four" style={{ gap: 12, marginBottom: 16 }}>
        <Stat label="Completed" value={d.lessons.completed} hint={`${d.lessons.hours_driven} hours driven`} />
        <Stat label="Students taught" value={d.lessons.students_taught} />
        <Stat label="No-shows" value={d.lessons.no_show} hint={`${d.lessons.cancelled} cancelled`} />
        <Stat label="Still planned" value={d.lessons.planned} />
      </div>

      <section className="card table-wrap">
        <h2>Instructor utilisation</h2>
        <table>
          <thead><tr><th>Instructor</th><th>Available (h)</th><th>Booked (h)</th><th>Completed (h)</th><th>Utilisation</th></tr></thead>
          <tbody>
            {d.instructors.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td>{i.available_hours}</td>
                <td>{i.booked_hours}</td>
                <td>{i.completed_hours}</td>
                <td>{i.utilisation === null ? <span className="muted small">no availability set</span> : `${i.utilisation}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Booked hours include planned, completed and no-show lessons. Available hours come from the instructors&apos; availability and time off.</p>
      </section>

      <h2>Students</h2>
      <div className="grid four" style={{ gap: 12, marginBottom: 16 }}>
        <Stat label="New in period" value={d.students.new_students} />
        <Stat label="Active now" value={d.students.active} />
        <Stat label="Leads" value={d.students.leads} />
        <Stat label="Finished" value={d.students.completed} />
      </div>
    </>
  );
}
