import { Fragment } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { PhraseField, SkillChips } from "@/components/feedback-inputs";
import { getI18n } from "@/i18n/server";
import { FEEDBACK, type Band } from "@/i18n/phrases";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { saveLessonFeedback } from "@/server/services/feedback";
import { bool, num, runAction, str, idOr404 } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";
import { requireInstructorProfile } from "../../data";
import { DateTime } from "luxon";
import { TopicPicker } from "@/components/topic-picker";
import { listTopics, setLessonTopics, topicsForLessons } from "@/server/services/topics";
import { bookLesson } from "@/server/services/lessons";
import { schoolHeader } from "@/server/school";
import { AppError, PolicyError } from "@/lib/errors";
import { getLocale } from "@/i18n/server";
import { tryTranslate } from "@/i18n";

async function saveAction(fd: FormData) {
  "use server";
  const { t, locale: fmtLocale } = await getI18n();
  const lessonId = str(fd, "lessonId");
  let booked: DateTime | null = null;
  await runAction(
    async () => {
      const actor = await requireSchoolActor("lessons:feedback_own");
      const covered = fd.getAll("covered").map(String);
      const nextTopics = fd.getAll("nextTopics").map(String);
      const nextLessonId = str(fd, "nextLessonId");
      const skills = [...fd.entries()]
        .filter(([k, v]) => k.startsWith("skill_") && v)
        .map(([k, v]) => ({ skillId: k.slice(6), status: String(v) as "in_progress" | "needs_improvement" | "completed" }));
      await withTenant(actor.schoolId, (tx) =>
        saveLessonFeedback(tx, userPrincipal(actor), lessonId, {
          strengths: str(fd, "strengths"),
          weaknesses: str(fd, "weaknesses"),
          practiceItems: str(fd, "practiceItems"),
          nextFocus: str(fd, "nextFocus"),
          instructorNotes: str(fd, "instructorNotes"),
          overallRating: num(fd, "rating") ?? null,
          visibleToStudent: bool(fd, "visible"),
          skills,
          newLevelId: str(fd, "levelId") || null,
        }).then(async () => {
          await setLessonTopics(tx, userPrincipal(actor), lessonId, "covered", covered);
          if (nextLessonId) await setLessonTopics(tx, userPrincipal(actor), nextLessonId, "planned", nextTopics);
        }),
      );
      // Optionally book the next lesson in the instructor's own calendar (separate step: the feedback stays saved if the time is taken).
      const nextDate = str(fd, "nextDate");
      if (!nextLessonId && nextDate && actor.instructorId) {
        const tz = (await schoolHeader(actor.schoolId)).timezone;
        const start = DateTime.fromISO(`${nextDate}T${str(fd, "nextTime") || "09:00"}`, { zone: tz });
        const minutes = Number(str(fd, "nextMinutes")) || 60;
        try {
          if (!start.isValid || start < DateTime.now()) throw new PolicyError("Pick a time in the future.", "time_in_past");
          await withTenant(actor.schoolId, (tx) =>
            bookLesson(tx, userPrincipal(actor), {
              studentId: str(fd, "studentId"),
              slot: { start: start.toJSDate(), end: start.plus({ minutes }).toJSDate(), instructorId: actor.instructorId!, vehicleId: null },
              bookedVia: "staff",
              plannedTopicIds: nextTopics,
            }),
          );
          booked = start;
        } catch (e) {
          const locale = await getLocale();
          const reason = e instanceof AppError ? (tryTranslate(locale, `errors.${e.code}`) ?? e.message) : tryTranslate(locale, "errors.generic")!;
          throw new PolicyError(t("topics.bookFailed", { reason }), "next_lesson_not_booked");
        }
      }
      after(() => deliverNotifications(10).catch(() => undefined));
    },
    {
      back: `/instructor/feedback/${lessonId}`,
      success: "/instructor/feedback",
      okMessage: () => (booked ? t("topics.bookedFlash", { when: booked.setLocale(fmtLocale).toFormat("ccc d LLL HH:mm") }) : t("instructor.feedback.saved", { name: str(fd, "studentName") })),
    },
  );
}

export default async function FeedbackComposer({ params, searchParams }: { params: Promise<{ lessonId: string }>; searchParams: SearchParams }) {
  const lessonId = idOr404((await params).lessonId);
  const q = await sp(searchParams);
  const { actor, t, f, locale, school } = await requireInstructorProfile();
  const d = await withTenant(actor.schoolId, async (tx) => {
    const l = await one<{ id: string; instructor_id: string; student_id: string; status: string; start_time: Date; end_time: Date; lesson_number: number; student_name: string; current_level_id: string | null; level_position: number | null; done: number }>(
      tx,
      `SELECT l.id, l.instructor_id, l.student_id, l.status, l.start_time, l.end_time, l.lesson_number,
              s.first_name || ' ' || s.last_name AS student_name, s.current_level_id, ld.position AS level_position,
              (SELECT count(*)::int FROM lessons x WHERE x.student_id = s.id AND x.status = 'completed') AS done
         FROM lessons l JOIN students s ON s.id = l.student_id LEFT JOIN level_definitions ld ON ld.id = s.current_level_id
        WHERE l.id = $1`,
      [lessonId],
    );
    if (!l || (l.instructor_id !== actor.instructorId && !["school_owner", "school_admin"].includes(actor.role))) return null;
    const fb = await one<{ strengths: string | null; weaknesses: string | null; practice_items: string | null; next_focus: string | null; instructor_notes: string | null; overall_rating: number | null; visible_to_student: boolean }>(
      tx,
      `SELECT strengths, weaknesses, practice_items, next_focus, instructor_notes, overall_rating, visible_to_student FROM lesson_feedback WHERE lesson_id = $1`,
      [lessonId],
    );
    const levels = await many<{ id: string; name: string }>(tx, `SELECT id, COALESCE(name_translations->>$1, name) AS name FROM level_definitions ORDER BY position`, [locale]);
    const skills = await many<{ id: string; name: string; status: string | null }>(
      tx,
      `SELECT sk.id, COALESCE(sk.name_translations->>$3, sk.name) AS name, sp.status
         FROM skills sk JOIN level_definitions ld ON ld.id = sk.level_id
         LEFT JOIN student_skill_progress sp ON sp.skill_id = sk.id AND sp.student_id = $1
        WHERE sk.is_active AND ld.position BETWEEN COALESCE($2, 1) AND COALESCE($2, 1) + 1
        ORDER BY ld.position, sk.position`,
      [l.student_id, l.level_position, locale],
    );
    const topics = await listTopics(tx, locale);
    const next = await one<{ id: string; start_time: Date; end_time: Date }>(
      tx,
      `SELECT id, start_time, end_time FROM lessons WHERE student_id = $1 AND instructor_id = $2 AND status IN ('scheduled','confirmed') AND start_time > now() ORDER BY start_time LIMIT 1`,
      [l.student_id, l.instructor_id],
    );
    const tmap = await topicsForLessons(tx, next ? [lessonId, next.id] : [lessonId], locale);
    return { l, fb, levels, skills, topics, next, covered: (tmap.get(lessonId)?.covered ?? []).map((x) => x.id), plannedHere: tmap.get(lessonId)?.planned ?? [], nextPlanned: next ? (tmap.get(next.id)?.planned ?? []).map((x) => x.id) : [] };
  });
  if (!d) notFound();
  const { l, fb } = d;
  const band: Band = l.done <= 5 ? "early" : l.done <= 13 ? "mid" : "late";
  const bank = FEEDBACK[locale][band];
  const writable = ["completed", "in_progress"].includes(l.status);
  const skillLabels = {
    not_started: t("skillStatus.not_started"),
    in_progress: t("skillStatus.in_progress"),
    needs_improvement: t("skillStatus.needs_improvement"),
    completed: t("skillStatus.completed"),
  };

  return (
    <>
      <p><Link href="/instructor/feedback"><span className="flip">←</span> {t("instructor.feedback.title")}</Link></p>
      <div className="page-head" style={{ display: "block" }}>
        <span className="eyebrow">{t("common.lessonNo", { number: l.lesson_number })} · {f.date(l.start_time)} · <span className="num">{f.range(l.start_time, l.end_time)}</span></span>
        <h1 style={{ marginTop: 4 }}>{t("instructor.feedback.composerTitle", { name: l.student_name })}</h1>
      </div>
      <Flash searchParams={q} />
      {!writable ? (
        <div className="card"><p>{t("instructor.schedule.completeFirst")}</p><Link className="btn" href={`/lessons/${l.id}`}>{t("instructor.openLesson")}</Link></div>
      ) : (
        <form action={saveAction} className="fb-card">
          <input type="hidden" name="lessonId" value={l.id} />
          <input type="hidden" name="studentName" value={l.student_name.split(" ")[0]} />
          <section className="card" style={{ margin: 0 }}>
            <h2>{t("instructor.feedback.rating")}</h2>
            <div className="star-input" role="radiogroup" aria-label={t("instructor.feedback.rating")}>
              {[5, 4, 3, 2, 1].map((n) => (
                <Fragment key={n}>
                  <input type="radio" id={`r${n}`} name="rating" value={n} defaultChecked={fb?.overall_rating === n} />
                  <label htmlFor={`r${n}`} aria-label={`${n}/5`}>★</label>
                </Fragment>
              ))}
            </div>
          </section>
          <section className="card" style={{ margin: 0 }}>
            <h2>{t("topics.practisedTitle")}</h2>
            <p className="muted small">{t("topics.practisedHint")}</p>
            {d.plannedHere.length > 0 && <p className="small"><span className="muted">{t("topics.planned")}: </span>{d.plannedHere.map((x) => x.name).join(", ")}</p>}
            <TopicPicker name="covered" topics={d.topics} defaultSelected={d.covered.length ? d.covered : d.plannedHere.map((x) => x.id)} label={t("topics.practisedTitle")} placeholder={t("topics.choose")} />
          </section>
          <section className="card" style={{ margin: 0 }}>
            <div className="fb-grid">
              <PhraseField id="strengths" name="strengths" tone="good" label={t("instructor.lesson.wentWell")} defaultValue={fb?.strengths ?? ""} phrases={bank.strengths.slice(0, 3)} hint={t("instructor.feedback.quickAdd")} />
              <PhraseField id="weaknesses" name="weaknesses" tone="improve" label={t("instructor.lesson.toImprove")} defaultValue={fb?.weaknesses ?? ""} phrases={bank.weaknesses.slice(0, 3)} hint={t("instructor.feedback.quickAdd")} />
              <PhraseField id="practiceItems" name="practiceItems" tone="practice" label={t("instructor.lesson.toPractice")} defaultValue={fb?.practice_items ?? ""} phrases={bank.practice.slice(0, 3)} hint={t("instructor.feedback.quickAdd")} />
              <PhraseField id="nextFocus" name="nextFocus" tone="focus" label={t("instructor.lesson.nextFocus")} defaultValue={fb?.next_focus ?? ""} phrases={bank.next.slice(0, 3)} hint={t("instructor.feedback.quickAdd")} />
            </div>
          </section>
          <section className="card" style={{ margin: 0 }}>
            <h2>{t("instructor.lesson.skills")}</h2>
            <p className="muted small">{t("instructor.feedback.skillsHint")}</p>
            <SkillChips skills={d.skills} labels={skillLabels} />
            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label htmlFor="levelId">{t("instructor.lesson.studentLevel")}</label>
              <select id="levelId" name="levelId" defaultValue="">
                <option value="">{t("instructor.lesson.keepLevel")}{l.current_level_id ? ` (${d.levels.find((x) => x.id === l.current_level_id)?.name ?? ""})` : ""}</option>
                {d.levels.map((lv) => <option key={lv.id} value={lv.id}>{lv.name}</option>)}
              </select>
            </div>
          </section>
          <section className="card" style={{ margin: 0 }}>
            <h2>{t("topics.nextTitle")}</h2>
            <input type="hidden" name="studentId" value={l.student_id} />
            {d.next ? (
              <>
                <input type="hidden" name="nextLessonId" value={d.next.id} />
                <p className="small">{t("topics.nextBooked", { when: `${f.date(d.next.start_time)} ${f.range(d.next.start_time, d.next.end_time)}` })}</p>
              </>
            ) : (
              <>
                <p className="muted small">{t("topics.bookNext")}. {t("topics.bookNextHint")}</p>
                <div className="fields">
                  <div className="field"><label htmlFor="nextDate">{t("topics.date")}</label><input id="nextDate" name="nextDate" type="date" min={DateTime.now().toISODate()!} /></div>
                  <div className="field"><label htmlFor="nextTime">{t("topics.time")}</label><input id="nextTime" name="nextTime" type="time" step={900} defaultValue={DateTime.fromJSDate(l.start_time).setZone(school.timezone).toFormat("HH:mm")} /></div>
                  <input type="hidden" name="nextMinutes" value={Math.round((l.end_time.getTime() - l.start_time.getTime()) / 60000)} />
                </div>
              </>
            )}
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="tp-nextTopics">{t("topics.nextTopics")}</label>
              <TopicPicker name="nextTopics" id="tp-nextTopics" topics={d.topics} defaultSelected={d.nextPlanned} label={t("topics.nextTopics")} placeholder={t("topics.choose")} />
            </div>
          </section>
          <section className="card" style={{ margin: 0 }}>
            <label className="switch" htmlFor="visible">
              <span>
                {t("instructor.feedback.visible")}
                <span className="muted small" style={{ display: "block", fontWeight: 400 }}>{t("instructor.feedback.visibleHint")}</span>
              </span>
              <input type="checkbox" id="visible" name="visible" role="switch" defaultChecked={fb ? fb.visible_to_student : true} />
            </label>
            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label htmlFor="instructorNotes">{t("instructor.feedback.privateNote")}</label>
              <textarea id="instructorNotes" name="instructorNotes" rows={2} defaultValue={fb?.instructor_notes ?? ""} />
            </div>
          </section>
          <button className="primary block" type="submit" style={{ minHeight: 52, fontSize: "1rem" }}>{t("instructor.feedback.save")}</button>
        </form>
      )}
    </>
  );
}
