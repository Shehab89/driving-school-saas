import { many, one, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { updateOwnStudentProfile } from "@/server/services/students";
import { runAction, str } from "@/server/web";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function saveProfile(fd: FormData) {
  "use server";
  await runAction(
    async () => {
      const actor = await requireSchoolActor("profile:write_own");
      const availability = DAYS.flatMap((_, i) => {
        const start = str(fd, `start_${i + 1}`);
        const end = str(fd, `end_${i + 1}`);
        return start && end ? [{ weekday: i + 1, start, end }] : [];
      });
      await withTenant(actor.schoolId, (tx) =>
        updateOwnStudentProfile(tx, userPrincipal(actor), {
          phone: str(fd, "phone"),
          preferredTransmission: str(fd, "transmission") as "manual" | "automatic",
          availability,
        }),
      );
    },
    { back: "/student/profile", okMessage: "Profile saved" },
  );
}

export default async function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("profile:write_own");
  const d = await withTenant(actor.schoolId, async (tx) => ({
    s: (await one<{ first_name: string; last_name: string; email: string | null; phone: string | null; preferred_transmission: string; student_number: string }>(
      tx,
      `SELECT first_name, last_name, email, phone, preferred_transmission, student_number FROM students WHERE id = $1`,
      [actor.studentId],
    ))!,
    av: await many<{ weekday: number; start: string; end: string }>(
      tx,
      `SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end" FROM student_availability WHERE student_id = $1`,
      [actor.studentId],
    ),
  }));
  return (
    <div className="narrow">
      <h1>My profile</h1>
      <Flash searchParams={q} />
      <form action={saveProfile} className="card">
        <p className="muted small">{d.s.first_name} {d.s.last_name} · {d.s.student_number} · {d.s.email}</p>
        <div className="field">
          <label htmlFor="phone">Phone (international format, used for WhatsApp)</label>
          <input id="phone" name="phone" defaultValue={d.s.phone ?? ""} placeholder="+31 6 1234 5678" />
        </div>
        <div className="field">
          <label htmlFor="transmission">Preferred transmission</label>
          <select id="transmission" name="transmission" defaultValue={d.s.preferred_transmission}>
            <option value="manual">Manual</option>
            <option value="automatic">Automatic</option>
          </select>
        </div>
        <h2>When can you take lessons?</h2>
        <p className="muted small">Leave a day empty if you are not available. We only offer lesson times inside these windows.</p>
        {DAYS.map((day, i) => {
          const w = d.av.find((a) => a.weekday === i + 1);
          return (
            <div className="row" key={day} style={{ marginBottom: 6 }}>
              <span style={{ width: 40 }}>{day}</span>
              <input aria-label={`${day} from`} type="time" name={`start_${i + 1}`} defaultValue={w?.start ?? ""} style={{ width: 130 }} />
              <span>–</span>
              <input aria-label={`${day} until`} type="time" name={`end_${i + 1}`} defaultValue={w?.end ?? ""} style={{ width: 130 }} />
            </div>
          );
        })}
        <button className="primary" type="submit" style={{ marginTop: 12 }}>Save</button>
      </form>
    </div>
  );
}
