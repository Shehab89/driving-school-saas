import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Minimal stand-ins for the Next.js request context so the real session code can run here.
const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { closePools, one, withPlatform } from "@/lib/db";
import { createSession, destroySession, getActor } from "@/server/auth/session";
import { sweepRevokedSessions } from "@/server/auth/revocation";
import { createFixture, type Fixture } from "./helpers";

let f: Fixture;

beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

async function tokenVersion() {
  return (await withPlatform((tx) => one<{ token_version: number }>(tx, `SELECT token_version FROM users WHERE id = $1`, [f.ownerActor.userId])))!.token_version;
}

describe("logging out", () => {
  it("makes a copied session cookie stop working at once", async () => {
    await createSession({ sub: f.ownerActor.userId, sid: f.schoolId, role: "school_owner", tv: await tokenVersion() });
    const copied = jar.get("dsa_session")!;
    expect((await getActor())?.userId).toBe(f.ownerActor.userId);

    await destroySession();
    expect(jar.has("dsa_session")).toBe(false);

    // Someone who kept a copy of the cookie (shared computer, stolen cookie) is now signed out too.
    jar.set("dsa_session", copied);
    expect(await getActor()).toBeNull();
  });

  it("leaves other sessions of the same user signed in", async () => {
    const tv = await tokenVersion();
    await createSession({ sub: f.ownerActor.userId, sid: f.schoolId, role: "school_owner", tv });
    const phone = jar.get("dsa_session")!;
    await createSession({ sub: f.ownerActor.userId, sid: f.schoolId, role: "school_owner", tv });
    await destroySession();
    jar.set("dsa_session", phone);
    expect((await getActor())?.userId).toBe(f.ownerActor.userId);
  });

  it("rejects a token without a session id", async () => {
    const { SignJWT } = await import("jose");
    const legacy = await new SignJWT({ sid: f.schoolId, role: "school_owner", tv: await tokenVersion() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(f.ownerActor.userId)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    jar.set("dsa_session", legacy);
    expect(await getActor()).toBeNull();
  });

  it("the cleanup job keeps revocations that have not expired yet", async () => {
    const before = await withPlatform((tx) => one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM revoked_sessions WHERE expires_at > now()`));
    await sweepRevokedSessions();
    const after = await withPlatform((tx) => one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM revoked_sessions WHERE expires_at > now()`));
    expect(after!.n).toBe(before!.n);
    expect(after!.n).toBeGreaterThanOrEqual(2);
  });
});
