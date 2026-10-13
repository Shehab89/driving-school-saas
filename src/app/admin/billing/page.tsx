import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { formatMoney } from "@/lib/time";
import { formatVatRate } from "@/lib/vat";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { updateSchoolProfileAndSettings } from "@/server/services/schools";
import { createPackage, listPackages, setPackageActive } from "@/server/services/packages";
import { schoolHeader } from "@/server/school";
import { bool, num, runAction, str } from "@/server/web";
import { ValidationError } from "@/lib/errors";

async function saveBilling(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    const mode = str(fd, "payment_mode");
    if (!["after_lesson", "at_booking", "credits"].includes(mode)) throw new ValidationError("Choose how students pay.");
    const rate = num(fd, "vat_rate");
    if (rate === undefined || rate < 0 || rate > 100) throw new ValidationError("VAT rate must be between 0 and 100%.");
    const iban = str(fd, "iban").replace(/\s+/g, "").toUpperCase();
    if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new ValidationError("This IBAN does not look right.");
    await withTenant(actor.schoolId, (tx) =>
      updateSchoolProfileAndSettings(tx, userPrincipal(actor), {
        school: {},
        settings: {
          payment_mode: mode,
          vat_rate_bps: Math.round(rate * 100),
          prices_include_vat: bool(fd, "prices_include_vat"),
          vat_number: str(fd, "vat_number") || null,
          chamber_of_commerce_number: str(fd, "kvk") || null,
          iban: iban || null,
          vat_exemption_note: str(fd, "vat_exemption_note") || null,
        },
      }),
    );
  }, { back: "/admin/billing", okMessage: "Billing settings saved" });
}

async function addPackage(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    const euros = num(fd, "price");
    await withTenant(actor.schoolId, (tx) =>
      createPackage(tx, userPrincipal(actor), {
        name: str(fd, "name"),
        description: str(fd, "description") || undefined,
        lessonCount: str(fd, "lessons"),
        priceCents: euros === undefined ? 0 : Math.round(euros * 100),
        soldOnline: bool(fd, "sold_online"),
      }),
    );
  }, { back: "/admin/billing#packages", okMessage: "Package added" });
}

async function togglePackage(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    await withTenant(actor.schoolId, (tx) => setPackageActive(tx, userPrincipal(actor), str(fd, "packageId"), str(fd, "active") === "true"));
  }, { back: "/admin/billing#packages" });
}

const MODES = [
  ["after_lesson", "After each lesson", "An invoice is sent when the instructor completes the lesson. Most common."],
  ["at_booking", "In advance, at booking", "An invoice is sent as soon as a lesson is booked, due before the lesson. Unpaid invoices are cancelled automatically when the lesson is cancelled in time."],
  ["credits", "Lesson packages (prepaid)", "Students buy packages; each lesson uses one credit. Students need credit to book online. Without credit, a lesson is invoiced afterwards."],
] as const;

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("pricing:write");
  const school = await schoolHeader(actor.schoolId);
  const { ctx, packages } = await withTenant(actor.schoolId, async (tx) => ({
    ctx: await loadSchoolContext(tx, actor.schoolId),
    packages: await listPackages(tx, { includeInactive: true }),
  }));
  const s = ctx.settings;
  const money = (c: number) => formatMoney(c, school.currency, school.locale);
  return (
    <>
      <h1>Billing</h1>
      <Flash searchParams={q} />
      <form action={saveBilling} className="card">
        <h2>How students pay</h2>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="sr-only">Payment model</legend>
          {MODES.map(([value, label, help]) => (
            <label key={value} className="check" style={{ alignItems: "flex-start", marginBottom: 10 }}>
              <input type="radio" name="payment_mode" value={value} defaultChecked={s.payment_mode === value} />
              <span><strong>{label}</strong><br /><span className="small muted">{help}</span></span>
            </label>
          ))}
        </fieldset>
        <h2>VAT and invoice details</h2>
        <div className="fields">
          <div className="field"><label htmlFor="vat_rate">VAT rate (%)</label><input id="vat_rate" name="vat_rate" type="number" min={0} max={100} step="0.01" defaultValue={s.vat_rate_bps / 100} /></div>
          <div className="field"><label htmlFor="vat_number">VAT number (btw-id)</label><input id="vat_number" name="vat_number" defaultValue={s.vat_number ?? ""} placeholder="NL000099998B57" /></div>
          <div className="field"><label htmlFor="kvk">Chamber of Commerce (KvK) number</label><input id="kvk" name="kvk" defaultValue={s.chamber_of_commerce_number ?? ""} /></div>
          <div className="field"><label htmlFor="iban">IBAN for bank transfers</label><input id="iban" name="iban" defaultValue={s.iban ?? ""} /></div>
          <div className="field"><label htmlFor="vat_exemption_note">Note when VAT is 0% (e.g. small business scheme)</label><input id="vat_exemption_note" name="vat_exemption_note" defaultValue={s.vat_exemption_note ?? ""} /></div>
        </div>
        <label className="check"><input type="checkbox" name="prices_include_vat" defaultChecked={s.prices_include_vat} /> My lesson prices include VAT</label>
        <p className="small muted">
          Invoices show the VAT rate, net amount and VAT separately; the rate is frozen on each invoice when it is issued.
          Whether VAT applies to your lessons, and at which rate, is something to confirm with your accountant. DriveDesk does not give tax advice.
        </p>
        <button className="primary" type="submit">Save billing settings</button>
      </form>

      <section className="card" id="packages">
        <h2>Lesson packages</h2>
        <p className="small muted">Packages are used when students pay in advance with credits. Credits are added only once the payment is confirmed.</p>
        {packages.length === 0 ? <p className="muted">No packages yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Package</th><th>Lessons</th><th>Price</th><th>Per lesson</th><th>Online</th><th>Status</th><th /></tr></thead>
              <tbody>
                {packages.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}{p.description && <div className="small muted">{p.description}</div>}</td>
                    <td>{p.lesson_count}</td>
                    <td>{money(p.price_cents)}</td>
                    <td className="small">{money(Math.round(p.price_cents / p.lesson_count))}</td>
                    <td>{p.sold_online ? "yes" : "at the school"}</td>
                    <td><Badge value={p.is_active ? "active" : "closed"} label={p.is_active ? "on sale" : "off"} /></td>
                    <td>
                      <form action={togglePackage}>
                        <input type="hidden" name="packageId" value={p.id} />
                        <input type="hidden" name="active" value={String(!p.is_active)} />
                        <button type="submit">{p.is_active ? "Stop selling" : "Sell again"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details style={{ marginTop: 12 }}>
          <summary><strong>Add a package</strong></summary>
          <form action={addPackage} style={{ marginTop: 12 }}>
            <div className="fields">
              <div className="field"><label htmlFor="pname">Name</label><input id="pname" name="name" required placeholder="10 lessons" /></div>
              <div className="field"><label htmlFor="plessons">Number of lessons</label><input id="plessons" name="lessons" type="number" min={1} max={200} required /></div>
              <div className="field"><label htmlFor="pprice">Price ({school.currency}, {s.prices_include_vat ? `incl. ${formatVatRate(s.vat_rate_bps)} VAT` : "excl. VAT"})</label><input id="pprice" name="price" type="number" min={1} step="0.01" required /></div>
              <div className="field"><label htmlFor="pdesc">Description (optional)</label><input id="pdesc" name="description" /></div>
            </div>
            <label className="check"><input type="checkbox" name="sold_online" defaultChecked /> Students can buy it in the student app</label>
            <button className="primary" type="submit">Add package</button>
          </form>
        </details>
      </section>
    </>
  );
}
