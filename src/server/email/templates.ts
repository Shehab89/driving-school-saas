/**
 * Transactional e-mail templates. Plain functions returning subject/html/text;
 * every interpolated value is HTML-escaped.
 */
import { formatDate, formatMoney, formatTimeRange, durationMinutes } from "@/lib/time";
import type { NotificationType } from "../services/notifications";

export interface SchoolBrand {
  name: string;
  timezone: string;
  currency: string;
  locale: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

interface LessonSnap {
  lesson_number: number;
  start_time: string;
  end_time: string;
  student_first_name: string;
  instructor_name: string;
  vehicle: string | null;
  price_cents?: number;
  currency?: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Block = { kind: "p"; text: string } | { kind: "kv"; rows: Array<[string, string]> } | { kind: "button"; label: string; url: string };

function layout(school: SchoolBrand, heading: string, blocks: Block[]): { html: string; text: string } {
  const htmlBlocks = blocks
    .map((b) => {
      if (b.kind === "p") return `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(b.text)}</p>`;
      if (b.kind === "kv")
        return `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px">${b.rows
          .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${escapeHtml(k)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(v)}</td></tr>`)
          .join("")}</table>`;
      return `<p style="margin:24px 0"><a href="${escapeHtml(b.url)}" style="background:#1f6feb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(b.label)}</a></p>`;
    })
    .join("\n");
  const footer = [school.name, school.address, school.phone, school.email].filter(Boolean).join(" · ");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1f24">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:8px;padding:28px">
<h1 style="font-size:20px;margin:0 0 20px">${escapeHtml(heading)}</h1>
${htmlBlocks}
</div>
<p style="font-size:12px;color:#6a737d;text-align:center;margin-top:16px">${escapeHtml(footer)}</p>
</div></body></html>`;
  const text = [
    heading,
    "",
    ...blocks.map((b) =>
      b.kind === "p" ? b.text : b.kind === "kv" ? b.rows.map(([k, v]) => `${k}: ${v}`).join("\n") : `${b.label}: ${b.url}`,
    ),
    "",
    "—",
    footer,
  ].join("\n\n");
  return { html, text };
}

function lessonRows(l: LessonSnap, school: SchoolBrand): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Lesson", `#${l.lesson_number}`],
    ["Date", formatDate(l.start_time, school.timezone, school.locale)],
    ["Time", formatTimeRange(l.start_time, l.end_time, school.timezone)],
    ["Instructor", l.instructor_name],
  ];
  if (l.vehicle) rows.push(["Vehicle", l.vehicle]);
  return rows;
}

export function renderEmail(type: NotificationType, payload: Record<string, unknown>, school: SchoolBrand): Rendered {
  const lesson = payload.lesson as LessonSnap | undefined;
  const name = (lesson?.student_first_name ?? (payload.name as string | undefined) ?? "there").trim();
  const money = (cents: unknown, cur?: unknown) => formatMoney(Number(cents), String(cur ?? school.currency), school.locale);
  const r = (subject: string, heading: string, blocks: Block[]): Rendered => ({ subject, ...layout(school, heading, blocks) });

  switch (type) {
    case "student_welcome":
      return r(`Welcome to ${school.name}`, `Welcome, ${name}!`, [
        { kind: "p", text: `Your student account at ${school.name} is ready. From your dashboard you can see your level, your instructor's feedback, upcoming lessons and payments, and reschedule lessons.` },
        { kind: "button", label: "Activate my account", url: String(payload.activation_url) },
        { kind: "p", text: "This link is valid for 7 days." },
      ]);
    case "user_invite":
      return r(`You're invited to ${school.name}`, `Hi ${name}`, [
        { kind: "p", text: `You have been invited to ${school.name} as ${String(payload.role).replace("_", " ")}. Set your password to get started.` },
        { kind: "button", label: "Set my password", url: String(payload.activation_url) },
        { kind: "p", text: "This link is valid for 7 days." },
      ]);
    case "lesson_booked":
      return r(`Lesson booked: ${formatDate(lesson!.start_time, school.timezone, school.locale)}`, "Your lesson is booked", [
        { kind: "p", text: `Hi ${name}, your driving lesson has been booked.` },
        { kind: "kv", rows: lessonRows(lesson!, school) },
      ]);
    case "lesson_reminder":
      return r(`Reminder: driving lesson ${formatDate(lesson!.start_time, school.timezone, school.locale)}`, "See you soon!", [
        { kind: "p", text: `Hi ${name}, this is a reminder of your upcoming driving lesson.` },
        { kind: "kv", rows: lessonRows(lesson!, school) },
        { kind: "p", text: "Please bring your ID/learner permit." },
      ]);
    case "lesson_rescheduled": {
      const prev = payload.previous as { start_time: string; end_time: string } | undefined;
      return r("Your lesson has been rescheduled", "New lesson time", [
        { kind: "p", text: `Hi ${name}, your lesson has been moved.` },
        ...(prev ? [{ kind: "kv" as const, rows: [["Previous", `${formatDate(prev.start_time, school.timezone, school.locale)} ${formatTimeRange(prev.start_time, prev.end_time, school.timezone)}`]] as Array<[string, string]> }] : []),
        { kind: "kv", rows: lessonRows(lesson!, school) },
      ]);
    }
    case "lesson_cancelled":
      return r("Your lesson has been cancelled", "Lesson cancelled", [
        { kind: "p", text: `Hi ${name}, the following lesson has been cancelled${payload.reason ? `: ${String(payload.reason)}` : "."}` },
        { kind: "kv", rows: lessonRows(lesson!, school) },
        { kind: "p", text: "Contact us or use your dashboard to book a new lesson." },
      ]);
    case "lesson_completed_payment_request": {
      const amount = money(payload.amount_cents, payload.currency);
      const due = formatDate(`${String(payload.due_date)}T12:00:00Z`, school.timezone, school.locale);
      if (payload.is_cancellation_fee) {
        return r(`Late cancellation fee – ${amount}`, "Late cancellation fee", [
          { kind: "p", text: `Hi ${name}, a late cancellation fee applies to your recently cancelled lesson.` },
          { kind: "kv", rows: [["Amount due", amount], ["Pay before", due], ["Reference", `Invoice ${String(payload.invoice_number)}`]] },
          { kind: "button", label: "Pay now", url: String(payload.pay_url) },
        ]);
      }
      return r(`Lesson completed – ${amount} due`, "Thanks for your lesson!", [
        { kind: "p", text: `Hi ${name}, your driving lesson on ${formatDate(lesson!.start_time, school.timezone, school.locale)} has been completed.` },
        { kind: "kv", rows: [...lessonRows(lesson!, school), ["Duration", `${durationMinutes(lesson!.start_time, lesson!.end_time)} min`], ["Amount due", amount], ["Pay before", due], ["Invoice", String(payload.invoice_number)]] },
        { kind: "button", label: `Pay ${amount}`, url: String(payload.pay_url) },
        { kind: "p", text: "Payments are processed securely by our payment provider. We never see your card details." },
      ]);
    }
    case "payment_succeeded":
      return r(`Payment received – ${money(payload.amount_cents, payload.currency)}`, "Payment received", [
        { kind: "p", text: `Thank you! We received your payment of ${money(payload.amount_cents, payload.currency)}.` },
        { kind: "kv", rows: [["Reference", String(payload.reference ?? "")]] },
      ]);
    case "payment_overdue":
      return r(`Payment overdue – ${money(payload.amount_cents, payload.currency)}`, "Payment reminder", [
        { kind: "p", text: `Hi ${name}, we have not yet received payment of ${money(payload.amount_cents, payload.currency)} (due ${formatDate(`${String(payload.due_date)}T12:00:00Z`, school.timezone, school.locale)}).` },
        { kind: "button", label: "Pay now", url: String(payload.pay_url) },
        { kind: "p", text: "If you already paid, please ignore this message." },
      ]);
    case "reschedule_request_received":
      return r("We received your reschedule request", "Reschedule request received", [
        { kind: "p", text: `Hi ${name}, we received your request to move lesson #${lesson?.lesson_number}. The school will confirm shortly.` },
        { kind: "kv", rows: [["Requested time", `${formatDate(String(payload.requested_start), school.timezone, school.locale)} ${formatTimeRange(String(payload.requested_start), String(payload.requested_end), school.timezone)}`]] },
      ]);
    case "handoff_requested":
      return r(`WhatsApp: ${String(payload.contact ?? "a contact")} needs help`, "A WhatsApp conversation needs you", [
        { kind: "p", text: `The assistant handed a conversation to the team. Reason: ${String(payload.reason ?? "not given")}` },
        { kind: "kv", rows: [["Contact", String(payload.contact ?? "")], ["Last message", String(payload.last_message ?? "")]] },
        { kind: "button", label: "Open inbox", url: String(payload.inbox_url) },
      ]);
    case "feedback_received":
      return r(`New feedback from ${lesson?.instructor_name ?? "your instructor"}`, "New feedback on your lesson", [
        { kind: "p", text: `Hi ${name}, your instructor wrote feedback on lesson #${lesson?.lesson_number} (${lesson ? formatDate(lesson.start_time, school.timezone, school.locale) : ""}).` },
        ...(payload.next_focus ? [{ kind: "kv" as const, rows: [["Next lesson focus", String(payload.next_focus)]] as Array<[string, string]> }] : []),
        { kind: "button", label: "Read it in the app", url: String(payload.app_url ?? "") },
      ]);
    case "whatsapp_link_code":
      return r(`${school.name}: your verification code`, "Verification code", [
        { kind: "p", text: `Someone asked to link a WhatsApp number to your student account. If this was you, reply in WhatsApp with this code:` },
        { kind: "kv", rows: [["Code", String(payload.code)]] },
        { kind: "p", text: "The code is valid for 15 minutes. If this wasn't you, ignore this e-mail." },
      ]);
  }
}
