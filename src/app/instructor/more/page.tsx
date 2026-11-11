import Link from "next/link";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import type { Translate } from "@/i18n";

type Item = { href: string; key: string; hint?: string };

/** "More" tab of the one-person-school app: everything the owner sets up once in a while. */
export default async function MorePage() {
  const actor = await requireSchoolPage("school:manage_settings");
  const { t } = await schoolI18n(actor.schoolId);
  const groups: Array<[string, Item[]]> = [
    ["instructor.solo.groupWork", [
      { href: "/instructor/calendar", key: "instructor.tabs.calendar" },
      { href: "/instructor/feedback", key: "instructor.tabs.feedback" },
      { href: "/instructor/availability", key: "instructor.solo.workingHours" },
      { href: "/admin/exams", key: "instructor.solo.cbrExams" },
      { href: "/admin/whatsapp", key: "instructor.solo.whatsapp" },
      { href: "/instructor/mileage", key: "instructor.solo.mileage", hint: "instructor.mileage.moreHint" },
    ]],
    ["instructor.solo.groupStudents", [
      { href: "/instructor/students/new", key: "instructor.solo.addStudent" },
      { href: "/instructor/lessons/new", key: "instructor.plan.title" },
      { href: "/admin/students/import", key: "instructor.solo.importStudents", hint: "instructor.solo.importHint" },
      { href: "/admin/messages", key: "instructor.solo.messageStudents", hint: "instructor.solo.messageHint" },
    ]],
    ["instructor.solo.groupSchool", [
      { href: "/admin/settings", key: "instructor.solo.schoolSettings", hint: "instructor.solo.schoolSettingsHint" },
      { href: "/admin/billing", key: "instructor.solo.paymentSettings" },
      { href: "/admin/vehicles", key: "instructor.solo.car" },
      { href: "/admin/settings#brand", key: "instructor.solo.brand", hint: "instructor.solo.brandHint" },
      { href: "/admin/reports", key: "instructor.solo.reports" },
    ]],
    ["instructor.solo.groupGrow", [
      { href: "/admin/team", key: "instructor.solo.hire", hint: "instructor.solo.hireHint" },
      { href: "/admin", key: "instructor.solo.fullPortal", hint: "instructor.solo.fullPortalHint" },
    ]],
  ];
  const tr = (k: string) => t(k as Parameters<Translate>[0]);
  return (
    <>
      <h1>{t("instructor.tabs.more")}</h1>
      {groups.map(([title, items]) => (
        <section key={title} className="card">
          <h2>{tr(title)}</h2>
          {items.map((i) => (
            <Link key={i.href} className="list-row" href={i.href}>
              <span>{tr(i.key)}{i.hint && <span className="sub" style={{ display: "block" }}>{tr(i.hint)}</span>}</span>
              <span className="flip" aria-hidden>›</span>
            </Link>
          ))}
        </section>
      ))}
      <section className="card">
        <Link className="list-row" href="/instructor/profile">{t("common.profile")} <span className="flip" aria-hidden>›</span></Link>
        <form action="/logout" method="post"><button type="submit" className="ghost block">{t("instructor.solo.logout")}</button></form>
      </section>
    </>
  );
}
