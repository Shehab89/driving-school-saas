import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { StatusBadge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { createInstructor, makeOwnerAnInstructor } from "@/server/services/staff";
import { bool, optStr, runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import { schoolI18n } from "@/server/school";

async function create(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("instructors:write");
    await withTenant(actor.schoolId, (tx) =>
      createInstructor(tx, userPrincipal(actor), {
        firstName: str(fd, "firstName"),
        lastName: str(fd, "lastName"),
        email: str(fd, "email"),
        phone: optStr(fd, "phone"),
        licenseCategories: str(fd, "categories").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
        defaultVehicleId: optStr(fd, "vehicleId"),
        color: optStr(fd, "color"),
        createLogin: bool(fd, "createLogin"),
      }),
    );
  }, { back: "/admin/instructors", okMessage: pt("Instructor added") });
}

async function linkSelf() {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor();
    await withTenant(actor.schoolId, (tx) => makeOwnerAnInstructor(tx, userPrincipal(actor)));
  }, { back: "/admin/instructors", okMessage: pt("You are now also an instructor") });
}

export default async function InstructorsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("instructors:write");
  const { t, pt } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => ({
    instructors: await many<{ id: string; name: string; email: string | null; phone: string | null; categories: string[]; vehicle: string | null; status: string; hours: number; upcoming: number }>(
      tx,
      `SELECT i.id, i.first_name || ' ' || i.last_name AS name, i.email, i.phone, i.license_categories AS categories, i.status,
              v.brand || ' ' || v.model AS vehicle,
              (SELECT count(*)::int FROM instructor_availability a WHERE a.instructor_id = i.id) AS hours,
              (SELECT count(*)::int FROM lessons l WHERE l.instructor_id = i.id AND l.status IN ('scheduled','confirmed') AND l.start_time > now()) AS upcoming
         FROM instructors i LEFT JOIN vehicles v ON v.id = i.default_vehicle_id ORDER BY i.status, i.first_name`,
    ),
    vehicles: await many<{ id: string; label: string }>(tx, `SELECT id, brand || ' ' || model || ' (' || registration_number || ')' AS label FROM vehicles WHERE status = 'active'`),
  }));
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Instructors")}</h1>
          <p>{pt("Students can only book an instructor who has working hours set.")}</p>
        </div>
        <div className="actions"><a className="btn primary" href="#add-instructor">{pt("Add instructor")}</a></div>
      </div>
      <Flash searchParams={q} />
      <div className="card table-card">
        <div className="table-wrap">
        <table className="stack-table">
          <thead><tr><th>{pt("Name")}</th><th>{pt("Contact")}</th><th>{pt("Categories")}</th><th>{pt("Usual car")}</th><th>{pt("Upcoming lessons")}</th><th>{pt("Working hours")}</th></tr></thead>
          <tbody>
            {d.instructors.map((i) => (
              <tr key={i.id}>
                <td data-label={pt("Name")}><strong>{i.name}</strong> <StatusBadge value={i.status} t={t} /></td>
                <td data-label={pt("Contact")} className="small"><span dir="ltr">{i.email}</span>{i.email && i.phone ? <br /> : null}<span dir="ltr">{i.phone}</span></td>
                <td data-label={pt("Categories")}>{i.categories.join(", ")}</td>
                <td data-label={pt("Usual car")}>{i.vehicle ?? "—"}</td>
                <td data-label={pt("Upcoming lessons")} className="num">{i.upcoming}</td>
                <td data-label={pt("Working hours")}>
                  {i.hours
                    ? <Link className="btn sm" href={`/instructor/availability?instructor=${i.id}`}>{pt("Edit hours")}</Link>
                    : <Link className="btn sm accent" href={`/instructor/availability?instructor=${i.id}`}>{pt("Set hours")}</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {!actor.instructorId && (
          <form action={linkSelf} style={{ padding: "0 18px 16px" }}>
            <button className="sm">{pt("I teach lessons myself: add me as an instructor")}</button>
          </form>
        )}
      </div>
      <details className="card" id="add-instructor" open={d.instructors.length === 0}>
        <summary>{pt("Add instructor")}</summary>
        <form action={create}>
          <div className="fields">
            <div className="field"><label htmlFor="firstName">{pt("First name")}</label><input id="firstName" name="firstName" required /></div>
            <div className="field"><label htmlFor="lastName">{pt("Last name")}</label><input id="lastName" name="lastName" required /></div>
            <div className="field"><label htmlFor="email">{pt("E-mail")}</label><input id="email" type="email" name="email" dir="ltr" required /></div>
            <div className="field"><label htmlFor="phone">{pt("Phone")}</label><input id="phone" name="phone" type="tel" dir="ltr" /></div>
            <div className="field"><label htmlFor="categories">{pt("Licence categories (e.g. B or B, A)")}</label><input id="categories" name="categories" defaultValue="B" /></div>
            <div className="field"><label htmlFor="vehicleId">{pt("Usual car")}</label><select id="vehicleId" name="vehicleId"><option value="">{pt("None")}</option>{d.vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
            <div className="field"><label htmlFor="color">{pt("Colour in the calendar")}</label><input id="color" type="color" name="color" defaultValue="#2f5bd3" /></div>
          </div>
          <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" name="createLogin" defaultChecked /> {pt("Send an e-mail so they can use the instructor app")}</label>
          <button className="primary">{pt("Add instructor")}</button>
        </form>
      </details>
    </>
  );
}
