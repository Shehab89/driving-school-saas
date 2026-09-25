import { many, withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { createVehicle, setVehicleStatus } from "@/server/services/staff";
import { runAction, str } from "@/server/web";

async function create(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("vehicles:write");
    await withTenant(actor.schoolId, (tx) =>
      createVehicle(tx, userPrincipal(actor), {
        registrationNumber: str(fd, "registrationNumber"),
        brand: str(fd, "brand"),
        model: str(fd, "model"),
        transmission: str(fd, "transmission") as "manual" | "automatic",
        vehicleType: (str(fd, "vehicleType") || "car") as "car",
        licenseCategory: str(fd, "licenseCategory") || "B",
      }),
    );
  }, { back: "/admin/vehicles", okMessage: "Vehicle added" });
}

async function changeStatus(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("vehicles:write");
    await withTenant(actor.schoolId, (tx) => setVehicleStatus(tx, userPrincipal(actor), str(fd, "vehicleId"), str(fd, "status") as "active"));
  }, { back: "/admin/vehicles" });
}

export default async function VehiclesPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("vehicles:write");
  const vehicles = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; registration_number: string; brand: string; model: string; transmission: string; vehicle_type: string; license_category: string; status: string }>(
      tx,
      `SELECT * FROM vehicles ORDER BY status, brand`,
    ),
  );
  return (
    <>
      <h1>Vehicles</h1>
      <Flash searchParams={q} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Registration</th><th>Vehicle</th><th>Transmission</th><th>Category</th><th>Status</th></tr></thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td>{v.registration_number}</td>
                <td>{v.brand} {v.model} <span className="muted small">({v.vehicle_type})</span></td>
                <td>{v.transmission}</td>
                <td>{v.license_category}</td>
                <td>
                  <form action={changeStatus} className="row">
                    <input type="hidden" name="vehicleId" value={v.id} />
                    <Badge value={v.status === "active" ? "active" : "pending"} label={v.status} />
                    <select name="status" defaultValue={v.status} aria-label="Status" style={{ width: "auto", minHeight: 32 }}>
                      <option value="active">active</option><option value="maintenance">maintenance</option><option value="retired">retired</option>
                    </select>
                    <button style={{ minHeight: 32 }}>Set</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="card" open={vehicles.length === 0}>
        <summary><strong>Add vehicle</strong></summary>
        <form action={create} style={{ marginTop: 12 }}>
          <div className="fields">
            <div className="field"><label htmlFor="registrationNumber">Registration</label><input id="registrationNumber" name="registrationNumber" required /></div>
            <div className="field"><label htmlFor="brand">Brand</label><input id="brand" name="brand" required /></div>
            <div className="field"><label htmlFor="model">Model</label><input id="model" name="model" required /></div>
            <div className="field"><label htmlFor="transmission">Transmission</label><select id="transmission" name="transmission"><option value="manual">Manual</option><option value="automatic">Automatic</option></select></div>
            <div className="field"><label htmlFor="vehicleType">Type</label><select id="vehicleType" name="vehicleType"><option>car</option><option>motorcycle</option><option>truck</option><option>bus</option><option>trailer</option><option>other</option></select></div>
            <div className="field"><label htmlFor="licenseCategory">Licence category</label><input id="licenseCategory" name="licenseCategory" defaultValue="B" /></div>
          </div>
          <button className="primary">Add vehicle</button>
        </form>
      </details>
    </>
  );
}
