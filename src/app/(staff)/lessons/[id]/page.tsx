import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { durationMinutes } from "@/lib/time";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { schoolI18n } from "@/server/school";
import { requireSchoolPage } from "@/server/auth/session";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { cancelAction, completeAction, confirmAction, noShowAction, requestPaymentAction, startAction } from "./actions";

export default async function LessonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const { t, f, locale } = await schoolI18n(actor.schoolId);

  const d = await withTenant(actor.schoolId, async (tx) => {
    const lesson = await one<{
      id: string; status: string; start_time: Date; end_time: Date; lesson_number: number; price_cents: number; currency: string;
      payment_status: string; cancellation_reason: string | null; instructor_id: string; student_id: string; notes: string | null;
      student_name: string; student_phone: string | null; student_email: string | null; current_level_id: string | null;
      level_name: string | null; level_position: number | null; instructor_name: string; vehicle: string | null; now: Date;
    }>(
      tx,
      `SELECT l.*, s.first_name || ' ' || s.last_name AS student_name, s.phone AS student_phone, s.email AS student_email,
              s.current_level_id, COALESCE(ld.name_translations->>$2, ld.name) AS level_name, ld.position AS level_position,
              i.first_name || ' ' || i.last_name AS instructor_name,
              CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model || ' (' || v.registration_number || ')' END AS vehicle,
              now() AS now
         FROM lessons l JOIN students s ON s.id = l.student_id JOIN instructors i ON i.id = l.instructor_id
         LEFT JOIN vehicles v ON v.id = l.vehicle_id LEFT JOIN level_definitions ld ON ld.id = s.current_level_id
        WHERE l.id = $1`,
      [id, locale],
    );
    if (!lesson) return null;
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const levels = await many<{ id: string; name: string; position: number }>(tx, `SELECT id, COALESCE(name_translations->>$1, name) AS name, position FROM level_definitions ORDER BY position`, [locale]);
    // Skills of the current and next level, with the student's status.
    const skills = await many<{ id: string; name: string; level_name: string; status: string | null }>(
      tx,
      `SELECT sk.id, COALESCE(sk.name_translations->>$3, sk.name) AS name, COALESCE(ld.name_translations->>$3, ld.name) AS level_name, sp.status
         FROM skills sk JOIN level_definitions ld ON ld.id = sk.level_id
         LEFT JOIN student_skill_progress sp ON sp.skill_id = sk.id AND sp.student_id = $1
        WHERE sk.is_active AND ld.position BETWEEN COALESCE($2, 1) AND COALESCE($2, 1) + 1
        ORDER BY ld.position, sk.position`,
      [lesson.student_id, lesson.level_position, locale],
    );
    const feedback = await one<{ strengths: string | null; weaknesses: string | null; practice_items: string | null; next_focus: string | null; instructor_notes: string | null }>(
      tx,
      `SELECT strengths, weaknesses, practice_items, next_focus, instructor_notes FROM lesson_feedback WHERE lesson_id = $1`,
      [id],
    );
    const payment = await one<{ status: string; amount_cents: number; pay_token: string }>(tx, `SELECT status, amount_cents, pay_token FROM payments WHERE lesson_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
    return { lesson, ctx, levels, skills, feedback, payment };
  });
  if (!d) return <p>{t("common.notFound")}</p>;
  const { lesson: l, ctx } = d;
  const isOwn = actor.instructorId === l.instructor_id;
  if (!isOwn && !can(actor.role, "lessons:write_all")) return <p>{t("instructor.lesson.otherInstructor")}</p>;

  const upcoming = ["scheduled", "confirmed"].includes(l.status);
  const openable = ["scheduled", "confirmed", "in_progress"].includes(l.status);
  const started = new Date(l.now) >= new Date(l.start_time);
  const hidden = <input type="hidden" name="lessonId" value={l.id} />;

  return (
    <div className="narrow">
      <p><Link href="/instructor/calendar"><span className="flip" style={{ display: "inline-block" }}>←</span> {t("instructor.lesson.calendarBack")}</Link></p>
      <div className="spread">
        <h1>{t("instructor.lesson.title", { number: l.lesson_number })}</h1>
        <StatusBadge value={l.status} t={t} />
      </div>
      <Flash searchParams={q} />

      <section className="card">
        <dl className="kv">
          <dt>{t("common.student")}</dt><dd><Link href={`/students/${l.student_id}`}>{l.student_name}</Link></dd>
          <dt>{t("instructor.lesson.studentLevel")}</dt><dd>{l.level_name ?? t("common.levelNotSet")}</dd>
          <dt>{t("common.date")}</dt><dd>{f.date(l.start_time)}</dd>
          <dt>{t("common.time")}</dt><dd className="num">{f.range(l.start_time, l.end_time)} ({durationMinutes(l.start_time, l.end_time)} {t("common.min")})</dd>
          <dt>{t("common.vehicle")}</dt><dd>{l.vehicle ?? t("common.noVehicle")}</dd>
          <dt>{t("common.instructor")}</dt><dd>{l.instructor_name}</dd>
          <dt>{t("instructor.lesson.price")}</dt><dd>{f.money(l.price_cents, l.currency)} · <StatusBadge value={l.payment_status} t={t} /></dd>
          {l.student_phone && (<><dt>{t("common.phone")}</dt><dd><a dir="ltr" href={`tel:${l.student_phone}`}>{l.student_phone}</a></dd></>)}
          {l.cancellation_reason && (<><dt>{t("instructor.lesson.cancelled")}</dt><dd>{l.cancellation_reason}</dd></>)}
        </dl>
      </section>

      {upcoming && (
        <div className="row" style={{ marginBottom: 16 }}>
          {l.status === "scheduled" && <form action={confirmAction}>{hidden}<button>{t("instructor.lesson.confirm")}</button></form>}
          <form action={startAction}>{hidden}<button className="primary">{t("instructor.lesson.start")}</button></form>
          <Link className="btn" href={`/lessons/${l.id}/reschedule`}>{t("instructor.lesson.reschedule")}</Link>
        </div>
      )}

      {openable && started && (
        <form action={completeAction} className="card">
          {hidden}
          <h2>{t("instructor.lesson.complete")}</h2>
          <p className="muted small">{t("instructor.lesson.completeHint")}</p>
          <label className="switch" style={{ margin: "12px 0 16px" }}>
            <span>{t("instructor.lesson.requestPayment", { amount: f.money(l.price_cents, l.currency) })}</span>
            <input type="checkbox" name="paymentRequired" role="switch" defaultChecked={ctx.settings.auto_payment_request && l.price_cents > 0} />
          </label>
          <button className="primary block" type="submit">{t("instructor.lesson.complete")}</button>
        </form>
      )}

      {["completed", "in_progress"].includes(l.status) && (
        <section className="card">
          <div className="spread" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{t("instructor.feedback.title")}</h2>
            <Link className="btn sm accent" href={`/instructor/feedback/${l.id}`}>
              {d.feedback?.strengths || d.feedback?.next_focus ? t("instructor.feedback.edit") : t("instructor.feedback.give")}
            </Link>
          </div>
          {d.feedback && (d.feedback.strengths || d.feedback.weaknesses || d.feedback.next_focus) ? (
            <div className="fb-grid">
              {d.feedback.strengths && <div className="fb-item good"><h3>{t("instructor.lesson.wentWell")}</h3><p>{d.feedback.strengths}</p></div>}
              {d.feedback.weaknesses && <div className="fb-item improve"><h3>{t("instructor.lesson.toImprove")}</h3><p>{d.feedback.weaknesses}</p></div>}
              {d.feedback.next_focus && <div className="fb-item focus"><h3>{t("instructor.lesson.nextFocus")}</h3><p>{d.feedback.next_focus}</p></div>}
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>{t("instructor.feedback.waiting")}</p>
          )}
        </section>
      )}

      {l.status === "completed" && (
        <section className="card">
          <h2>{t("instructor.lesson.payment")}</h2>
          {d.payment ? (
            <p>{f.money(d.payment.amount_cents, l.currency)} · <StatusBadge value={d.payment.status} t={t} /></p>
          ) : l.price_cents > 0 ? (
            <form action={requestPaymentAction}>{hidden}<button className="primary">{t("instructor.lesson.markRequired")}</button></form>
          ) : (
            <p className="muted">{t("instructor.lesson.noPaymentNeeded")}</p>
          )}
        </section>
      )}

      {upcoming && (
        <details className="card">
          <summary><strong>{t("instructor.lesson.cancelOrNoShow")}</strong></summary>
          <form action={cancelAction} style={{ marginTop: 12 }}>
            {hidden}
            <div className="field"><label htmlFor="reason">{t("instructor.lesson.cancelReason")}</label><input id="reason" name="reason" required /></div>
            {can(actor.role, "lessons:write_all") && ctx.settings.late_cancellation_fee_cents > 0 && (
              <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" name="waiveFee" /> {t("instructor.lesson.waiveFee")}</label>
            )}
            <button className="danger">{t("instructor.lesson.cancelLesson")}</button>
          </form>
          {started && (
            <form action={noShowAction} style={{ marginTop: 16 }}>
              {hidden}
              <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" name="charge" defaultChecked /> {t("instructor.lesson.chargeLesson")}</label>
              <button className="danger">{t("instructor.lesson.noShow")}</button>
            </form>
          )}
        </details>
      )}
    </div>
  );
}
