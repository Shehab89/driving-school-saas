import Link from "next/link";
import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { schoolCbrOverview } from "@/server/services/cbr";
import { cbrLabels, cbrTone } from "@/components/cbr-labels";
import { checkText } from "@/components/cbr-panel";
import { CBR_LINKS, cancelDeadline, cbrChecklist } from "@/lib/cbr";

export const metadata = { title: "CBR exams" };

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}

export default async function ExamsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:read_all");
  const { f, pt } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, (tx) => schoolCbrOverview(tx, userPrincipal(actor)));
  const L = cbrLabels(pt);
  const now = new Date();
  const soon = d.open.filter((e) => e.exam_at && e.exam_at > now && e.exam_at.getTime() - now.getTime() < 14 * 86_400_000).length;
  const toReserve = d.open.filter((e) => e.status === "to_reserve").length;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("CBR exams")}</h1>
          <p>{pt("All reserved exams, what is still missing, and the results.")}</p>
        </div>
        <div className="row">
          <a className="btn" href={CBR_LINKS.rulesForSchools} target="_blank" rel="noopener noreferrer">{pt("CBR rules")} ↗</a>
          <a className="btn primary" href={CBR_LINKS.schoolPortal} target="_blank" rel="noopener noreferrer">{pt("Open CBR portal")} ↗</a>
        </div>
      </div>
      <Flash searchParams={q} />
      <div className="grid four stat-grid">
        <Stat label={pt("Open exams")} value={d.open.length} />
        <Stat label={pt("In the next 14 days")} value={soon} />
        <Stat label={pt("Still to reserve")} value={toReserve} />
        <Stat
          label={pt("Pass rate (practical, 12 months)")}
          value={d.pass.rate === null ? "—" : `${Math.round(d.pass.rate * 100)}%`}
          hint={d.pass.taken ? pt("{passed} of {taken} passed", { passed: d.pass.passed, taken: d.pass.taken }) : undefined}
        />
      </div>

      <section className="card">
        <h2>{pt("Coming up")}</h2>
        {d.open.length === 0 ? (
          <p className="muted">{pt("No open exams. Add one from the student's profile.")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{pt("Student")}</th><th>{pt("Exam")}</th><th>{pt("Date and time")}</th><th>{pt("Status")}</th><th>{pt("Still needed")}</th></tr></thead>
              <tbody>
                {d.open.map((e) => {
                  const missing = cbrChecklist({ theoryPassedOn: e.cbr_theory_passed_on, health: e.cbr_health_status, authorizedOn: e.cbr_authorized_on }, e.product).filter((c) => !c.done);
                  const late = e.exam_at && e.status === "reserved" && cancelDeadline(e.exam_at) < now && e.exam_at > now;
                  return (
                    <tr key={e.id}>
                      <td><Link href={`/students/${e.student_id}#cbr`}>{e.student_name}</Link></td>
                      <td>{L.product[e.product]}{e.reservation_number && <div className="small muted" dir="ltr">{e.reservation_number}</div>}</td>
                      <td>{e.exam_at ? f.dateTime(e.exam_at) : "—"}{e.location && <div className="small muted">{e.location}</div>}</td>
                      <td><Badge value={cbrTone(e.status)} label={L.status[e.status]} />{late && <div className="small muted">{pt("within 4 weeks")}</div>}</td>
                      <td className="small">{missing.length === 0 ? <span className="muted">{pt("Nothing")}</span> : missing.map((c) => <div key={c.key}>• {checkText(c, pt, f)}</div>)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{pt("Results (last 12 months)")}</h2>
        {d.results.length === 0 ? (
          <p className="muted">{pt("No results yet.")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{pt("Student")}</th><th>{pt("Exam")}</th><th>{pt("Date")}</th><th>{pt("Result")}</th></tr></thead>
              <tbody>
                {d.results.map((e) => (
                  <tr key={e.id}>
                    <td><Link href={`/students/${e.student_id}#cbr`}>{e.student_name}</Link></td>
                    <td>{L.product[e.product]}</td>
                    <td>{e.exam_at ? f.shortDate(e.exam_at) : "—"}</td>
                    <td><Badge value={cbrTone(e.status)} label={L.status[e.status]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="small muted">{pt("DriveDesk is not yet connected to CBR: exams are reserved in the CBR portal and noted here by hand. A direct link with CBR is planned.")}</p>
    </>
  );
}
