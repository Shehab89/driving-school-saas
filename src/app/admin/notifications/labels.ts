import { ptKey } from "@/i18n/portal";

/** Names of the automatic messages and their send states, translated with pt(). */
export const MESSAGE_TYPE: Record<string, string> = {
  student_welcome: ptKey("Welcome to the app"),
  user_invite: ptKey("Invitation to sign in"),
  lesson_booked: ptKey("Lesson booked"),
  lesson_reminder: ptKey("Lesson reminder"),
  lesson_rescheduled: ptKey("Lesson moved"),
  lesson_cancelled: ptKey("Lesson cancelled"),
  lesson_completed_payment_request: ptKey("Payment request after a lesson"),
  booking_payment_request: ptKey("Payment request when booking"),
  package_payment_request: ptKey("Payment request for a lesson package"),
  payment_succeeded: ptKey("Payment received"),
  payment_overdue: ptKey("Payment overdue"),
  payment_failed: ptKey("Payment failed"),
  payment_refunded: ptKey("Payment refunded"),
  payment_disputed: ptKey("Payment disputed"),
  reschedule_request_received: ptKey("Change request received"),
  handoff_requested: ptKey("WhatsApp needs a person"),
  whatsapp_link_code: ptKey("WhatsApp verification code"),
  feedback_received: ptKey("New feedback"),
  password_reset: ptKey("Password reset"),
  password_changed: ptKey("Password changed"),
};

export const SEND_STATUS: Record<string, string> = {
  queued: ptKey("Waiting"),
  sending: ptKey("Sending"),
  sent: ptKey("Sent"),
  failed: ptKey("Failed"),
  cancelled: ptKey("Cancelled"),
  suppressed: ptKey("Not sent (on purpose)"),
  delivered: ptKey("Delivered"),
  delayed: ptKey("Delayed"),
  bounced: ptKey("Bounced"),
  complained: ptKey("Marked as spam"),
  read: ptKey("Read"),
};
