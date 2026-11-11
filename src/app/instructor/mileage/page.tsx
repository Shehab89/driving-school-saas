import { DateTime } from "luxon";
import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { DateField } from "@/components/date-field";
import { dateFieldLabels } from "@/components/date-field-labels";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { addMileage, deleteMileage, listMileage, mileageSuggestion, mileageTotals, PURPOSES, type Purpose } from "@/server/services/mileage";
import { num, optStr, runAction, str } from "@/server/web";
import { requireInstructorProfile } from "../data";

async function add(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  let km = 0;
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:operate_own");
    const school = await schoolHeader(actor.schoolId);
    const r = await withTenant(actor.schoolId, (tx) =>
      addMileage(tx, userPrincipal(actor), {
        date: str(fd, "date"),
        vehicleId: optStr(fd, "vehicleId") ?? null,
        startKm: num(fd, "startKm") ?? Number.NaN,
        endKm: num(fd, "endKm") ?? Number.NaN,
        fromPlace: optStr(fd, "fromPlace"),
        toPlace: optStr(fd, "toPlace"),
        purpose: (str(fd, "purpose") || "business") as Purpose,
        note: optStr(fd, "note"),
      }, school.timezone),
    );
    km = r.km;
  }, { back: `/instructor/mileage?month=${str(fd, "date").slice(0, 7)}`, okMessage: () => t("instructor.mileage.saved", { km }) });
}

async function remove(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:operate_own");
    await withTenant(actor.schoolId, (tx) => deleteMileage(tx, userPrincipal(actor), str(fd, "id")));
  }, { back: `/instructor/mileage?month=${str(fd, "month")}`, okMessage: t("instructor.mileage.deleted") });
}

/** Mileage log (kilometerregistratie): what a self-employed instructor needs for the tax office. */
export default async function MileagePage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f, locale } = await requireInstructorProfile();
  const school = await schoolHeader(actor.schoolId);
  const today = DateTime.now().setZone(school.timezone);
  const monthStart = /^\d{4}-\d{2}$/.test(q.month ?? "") ? DateTime.fromISO(`${q.month}-01`, { zone: school.timezone }) : today.startOf("month");
  const month = monthStart.isValid ? monthStart : today.startOf("month");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? "") ? q.date! : today.toISODate()!;
  const { rows, year, vehicles, hint } = await withTenant(actor.schoolId, async (tx) => ({
    rows: await listMileage(tx, actor.instructorId, month.toISODate()!, month.endOf("month").toISODate()!),
    year: await listMileage(tx, actor.instructorId, month.startOf("year").toISODate()!, month.endOf("year").toISODate()!),
    vehicles: await many<{ id: string; label: string }>(tx, `SELECT id, brand || ' ' || model || ' (' || registration_number || ')' AS label FROM vehicles WHERE status <> 'retired' ORDER BY brand, model`),
    hint: await mileageSuggestion(tx, actor.instructorId, day, school.timezone),
  }));
  const m = mileageTotals(rows);
  const y = mileageTotals(year);
  const km = (n: number) => `${f.number(n)} km`;
  const P = (p: Purpose) => t(`instructor.mileage.purposes.${p}`);
  const ym = month.toFormat("yyyy-MM");
  return (
    <>
      <div className="page-head"><h1>{t("instructor.mileage.title")}</h1></div>
      <p className="sub" style={{ marginTop: -6 }}>{t("instructor.mileage.intro")}</p>
      <Flash searchParams={q} />

      <form action={add} className="card" data-testid="mileage-form">
        <h2>{t("instructor.mileage.add")}</h2>
        {hint.lessons > 0 && <p className="small muted">{t("instructor.mileage.filled", { count: hint.lessons })}</p>}
        <div className="fields">
          <div className="field"><label htmlFor="date">{t("instructor.mileage.date")}</label><DateField id="date" name="date" defaultValue={day} max={today.toISODate()!} locale={locale} labels={dateFieldLabels(t)} required /></div>
          <div className="field">
            <label htmlFor="vehicleId">{t("common.vehicle")}</label>
            <select id="vehicleId" name="vehicleId" defaultValue={hint.vehicleId ?? ""}>
              <option value="">{t("instructor.mileage.ownCar")}</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="startKm">{t("instructor.mileage.startKm")}</label><input id="startKm" name="startKm" type="number" inputMode="numeric" min={0} required defaultValue={hint.startKm ?? ""} dir="ltr" /></div>
          <div className="field"><label htmlFor="endKm">{t("instructor.mileage.endKm")}</label><input id="endKm" name="endKm" type="number" inputMode="numeric" min={0} required dir="ltr" /></div>
          <div className="field"><label htmlFor="fromPlace">{t("instructor.mileage.from")}</label><input id="fromPlace" name="fromPlace" maxLength={200} defaultValue={hint.fromPlace ?? ""} /></div>
          <div className="field"><label htmlFor="toPlace">{t("instructor.mileage.to")}</label><input id="toPlace" name="toPlace" maxLength={200} defaultValue={hint.toPlace ?? ""} /></div>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: "4px 0 10px" }}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>{t("instructor.mileage.purpose")}</legend>
          <div className="chips">
            {PURPOSES.map((p) => (
              <label key={p} className="check chip"><input type="radio" name="purpose" value={p} defaultChecked={p === "business"} /> {P(p)}</label>
            ))}
          </div>
        </fieldset>
        <div className="field"><label htmlFor="note">{t("instructor.mileage.note")}</label><input id="note" name="note" maxLength={200} placeholder={t("instructor.mileage.notePlaceholder")} /></div>
        <button className="primary block">{t("instructor.mileage.save")}</button>
      </form>

      <section className="card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>{f.monthYear(month.toJSDate())}</h2>
          <nav className="row" aria-label={t("instructor.mileage.month")}>
            <Link className="btn sm" href={`/instructor/mileage?month=${month.minus({ months: 1 }).toFormat("yyyy-MM")}`} aria-label={t("instructor.mileage.prev")}><span className="flip">‹</span></Link>
            <Link className="btn sm" href={`/instructor/mileage?month=${month.plus({ months: 1 }).toFormat("yyyy-MM")}`} aria-label={t("instructor.mileage.next")}><span className="flip">›</span></Link>
          </nav>
        </div>
        <dl className="mini-stats">
          <div><dt>{P("business")}</dt><dd className="num">{km(m.business)}</dd></div>
          <div><dt>{P("commute")}</dt><dd className="num">{km(m.commute)}</dd></div>
          <div><dt>{P("private")}</dt><dd className="num">{km(m.private)}</dd></div>
        </dl>
        {rows.length === 0 && <p className="muted">{t("instructor.mileage.empty")}</p>}
        {rows.map((r) => (
          <div key={r.id} className="list-row" style={{ flexWrap: "wrap" }} data-testid="mileage-row">
            <div style={{ flex: 1, minWidth: 180 }}>
              <strong>{f.isoDate(r.trip_date)}</strong> · <span className="num">{km(r.km)}</span> · {P(r.purpose)}
              <div className="sub"><span dir="ltr">{f.number(r.start_km)} → {f.number(r.end_km)}</span>{r.vehicle ? ` · ${r.vehicle}` : ""}</div>
              {(r.from_place || r.to_place) && <div className="sub">{[r.from_place, r.to_place].filter(Boolean).join(" → ")}</div>}
              {r.note && <div className="sub">{r.note}</div>}
            </div>
            <form action={remove}>
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="month" value={ym} />
              <button className="ghost sm" aria-label={t("instructor.mileage.delete")}>{t("instructor.mileage.delete")}</button>
            </form>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>{t("instructor.mileage.yearTitle", { year: month.year })}</h2>
        <dl className="kv">
          <dt>{P("business")}</dt><dd className="num">{km(y.business)}</dd>
          <dt>{P("commute")}</dt><dd className="num">{km(y.commute)}</dd>
          <dt>{P("private")}</dt><dd className="num">{km(y.private)}</dd>
          <dt>{t("instructor.mileage.total")}</dt><dd className="num"><strong>{km(y.total)}</strong></dd>
        </dl>
        <p className="small muted">{t("instructor.mileage.privateHint")}</p>
        <a className="list-row" href={`/api/reports/mileage?from=${month.toISODate()}&to=${month.endOf("month").toISODate()}`}>{t("instructor.mileage.exportMonth")} <span aria-hidden>↓</span></a>
        <a className="list-row" href={`/api/reports/mileage?from=${month.startOf("year").toISODate()}&to=${month.endOf("year").toISODate()}`}>{t("instructor.mileage.exportYear", { year: month.year })} <span aria-hidden>↓</span></a>
      </section>
    </>
  );
}
