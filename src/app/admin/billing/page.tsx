import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { formatVatRate } from "@/lib/vat";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { updateSchoolProfileAndSettings } from "@/server/services/schools";
import { createPackage, listPackages, setPackageActive, updatePackage } from "@/server/services/packages";
import { schoolI18n } from "@/server/school";
import { getPt } from "@/i18n/server";
import { ptKey } from "@/i18n/portal";
import { bool, num, runAction, str } from "@/server/web";
import { ValidationError } from "@/lib/errors";

async function saveBilling(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    const mode = str(fd, "payment_mode");
    if (!["after_lesson", "at_booking", "credits"].includes(mode)) throw new ValidationError(pt("Choose how students pay."));
    const rate = num(fd, "vat_rate");
    if (rate === undefined || rate < 0 || rate > 100) throw new ValidationError(pt("VAT rate must be between 0 and 100%."));
    const iban = str(fd, "iban").replace(/\s+/g, "").toUpperCase();
    if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new ValidationError(pt("This IBAN does not look right."));
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
  }, { back: "/admin/billing", okMessage: pt("Billing settings saved") });
}

async function addPackage(fd: FormData) {
  "use server";
  const pt = await getPt();
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
        includesExam: bool(fd, "includes_exam"),
      }),
    );
  }, { back: "/admin/billing#packages", okMessage: pt("Package added") });
}

async function editPackage(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    const euros = num(fd, "price");
    await withTenant(actor.schoolId, (tx) =>
      updatePackage(tx, userPrincipal(actor), str(fd, "packageId"), {
        name: str(fd, "name"),
        description: str(fd, "description") || undefined,
        lessonCount: str(fd, "lessons"),
        priceCents: euros === undefined ? 0 : Math.round(euros * 100),
        soldOnline: bool(fd, "sold_online"),
        includesExam: bool(fd, "includes_exam"),
      }),
    );
  }, { back: "/admin/billing#packages", okMessage: pt("Package saved") });
}

async function togglePackage(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    await withTenant(actor.schoolId, (tx) => setPackageActive(tx, userPrincipal(actor), str(fd, "packageId"), str(fd, "active") === "true"));
  }, { back: "/admin/billing#packages", okMessage: pt("Saved") });
}

const MODES = [
  ["after_lesson", ptKey("After each lesson"), ptKey("An invoice is sent when the instructor finishes the lesson. Most common.")],
  ["at_booking", ptKey("In advance, when booking"), ptKey("An invoice is sent as soon as a lesson is booked, due before the lesson. Unpaid invoices are cancelled automatically when the lesson is cancelled in time.")],
  ["credits", ptKey("Lesson packages (paid in advance)"), ptKey("Students buy packages; each lesson uses one credit. Students need credit to book online. Without credit, a lesson is invoiced afterwards.")],
] as const;

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("pricing:write");
  const { school, f, pt } = await schoolI18n(actor.schoolId);
  const { ctx, packages } = await withTenant(actor.schoolId, async (tx) => ({
    ctx: await loadSchoolContext(tx, actor.schoolId),
    packages: await listPackages(tx, { includeInactive: true }),
  }));
  const s = ctx.settings;
  const money = (c: number) => f.money(c, school.currency);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Invoices & VAT")}</h1>
          <p>{pt("When students pay, what goes on your invoices, and lesson packages.")}</p>
        </div>
      </div>
      <Flash searchParams={q} />
      <form action={saveBilling} className="card">
        <h2>{pt("When do students pay?")}</h2>
        <fieldset className="choice-cards">
          <legend className="sr-only">{pt("When do students pay?")}</legend>
          {MODES.map(([value, label, help]) => (
            <label key={value} className="choice">
              <input type="radio" name="payment_mode" value={value} defaultChecked={s.payment_mode === value} />
              <span><strong>{pt(label)}</strong><span className="small muted">{pt(help)}</span></span>
            </label>
          ))}
        </fieldset>
        <h2 style={{ marginTop: 18 }}>{pt("VAT and invoice details")}</h2>
        <div className="fields">
          <div className="field"><label htmlFor="vat_rate">{pt("VAT rate (%)")}</label><input id="vat_rate" name="vat_rate" type="number" min={0} max={100} step="0.01" defaultValue={s.vat_rate_bps / 100} /></div>
          <div className="field"><label htmlFor="vat_number">{pt("VAT number")}</label><input id="vat_number" name="vat_number" dir="ltr" defaultValue={s.vat_number ?? ""} placeholder="NL000099998B57" /></div>
          <div className="field"><label htmlFor="kvk">{pt("Chamber of Commerce (KvK) number")}</label><input id="kvk" name="kvk" dir="ltr" defaultValue={s.chamber_of_commerce_number ?? ""} /></div>
          <div className="field"><label htmlFor="iban">{pt("IBAN for bank transfers")}</label><input id="iban" name="iban" dir="ltr" defaultValue={s.iban ?? ""} /></div>
          <div className="field"><label htmlFor="vat_exemption_note">{pt("Note when VAT is 0% (e.g. small business scheme)")}</label><input id="vat_exemption_note" name="vat_exemption_note" defaultValue={s.vat_exemption_note ?? ""} /></div>
        </div>
        <label className="switch" style={{ marginBottom: 10 }}>{pt("My lesson prices include VAT")}<input type="checkbox" name="prices_include_vat" defaultChecked={s.prices_include_vat} /></label>
        <p className="small muted">
          {pt("Invoices show the VAT rate, net amount and VAT separately; the rate is fixed on each invoice when it is issued. Whether VAT applies to your lessons, and at which rate, is something to confirm with your accountant. DriveDesk does not give tax advice.")}
        </p>
        <button className="primary" type="submit">{pt("Save")}</button>
      </form>

      <section className="card" id="packages">
        <h2>{pt("Lesson packages")}</h2>
        <p className="small muted">{pt("Build your own bundles: any number of lessons, any price, with or without the exam. Credits are added only once the payment is confirmed.")}</p>
        {packages.length === 0 ? <p className="muted">{pt("No packages yet.")}</p> : (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>{pt("Package")}</th><th>{pt("Lessons")}</th><th>{pt("Price")}</th><th>{pt("Per lesson")}</th><th>{pt("Sold")}</th><th>{pt("Status")}</th><th /></tr></thead>
              <tbody>
                {packages.map((p) => (
                  <tr key={p.id}>
                    <td data-label={pt("Package")}><strong>{p.name}</strong> {p.includes_exam && <Badge value="info" label={pt("incl. exam")} />}{p.description && <div className="small muted">{p.description}</div>}</td>
                    <td data-label={pt("Lessons")} className="num">{p.lesson_count}</td>
                    <td data-label={pt("Price")} className="num">{money(p.price_cents)}</td>
                    <td data-label={pt("Per lesson")} className="small num">{money(Math.round(p.price_cents / p.lesson_count))}</td>
                    <td data-label={pt("Sold")}>{p.sold_online ? pt("in the app") : pt("at the school")}</td>
                    <td data-label={pt("Status")}><Badge value={p.is_active ? "active" : "closed"} label={p.is_active ? pt("on sale") : pt("not on sale")} /></td>
                    <td>
                      <div className="row">
                        <form action={togglePackage}>
                          <input type="hidden" name="packageId" value={p.id} />
                          <input type="hidden" name="active" value={String(!p.is_active)} />
                          <button type="submit" className="sm">{p.is_active ? pt("Stop selling") : pt("Sell again")}</button>
                        </form>
                        <details>
                          <summary className="btn sm">{pt("Edit")}</summary>
                          <form action={editPackage} style={{ marginTop: 8, minWidth: 260 }}>
                            <input type="hidden" name="packageId" value={p.id} />
                            <div className="field"><label htmlFor={`pn-${p.id}`}>{pt("Name")}</label><input id={`pn-${p.id}`} name="name" required defaultValue={p.name} /></div>
                            <div className="field"><label htmlFor={`pl-${p.id}`}>{pt("Number of lessons")}</label><input id={`pl-${p.id}`} name="lessons" type="number" min={1} max={200} required defaultValue={p.lesson_count} /></div>
                            <div className="field"><label htmlFor={`pp-${p.id}`}>{pt("Price")}</label><input id={`pp-${p.id}`} name="price" type="number" min={1} step="0.01" required defaultValue={(p.price_cents / 100).toFixed(2)} /></div>
                            <div className="field"><label htmlFor={`pd-${p.id}`}>{pt("Description (optional)")}</label><input id={`pd-${p.id}`} name="description" defaultValue={p.description ?? ""} /></div>
                            <label className="check"><input type="checkbox" name="sold_online" defaultChecked={p.sold_online} /> {pt("Students can buy it in the student app")}</label>
                            <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" name="includes_exam" defaultChecked={p.includes_exam} /> {pt("Includes the exam")}</label>
                            <button className="primary sm" type="submit">{pt("Save")}</button>
                          </form>
                        </details>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="setting-row" style={{ marginTop: 12 }}>
          <summary>{pt("Add a package")}</summary>
          <form action={addPackage} style={{ marginTop: 12 }}>
            <div className="fields">
              <div className="field"><label htmlFor="pname">{pt("Name")}</label><input id="pname" name="name" required placeholder={pt("10 lessons")} /></div>
              <div className="field"><label htmlFor="plessons">{pt("Number of lessons")}</label><input id="plessons" name="lessons" type="number" min={1} max={200} required /></div>
              <div className="field"><label htmlFor="pprice">{s.prices_include_vat ? pt("Price ({currency}, incl. {rate} VAT)", { currency: school.currency, rate: formatVatRate(s.vat_rate_bps) }) : pt("Price ({currency}, excl. VAT)", { currency: school.currency })}</label><input id="pprice" name="price" type="number" min={1} step="0.01" required /></div>
              <div className="field"><label htmlFor="pdesc">{pt("Description (optional)")}</label><input id="pdesc" name="description" /></div>
            </div>
            <label className="check"><input type="checkbox" name="sold_online" defaultChecked /> {pt("Students can buy it in the student app")}</label>
            <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" name="includes_exam" /> {pt("Includes the exam")}</label>
            <button className="primary" type="submit">{pt("Add package")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
