import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { StatusBadge, Flash, PAGE_SIZE, Pager, pageParam, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { createStudent } from "@/server/services/students";
import { bool, optStr, runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";
import { getPt } from "@/i18n/server";
import { schoolI18n } from "@/server/school";

async function create(fd: FormData) {
  "use server";
  const pt = await getPt();
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
  }, { back: "/admin/students", okMessage: pt("Student added") });
}

export default async function StudentsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:read_all");
  const search = q.q ?? "";
  const page = pageParam(q.page);
  const { school, t, f, pt } = await schoolI18n(actor.schoolId);
  const { students, instructors } = await withTenant(actor.schoolId, async (tx) => ({
    students: await many<{ id: string; student_number: string; name: string; email: string | null; phone: string | null; status: string; level: string | null; level_confirmed: boolean; next_lesson: Date | null; open_cents: number }>(
      tx,
      `SELECT s.id, s.student_number, s.first_name || ' ' || s.last_name AS name, s.email, s.phone, s.status, ld.position::text AS level, s.level_confirmed,
              (SELECT min(start_time) FROM lessons l WHERE l.student_id = s.id AND l.status IN ('scheduled','confirmed') AND l.start_time > now()) AS next_lesson,
              (SELECT COALESCE(sum(amount_cents),0)::int FROM payments p WHERE p.student_id = s.id AND p.status IN ('pending','overdue','failed')) AS open_cents
         FROM students s LEFT JOIN level_definitions ld ON ld.id = s.current_level_id
        WHERE s.status <> 'archived' AND ($1 = '' OR s.first_name || ' ' || s.last_name ILIKE '%' || $1 || '%' OR s.email ILIKE '%' || $1 || '%' OR s.phone ILIKE '%' || $1 || '%' OR s.student_number ILIKE '%' || $1 || '%')
        ORDER BY s.status = 'lead' DESC, s.last_name, s.first_name, s.id LIMIT $2 OFFSET $3`,
      [search, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE],
    ),
    instructors: await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active'`),
  }));
  const adding = q.new === "1" || (students.length === 0 && !search);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Students")}</h1>
          <p>{pt("Everyone learning at your school. New sign-ups are shown first.")}</p>
        </div>
        <div className="actions"><a className="btn primary" href="#add-student">{pt("Add student")}</a></div>
      </div>
      <Flash searchParams={q} />
      <form className="filters" role="search">
        <div className="field grow">
          <label htmlFor="q" className="sr-only">{pt("Search")}</label>
          <input id="q" name="q" type="search" defaultValue={search} placeholder={pt("Search by name, e-mail, phone or number")} />
        </div>
        <button>{pt("Search")}</button>
        {search && <Link className="btn ghost" href="/admin/students">{pt("Clear")}</Link>}
      </form>
      <div className="card table-card">
        {students.length === 0 ? (
          <p className="empty">{search ? pt("No students match “{q}”.", { q: search }) : pt("No students yet. Add your first student below.")}</p>
        ) : (
        <div className="table-wrap">
        <table className="stack-table">
          <thead><tr><th>{pt("Name")}</th><th>{pt("Contact")}</th><th>{pt("Level")}</th><th>{pt("Next lesson")}</th><th>{pt("To pay")}</th><th>{pt("Status")}</th></tr></thead>
          <tbody>
            {students.slice(0, PAGE_SIZE).map((s) => (
              <tr key={s.id}>
                <td data-label={pt("Name")}><Link href={`/students/${s.id}`}><strong>{s.name}</strong></Link><div className="small muted">#{s.student_number}</div></td>
                <td data-label={pt("Contact")} className="small"><span dir="ltr">{s.email}</span>{s.email && s.phone ? <br /> : null}<span dir="ltr">{s.phone}</span></td>
                <td data-label={pt("Level")}>{s.level ?? "—"}{s.level && !s.level_confirmed && <span title={pt("Suggested by the WhatsApp assistant, not yet confirmed")}> *</span>}</td>
                <td data-label={pt("Next lesson")} className="small">{s.next_lesson ? f.dateTime(s.next_lesson) : "—"}</td>
                <td data-label={pt("To pay")} className="num">{s.open_cents ? <span style={{ color: "var(--danger)" }}>{f.money(s.open_cents, school.currency)}</span> : "—"}</td>
                <td data-label={pt("Status")}><StatusBadge value={s.status} t={t} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
        <div style={{ padding: "0 18px 14px" }}>
          <Pager pt={pt} page={page} hasNext={students.length > PAGE_SIZE} href={(n) => `/admin/students?${new URLSearchParams({ ...(search ? { q: search } : {}), page: String(n) })}`} />
          <p className="small muted" style={{ margin: 0 }}>* {pt("Suggested by the WhatsApp assistant, not yet confirmed")}</p>
        </div>
      </div>

      <details className="card" id="add-student" open={adding}>
        <summary>{pt("Add student")}</summary>
        <form action={create}>
          <div className="fields">
            <div className="field"><label htmlFor="firstName">{pt("First name")}</label><input id="firstName" name="firstName" required autoComplete="off" /></div>
            <div className="field"><label htmlFor="lastName">{pt("Last name")}</label><input id="lastName" name="lastName" autoComplete="off" /></div>
            <div className="field"><label htmlFor="email">{pt("E-mail")}</label><input id="email" type="email" name="email" dir="ltr" /></div>
            <div className="field"><label htmlFor="phone">{pt("Mobile number (with country code, e.g. +31 6…)")}</label><input id="phone" name="phone" type="tel" dir="ltr" /></div>
            <div className="field"><label htmlFor="dateOfBirth">{pt("Date of birth")}</label><input id="dateOfBirth" type="date" name="dateOfBirth" /></div>
            <div className="field"><label htmlFor="licenseCategory">{pt("Licence category")}</label><input id="licenseCategory" name="licenseCategory" defaultValue="B" /></div>
            <div className="field"><label htmlFor="transmission">{pt("Gearbox")}</label><select id="transmission" name="transmission"><option value="manual">{pt("Manual")}</option><option value="automatic">{pt("Automatic")}</option></select></div>
            <div className="field"><label htmlFor="instructorId">{pt("Instructor")}</label><select id="instructorId" name="instructorId"><option value="">{pt("Any instructor")}</option>{instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
          </div>
          <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" name="createLogin" defaultChecked /> {pt("Give the student the app: send a welcome e-mail with a sign-in link")}</label>
          <button className="primary">{pt("Add student")}</button>
        </form>
      </details>
    </>
  );
}
