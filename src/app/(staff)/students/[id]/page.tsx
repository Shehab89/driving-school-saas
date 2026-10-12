import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { Badge, Flash, ProgressBar, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { schoolI18n } from "@/server/school";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { assertCanViewStudent } from "@/server/services/students";
import { getProgressSummary } from "@/server/services/progress";
import { reviewAssessment } from "@/server/services/assessments";
import { runAction, str } from "@/server/web";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { adjustCredits } from "@/server/services/billing";
import { listPackages, purchasePackage, studentCredits } from "@/server/services/packages";
import { eraseStudent } from "@/server/services/privacy";
import { setUserStatus } from "@/server/services/team";

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
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: "Package invoiced. Credits are added once it is paid." });
}

async function adjustCreditsAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => adjustCredits(tx, userPrincipal(actor), str(fd, "studentId"), Number(str(fd, "delta")), str(fd, "note")));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: "Credits adjusted" });
}

async function loginAccessAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("students:write");
    await withTenant(actor.schoolId, (tx) => setUserStatus(tx, userPrincipal(actor), str(fd, "userId"), str(fd, "status") === "active" ? "active" : "disabled"));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: "App access updated" });
}

async function eraseAction(fd: FormData) {
  "use server";
  const studentId = str(fd, "studentId");
  await runAction(async () => {
    const actor = await requireSchoolActor("students:erase");
    if (str(fd, "confirm") !== str(fd, "expected")) throw new PolicyError("Type the student number exactly to confirm.", "confirm_mismatch");
    await withTenant(actor.schoolId, (tx) => eraseStudent(tx, userPrincipal(actor), studentId, str(fd, "reason")));
  }, { back: `/students/${studentId}`, okMessage: "Personal data erased" });
}

export default async function StudentProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const { t, f, locale } = await schoolI18n(actor.schoolId);
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
      lessons: await many<{ id: string; lesson_number: number; start_time: Date; status: string; payment_status: string; instructor: string; strengths: string | null; weaknesses: string | null; next_focus: string | null }>(
        tx,
        `SELECT l.id, l.lesson_number, l.start_time, l.status, l.payment_status, i.first_name AS instructor, f.strengths, f.weaknesses, f.next_focus
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
  if (!d) return <p>{t("common.notFound")}</p>;
  const { s, progress: p } = d;
  const staff = can(actor.role, "students:read_all");
  const skillTone = (st: string) => (st === "completed" ? "completed" : st === "needs_improvement" ? "overdue" : "pending");

  return (
    <>
      <div className="spread">
        <h1>{s.first_name} {s.last_name}</h1>
        <div className="row">
          <StatusBadge value={s.status} t={t} />
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
        <h2>{t("studentProfile.lessons")}</h2>
        <div className="table-wrap">
          <table className="stack-table">
            <thead><tr><th>#</th><th>{t("common.date")}</th><th>{t("common.instructor")}</th><th>{t("common.status")}</th><th>{t("studentProfile.feedback")}</th><th>{t("studentProfile.payment")}</th></tr></thead>
            <tbody>
              {d.lessons.map((l) => (
                <tr key={l.id}>
                  <td data-label="#"><Link href={`/lessons/${l.id}`}>{l.lesson_number}</Link></td>
                  <td data-label={t("common.date")}>{f.shortDate(l.start_time)}</td>
                  <td data-label={t("common.instructor")}>{l.instructor}</td>
                  <td data-label={t("common.status")}><StatusBadge value={l.status} t={t} /></td>
                  <td data-label={t("studentProfile.feedback")} className="small">{[l.strengths && `+ ${l.strengths}`, l.weaknesses && `− ${l.weaknesses}`, l.next_focus && `→ ${l.next_focus}`].filter(Boolean).join(" ") || t("common.none")}</td>
                  <td data-label={t("studentProfile.payment")}><StatusBadge value={l.payment_status} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {d.credits && (
        <section className="card">
          <div className="spread">
            <h2>Lesson credits</h2>
            <span><strong>{d.credits.available}</strong> available{d.credits.upcoming > 0 && <span className="muted small"> ({d.credits.balance} total, {d.credits.upcoming} reserved for upcoming lessons)</span>}</span>
          </div>
          <div className="grid two">
            {d.packages.length > 0 && (
              <form action={sellPackageAction} className="row">
                <input type="hidden" name="studentId" value={s.id} />
                <select name="packageId" aria-label="Package" style={{ width: "auto" }}>
                  {d.packages.map((pk) => <option key={pk.id} value={pk.id}>{pk.name} · {pk.lesson_count} lessons · {f.money(pk.price_cents, pk.currency)}</option>)}
                </select>
                <button>Sell package</button>
              </form>
            )}
            <form action={adjustCreditsAction} className="row">
              <input type="hidden" name="studentId" value={s.id} />
              <input name="delta" type="number" min={-100} max={100} step={1} required placeholder="+/- lessons" aria-label="Change in lessons" style={{ width: 110 }} />
              <input name="note" required placeholder="Reason (kept in the audit log)" aria-label="Reason" style={{ width: 220 }} />
              <button>Adjust</button>
            </form>
          </div>
          {d.credits.ledger.length > 0 && (
            <details className="small" style={{ marginTop: 8 }}>
              <summary>History</summary>
              <table>
                <tbody>
                  {d.credits.ledger.map((c, i) => (
                    <tr key={i}>
                      <td>{f.shortDate(c.created_at)}</td>
                      <td className="num">{c.delta > 0 ? `+${c.delta}` : c.delta}</td>
                      <td>{c.reason.replace(/_/g, " ")}{c.lesson_number ? ` · lesson #${c.lesson_number}` : ""}</td>
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
          <h2>Privacy and access</h2>
          {s.erased_at ? (
            <p>Personal data was erased on {f.shortDate(s.erased_at)}. Invoices and payments are kept for the legal retention period.</p>
          ) : (
            <>
              <dl className="kv small">
                <dt>WhatsApp messages</dt>
                <dd>{s.whatsapp_opt_in_at && (!s.whatsapp_opt_out_at || s.whatsapp_opt_in_at > s.whatsapp_opt_out_at) ? `agreed on ${f.shortDate(s.whatsapp_opt_in_at)}` : s.whatsapp_opt_out_at ? `stopped on ${f.shortDate(s.whatsapp_opt_out_at)}` : "no consent"}</dd>
                <dt>Student app</dt>
                <dd>{s.user_id ? (s.user_status ?? "").replace("invited", "invited, not activated") : "no account"}</dd>
              </dl>
              <div className="row" style={{ marginTop: 8 }}>
                <a className="btn" href={`/api/students/${s.id}/export`}>Download all data (JSON)</a>
                {s.user_id && (
                  <form action={loginAccessAction}>
                    <input type="hidden" name="studentId" value={s.id} />
                    <input type="hidden" name="userId" value={s.user_id} />
                    <input type="hidden" name="status" value={s.user_status === "disabled" ? "active" : "disabled"} />
                    <button type="submit">{s.user_status === "disabled" ? "Enable app access" : "Disable app access"}</button>
                  </form>
                )}
              </div>
              {can(actor.role, "students:erase") && (
                <details style={{ marginTop: 12 }}>
                  <summary className="small">Erase personal data</summary>
                  <form action={eraseAction} style={{ marginTop: 8 }}>
                    <p className="small muted">
                      Removes name, contact details, notes, feedback texts, assessments and WhatsApp chats. Lessons, invoices and payments stay without personal data;
                      issued invoices keep the billed name for the 7 years Dutch tax law requires. This cannot be undone. Planned lessons and open payments must be dealt with first.
                    </p>
                    <input type="hidden" name="studentId" value={s.id} />
                    <input type="hidden" name="expected" value={s.student_number} />
                    <div className="fields">
                      <div className="field"><label htmlFor="erase_reason">Reason</label><input id="erase_reason" name="reason" required placeholder="Request by the student on …" /></div>
                      <div className="field"><label htmlFor="erase_confirm">Type {s.student_number} to confirm</label><input id="erase_confirm" name="confirm" required autoComplete="off" /></div>
                    </div>
                    <button className="danger" type="submit">Erase permanently</button>
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
