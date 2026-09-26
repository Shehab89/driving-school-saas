"use server";
import { withTenant } from "@/lib/db";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { cancelLesson, completeLesson, confirmLesson, markNoShow, rescheduleLesson, startLesson } from "@/server/services/lessons";
import { requestPaymentForLesson } from "@/server/services/billing";
import { loadSchoolContext } from "@/server/scheduling/loader";
import type { SkillStatus } from "@/server/services/progress";
import { bool, num, runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";
import { getI18n } from "@/i18n/server";

const back = (fd: FormData) => `/lessons/${str(fd, "lessonId")}`;
/** Send queued e-mails right after the response instead of waiting for the next cron tick. */
const flush = () => after(() => deliverNotifications(20).catch(() => undefined));

async function withActor<T>(fn: (a: Awaited<ReturnType<typeof requireSchoolActor>>) => Promise<T>) {
  const actor = await requireSchoolActor("lessons:operate_own");
  return fn(actor);
}

export async function confirmAction(fd: FormData) {
  await runAction(() => withActor((a) => withTenant(a.schoolId, (tx) => confirmLesson(tx, userPrincipal(a), str(fd, "lessonId")))), { back: back(fd), okMessage: (await getI18n()).t("instructor.flash.confirmed") });
}

export async function startAction(fd: FormData) {
  await runAction(() => withActor((a) => withTenant(a.schoolId, (tx) => startLesson(tx, userPrincipal(a), str(fd, "lessonId")))), { back: back(fd), okMessage: (await getI18n()).t("instructor.flash.started") });
}

export async function completeAction(fd: FormData) {
  await runAction(
    () =>
      withActor((a) => {
        const skills = [...fd.entries()]
          .filter(([k, v]) => k.startsWith("skill_") && v)
          .map(([k, v]) => ({ skillId: k.slice(6), status: String(v) as SkillStatus }));
        return withTenant(a.schoolId, (tx) =>
          completeLesson(tx, userPrincipal(a), str(fd, "lessonId"), {
            feedback: {
              strengths: str(fd, "strengths"),
              weaknesses: str(fd, "weaknesses"),
              practiceItems: str(fd, "practiceItems"),
              nextFocus: str(fd, "nextFocus"),
              instructorNotes: str(fd, "instructorNotes"),
              overallRating: num(fd, "overallRating"),
              overallLevelId: str(fd, "levelId") || null,
            },
            skills,
            newLevelId: str(fd, "levelId") || null,
            paymentRequired: bool(fd, "paymentRequired"),
          }),
        ).then(flush);
      }),
    { back: back(fd), success: `/instructor/feedback/${str(fd, "lessonId")}`, okMessage: (await getI18n()).t("instructor.flash.completed") },
  );
}

export async function noShowAction(fd: FormData) {
  await runAction(() => withActor((a) => withTenant(a.schoolId, (tx) => markNoShow(tx, userPrincipal(a), str(fd, "lessonId"), bool(fd, "charge"))).then(flush)), {
    back: back(fd),
    okMessage: (await getI18n()).t("instructor.flash.noShow"),
  });
}

export async function cancelAction(fd: FormData) {
  await runAction(
    () => withActor((a) => withTenant(a.schoolId, (tx) => cancelLesson(tx, userPrincipal(a), str(fd, "lessonId"), str(fd, "reason"), { waiveFee: bool(fd, "waiveFee") })).then(flush)),
    { back: back(fd), okMessage: (await getI18n()).t("instructor.flash.cancelled") },
  );
}

export async function requestPaymentAction(fd: FormData) {
  await runAction(
    () =>
      withActor((a) =>
        withTenant(a.schoolId, async (tx) => requestPaymentForLesson(tx, userPrincipal(a), await loadSchoolContext(tx, a.schoolId), str(fd, "lessonId"))).then(flush),
      ),
    { back: back(fd), okMessage: (await getI18n()).t("instructor.flash.paymentRequested") },
  );
}

export async function staffRescheduleAction(fd: FormData) {
  const lessonId = str(fd, "lessonId");
  await runAction(
    () =>
      withActor((a) => {
        const [start, end, instructorId, vehicleId] = str(fd, "slot").split("|");
        if (!start || !end || !instructorId) throw new Error("Pick a time");
        return withTenant(a.schoolId, (tx) =>
          rescheduleLesson(tx, userPrincipal(a), lessonId, { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null }, { channel: "staff", reason: str(fd, "reason") }),
        ).then((r) => {
          flush();
          return r;
        });
      }),
    { back: `/lessons/${lessonId}/reschedule`, success: "/instructor/calendar", okMessage: (await getI18n()).t("instructor.flash.moved") },
  );
}
