/**
 * The school's own logo and colour, shown in the student and instructor apps,
 * the school portal and the e-mails, so students see "their" driving school.
 *
 * The logo is stored in the database (small images only) and served at
 * /api/school-logo/<school id>; a logo is not secret.
 */
import { one, withTenant, type Tx } from "@/lib/db";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";

export const MAX_LOGO_BYTES = 500 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ready-made colours for people who don't know their hex code. */
export const BRAND_PRESETS = ["#f5b000", "#e4572e", "#d81b60", "#7b1fa2", "#3949ab", "#1e88e5", "#00897b", "#43a047", "#16181d"] as const;

function assertOwner(p: Principal) {
  if (p.type !== "user" || !can(p.actor.role, "school:manage_settings")) throw new ForbiddenError();
}

export function normaliseColor(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s);
  if (!m) throw new PolicyError("Not a colour code.", "brand_color_invalid");
  const hex = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return `#${hex}`;
}

export async function setBrandColor(tx: Tx, p: Principal, raw: string | null) {
  assertOwner(p);
  const color = normaliseColor(raw);
  await tx.query(`UPDATE schools SET brand_color = $2 WHERE id = $1`, [p.schoolId, color]);
  await audit(tx, p, "school.brand_color_changed", "school", p.schoolId, { color });
  return color;
}

/** Recognise the image by its first bytes, not by the name or the type the browser sent. */
export function sniffImage(data: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length > 12 && String.fromCharCode(...data.slice(0, 4)) === "RIFF" && String.fromCharCode(...data.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export async function setLogo(tx: Tx, p: Principal, data: Uint8Array) {
  assertOwner(p);
  if (data.length === 0) throw new PolicyError("Choose a picture.", "logo_missing");
  if (data.length > MAX_LOGO_BYTES) throw new PolicyError("The picture is too large.", "logo_too_large", { max: "500 KB" });
  const type = sniffImage(data);
  if (!type) throw new PolicyError("Use a PNG, JPG or WebP picture.", "logo_type");
  await tx.query(
    `INSERT INTO school_logos (school_id, content_type, data) VALUES ($1, $2, $3)
     ON CONFLICT (school_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
    [p.schoolId, type, Buffer.from(data)],
  );
  await audit(tx, p, "school.logo_changed", "school", p.schoolId, { bytes: data.length, type });
}

export async function removeLogo(tx: Tx, p: Principal) {
  assertOwner(p);
  await tx.query(`DELETE FROM school_logos WHERE school_id = $1`, [p.schoolId]);
  await audit(tx, p, "school.logo_removed", "school", p.schoolId);
}

/** For the public logo route. */
export async function loadLogo(schoolId: string): Promise<{ content_type: string; data: Buffer; updated_at: Date } | null> {
  if (!UUID.test(schoolId)) return null;
  return withTenant(schoolId, (tx) => one(tx, `SELECT content_type, data, updated_at FROM school_logos WHERE school_id = $1`, [schoolId]));
}

export function logoUrl(schoolId: string, version: Date | string | null | undefined): string | null {
  if (!version) return null;
  return `/api/school-logo/${schoolId}?v=${Math.floor(new Date(version).getTime() / 1000)}`;
}
