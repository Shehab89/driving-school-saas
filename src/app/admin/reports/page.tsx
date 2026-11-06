import { withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { instructorUtilisation, lessonSummary, parseRange, revenueSummary, studentSummary } from "@/server/services/reports";
import { DateField } from "@/components/date-field";
import { dateFieldLabels } from "@/components/date-field-labels";

export const metadata = { title: "Reports" };

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("payments:read_all");
  const { school, f, pt, t, locale } = await schoolI18n(actor.schoolId);
  let range;
  let error: string | null = null;
  try {
    range = parseRange(q.from, q.to, school.timezone);
  } catch (e) {
    error = pt("Please choose a valid period (at most a year).");
    range = parseRange(undefined, undefined, school.timezone);
  }
  const d = await withTenant(actor.schoolId, async (tx) => ({
    lessons: (await lessonSummary(tx, range))!,
    instructors: await instructorUtilisation(tx, range),
    revenue: await revenueSummary(tx, range),
    students: (await studentSummary(tx, range))!,
  }));
  const money = (c: number) => f.money(c, school.currency);
  const r = d.revenue;
  const h = (n: number) => f.number(n);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Reports")}</h1>
          <p>{pt("Income, lessons and students for a period you choose.")}</p>
        </div>
      </div>
      <Flash searchParams={q} />
      {error && <div className="flash error" role="alert">{error}</div>}
      <form className="filters card" style={{ padding: 14 }}>
        <div className="field"><label htmlFor="from">{pt("From")}</label><DateField id="from" name="from" defaultValue={range.from} locale={locale} labels={dateFieldLabels(t)} /></div>
        <div className="field"><label htmlFor="to">{pt("Until")}</label><DateField id="to" name="to" defaultValue={range.to} locale={locale} labels={dateFieldLabels(t)} /></div>
        <button className="primary">{pt("Show")}</button>
        <a className="btn" href={`/api/reports/payments?from=${range.from}&to=${range.to}`}>{pt("Download payments for the accountant (CSV)")}</a>
      </form>

      <h2 className="section-title">{pt("Money")}</h2>
      <div className="grid four stat-grid">
        <Stat label={pt("Received")} value={money(r.gross_cents)} hint={pt("{count} payments · VAT {vat}", { count: r.payments, vat: money(r.vat_cents) })} />
        <Stat label={pt("Refunded")} value={money(r.refunded_cents)} hint={pt("{count} refunds", { count: r.refunds })} />
        <Stat label={pt("Net received")} value={money(r.net_cents)} hint={pt("online {online} · cash/bank {manual}", { online: money(r.online_cents), manual: money(r.manual_cents) })} />
        <Stat label={pt("Still to receive (today)")} value={money(r.open_cents + r.overdue_cents)} hint={pt("overdue {amount}", { amount: money(r.overdue_cents) }) + (r.disputed_cents ? ` · ${pt("disputed {amount}", { amount: money(r.disputed_cents) })}` : "")} />
      </div>
      <p className="small muted">
        {pt("Only payments confirmed by the payment provider or recorded by staff are counted, on the day they were paid. Prepaid lessons not used yet: {count}. This overview helps you follow your income; your accountant remains responsible for the VAT return.", { count: r.prepaid_lessons_outstanding })}
      </p>

      <h2 className="section-title">{pt("Lessons")}</h2>
      <div className="grid four stat-grid">
        <Stat label={pt("Given")} value={d.lessons.completed} hint={pt("{hours} hours driven", { hours: h(d.lessons.hours_driven) })} />
        <Stat label={pt("Students taught")} value={d.lessons.students_taught} />
        <Stat label={pt("Did not show up")} value={d.lessons.no_show} hint={pt("{count} cancelled", { count: d.lessons.cancelled })} />
        <Stat label={pt("Still planned")} value={d.lessons.planned} />
      </div>

      <section className="card table-card">
        <h2>{pt("How busy the instructors were")}</h2>
        <div className="table-wrap">
        <table className="stack-table">
          <thead><tr><th>{pt("Instructor")}</th><th>{pt("Available (hours)")}</th><th>{pt("Booked (hours)")}</th><th>{pt("Given (hours)")}</th><th>{pt("Booked share")}</th></tr></thead>
          <tbody>
            {d.instructors.map((i) => (
              <tr key={i.id}>
                <td data-label={pt("Instructor")}><strong>{i.name}</strong></td>
                <td data-label={pt("Available (hours)")} className="num">{i.available_hours}</td>
                <td data-label={pt("Booked (hours)")} className="num">{i.booked_hours}</td>
                <td data-label={pt("Given (hours)")} className="num">{i.completed_hours}</td>
                <td data-label={pt("Booked share")}>{i.utilisation === null ? <span className="muted small">{pt("no working hours set")}</span> : <span className="util"><span className="progress"><span style={{ width: `${Math.min(100, i.utilisation)}%` }} /></span> {i.utilisation}%</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="small muted" style={{ padding: "0 18px 14px" }}>{pt("Booked hours include planned, given and no-show lessons. Available hours come from the instructors' working hours and time off.")}</p>
      </section>

      <h2 className="section-title">{pt("Students")}</h2>
      <div className="grid four stat-grid">
        <Stat label={pt("New in this period")} value={d.students.new_students} />
        <Stat label={pt("Active now")} value={d.students.active} />
        <Stat label={pt("Sign-ups to follow up")} value={d.students.leads} />
        <Stat label={pt("Finished")} value={d.students.completed} />
      </div>
    </>
  );
}
