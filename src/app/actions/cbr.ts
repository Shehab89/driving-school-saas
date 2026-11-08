"use server";
import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { CBR_STATUSES, type CbrProduct, type CbrStatus } from "@/lib/cbr";
import { getPt } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { deleteCbrExam, saveCbrExam, saveCbrStudent } from "@/server/services/cbr";
import { bool, num, runAction, str } from "@/server/web";

/** Where to go back to: the page the form was on (student profile or exam overview). */
function backTo(fd: FormData) {
  const b = str(fd, "back");
  return b.startsWith("/students/") || b === "/admin/exams" ? b : `/students/${str(fd, "studentId")}`;
}

export async function saveCbrExamAction(fd: FormData) {
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:write_all");
    const tz = (await schoolHeader(actor.schoolId)).timezone;
    const when = str(fd, "examAt");
    let examAt: Date | null = null;
    if (when) {
      const d = DateTime.fromISO(when, { zone: tz });
      if (!d.isValid) throw new ValidationError(pt("Enter the exam date and time."));
      examAt = d.toJSDate();
    }
    const status = str(fd, "status") as CbrStatus;
    if (status && !(CBR_STATUSES as readonly string[]).includes(status)) throw new ValidationError(pt("Choose a status."));
    if (!examAt && status !== "to_reserve" && status !== "cancelled") throw new ValidationError(pt("Enter the exam date and time."));
    const fee = num(fd, "fee");
    await withTenant(actor.schoolId, (tx) =>
      saveCbrExam(tx, userPrincipal(actor), {
        id: str(fd, "id") || undefined,
        studentId: str(fd, "studentId"),
        product: str(fd, "product") as CbrProduct,
        status: status || "reserved",
        examAt,
        location: str(fd, "location"),
        reservationNumber: str(fd, "reservationNumber"),
        feeCents: fee === undefined ? null : Math.round(fee * 100),
        resultNotes: str(fd, "resultNotes"),
        bookCalendar: bool(fd, "bookCalendar") && str(fd, "calendarInstructorId") ? { instructorId: str(fd, "calendarInstructorId") } : null,
      }),
    );
  }, { back: backTo(fd), okMessage: pt("CBR exam saved") });
}

export async function deleteCbrExamAction(fd: FormData) {
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:write_all");
    await withTenant(actor.schoolId, (tx) => deleteCbrExam(tx, userPrincipal(actor), str(fd, "id")));
  }, { back: backTo(fd), okMessage: pt("Removed") });
}

export async function saveCbrStudentAction(fd: FormData) {
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("students:write");
    await withTenant(actor.schoolId, (tx) =>
      saveCbrStudent(tx, userPrincipal(actor), str(fd, "studentId"), {
        theoryPassedOn: str(fd, "theoryPassedOn"),
        health: (str(fd, "health") || "unknown") as "unknown",
        authorizedOn: str(fd, "authorizedOn"),
      }),
    );
  }, { back: backTo(fd), okMessage: pt("Saved") });
}
