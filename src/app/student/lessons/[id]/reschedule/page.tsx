import Link from "next/link";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { ReschedulePicker } from "@/components/reschedule-picker";
import { pickerLabels } from "@/components/reschedule-button";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";

/** Full-page version of the reschedule pop-up (deep links, e-mail links). */
export default async function ReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const { t } = await schoolI18n(actor.schoolId);
  return (
    <>
      <p><Link href="/student"><span className="flip" style={{ display: "inline-block" }}>←</span> {t("common.back")}</Link></p>
      <Flash searchParams={q} />
      <section className="card">
        <ReschedulePicker lessonId={id} labels={pickerLabels(t)} />
      </section>
    </>
  );
}
