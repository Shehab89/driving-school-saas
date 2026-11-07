import Link from "next/link";
import { DateTime } from "luxon";
import type { PortalTranslate } from "@/i18n/portal";
import { Badge } from "@/components/ui";
import { DateField } from "@/components/date-field";
import { DateTimeField } from "@/components/date-time-field";
import type { DateFieldLabels } from "@/components/date-field-labels";
import { cbrLabels, cbrTone } from "@/components/cbr-labels";
import { deleteCbrExamAction, saveCbrExamAction, saveCbrStudentAction } from "@/app/actions/cbr";
import {
  CBR_EXAM_DAY_MINUTES, CBR_FEES_2026, CBR_HEALTH, CBR_LINKS, CBR_PRODUCTS, CBR_STATUSES,
  cancelDeadline, cbrChecklist, isPractical, type CbrCheck, type CbrProduct,
} from "@/lib/cbr";
import type { CbrExam, CbrStudentRow } from "@/server/services/cbr";

type Fmt = { date: (d: Date) => string; dateTime: (d: Date) => string; isoDate: (s: string) => string; money: (c: number, cur: string) => string };

export function checkText(c: CbrCheck, pt: PortalTranslate, f: Fmt) {
  if (c.key === "authorization") return c.done ? pt("Student authorised the school in Mijn CBR") : pt("Student has not yet authorised the school in Mijn CBR");
  if (c.key === "health") return c.done ? pt("Health declaration approved") : pt("Health declaration not yet approved");
  if (c.detail?.expired) return pt("Theory certificate expired on {date}", { date: f.isoDate(c.detail.until!) });
  return c.done ? pt("Theory passed, valid until {date}", { date: f.isoDate(c.detail!.until!) }) : pt("Theory not passed yet (needed before a practical exam can be reserved)");
}

export function CbrChecklist({ checks, pt, f }: { checks: CbrCheck[]; pt: PortalTranslate; f: Fmt }) {
  return (
    <ul className="cbr-checks">
      {checks.map((c) => (
        <li key={c.key} className={c.done ? "done" : c.blocking ? "todo" : "warn"}>
          <span aria-hidden="true">{c.done ? "✓" : "!"}</span> {checkText(c, pt, f)}
        </li>
      ))}
    </ul>
  );
}

type Cal = { instructors: Array<{ id: string; name: string }>; defaultInstructorId: string | null };

function ExamFields({ exam, studentId, back, pt, locale, labels, tz, currency, cal }: {
  exam?: CbrExam; studentId: string; back: string; pt: PortalTranslate; locale: string; labels: DateFieldLabels; tz: string; currency: string; cal?: Cal;
}) {
  const L = cbrLabels(pt);
  const key = exam?.id ?? "new";
  const product: CbrProduct = exam?.product ?? "practical";
  const fee = exam ? exam.fee_cents : CBR_FEES_2026[product];
  return (
    <>
      {exam && <input type="hidden" name="id" value={exam.id} />}
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="back" value={back} />
      <div className="fields">
        <div className="field">
          <label htmlFor={`product-${key}`}>{pt("Exam")}</label>
          <select id={`product-${key}`} name="product" defaultValue={product}>
            {CBR_PRODUCTS.map((p) => <option key={p} value={p}>{L.product[p]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`status-${key}`}>{pt("Status")}</label>
          <select id={`status-${key}`} name="status" defaultValue={exam?.status ?? "reserved"}>
            {CBR_STATUSES.map((s) => <option key={s} value={s}>{L.status[s]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`examAt-${key}`}>{pt("Date and time")}</label>
          <DateTimeField
            id={`examAt-${key}`} name="examAt" locale={locale} labels={labels} timeLabel={pt("Time")}
            defaultValue={exam?.exam_at ? DateTime.fromJSDate(exam.exam_at, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm") : ""}
          />
        </div>
        <div className="field">
          <label htmlFor={`location-${key}`}>{pt("Exam centre")}</label>
          <input id={`location-${key}`} name="location" maxLength={120} defaultValue={exam?.location ?? ""} placeholder={pt("e.g. CBR Utrecht")} list="cbr-locations" />
        </div>
        <div className="field">
          <label htmlFor={`res-${key}`}>{pt("CBR reservation number")}</label>
          <input id={`res-${key}`} name="reservationNumber" maxLength={40} dir="ltr" defaultValue={exam?.reservation_number ?? ""} />
        </div>
        <div className="field">
          <label htmlFor={`fee-${key}`}>{pt("CBR fee ({currency})", { currency })}</label>
          <input id={`fee-${key}`} name="fee" type="number" step="0.01" min="0" defaultValue={fee != null ? (fee / 100).toFixed(2) : ""} />
        </div>
      </div>
      {cal && cal.instructors.length > 0 && !exam?.lesson_id && (
        <fieldset className="field cal-book">
          <label className="check"><input type="checkbox" name="bookCalendar" defaultChecked /> {pt("Put the exam day in the calendar (car and instructor)")}</label>
          <div className="row" style={{ marginTop: 6 }}>
            <label htmlFor={`cal-ins-${key}`} className="small">{pt("Instructor")}</label>
            <select id={`cal-ins-${key}`} name="calendarInstructorId" defaultValue={cal.defaultInstructorId ?? ""} style={{ width: "auto" }}>
              {cal.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <p className="small muted" style={{ margin: "4px 0 0" }}>{pt("Booked from 1 hour before the exam (pick-up and warm-up). If that time is already taken, nothing is saved and you see who is busy.")}</p>
        </fieldset>
      )}
      <div className="field">
        <label htmlFor={`notes-${key}`}>{pt("Result notes (what went well, what to work on)")}</label>
        <textarea id={`notes-${key}`} name="resultNotes" maxLength={2000} rows={2} defaultValue={exam?.result_notes ?? ""} />
      </div>
    </>
  );
}

/** The CBR block on a student's profile: checklist, exams and results, add/edit forms. */
export function CbrPanel({ studentId, student, exams, canEdit, canEditStudent, pt, f, locale, labels, tz, currency, locations, instructors = [], defaultInstructorId = null }: {
  studentId: string; student: CbrStudentRow; exams: CbrExam[]; canEdit: boolean; canEditStudent: boolean;
  instructors?: Array<{ id: string; name: string }>; defaultInstructorId?: string | null;
  pt: PortalTranslate; f: Fmt; locale: string; labels: DateFieldLabels; tz: string; currency: string; locations: string[];
}) {
  const L = cbrLabels(pt);
  const back = `/students/${studentId}`;
  const state = { theoryPassedOn: student.cbr_theory_passed_on, health: student.cbr_health_status, authorizedOn: student.cbr_authorized_on };
  const checks = cbrChecklist(state, "practical");
  const now = new Date();
  const cal: Cal = { instructors, defaultInstructorId };
  return (
    <section className="card" id="cbr">
      <div className="spread">
        <h2>{pt("CBR exams")}</h2>
        <a className="btn sm" href={CBR_LINKS.schoolPortal} target="_blank" rel="noopener noreferrer">{pt("Open CBR portal")} ↗</a>
      </div>
      <p className="small muted">{pt("Reserve the exam in the CBR portal as usual, then note it here. DriveDesk shows it to the student and in your exam overview.")}</p>

      <h3 className="small" style={{ margin: "12px 0 4px" }}>{pt("Before a practical exam")}</h3>
      <CbrChecklist checks={checks} pt={pt} f={f} />
      {canEditStudent && (
        <details className="small">
          <summary>{pt("Update")}</summary>
          <form action={saveCbrStudentAction} style={{ marginTop: 8 }}>
            <input type="hidden" name="studentId" value={studentId} />
            <input type="hidden" name="back" value={back} />
            <div className="fields">
              <div className="field"><label htmlFor="cbr-theory">{pt("Theory passed on")}</label><DateField id="cbr-theory" name="theoryPassedOn" defaultValue={student.cbr_theory_passed_on ?? ""} locale={locale} labels={labels} /></div>
              <div className="field">
                <label htmlFor="cbr-health">{pt("Health declaration")}</label>
                <select id="cbr-health" name="health" defaultValue={student.cbr_health_status}>{CBR_HEALTH.map((h) => <option key={h} value={h}>{L.health[h]}</option>)}</select>
              </div>
              <div className="field"><label htmlFor="cbr-auth">{pt("Authorised the school on")}</label><DateField id="cbr-auth" name="authorizedOn" defaultValue={student.cbr_authorized_on ?? ""} locale={locale} labels={labels} /></div>
            </div>
            <button type="submit" className="primary">{pt("Save")}</button>
          </form>
        </details>
      )}

      <datalist id="cbr-locations">{locations.map((l) => <option key={l} value={l} />)}</datalist>
      <div style={{ marginTop: 12 }}>
        {exams.length === 0 && <p className="muted small">{pt("No CBR exams yet.")}</p>}
        {exams.map((e) => {
          const deadline = e.exam_at ? cancelDeadline(e.exam_at) : null;
          const upcoming = e.exam_at && e.exam_at > now && e.status === "reserved";
          return (
            <details key={e.id} className="lesson-row">
              <summary>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{L.product[e.product]}</strong> · {e.exam_at ? f.dateTime(e.exam_at) : pt("no date yet")}{e.location ? ` · ${e.location}` : ""}
                </span>
                <Badge value={cbrTone(e.status)} label={L.status[e.status]} />
              </summary>
              <div className="lesson-row-body">
                <p className="small" style={{ margin: 0 }}>
                  {e.reservation_number && <>{pt("Reservation")}: <span dir="ltr" className="num">{e.reservation_number}</span> · </>}
                  {e.fee_cents != null && <>{pt("CBR fee")}: {f.money(e.fee_cents, currency)}</>}
                </p>
                {upcoming && deadline && (
                  <p className="small" style={{ margin: "4px 0" }}>
                    {deadline > now ? pt("Can be cancelled or moved until {date}.", { date: f.date(deadline) }) : pt("Less than 4 weeks to go: cancelling now counts as a late cancellation at CBR.")}
                  </p>
                )}
                {e.result_notes && <p className="small" style={{ whiteSpace: "pre-wrap" }}>{e.result_notes}</p>}
                {e.lesson_id && <p className="small"><Link href={`/lessons/${e.lesson_id}`}>{pt("Exam day is in the calendar")} →</Link></p>}
                {canEdit && upcoming && isPractical(e.product) && !e.lesson_id && e.exam_at && (
                  <p className="small">
                    <Link href={`/admin/lessons/new?student=${studentId}&type=exam&from=${DateTime.fromJSDate(e.exam_at, { zone: tz }).toISODate()}&minutes=${CBR_EXAM_DAY_MINUTES[e.product]}`}>
                      {pt("Book car and instructor for the exam day")} →
                    </Link>
                  </p>
                )}
                {canEdit && (
                  <>
                    <form action={saveCbrExamAction} style={{ marginTop: 8 }}>
                      <ExamFields exam={e} studentId={studentId} back={back} pt={pt} locale={locale} labels={labels} tz={tz} currency={currency} cal={cal} />
                      <button type="submit" className="primary">{pt("Save")}</button>
                    </form>
                    <form action={deleteCbrExamAction} style={{ marginTop: 6 }}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="studentId" value={studentId} />
                      <input type="hidden" name="back" value={back} />
                      <button className="sm danger" type="submit">{pt("Remove (entered by mistake)")}</button>
                    </form>
                  </>
                )}
              </div>
            </details>
          );
        })}
      </div>
      {canEdit && (
        <details style={{ marginTop: 12 }}>
          <summary className="btn">{pt("Add CBR exam")}</summary>
          <form action={saveCbrExamAction} style={{ marginTop: 8 }}>
            <ExamFields studentId={studentId} back={back} pt={pt} locale={locale} labels={labels} tz={tz} currency={currency} cal={cal} />
            <p className="small muted">{pt("CBR fees 2026: practical exam and interim test €143.50, fear-of-failure exam €202.00. Change the amount if yours differs.")}</p>
            <button type="submit" className="primary">{pt("Save")}</button>
          </form>
        </details>
      )}
    </section>
  );
}
