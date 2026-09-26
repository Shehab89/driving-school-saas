import Link from "next/link";
import { withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { feedbackQueue } from "@/server/services/feedback";
import { requireInstructorProfile } from "../data";

function Stars({ n }: { n: number | null }) {
  if (!n) return null;
  return (
    <span className="stars" aria-label={`${n}/5`}>
      {"★".repeat(n)}
      <span className="off">{"★".repeat(5 - n)}</span>
    </span>
  );
}

export default async function FeedbackInbox({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f } = await requireInstructorProfile();
  const { waiting, recent } = await withTenant(actor.schoolId, (tx) => feedbackQueue(tx, actor.instructorId));
  return (
    <>
      <div className="page-head"><h1>{t("instructor.feedback.title")}</h1></div>
      <Flash searchParams={q} />
      <section className="card">
        <div className="spread" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{t("instructor.feedback.waiting")}</h2>
          {waiting.length > 0 && <span className="badge new">{waiting.length}</span>}
        </div>
        {waiting.length === 0 && <p className="empty">{t("instructor.feedback.waitingEmpty")}</p>}
        {waiting.map((l) => (
          <Link key={l.lesson_id} href={`/instructor/feedback/${l.lesson_id}`} className="list-row">
            <span className="avatar" aria-hidden="true">{l.student_name.trim()[0]}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{l.student_name}</strong>
              <span className="sub" style={{ display: "block" }}>
                {t("common.lessonNo", { number: l.lesson_number })} · {f.shortDate(l.start_time)} · <span className="num">{f.range(l.start_time, l.end_time)}</span>
              </span>
            </span>
            <span className="btn sm accent">{t("instructor.feedback.give")}</span>
          </Link>
        ))}
      </section>
      <section className="card">
        <h2>{t("instructor.feedback.recent")}</h2>
        {recent.map((l) => (
          <Link key={l.lesson_id} href={`/instructor/feedback/${l.lesson_id}`} className="list-row">
            <span className="avatar" aria-hidden="true">{l.student_name.trim()[0]}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{l.student_name}</strong> <Stars n={l.overall_rating} />
              <span className="sub" style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t("common.lessonNo", { number: l.lesson_number })} · {f.shortDate(l.start_time)}
                {l.next_focus ? ` · → ${l.next_focus}` : ""}
              </span>
            </span>
            {!l.visible_to_student ? (
              <span className="badge">{t("instructor.feedback.hidden")}</span>
            ) : l.seen_at ? (
              <span className="badge success">{t("instructor.feedback.seen")}</span>
            ) : (
              <span className="badge warning">{t("instructor.feedback.notSeen")}</span>
            )}
          </Link>
        ))}
      </section>
    </>
  );
}
