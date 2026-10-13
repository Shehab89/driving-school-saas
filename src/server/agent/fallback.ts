/**
 * Deterministic WhatsApp replies for when the AI model is unavailable (no API
 * key, provider outage, rate limit). It only reads data through the same
 * read-only tools the agent uses, never books or changes anything, and always
 * hands the conversation to the team so a person follows up.
 */
import { executeTool, type Intent, type ToolContext } from "./tools";

type Locale = "en" | "nl" | "ar";

const T: Record<Locale, { unavailable: string; next: string; none: string; open: string; allPaid: string; link: string }> = {
  en: {
    unavailable: "Our automatic assistant is not available right now. Someone from the school will reply to you here as soon as possible.",
    next: "Your next lessons:",
    none: "You have no upcoming lessons booked.",
    open: "Open payments:",
    allPaid: "You have no open payments.",
    link: "If you are a student with us, you can also check your lessons and payments in the student app.",
  },
  nl: {
    unavailable: "Onze automatische assistent is nu niet beschikbaar. Iemand van de rijschool reageert hier zo snel mogelijk.",
    next: "Je volgende lessen:",
    none: "Je hebt geen geplande lessen.",
    open: "Openstaande betalingen:",
    allPaid: "Je hebt geen openstaande betalingen.",
    link: "Ben je leerling bij ons? Je lessen en betalingen staan ook in de leerling-app.",
  },
  ar: {
    unavailable: "المساعد الآلي غير متاح حاليًا. سيرد عليك أحد موظفي المدرسة هنا في أقرب وقت ممكن.",
    next: "دروسك القادمة:",
    none: "لا توجد دروس محجوزة قادمة.",
    open: "مدفوعات مستحقة:",
    allPaid: "لا توجد مدفوعات مستحقة.",
    link: "إذا كنت طالبًا لدينا، يمكنك أيضًا رؤية دروسك ومدفوعاتك في تطبيق الطالب.",
  },
};

const LESSON_WORDS = /\b(les|lessen|lesson|lessons|when|wanneer|afspraak|appointment|next|volgende)\b|درس|موعد/i;
const PAYMENT_WORDS = /\b(pay|paid|payment|invoice|betal\w*|factuur|rekening|bill)\b|دفع|فاتورة/i;

export async function deterministicReply(ctx: ToolContext, text: string, locale: string, reason: string): Promise<{ reply: string; intent: Intent }> {
  const t = T[(["en", "nl", "ar"].includes(locale) ? locale : "en") as Locale];
  const parts: string[] = [];
  let intent: Intent = "human_support";
  if (ctx.studentId && LESSON_WORDS.test(text)) {
    intent = "check_upcoming_lesson";
    const r = (await executeTool("get_my_lessons", { include_history: false }, ctx)) as { upcoming: Array<{ lesson_number: number; when: string; instructor: string }> };
    parts.push(r.upcoming.length ? [t.next, ...r.upcoming.slice(0, 3).map((l) => `• #${l.lesson_number} ${l.when} (${l.instructor})`)].join("\n") : t.none);
  } else if (ctx.studentId && PAYMENT_WORDS.test(text)) {
    intent = "payment";
    const r = (await executeTool("get_my_payments", {}, ctx)) as { payments: Array<{ amount: string; due: string; pay_link: string | null }> };
    const open = r.payments.filter((p) => p.pay_link);
    parts.push(open.length ? [t.open, ...open.slice(0, 3).map((p) => `• ${p.amount} (${p.due}): ${p.pay_link}`)].join("\n") : t.allPaid);
  } else if (!ctx.studentId) {
    parts.push(t.link);
  }
  ctx.handoff ??= { reason };
  return { reply: [t.unavailable, ...parts].join("\n\n"), intent };
}
