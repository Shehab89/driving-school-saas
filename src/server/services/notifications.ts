import type { Tx } from "@/lib/db";

export type NotificationType =
  | "student_welcome"
  | "user_invite"
  | "lesson_booked"
  | "lesson_reminder"
  | "lesson_rescheduled"
  | "lesson_cancelled"
  | "lesson_completed_payment_request"
  | "payment_succeeded"
  | "payment_overdue"
  | "reschedule_request_received"
  | "handoff_requested"
  | "whatsapp_link_code"
  | "feedback_received";

export interface EnqueueArgs {
  schoolId: string;
  type: NotificationType;
  channel?: "email" | "whatsapp";
  to: string | null | undefined;
  studentId?: string | null;
  userId?: string | null;
  lessonId?: string | null;
  paymentId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  scheduledFor?: Date;
}

/**
 * Transactional outbox: the notification row is written in the same
 * transaction as the business change, and a worker delivers it afterwards
 * (src/server/jobs/notification-worker.ts). If the transaction rolls back,
 * no e-mail is sent; if the provider is down, the worker retries.
 */
export async function enqueueNotification(tx: Tx, a: EnqueueArgs): Promise<string | null> {
  if (!a.to) return null; // recipient has no address on file
  const r = await tx.query<{ id: string }>(
    `INSERT INTO notifications (school_id, type, channel, to_address, recipient_student_id, recipient_user_id,
                                lesson_id, payment_id, payload, dedupe_key, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()))
     ON CONFLICT (school_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      a.schoolId,
      a.type,
      a.channel ?? "email",
      a.to,
      a.studentId ?? null,
      a.userId ?? null,
      a.lessonId ?? null,
      a.paymentId ?? null,
      JSON.stringify(a.payload ?? {}),
      a.dedupeKey ?? null,
      a.scheduledFor ?? null,
    ],
  );
  return r.rows[0]?.id ?? null;
}
