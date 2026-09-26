import { one, withTenant } from "@/lib/db";
import Link from "next/link";
import { LanguageSwitcher } from "@/components/language-switcher";
import { requireInstructorProfile } from "../data";

export default async function InstructorProfile() {
  const { actor, t, locale } = await requireInstructorProfile();
  const me = await withTenant(actor.schoolId, (tx) =>
    one<{ first_name: string; last_name: string; email: string | null; phone: string | null; license_categories: string[]; vehicle: string | null }>(
      tx,
      `SELECT i.first_name, i.last_name, i.email, i.phone, i.license_categories, v.brand || ' ' || v.model || ' (' || v.registration_number || ')' AS vehicle
         FROM instructors i LEFT JOIN vehicles v ON v.id = i.default_vehicle_id WHERE i.id = $1`,
      [actor.instructorId],
    ),
  );
  return (
    <>
      <div className="page-head"><h1>{t("instructor.profileTitle")}</h1></div>
      <section className="card spread">
        <strong>{t("common.language")}</strong>
        <LanguageSwitcher current={locale} label={t("common.language")} />
      </section>
      <section className="card">
        <dl className="kv">
          <dt>{t("common.instructor")}</dt><dd>{me?.first_name} {me?.last_name}</dd>
          <dt>{t("common.email")}</dt><dd dir="ltr">{me?.email ?? actor.email}</dd>
          <dt>{t("common.phone")}</dt><dd dir="ltr">{me?.phone ?? t("common.none")}</dd>
          <dt>{t("studentProfile.licence")}</dt><dd>{me?.license_categories.join(", ")}</dd>
          <dt>{t("common.vehicle")}</dt><dd>{me?.vehicle ?? t("common.noVehicle")}</dd>
        </dl>
      </section>
      <Link className="btn block" href="/instructor/availability" style={{ marginBottom: 10 }}>{t("instructor.availabilityTitle")}</Link>
      <form action="/logout" method="post">
        <button type="submit" className="block">{t("common.logout")}</button>
      </form>
    </>
  );
}
