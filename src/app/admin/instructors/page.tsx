import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { createInstructor, makeOwnerAnInstructor } from "@/server/services/staff";
import { bool, optStr, runAction, str } from "@/server/web";

async function create(fd: FormData) {
  "use server";
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
  }, { back: "/admin/instructors", okMessage: "Instructor added" });
}

async function linkSelf() {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor();
    await withTenant(actor.schoolId, (tx) => makeOwnerAnInstructor(tx, userPrincipal(actor)));
  }, { back: "/admin/instructors", okMessage: "You are now also an instructor" });
}

export default async function InstructorsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("instructors:write");
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
      <h1>Instructors</h1>
      <Flash searchParams={q} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Contact</th><th>Categories</th><th>Default car</th><th>Upcoming</th><th /></tr></thead>
          <tbody>
            {d.instructors.map((i) => (
              <tr key={i.id}>
                <td>{i.name} <Badge value={i.status} /></td>
                <td className="small">{i.email}<br />{i.phone}</td>
                <td>{i.categories.join(", ")}</td>
                <td>{i.vehicle ?? "—"}</td>
                <td>{i.upcoming}</td>
                <td><Link href={`/instructor/availability?instructor=${i.id}`}>{i.hours ? "Availability" : "Set availability ⚠"}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!actor.instructorId && (
          <form action={linkSelf} style={{ marginTop: 12 }}>
            <button>I teach lessons myself — add me as instructor</button>
          </form>
        )}
      </div>
      <details className="card">
        <summary><strong>Add instructor</strong></summary>
        <form action={create} style={{ marginTop: 12 }}>
          <div className="fields">
            <div className="field"><label htmlFor="firstName">First name</label><input id="firstName" name="firstName" required /></div>
            <div className="field"><label htmlFor="lastName">Last name</label><input id="lastName" name="lastName" required /></div>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" type="email" name="email" required /></div>
            <div className="field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" /></div>
            <div className="field"><label htmlFor="categories">Licence categories (comma separated)</label><input id="categories" name="categories" defaultValue="B" /></div>
            <div className="field"><label htmlFor="vehicleId">Default vehicle</label><select id="vehicleId" name="vehicleId"><option value="">None</option>{d.vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
            <div className="field"><label htmlFor="color">Calendar colour</label><input id="color" type="color" name="color" defaultValue="#1f6feb" /></div>
          </div>
          <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" name="createLogin" defaultChecked /> Send login invitation</label>
          <button className="primary">Add instructor</button>
        </form>
      </details>
    </>
  );
}
