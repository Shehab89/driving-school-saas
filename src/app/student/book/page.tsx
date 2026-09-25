import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { bookLesson } from "@/server/services/lessons";
import { runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";
import { loadStudent } from "../data";

async function bookAction(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(
    async () => {
      const actor = await requireSchoolActor("lessons:request_reschedule");
      const [start, end, instructorId, vehicleId] = str(fd, "slot").split("|");
      if (!start || !end || !instructorId) throw new Error(t("errors.pickTime"));
      // bookLesson re-checks availability, lead time and the school's self-booking setting on the server.
      await withTenant(actor.schoolId, (tx) =>
        bookLesson(tx, userPrincipal(actor), {
          studentId: actor.studentId!,
          slot: { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null },
          bookedVia: "student_portal",
        }),
      );
      after(() => deliverNotifications(10).catch(() => undefined));
    },
    { back: "/student/book", success: "/student", okMessage: t("student.bookedOk") },
  );
}

export default async function BookPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, d, t, f, school } = await loadStudent();
  if (!d.booking.selfBooking) {
    return (<><h1>{t("student.bookTitle")}</h1><div className="card"><p>{t("student.bookingOff")}</p></div></>);
  }
  const slots = await withTenant(actor.schoolId, async (tx) => {
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const from = new Date();
    return searchSlots(tx, ctx, { studentId: actor.studentId!, from, to: DateTime.fromJSDate(from).plus({ days: 14 }).toJSDate(), distinctTimes: true, maxSlots: 60 });
  });
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const k = DateTime.fromJSDate(s.start, { zone: school.timezone }).toISODate()!;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  return (
    <>
      <h1>{t("student.bookTitle")}</h1>
      <Flash searchParams={q} />
      <p className="muted">
        {t("student.bookIntro", {
          transmission: d.student.preferred_transmission === "automatic" ? t("student.automatic").toLowerCase() : t("student.manual").toLowerCase(),
          minutes: d.booking.minutes,
          price: f.money(d.booking.priceCents, d.currency),
        })}
      </p>
      {slots.length === 0 ? (
        <div className="card"><p>{t("student.noSlots")}</p></div>
      ) : (
        <form action={bookAction} className="card">
          {[...byDay.entries()].map(([day, list]) => (
            <fieldset key={day} style={{ border: 0, padding: 0, margin: "0 0 14px" }}>
              <legend style={{ fontWeight: 700, marginBottom: 6 }}>{f.date(list[0]!.start)}</legend>
              <div className="slot-list" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                {list.map((s) => {
                  const value = [s.start.toISOString(), s.end.toISOString(), s.instructorId, s.vehicleId ?? ""].join("|");
                  return (
                    <label key={value} className="slot-option">
                      <input type="radio" name="slot" value={value} required />
                      <span className="num">{f.range(s.start, s.end)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <button className="primary block" type="submit">{t("student.bookThis")}</button>
        </form>
      )}
    </>
  );
}
