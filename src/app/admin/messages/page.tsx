import { many, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { audienceCounts, MAX_ANNOUNCEMENTS_PER_DAY, recentAnnouncements, sendAnnouncement, type Audience } from "@/server/services/announcements";
import { num, optStr, runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import { schoolI18n } from "@/server/school";

export const metadata = { title: "Message students" };

async function send(fd: FormData) {
  "use server";
  const pt = await getPt();
  let count = 0;
  await runAction(async () => {
    const actor = await requireSchoolActor("students:write");
    const r = await withTenant(actor.schoolId, (tx) =>
      sendAnnouncement(tx, userPrincipal(actor), {
        audience: str(fd, "audience") as Audience,
        instructorId: optStr(fd, "instructorId"),
        days: num(fd, "days") ?? 2,
        subject: str(fd, "subject"),
        body: String(fd.get("body") ?? "").trim(),
      }),
    );
    count = r.recipients;
  }, { back: "/admin/messages", okMessage: () => pt("Sent to {count} students. You can follow it under Sent messages.", { count }) });
}

/** One message to many students: "closed today because of the snow", "new prices from 1 January". */
export default async function MessagesPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:write");
  const { pt, f } = await schoolI18n(actor.schoolId);
  const { counts, instructors, recent } = await withTenant(actor.schoolId, async (tx) => ({
    counts: await audienceCounts(tx, 2),
    instructors: await many<{ id: string; name: string; n: number }>(
      tx,
      `SELECT i.id, i.first_name || ' ' || i.last_name AS name,
              (SELECT count(*)::int FROM students s WHERE s.status = 'active' AND (s.primary_instructor_id = i.id OR EXISTS (
                 SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = i.id AND l.status IN ('scheduled','confirmed') AND l.start_time >= now()))) AS n
         FROM instructors i WHERE i.status = 'active' ORDER BY i.first_name`,
    ),
    recent: await recentAnnouncements(tx, 10),
  }));
  const AUD: Record<Audience, string> = { all: pt("All active students"), upcoming: pt("Students with a lesson soon"), instructor: pt("Students of one instructor") };
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Message students")}</h1>
          <p>{pt("Send one message to many students at once, for example when the school is closed because of snow. Each student gets it by e-mail, or by WhatsApp if they chose that.")}</p>
        </div>
      </div>
      <Flash searchParams={q} />
      <form action={send} className="card narrow" style={{ maxWidth: 720 }}>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>{pt("Who gets it")}</legend>
          <div className="aud-list">
            <label className="aud-opt">
              <input type="radio" name="audience" value="upcoming" defaultChecked />
              <span>{AUD.upcoming} <span className="muted small">({pt("{count} now, for 2 days", { count: counts.upcoming })})</span></span>
              <span className="aud-more">
                <span className="muted small">{pt("lesson in the next")}</span>
                <select name="days" defaultValue="2" aria-label={pt("Days ahead")}>
                  {[1, 2, 3, 7, 14].map((d) => <option key={d} value={d}>{pt("{count} days", { count: d })}</option>)}
                </select>
              </span>
            </label>
            <label className="aud-opt">
              <input type="radio" name="audience" value="all" />
              <span>{AUD.all} <span className="muted small">({counts.all})</span></span>
            </label>
            {instructors.length > 1 && (
              <label className="aud-opt">
                <input type="radio" name="audience" value="instructor" />
                <span>{AUD.instructor}</span>
                <span className="aud-more">
                  <select name="instructorId" aria-label={pt("Instructor")}>
                    {instructors.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.n})</option>)}
                  </select>
                </span>
              </label>
            )}
          </div>
        </fieldset>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="subject">{pt("Title")}</label>
          <input id="subject" name="subject" required maxLength={120} placeholder={pt("Closed today because of snow")} />
        </div>
        <div className="field">
          <label htmlFor="body">{pt("Message")}</label>
          <textarea id="body" name="body" required maxLength={2000} rows={6} placeholder={pt("All lessons today are cancelled because the roads are not safe. We will contact you to plan a new time.")} />
          <p className="small muted" style={{ margin: "4px 0 0" }}>{pt("Each message starts with “Hi” and the student's first name. At most {max} messages like this a day.", { max: MAX_ANNOUNCEMENTS_PER_DAY })}</p>
        </div>
        <button className="primary">{pt("Send message")}</button>
      </form>

      {recent.length > 0 && (
        <section className="card">
          <h2>{pt("Sent earlier")}</h2>
          {recent.map((a) => (
            <div key={a.id} className="list-row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{a.subject}</strong>
                <div className="sub">{f.dateTime(a.created_at)} · {AUD[a.audience]}</div>
                <div className="small muted" style={{ whiteSpace: "pre-line", marginTop: 4 }}>{a.body.length > 220 ? `${a.body.slice(0, 220)}…` : a.body}</div>
              </div>
              <span className="small muted num" style={{ whiteSpace: "nowrap" }}>{pt("{sent} of {count} sent", { sent: a.sent, count: a.recipients })}{a.failed ? ` · ${pt("{count} failed", { count: a.failed })}` : ""}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
