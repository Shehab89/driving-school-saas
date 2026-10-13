-- Platform support access: a school owner grants platform support a time-boxed,
-- read-only look at the school's operational data. Without an active grant the
-- platform console shows aggregates only. Every support view is audited and
-- visible to the school.
CREATE TABLE support_access_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  granted_by  uuid NOT NULL,
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  FOREIGN KEY (school_id, granted_by) REFERENCES users(school_id, id) ON DELETE CASCADE
);
CREATE INDEX support_access_grants_active ON support_access_grants(school_id, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_access_grants USING (school_id = app_current_school_id()) WITH CHECK (school_id = app_current_school_id());
-- Grants are history: never deleted by the app.
REVOKE DELETE ON support_access_grants FROM dsa_app, dsa_platform;
