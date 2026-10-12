import { one, type Tx } from "@/lib/db";

export interface SetupStep {
  key: string;
  label: string;
  done: boolean;
  href: string;
  optional?: boolean;
}

/** What a new school still has to configure before students can book. Derived from real data, so it never goes stale. */
export async function setupChecklist(tx: Tx): Promise<SetupStep[]> {
  const r = (await one<{ hours: boolean; vehicle: boolean; instructor: boolean; availability: boolean; student: boolean; stripe: boolean; whatsapp: boolean; email: boolean }>(
    tx,
    `SELECT EXISTS (SELECT 1 FROM school_opening_hours) AS hours,
            EXISTS (SELECT 1 FROM vehicles WHERE status = 'active') AS vehicle,
            EXISTS (SELECT 1 FROM instructors WHERE status = 'active') AS instructor,
            EXISTS (SELECT 1 FROM instructor_availability a JOIN instructors i ON i.id = a.instructor_id WHERE i.status = 'active') AS availability,
            EXISTS (SELECT 1 FROM students) AS student,
            EXISTS (SELECT 1 FROM school_payment_accounts WHERE status = 'active') AS stripe,
            EXISTS (SELECT 1 FROM whatsapp_accounts WHERE status = 'active') AS whatsapp,
            EXISTS (SELECT 1 FROM schools WHERE email IS NOT NULL) AS email`,
  ))!;
  return [
    { key: "profile", label: "Add your school's contact e-mail (used as reply-to on e-mails)", done: r.email, href: "/admin/settings" },
    { key: "hours", label: "Set opening hours", done: r.hours, href: "/admin/settings" },
    { key: "vehicle", label: "Add a vehicle", done: r.vehicle, href: "/admin/vehicles" },
    { key: "instructor", label: "Add an instructor (or yourself)", done: r.instructor, href: "/admin/instructors" },
    { key: "availability", label: "Set instructor working hours", done: r.availability, href: "/admin/instructors" },
    { key: "student", label: "Add or invite your first student", done: r.student, href: "/admin/students" },
    { key: "stripe", label: "Connect Stripe to receive online payments", done: r.stripe, href: "/admin/settings#integrations", optional: true },
    { key: "whatsapp", label: "Connect WhatsApp for the assistant", done: r.whatsapp, href: "/admin/settings#integrations", optional: true },
  ];
}
