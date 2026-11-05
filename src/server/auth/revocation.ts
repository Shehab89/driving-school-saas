import { withPlatform } from "@/lib/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mark one session token (by its jti) as signed out until it would have expired anyway. */
export async function revokeSessionId(jti: string, expiresAt: Date) {
  if (!UUID.test(jti)) return;
  await withPlatform((tx) =>
    tx.query(`INSERT INTO revoked_sessions (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING`, [jti, expiresAt]),
  );
}

/** Drop revocations whose tokens have expired on their own. Called from the cron tick. */
export async function sweepRevokedSessions() {
  await withPlatform((tx) => tx.query(`DELETE FROM revoked_sessions WHERE expires_at < now()`));
}
