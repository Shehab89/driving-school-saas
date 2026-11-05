import { many, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { createVehicle, setVehicleStatus } from "@/server/services/staff";
import { runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import { schoolI18n } from "@/server/school";

async function create(fd: FormData) {
  "use server";
  const pt = await getPt();
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
  }, { back: "/admin/vehicles", okMessage: pt("Car added") });
}

async function changeStatus(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("vehicles:write");
    await withTenant(actor.schoolId, (tx) => setVehicleStatus(tx, userPrincipal(actor), str(fd, "vehicleId"), str(fd, "status") as "active"));
  }, { back: "/admin/vehicles", okMessage: pt("Saved") });
}

export default async function VehiclesPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("vehicles:write");
  const { pt } = await schoolI18n(actor.schoolId);
  const STATUS: Record<string, string> = { active: pt("In use"), maintenance: pt("In maintenance"), retired: pt("Retired") };
  const TYPES: Record<string, string> = { car: pt("Car"), motorcycle: pt("Motorcycle"), truck: pt("Truck"), bus: pt("Bus"), trailer: pt("Trailer"), other: pt("Other") };
  const vehicles = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; registration_number: string; brand: string; model: string; transmission: string; vehicle_type: string; license_category: string; status: string }>(
      tx,
      `SELECT * FROM vehicles ORDER BY status, brand`,
    ),
  );
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Cars")}</h1>
          <p>{pt("A car in maintenance is not offered for new lessons.")}</p>
        </div>
        <div className="actions"><a className="btn primary" href="#add-vehicle">{pt("Add car")}</a></div>
      </div>
      <Flash searchParams={q} />
      {vehicles.length > 0 && (
      <div className="card table-card">
        <div className="table-wrap">
        <table className="stack-table">
          <thead><tr><th>{pt("Number plate")}</th><th>{pt("Car")}</th><th>{pt("Gearbox")}</th><th>{pt("Category")}</th><th>{pt("Status")}</th></tr></thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v.id}>
                <td data-label={pt("Number plate")}><span className="plate" dir="ltr">{v.registration_number}</span></td>
                <td data-label={pt("Car")}><strong>{v.brand} {v.model}</strong> {v.vehicle_type !== "car" && <span className="muted small">({TYPES[v.vehicle_type] ?? v.vehicle_type})</span>}</td>
                <td data-label={pt("Gearbox")}>{v.transmission === "automatic" ? pt("Automatic") : pt("Manual")}</td>
                <td data-label={pt("Category")}>{v.license_category}</td>
                <td data-label={pt("Status")}>
                  <form action={changeStatus} className="row">
                    <input type="hidden" name="vehicleId" value={v.id} />
                    <select name="status" defaultValue={v.status} aria-label={pt("Status")} style={{ width: "auto", minHeight: 34 }}>
                      {Object.entries(STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                    <button className="sm">{pt("Save")}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      )}
      <details className="card" id="add-vehicle" open={vehicles.length === 0}>
        <summary>{pt("Add car")}</summary>
        <form action={create}>
          <div className="fields">
            <div className="field"><label htmlFor="registrationNumber">{pt("Number plate")}</label><input id="registrationNumber" name="registrationNumber" dir="ltr" required /></div>
            <div className="field"><label htmlFor="brand">{pt("Make")}</label><input id="brand" name="brand" placeholder="Volkswagen" required /></div>
            <div className="field"><label htmlFor="model">{pt("Model")}</label><input id="model" name="model" placeholder="Golf" required /></div>
            <div className="field"><label htmlFor="transmission">{pt("Gearbox")}</label><select id="transmission" name="transmission"><option value="manual">{pt("Manual")}</option><option value="automatic">{pt("Automatic")}</option></select></div>
            <div className="field"><label htmlFor="vehicleType">{pt("Type")}</label><select id="vehicleType" name="vehicleType">{Object.entries(TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="licenseCategory">{pt("Licence category")}</label><input id="licenseCategory" name="licenseCategory" defaultValue="B" /></div>
          </div>
          <button className="primary">{pt("Add car")}</button>
        </form>
      </details>
    </>
  );
}
