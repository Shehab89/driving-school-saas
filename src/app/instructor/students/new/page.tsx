import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { setStudentPlaces } from "@/server/services/meeting-points";
import { createStudent } from "@/server/services/students";
import { bool, runAction, str } from "@/server/web";
import { requireInstructorProfile } from "../../data";

async function addAction(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  let id = "";
  await runAction(
    async () => {
      const actor = await requireSchoolActor("students:write");
      const email = str(fd, "email");
      await withTenant(actor.schoolId, async (tx) => {
        const p = userPrincipal(actor);
        const s = await createStudent(tx, p, {
          firstName: str(fd, "firstName"),
          lastName: str(fd, "lastName"),
          email,
          phone: str(fd, "phone") || undefined,
          preferredTransmission: str(fd, "transmission") === "automatic" ? "automatic" : "manual",
          primaryInstructorId: actor.instructorId ?? undefined,
          createLogin: bool(fd, "invite") && Boolean(email),
        });
        id = s.id;
        if (str(fd, "pickup") || str(fd, "dropoff")) await setStudentPlaces(tx, p, s.id, { pickup: str(fd, "pickup"), dropoff: str(fd, "dropoff") });
      });
    },
    { back: "/instructor/students/new", success: () => `/instructor/lessons/new?student=${id}`, okMessage: t("instructor.addStudent.created") },
  );
}

/** Add a student from the phone (one-person school, or anyone with office rights). */
export default async function AddStudentPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t } = await requireInstructorProfile();
  if (!can(actor.role, "students:write")) redirect("/instructor/students");
  return (
    <>
      <h1>{t("instructor.addStudent.title")}</h1>
      <Flash searchParams={q} />
      <form action={addAction} className="card">
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}><label htmlFor="firstName">{t("instructor.addStudent.firstName")}</label><input id="firstName" name="firstName" required maxLength={100} autoComplete="off" /></div>
          <div className="field" style={{ flex: 1 }}><label htmlFor="lastName">{t("instructor.addStudent.lastName")}</label><input id="lastName" name="lastName" maxLength={100} autoComplete="off" /></div>
        </div>
        <div className="field"><label htmlFor="phone">{t("student.phoneLabel")}</label><input id="phone" name="phone" type="tel" dir="ltr" placeholder="+31 6 1234 5678" /></div>
        <div className="field"><label htmlFor="email">{t("instructor.addStudent.email")}</label><input id="email" name="email" type="email" dir="ltr" /></div>
        <div className="field">
          <label htmlFor="transmission">{t("student.transmission")}</label>
          <select id="transmission" name="transmission" defaultValue="manual"><option value="manual">{t("student.manual")}</option><option value="automatic">{t("student.automatic")}</option></select>
        </div>
        <div className="field"><label htmlFor="pickup">{t("student.places.pickup")}</label><input id="pickup" name="pickup" maxLength={200} placeholder={t("student.places.placeholder")} /><p className="muted small" style={{ margin: "4px 0 0" }}>{t("student.places.pickupHint")}</p></div>
        <div className="field"><label htmlFor="dropoff">{t("student.places.dropoff")}</label><input id="dropoff" name="dropoff" maxLength={200} /></div>
        <label className="check" style={{ margin: "8px 0" }}><input type="checkbox" name="invite" defaultChecked /> {t("instructor.addStudent.invite")}</label>
        <p className="muted small">{t("instructor.addStudent.inviteHint")}</p>
        <button className="primary block" type="submit">{t("instructor.addStudent.submit")}</button>
      </form>
    </>
  );
}
