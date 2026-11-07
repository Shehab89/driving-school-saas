import Link from "next/link";
import { notFound } from "next/navigation";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { Badge, Flash, ProgressBar, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { schoolI18n } from "@/server/school";
import { getI18n, getPt } from "@/i18n/server";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { assertCanViewStudent } from "@/server/services/students";
import { getProgressSummary } from "@/server/services/progress";
import { reviewAssessment } from "@/server/services/assessments";
import { runAction, str, idOr404 } from "@/server/web";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { adjustCredits } from "@/server/services/billing";
import { listPackages, purchasePackage, studentCredits } from "@/server/services/packages";
import { eraseStudent } from "@/server/services/privacy";
import { setUserStatus } from "@/server/services/team";
import { Stars } from "@/components/ui";
import { TopicTags } from "@/components/topic-picker";
import { topicsForLessons } from "@/server/services/topics";
import { reviewsForLessons } from "@/server/services/reviews";
import { cbrStudent, studentCbrExams } from "@/server/services/cbr";
import { CbrPanel } from "@/components/cbr-panel";
import { dateFieldLabels } from "@/components/date-field-labels";

async function reviewAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("assessments:review");
    await withTenant(actor.schoolId, (tx) => reviewAssessment(tx, userPrincipal(actor), str(fd, "assessmentId"), str(fd, "levelId"), str(fd, "reason") || undefined));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: (await getI18n()).t("studentProfile.levelConfirmed") });
}

async function sellPackageAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => purchasePackage(tx, userPrincipal(actor), { studentId: str(fd, "studentId"), packageId: str(fd, "packageId") }));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: (await getPt())("Package invoiced. Credits are added once it is paid.") });
}

async function adjustCreditsAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => adjustCredits(tx, userPrincipal(actor), str(fd, "studentId"), Number(str(fd, "delta")), str(fd, "note")));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: (await getPt())("Credits adjusted") });
}

async function loginAccessAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("students:write");
    await withTenant(actor.schoolId, (tx) => setUserStatus(tx, userPrincipal(actor), str(fd, "userId"), str(fd, "status") === "active" ? "active" : "disabled"));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: (await getPt())("App access updated") });
}

async function eraseAction(fd: FormData) {
  "use server";
  const studentId = str(fd, "studentId");
  await runAction(async () => {
    const actor = await requireSchoolActor("students:erase");
    if (str(fd, "confirm") !== str(fd, "expected")) throw new PolicyError((await getPt())("Type the student number exactly to confirm."), "confirm_mismatch");
    await withTenant(actor.schoolId, (tx) => eraseStudent(tx, userPrincipal(actor), studentId, str(fd, "reason")));
  }, { back: `/students/${studentId}`, okMessage: (await getPt())("Personal data erased") });
}

export default async function StudentProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idOr404((await params).id);
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const { t, f, locale, pt, school } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => {
    try {
      await assertCanViewStudent(tx, userPrincipal(actor), id);
    } catch (e) {
      if (e instanceof ForbiddenError) return null;
      throw e;
    }
    const s = await one<{ id: string; first_name: string; last_name: string; student_number: string; email: string | null; phone: string | null; license_category: string; preferred_transmission: string; status: string; notes: string | null; tz: string; date_of_birth: string | null; erased_at: Date | null; user_id: string | null; user_status: string | null; whatsapp_opt_in_at: Date | null; whatsapp_opt_out_at: Date | null }>(
      tx,
      `SELECT st.*, sc.timezone AS tz, u.status AS user_status FROM students st JOIN schools sc ON sc.id = st.school_id LEFT JOIN users u ON u.id = st.user_id WHERE st.id = $1`,
      [id],
    );
    if (!s) return null;
    const billing = can(actor.role, "payments:record_manual");
    return {
      s,
      credits: billing ? await studentCredits(tx, id) : null,
      packages: billing ? await listPackages(tx) : [],
      progress: await getProgressSummary(tx, id, locale),
      levels: await many<{ id: string; name: string }>(tx, `SELECT id, COALESCE(name_translations->>$1, name) AS name FROM level_definitions ORDER BY position`, [locale]),
      lessons: await many<{ id: string; lesson_number: number; start_time: Date; status: string; payment_status: string; instructor: string; strengths: string | null; weaknesses: string | null; practice_items: string | null; next_focus: string | null; overall_rating: number | null }>(
        tx,
        `SELECT l.id, l.lesson_number, l.start_time, l.status, l.payment_status, i.first_name AS instructor, f.strengths, f.weaknesses, f.practice_items, f.next_focus, f.overall_rating
           FROM lessons l JOIN instructors i ON i.id = l.instructor_id LEFT JOIN lesson_feedback f ON f.lesson_id = l.id
          WHERE l.student_id = $1 AND l.status <> 'rescheduled' ORDER BY l.start_time DESC LIMIT 100`,
        [id],
      ),
      assessments: await many<{ id: string; created_at: Date; suggested_band: string; confidence: string; status: string; rationale: string | null; answers: Record<string, unknown>; suggested_level_id: string | null; suggested_level: string | null; final_level: string | null }>(
        tx,
        `SELECT a.*, COALESCE(sl.name_translations->>$2, sl.name) AS suggested_level, COALESCE(fl.name_translations->>$2, fl.name) AS final_level FROM assessments a
           LEFT JOIN level_definitions sl ON sl.id = a.suggested_level_id LEFT JOIN level_definitions fl ON fl.id = a.final_level_id
          WHERE a.student_id = $1 ORDER BY a.created_at DESC`,
        [id, locale],
      ),
    };
  });
  if (!d) notFound();
  const { s, progress: p } = d;
  const { topics, reviews, cbr } = await withTenant(actor.schoolId, async (tx) => ({
    topics: await topicsForLessons(tx, d.lessons.map((l) => l.id), locale),
    reviews: await reviewsForLessons(tx, userPrincipal(actor), d.lessons.map((l) => l.id)),
    cbr: can(actor.role, "students:read_all")
      ? {
          student: (await cbrStudent(tx, id))!,
          exams: await studentCbrExams(tx, id),
          locations: (await many<{ location: string }>(tx, `SELECT DISTINCT location FROM cbr_exams WHERE location IS NOT NULL ORDER BY location LIMIT 30`)).map((r) => r.location),
          instructors: await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' ORDER BY first_name`),
          primaryInstructorId: (await one<{ primary_instructor_id: string | null }>(tx, `SELECT primary_instructor_id FROM students WHERE id = $1`, [id]))?.primary_instructor_id ?? null,
        }
      : null,
  }));
  const rated = d.lessons.filter((l) => l.overall_rating);
  const avgRating = rated.length ? rated.reduce((a, l) => a + l.overall_rating!, 0) / rated.length : null;
  const staff = can(actor.role, "students:read_all");
  const skillTone = (st: string) => (st === "completed" ? "completed" : st === "needs_improvement" ? "overdue" : "pending");

  return (
    <>
      <div className="spread">
        <h1>{s.first_name} {s.last_name}</h1>
        <div className="row">
          <StatusBadge value={s.status} t={t} />
          {!s.erased_at && <Link className="btn" href={`/progress/${s.id}`}>{t("report.title")}</Link>}
          {staff && <a className="btn" href="#cbr">{pt("CBR exams")}</a>}
          {staff && <Link className="btn primary" href={`/admin/lessons/new?student=${s.id}`}>{t("studentProfile.bookLesson")}</Link>}
        </div>
      </div>
      <Flash searchParams={q} />
      <div className="grid two">
        <section className="card">
          <dl className="kv">
            <dt>{t("studentProfile.number")}</dt><dd>{s.student_number}</dd>
            <dt>{t("common.phone")}</dt><dd>{s.phone ? <a dir="ltr" href={`tel:${s.phone}`}>{s.phone}</a> : t("common.none")}</dd>
            <dt>{t("common.email")}</dt><dd dir="ltr">{s.email ?? t("common.none")}</dd>
            <dt>{t("studentProfile.licence")}</dt><dd>{s.license_category} · {s.preferred_transmission === "automatic" ? t("student.automatic") : t("student.manual")}</dd>
            {s.date_of_birth && (<><dt>{t("studentProfile.born")}</dt><dd>{f.isoDate(s.date_of_birth)}</dd></>)}
          </dl>
          {s.notes && <p className="small muted" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{s.notes}</p>}
        </section>
        <section className="card">
          <div className="spread">
            <h2>{t("studentProfile.progress")}</h2>
            {p.currentLevel && (
              <span>
                {t("common.levelOf", { position: p.currentLevel.position, total: p.totalLevels })}{" "}
                {!p.levelConfirmed && <Badge value="suggested" label={t("studentProfile.unconfirmed")} />}
              </span>
            )}
          </div>
          <ProgressBar value={p.percent} label={t("studentProfile.progress")} />
          <ul className="small" style={{ columns: 2 }}>
            {p.skills.map((sk) => (
              <li key={sk.id}>
                {sk.name} {sk.status !== "not_started" && <Badge value={skillTone(sk.status)} label={t(`skillStatus.${sk.status}`)} />}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {d.assessments.length > 0 && (
        <section className="card">
          <h2>{t("studentProfile.assessments")}</h2>
          {d.assessments.map((a) => (
            <div key={a.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
              <div className="spread">
                <span>{f.dateTime(a.created_at)} · {t("studentProfile.suggested", { level: a.suggested_level ?? a.suggested_band, pct: Math.round(Number(a.confidence) * 100) })}</span>
                <StatusBadge value={a.status === "suggested" ? "suggested" : "completed"} t={t} />
              </div>
              <p className="small muted">{a.rationale}</p>
              <details className="small"><summary>{t("studentProfile.answers")}</summary><pre dir="ltr" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(a.answers, null, 2)}</pre></details>
              {a.final_level && <p className="small">{t("studentProfile.finalLevel", { level: a.final_level })}</p>}
              {a.status === "suggested" && can(actor.role, "assessments:review") && (
                <form action={reviewAction} className="row" style={{ marginTop: 8 }}>
                  <input type="hidden" name="assessmentId" value={a.id} />
                  <input type="hidden" name="studentId" value={s.id} />
                  <select name="levelId" defaultValue={a.suggested_level_id ?? ""} aria-label={t("studentProfile.finalLevel", { level: "" })} style={{ width: "auto" }}>
                    {d.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <input name="reason" placeholder={t("studentProfile.overrideReason")} style={{ width: 220 }} />
                  <button className="primary">{t("studentProfile.confirmOverride")}</button>
                </form>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="spread">
          <h2>{t("studentProfile.lessons")}</h2>
          {avgRating !== null && <span className="row" style={{ gap: 6 }}><strong className="num">{f.number(Math.round(avgRating * 10) / 10)}</strong><Stars value={avgRating} /></span>}
        </div>
        <p className="muted small">{pt("Open a lesson to see the instructor's rating, the topics and all notes.")}</p>
        <div>
          {d.lessons.map((l) => {
            const tp = topics.get(l.id);
            const rv = reviews.get(l.id);
            return (
              <details key={l.id} className="lesson-row">
                <summary>
                  <span className="num" style={{ minWidth: 34 }}>#{l.lesson_number}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>{f.shortDate(l.start_time)} · {l.instructor} {l.overall_rating ? <Stars value={l.overall_rating} /> : null}</span>
                  <StatusBadge value={l.status} t={t} />
                </summary>
                <div className="lesson-row-body">
                  {tp && tp.covered.length > 0 && <p><span className="muted small">{t("topics.covered")}: </span><TopicTags topics={tp.covered} /></p>}
                  {tp && tp.planned.length > 0 && <p><span className="muted small">{t("topics.planned")}: </span><TopicTags topics={tp.planned} /></p>}
                  {l.strengths || l.weaknesses || l.practice_items || l.next_focus ? (
                    <div className="fb-grid">
                      {l.strengths && <div className="fb-item good"><h3>{t("instructor.lesson.wentWell")}</h3><p>{l.strengths}</p></div>}
                      {l.weaknesses && <div className="fb-item improve"><h3>{t("instructor.lesson.toImprove")}</h3><p>{l.weaknesses}</p></div>}
                      {l.practice_items && <div className="fb-item"><h3>{t("instructor.lesson.toPractice")}</h3><p>{l.practice_items}</p></div>}
                      {l.next_focus && <div className="fb-item focus"><h3>{t("instructor.lesson.nextFocus")}</h3><p>{l.next_focus}</p></div>}
                    </div>
                  ) : <p className="muted small">{t("review.noNotes")}</p>}
                  {rv && (
                    <div className="fb-item focus">
                      <h3>{t("review.studentReview")} <Stars value={rv.rating} /></h3>
                      {rv.comment && <p style={{ whiteSpace: "pre-wrap" }}>{rv.comment}</p>}
                    </div>
                  )}
                  <p className="small" style={{ margin: 0 }}><Link href={`/lessons/${l.id}`}>{t("review.open")} →</Link> · <span className="muted">{t("studentProfile.payment")}:</span> <StatusBadge value={l.payment_status} t={t} /></p>
                </div>
              </details>
            );
          })}
        </div>
      </section>
      {cbr && !s.erased_at && (
        <CbrPanel
          studentId={s.id} student={cbr.student} exams={cbr.exams} locations={cbr.locations}
          instructors={cbr.instructors} defaultInstructorId={cbr.primaryInstructorId ?? actor.instructorId ?? cbr.instructors[0]?.id ?? null}
          canEdit={can(actor.role, "lessons:write_all")} canEditStudent={can(actor.role, "students:write")}
          pt={pt} f={f} locale={locale} labels={dateFieldLabels(t)} tz={school.timezone} currency={school.currency}
        />
      )}
      {d.credits && (
        <section className="card">
          <div className="spread">
            <h2>{pt("Lesson credits")}</h2>
            <span><strong>{d.credits.available}</strong> {pt("available")}{d.credits.upcoming > 0 && <span className="muted small"> ({pt("{total} total, {upcoming} reserved for upcoming lessons", { total: d.credits.balance, upcoming: d.credits.upcoming })})</span>}</span>
          </div>
          <div className="grid two">
            {d.packages.length > 0 && (
              <form action={sellPackageAction} className="row">
                <input type="hidden" name="studentId" value={s.id} />
                <select name="packageId" aria-label={pt("Package")} style={{ width: "auto" }}>
                  {d.packages.map((pk) => <option key={pk.id} value={pk.id}>{pk.name} · {pt("{count} lessons", { count: pk.lesson_count })} · {f.money(pk.price_cents, pk.currency)}</option>)}
                </select>
                <button>{pt("Sell package")}</button>
              </form>
            )}
            <form action={adjustCreditsAction} className="row">
              <input type="hidden" name="studentId" value={s.id} />
              <input name="delta" type="number" min={-100} max={100} step={1} required placeholder={pt("+/- lessons")} aria-label={pt("Change in lessons")} style={{ width: 110 }} />
              <input name="note" required placeholder={pt("Reason (kept in the audit log)")} aria-label={pt("Reason")} style={{ width: 220 }} />
              <button>{pt("Adjust")}</button>
            </form>
          </div>
          {d.credits.ledger.length > 0 && (
            <details className="small" style={{ marginTop: 8 }}>
              <summary>{pt("History")}</summary>
              <table>
                <tbody>
                  {d.credits.ledger.map((c, i) => (
                    <tr key={i}>
                      <td>{f.shortDate(c.created_at)}</td>
                      <td className="num">{c.delta > 0 ? `+${c.delta}` : c.delta}</td>
                      <td>{c.reason.replace(/_/g, " ")}{c.lesson_number ? ` · ${pt("lesson #{number}", { number: c.lesson_number })}` : ""}</td>
                      <td className="muted">{c.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </section>
      )}
      {staff && can(actor.role, "students:write") && (
        <section className="card">
          <h2>{pt("Privacy and access")}</h2>
          {s.erased_at ? (
            <p>{pt("Personal data was erased on {date}. Invoices and payments are kept for the legal retention period.", { date: f.shortDate(s.erased_at) })}</p>
          ) : (
            <>
              <dl className="kv small">
                <dt>{pt("WhatsApp messages")}</dt>
                <dd>{s.whatsapp_opt_in_at && (!s.whatsapp_opt_out_at || s.whatsapp_opt_in_at > s.whatsapp_opt_out_at) ? pt("agreed on {date}", { date: f.shortDate(s.whatsapp_opt_in_at) }) : s.whatsapp_opt_out_at ? pt("stopped on {date}", { date: f.shortDate(s.whatsapp_opt_out_at) }) : pt("no consent")}</dd>
                <dt>{pt("Student app")}</dt>
                <dd>{s.user_id ? (s.user_status === "invited" ? pt("invited, not activated") : s.user_status === "disabled" ? pt("disabled") : pt("active")) : pt("no account")}</dd>
              </dl>
              <div className="row" style={{ marginTop: 8 }}>
                <a className="btn" href={`/api/students/${s.id}/export`}>{pt("Download all data (JSON)")}</a>
                {s.user_id && (
                  <form action={loginAccessAction}>
                    <input type="hidden" name="studentId" value={s.id} />
                    <input type="hidden" name="userId" value={s.user_id} />
                    <input type="hidden" name="status" value={s.user_status === "disabled" ? "active" : "disabled"} />
                    <button type="submit">{s.user_status === "disabled" ? pt("Enable app access") : pt("Disable app access")}</button>
                  </form>
                )}
              </div>
              {can(actor.role, "students:erase") && (
                <details style={{ marginTop: 12 }}>
                  <summary className="small">{pt("Erase personal data")}</summary>
                  <form action={eraseAction} style={{ marginTop: 8 }}>
                    <p className="small muted">
                      {pt("Removes name, contact details, notes, feedback texts, assessments and WhatsApp chats. Lessons, invoices and payments stay without personal data; issued invoices keep the billed name for the 7 years Dutch tax law requires. This cannot be undone. Planned lessons and open payments must be dealt with first.")}
                    </p>
                    <input type="hidden" name="studentId" value={s.id} />
                    <input type="hidden" name="expected" value={s.student_number} />
                    <div className="fields">
                      <div className="field"><label htmlFor="erase_reason">{pt("Reason")}</label><input id="erase_reason" name="reason" required placeholder={pt("Request by the student on …")} /></div>
                      <div className="field"><label htmlFor="erase_confirm">{pt("Type {number} to confirm", { number: s.student_number })}</label><input id="erase_confirm" name="confirm" required autoComplete="off" /></div>
                    </div>
                    <button className="danger" type="submit">{pt("Erase permanently")}</button>
                  </form>
                </details>
              )}
            </>
          )}
        </section>
      )}
      {!staff && <p className="small muted">{t("studentProfile.teachesNote")}</p>}
    </>
  );
}
