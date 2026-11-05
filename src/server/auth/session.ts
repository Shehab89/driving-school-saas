import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { SignJWT, decodeJwt, jwtVerify } from "jose";
import { env } from "@/lib/env";
import { revokeSessionId } from "./revocation";
import { one, withPlatform, withTenant } from "@/lib/db";
import { can, type Actor, type Permission, type Role, type SchoolActor } from "@/lib/rbac";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const COOKIE = "dsa_session";
const MAX_AGE_S = 60 * 60 * 24 * 14;

interface SessionClaims {
  sub: string;
  sid: string | null; // school id
  role: Role;
  tv: number; // token version
}

interface VerifiedClaims extends SessionClaims {
  jti: string;
}

function secret() {
  return new TextEncoder().encode(env.sessionSecret);
}

export async function createSession(claims: SessionClaims) {
  const jwt = await new SignJWT({ sid: claims.sid, role: claims.role, tv: claims.tv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, jwt, {
    httpOnly: true,
    // Secure everywhere except a production build run locally over plain http (E2E tests).
    secure: process.env.NODE_ENV === "production" && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(env.appUrl),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

/**
 * Sign out: the cookie is removed AND the token itself is revoked server-side,
 * so a copy of it (shared computer, stolen cookie) stops working at once.
 */
export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  jar.delete(COOKIE);
  if (!token) return;
  try {
    await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const { jti, exp } = decodeJwt(token);
    if (jti && exp) await revokeSessionId(jti, new Date(exp * 1000));
  } catch {
    // Invalid or expired token: nothing to revoke.
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActorRow {
  id: string;
  role: Role;
  school_id: string | null;
  email: string;
  status: string;
  token_version: number;
  instructor_id: string | null;
  student_id: string | null;
}

const ACTOR_SQL = `
  SELECT u.id, u.role, u.school_id, u.email, u.status, u.token_version,
         i.id AS instructor_id, s.id AS student_id
    FROM users u
    LEFT JOIN instructors i ON i.user_id = u.id AND i.status = 'active'
    LEFT JOIN students s ON s.user_id = u.id
   WHERE u.id = $1
     AND NOT EXISTS (SELECT 1 FROM revoked_sessions r WHERE r.jti = $2)`;

/** Resolve the current actor from the cookie; the DB row is re-read so disabled users and revoked sessions are rejected immediately. */
export async function getActor(): Promise<Actor | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? actorForToken(token) : null;
}

/** Layouts, pages and loaders each ask for the actor; within one request the same token is checked once. */
const actorForToken = cache(async (token: string): Promise<Actor | null> => {
  let claims: VerifiedClaims;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    claims = { sub: String(payload.sub), sid: (payload.sid as string | null) ?? null, role: payload.role as Role, tv: Number(payload.tv), jti: String(payload.jti ?? "") };
  } catch {
    return null;
  }
  // Every session token carries a random id so it can be revoked on sign-out.
  if (!UUID.test(claims.jti) || !UUID.test(claims.sub)) return null;
  const row = claims.sid
    ? await withTenant(claims.sid, (tx) => one<ActorRow>(tx, ACTOR_SQL, [claims.sub, claims.jti]))
    : await withPlatform((tx) => one<ActorRow>(tx, ACTOR_SQL + " AND u.school_id IS NULL", [claims.sub, claims.jti]));
  if (!row || row.status !== "active" || row.token_version !== claims.tv || row.role !== claims.role) return null;
  return {
    userId: row.id,
    role: row.role,
    schoolId: row.school_id,
    email: row.email,
    instructorId: row.instructor_id,
    studentId: row.student_id,
  };
});

/** For pages: redirect to /login when unauthenticated, 403 when lacking permission. */
export async function requirePage(permission?: Permission): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (permission && !can(actor.role, permission)) redirect("/forbidden");
  return actor;
}

export async function requireSchoolPage(permission?: Permission): Promise<SchoolActor> {
  const actor = await requirePage(permission);
  if (!actor.schoolId) redirect("/forbidden");
  return actor as SchoolActor;
}

/** For route handlers / server actions: throw instead of redirecting. */
export async function requireActor(permission?: Permission): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new UnauthorizedError();
  if (permission && !can(actor.role, permission)) throw new ForbiddenError();
  return actor;
}

export async function requireSchoolActor(permission?: Permission): Promise<SchoolActor> {
  const actor = await requireActor(permission);
  if (!actor.schoolId) throw new ForbiddenError("This action requires a school account");
  return actor as SchoolActor;
}
