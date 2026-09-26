/**
 * Role-based access control. Roles grant permissions; services additionally
 * check *ownership* (an instructor may only complete their own lessons, a
 * student may only see their own data). Tenant isolation is handled
 * separately by withTenant() + RLS.
 */
export const ROLES = ["saas_admin", "school_owner", "school_admin", "instructor", "student"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "platform:manage_schools"
  | "platform:manage_subscriptions"
  | "platform:view_stats"
  | "school:manage_settings"
  | "school:manage_integrations"
  | "school:view_reports"
  | "students:read_all"
  | "students:write"
  | "students:read_assigned"
  | "students:update_progress"
  | "instructors:write"
  | "vehicles:write"
  | "lessons:read_all"
  | "lessons:write_all"
  | "lessons:read_own"
  | "lessons:operate_own"       // start / complete / cancel / reschedule own lessons
  | "lessons:feedback_own"
  | "lessons:request_reschedule" // student self-service
  | "payments:read_all"
  | "payments:record_manual"
  | "payments:request"          // mark a lesson as requiring payment
  | "payments:read_own"
  | "availability:write_all"
  | "availability:write_own"
  | "assessments:review"
  | "whatsapp:inbox"
  | "profile:write_own"
  | "pricing:write";           // set lesson prices (owner only)

const SCHOOL_STAFF: Permission[] = [
  "school:view_reports",
  "students:read_all",
  "students:write",
  "students:update_progress",
  "instructors:write",
  "vehicles:write",
  "lessons:read_all",
  "lessons:write_all",
  "lessons:operate_own",
  "lessons:feedback_own",
  "payments:read_all",
  "payments:record_manual",
  "payments:request",
  "availability:write_all",
  "assessments:review",
  "whatsapp:inbox",
  "profile:write_own",
];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  saas_admin: new Set(["platform:manage_schools", "platform:manage_subscriptions", "platform:view_stats"]),
  school_owner: new Set([...SCHOOL_STAFF, "school:manage_settings", "school:manage_integrations", "pricing:write"]),
  school_admin: new Set(SCHOOL_STAFF),
  instructor: new Set([
    "students:read_assigned",
    "students:update_progress",
    "lessons:read_own",
    "lessons:operate_own",
    "lessons:feedback_own",
    "payments:request",
    "availability:write_own",
    "profile:write_own",
  ]),
  student: new Set(["lessons:read_own", "lessons:request_reschedule", "payments:read_own", "profile:write_own"]),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function isSchoolStaff(role: Role): boolean {
  return role === "school_owner" || role === "school_admin";
}

/** The authenticated principal, resolved on every request. */
export interface Actor {
  userId: string;
  role: Role;
  schoolId: string | null;
  email: string;
  instructorId: string | null;
  studentId: string | null;
}

/** A tenant-bound actor (everyone except SaaS admins). */
export type SchoolActor = Actor & { schoolId: string };

export function homePathFor(role: Role): string {
  switch (role) {
    case "saas_admin":
      return "/platform";
    case "school_owner":
    case "school_admin":
      return "/admin";
    case "instructor":
      return "/instructor";
    case "student":
      return "/student";
  }
}
