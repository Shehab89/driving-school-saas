import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { createStudent } from "@/server/services/students";
import { bool, optStr, runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";

async function create(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("students:write");
    await withTenant(actor.schoolId, (tx) =>
      createStudent(tx, userPrincipal(actor), {
        firstName: str(fd, "firstName"),
        lastName: str(fd, "lastName"),
        email: optStr(fd, "email"),
        phone: optStr(fd, "phone"),
        dateOfBirth: optStr(fd, "dateOfBirth"),
        licenseCategory: str(fd, "licenseCategory") || "B",
        preferredTransmission: str(fd, "transmission") as "manual" | "automatic",
        primaryInstructorId: optStr(fd, "instructorId"),
        createLogin: bool(fd, "createLogin"),
      }),
    );
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: "/admin/students", okMessage: "Student created" });
}

export default async function StudentsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:read_all");
  const search = q.q ?? "";
  const { students, instructors } = await withTenant(actor.schoolId, async (tx) => ({
    students: await many<{ id: string; student_number: string; name: string; email: string | null; phone: string | null; status: string; level: string | null; level_confirmed: boolean; next_lesson: Date | null; open_cents: number }>(
      tx,
      `SELECT s.id, s.student_number, s.first_name || ' ' || s.last_name AS name, s.email, s.phone, s.status, ld.position::text AS level, s.level_confirmed,
              (SELECT min(start_time) FROM lessons l WHERE l.student_id = s.id AND l.status IN ('scheduled','confirmed') AND l.start_time > now()) AS next_lesson,
              (SELECT COALESCE(sum(amount_cents),0)::int FROM payments p WHERE p.student_id = s.id AND p.status IN ('pending','overdue','failed')) AS open_cents
         FROM students s LEFT JOIN level_definitions ld ON ld.id = s.current_level_id
        WHERE s.status <> 'archived' AND ($1 = '' OR s.first_name || ' ' || s.last_name ILIKE '%' || $1 || '%' OR s.email ILIKE '%' || $1 || '%' OR s.phone ILIKE '%' || $1 || '%' OR s.student_number ILIKE '%' || $1 || '%')
        ORDER BY s.status = 'lead' DESC, s.last_name, s.first_name LIMIT 200`,
      [search],
    ),
    instructors: await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active'`),
  }));
  return (
    <>
      <h1>Students</h1>
      <Flash searchParams={q} />
      <form className="row" style={{ marginBottom: 12 }}>
        <input name="q" defaultValue={search} placeholder="Search name, e-mail, phone, number" style={{ maxWidth: 360 }} aria-label="Search" />
        <button>Search</button>
      </form>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>No.</th><th>Name</th><th>Contact</th><th>Level</th><th>Next lesson</th><th>Open</th><th>Status</th></tr></thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id}>
                <td>{s.student_number}</td>
                <td><Link href={`/students/${s.id}`}>{s.name}</Link></td>
                <td className="small">{s.email}<br />{s.phone}</td>
                <td>{s.level ?? "—"}{s.level && !s.level_confirmed && " *"}</td>
                <td className="small">{s.next_lesson ? s.next_lesson.toISOString().slice(0, 10) : "—"}</td>
                <td>{s.open_cents ? (s.open_cents / 100).toFixed(2) : "—"}</td>
                <td><Badge value={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">* level suggested by the WhatsApp assessment, not yet confirmed</p>
      </div>

      <details className="card" open={students.length === 0}>
        <summary><strong>Add student</strong></summary>
        <form action={create} style={{ marginTop: 12 }}>
          <div className="fields">
            <div className="field"><label htmlFor="firstName">First name</label><input id="firstName" name="firstName" required /></div>
            <div className="field"><label htmlFor="lastName">Last name</label><input id="lastName" name="lastName" /></div>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" type="email" name="email" /></div>
            <div className="field"><label htmlFor="phone">Phone (+country code)</label><input id="phone" name="phone" /></div>
            <div className="field"><label htmlFor="dateOfBirth">Date of birth</label><input id="dateOfBirth" type="date" name="dateOfBirth" /></div>
            <div className="field"><label htmlFor="licenseCategory">Licence category</label><input id="licenseCategory" name="licenseCategory" defaultValue="B" /></div>
            <div className="field"><label htmlFor="transmission">Transmission</label><select id="transmission" name="transmission"><option value="manual">Manual</option><option value="automatic">Automatic</option></select></div>
            <div className="field"><label htmlFor="instructorId">Instructor</label><select id="instructorId" name="instructorId"><option value="">Any</option>{instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
          </div>
          <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" name="createLogin" defaultChecked /> Create login &amp; send welcome e-mail</label>
          <button className="primary">Add student</button>
        </form>
      </details>
    </>
  );
}
