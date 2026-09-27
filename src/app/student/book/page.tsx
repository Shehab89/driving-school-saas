import { Flash, sp, type SearchParams } from "@/components/ui";
import { CalendarPanel } from "@/components/calendar-button";
import { loadStudent } from "../data";

/** Book tab: the booking calendar (free periods in green, busy time in grey). */
export default async function BookPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, d, t, f } = await loadStudent();
  if (!d.booking.selfBooking) {
    return (<><h1>{t("student.bookTitle")}</h1><div className="card"><p>{t("student.bookingOff")}</p></div></>);
  }
  const price = t("student.bookIntro", {
    transmission: d.student.preferred_transmission === "automatic" ? t("student.automatic").toLowerCase() : t("student.manual").toLowerCase(),
    minutes: d.booking.minutes,
    price: f.money(d.booking.priceCents, d.currency),
  });
  return (
    <>
      <Flash searchParams={q} />
      <section className="card">
        <CalendarPanel actor={actor} t={t} lessonId={null} price={price} />
      </section>
    </>
  );
}
