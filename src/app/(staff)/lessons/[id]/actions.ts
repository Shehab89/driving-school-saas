"use server";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { cancelLesson, completeLesson, confirmLesson, markNoShow, rescheduleLesson, startLesson } from "@/server/services/lessons";
import { requestPaymentForLesson } from "@/server/services/billing";
import { setLessonPrice } from "@/server/services/pricing";
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

/** Cancel from the calendar pop-up: same rules as cancelAction, but returns to the calendar the user came from. */
export async function boardCancelAction(fd: FormData) {
  const raw = str(fd, "back");
  const back = /^\/(admin|instructor)\/calendar(\?[\w=&%.-]*)?$/.test(raw) ? raw : "/instructor/calendar";
  await runAction(
    () => withActor((a) => withTenant(a.schoolId, (tx) => cancelLesson(tx, userPrincipal(a), str(fd, "lessonId"), str(fd, "reason"), { waiveFee: bool(fd, "waiveFee") })).then(flush)),
    { back, okMessage: (await getI18n()).t("instructor.flash.cancelled") },
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
  // Office staff return to the school calendar, instructors to their own.
  let dest = "/instructor/calendar";
  await runAction(
    () =>
      withActor((a) => {
        if (can(a.role, "lessons:write_all")) dest = "/admin/calendar";
        const [start, end, instructorId, vehicleId] = str(fd, "slot").split("|");
        if (!start || !end || !instructorId) throw new Error("Pick a time");
        return withTenant(a.schoolId, (tx) =>
          rescheduleLesson(tx, userPrincipal(a), lessonId, { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null }, { channel: "staff", reason: str(fd, "reason") }),
        ).then((r) => {
          flush();
          return r;
        });
      }),
    {
      back: `/lessons/${lessonId}/reschedule`,
      success: () => dest,
      okMessage: (await getI18n()).t("instructor.flash.moved"),
    },
  );
}

export async function setPriceAction(fd: FormData) {
  const lessonId = str(fd, "lessonId");
  await runAction(
    async () => {
      const actor = await requireSchoolActor("pricing:write");
      const euros = num(fd, "price");
      if (euros === undefined || euros < 0) throw new Error("Enter a price");
      await withTenant(actor.schoolId, (tx) => setLessonPrice(tx, userPrincipal(actor), lessonId, Math.round(euros * 100), str(fd, "reason") || undefined));
      flush();
    },
    { back: `/lessons/${lessonId}`, okMessage: (await getI18n()).t("instructor.lesson.priceSaved") },
  );
}

export async function plannedTopicsAction(fd: FormData) {
  const { setLessonTopics } = await import("@/server/services/topics");
  await runAction(
    () => withActor((a) => withTenant(a.schoolId, (tx) => setLessonTopics(tx, userPrincipal(a), str(fd, "lessonId"), "planned", fd.getAll("topics").map(String)))),
    { back: back(fd), okMessage: (await getI18n()).t("topics.saved") },
  );
}

/**
 * Edit a planned lesson in one go: day, start time, (school: instructor and car) and topics.
 * A new time goes through the normal reschedule (student is told, overlaps are refused by
 * the database); topics are saved on the lesson that results.
 */
export async function editLessonAction(fd: FormData) {
  const lessonId = str(fd, "lessonId");
  const { t } = await getI18n();
  let dest = `/lessons/${lessonId}`;
  await runAction(
    () =>
      withActor(async (a) => {
        const staff = can(a.role, "lessons:write_all");
        const { DateTime } = await import("luxon");
        const { one } = await import("@/lib/db");
        const { setLessonTopics } = await import("@/server/services/topics");
        const { ValidationError, PolicyError } = await import("@/lib/errors");
        await withTenant(a.schoolId, async (tx) => {
          const l = await one<{ start_time: Date; end_time: Date; instructor_id: string; vehicle_id: string | null; status: string; now: Date }>(
            tx,
            `SELECT start_time, end_time, instructor_id, vehicle_id, status, now() AS now FROM lessons WHERE id = $1`,
            [lessonId],
          );
          if (!l) throw new ValidationError("Lesson not found");
          const ctx = await loadSchoolContext(tx, a.schoolId);
          const start = DateTime.fromISO(`${str(fd, "date")}T${str(fd, "time")}`, { zone: ctx.timezone });
          if (!start.isValid) throw new PolicyError(t("instructor.lesson.inPast"), "edit_bad_time");
          const end = start.plus({ milliseconds: l.end_time.getTime() - l.start_time.getTime() });
          // Instructors move their own lessons only; the office may hand a lesson to someone else.
          const instructorId = staff && str(fd, "instructorId") ? str(fd, "instructorId") : l.instructor_id;
          const vehicleId = staff ? str(fd, "vehicleId") || null : l.vehicle_id;
          const moved = start.toMillis() !== l.start_time.getTime() || instructorId !== l.instructor_id || vehicleId !== l.vehicle_id;
          let id = lessonId;
          if (moved) {
            if (start.toJSDate() <= l.now) throw new PolicyError(t("instructor.lesson.inPast"), "edit_bad_time");
            const r = await rescheduleLesson(tx, userPrincipal(a), lessonId, { start: start.toJSDate(), end: end.toJSDate(), instructorId, vehicleId }, { channel: "staff", reason: str(fd, "reason") });
            id = r.newLessonId ?? lessonId;
          }
          await setLessonTopics(tx, userPrincipal(a), id, "planned", fd.getAll("topics").map(String));
          dest = `/lessons/${id}`;
        });
        flush();
      }),
    { back: `/lessons/${lessonId}/edit`, success: () => dest, okMessage: t("instructor.lesson.updated") },
  );
}
