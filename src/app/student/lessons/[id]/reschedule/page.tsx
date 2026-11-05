import Link from "next/link";
import { idOr404 } from "@/server/web";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { notFound } from "next/navigation";
import { calendarLabels } from "@/components/calendar-button";
import { SlotCalendar } from "@/components/slot-calendar";
import { loadCalendarData } from "@/server/slot-calendar";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";

/** Full-page version of the reschedule calendar (deep links, e-mail links). */
export default async function ReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idOr404((await params).id);
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const { t } = await schoolI18n(actor.schoolId);
  // Someone else's lesson, or one that no longer exists: "not found", not an error page.
  const data = await loadCalendarData(actor, id).catch((e) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  return (
    <>
      <p><Link href="/student"><span className="flip" style={{ display: "inline-block" }}>←</span> {t("common.back")}</Link></p>
      <Flash searchParams={q} />
      <section className="card">
        <SlotCalendar initial={data} labels={calendarLabels(t, null)} />
      </section>
    </>
  );
}
