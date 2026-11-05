import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { NotFoundError } from "@/lib/errors";
import { Flash, StatusBadge, Stars, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader, schoolI18n } from "@/server/school";
import { getPt } from "@/i18n/server";
import { instructorOverview, setHourlyRate } from "@/server/services/instructor-stats";
import { idOr404, num, runAction, str } from "@/server/web";
import { StatTile } from "@/components/charts";

async function rateAction(fd: FormData) {
  "use server";
  const pt = await getPt();
  const id = str(fd, "instructorId");
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    const euros = num(fd, "rate");
    await withTenant(actor.schoolId, (tx) => setHourlyRate(tx, userPrincipal(actor), id, euros === undefined ? null : Math.round(euros * 100)));
  }, { back: `/admin/instructors/${id}`, okMessage: pt("Hourly rate saved") });
}

export default async function InstructorDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idOr404((await params).id);
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("instructors:write");
  const { t, f, pt } = await schoolI18n(actor.schoolId);
  const tz = (await schoolHeader(actor.schoolId)).timezone;
  const d = await withTenant(actor.schoolId, async (tx) => {
    try {
      return await instructorOverview(tx, userPrincipal(actor), id, tz);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!d) notFound();
  const { instructor: i } = d;
  const h = (n: number) => f.number(Math.round(n * 10) / 10);
  return (
    <>
      <p><Link href="/admin/instructors"><span className="flip">←</span> {pt("Instructors")}</Link></p>
      <div className="page-title">
        <div>
          <h1>{i.name} <StatusBadge value={i.status} t={t} /></h1>
          <p>{i.vehicle ?? pt("No usual car")} · <span dir="ltr">{i.email}</span>{i.phone ? <> · <span dir="ltr">{i.phone}</span></> : null}</p>
        </div>
        <div className="actions"><Link className="btn" href={`/instructor/availability?instructor=${i.id}`}>{pt("Edit hours")}</Link></div>
      </div>
      <Flash searchParams={q} />
      <div className="stat-row">
        <StatTile label={pt("Rating from students")} value={d.rating.count ? <>{h(d.rating.avg)} <Stars value={d.rating.avg} /></> : "–"}><span className="sub">{pt("{count} reviews", { count: d.rating.count })}</span></StatTile>
        <StatTile label={pt("Booked this week")} value={pt("{hours}h", { hours: h(d.week.booked) })}><span className="sub">{pt("of {hours}h working hours", { hours: h(d.week.available) })}</span></StatTile>
        <StatTile label={pt("Free this week")} value={pt("{hours}h", { hours: h(d.week.free) })} />
        <StatTile label={pt("Pay this month")} value={d.month.payCents === null ? "–" : f.money(d.month.payCents, i.currency)}><span className="sub">{pt("{hours}h taught in {count} lessons", { hours: h(d.month.hours), count: d.month.lessons })}</span></StatTile>
      </div>
      <div className="grid two">
        <section className="card">
          <h2>{pt("Working hours and free time this week")}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>{pt("Day")}</th><th>{pt("Working hours")}</th><th>{pt("Booked")}</th><th>{pt("Free")}</th></tr></thead>
              <tbody>
                {d.days.map((day) => (
                  <tr key={day.weekday}>
                    <td>{f.weekday(day.weekday)}</td>
                    <td className="num small" dir="ltr">{day.slots.length ? day.slots.map((s) => `${s[0]}–${s[1]}`).join(", ") : <span className="muted">{pt("Day off")}</span>}</td>
                    <td className="num">{day.booked ? pt("{hours}h", { hours: h(day.booked) }) : "–"}</td>
                    <td className="num">{day.available ? pt("{hours}h", { hours: h(Math.max(0, day.available - day.booked)) }) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <h2>{pt("Pay")}</h2>
          <p className="small muted">{pt("What the school pays this instructor per hour taught. Only completed lessons count.")}</p>
          {can(actor.role, "pricing:write") ? (
            <form action={rateAction} className="row">
              <input type="hidden" name="instructorId" value={i.id} />
              <label htmlFor="rate" className="small">{pt("Hourly rate ({currency})", { currency: i.currency })}</label>
              <input id="rate" name="rate" type="number" min={0} max={1000} step="0.01" defaultValue={i.hourly_rate_cents == null ? "" : (i.hourly_rate_cents / 100).toFixed(2)} style={{ width: 120 }} />
              <button type="submit">{pt("Save")}</button>
            </form>
          ) : (
            <p>{i.hourly_rate_cents == null ? pt("Not set") : f.money(i.hourly_rate_cents, i.currency)}</p>
          )}
        </section>
      </div>
      <section className="card">
        <h2>{pt("What students say")}</h2>
        <p className="small muted">{pt("Students rate each lesson in their app. The instructor does not see these reviews.")}</p>
        {d.reviews.length === 0 ? <p className="muted">{pt("No reviews yet.")}</p> : (
          <div>
            {d.reviews.map((r) => (
              <div key={r.lesson_id} className="list-row" style={{ alignItems: "flex-start" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Stars value={r.rating} />
                  {r.comment && <span style={{ display: "block", whiteSpace: "pre-wrap", marginTop: 4 }}>{r.comment}</span>}
                  <span className="sub" style={{ display: "block" }}><Link href={`/students/${r.student_id}`}>{r.student_name}</Link> · {pt("lesson #{number}", { number: r.lesson_number })} · {f.shortDate(r.start_time)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
