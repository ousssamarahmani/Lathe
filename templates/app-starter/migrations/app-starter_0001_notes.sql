-- Example tenant table "notes" (task P1-07). Runs after the foundation migrations,
-- as the owner role. File names start with the app name: all apps record their
-- migrations in the same schema_migrations table, so names must not collide.
--
-- Tenant table checklist (security.md): org_id NOT NULL, RLS enabled and forced,
-- one policy on app_current_org_id(), accessed only through withTenant().

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notes_org_id_created_at_idx ON notes (org_id, created_at, id);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_tenant_isolation ON notes
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO :"app_role";
