-- P7-01: hierarchical scopes org → team → project (opt-in), with scoped role
-- grants and explicit denies. Applied by the migration runner as the owner role.
--
-- The foundation stores only the structure. Apps keep names and data in their own
-- tables and point them at a scope id. All three tables are tenant tables: org_id
-- NOT NULL, RLS enabled and forced, one policy on app_current_org_id().
--
-- Every cross-table reference includes org_id, so a scope, grant or deny can never
-- point at a row of another org, whatever the application code does.

-- Lets grants and denies reference a membership together with its org.
ALTER TABLE memberships ADD CONSTRAINT memberships_org_id_id_unique UNIQUE (org_id, id);

CREATE TABLE scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind text NOT NULL,
  parent_id uuid,
  parent_kind text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The referenced side of the composite keys below.
  CONSTRAINT scopes_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT scopes_org_id_id_kind_unique UNIQUE (org_id, id, kind),
  -- A team sits directly under the org; a project sits under a team. Depth is fixed.
  CONSTRAINT scopes_shape CHECK (
    (kind = 'team' AND parent_id IS NULL AND parent_kind IS NULL)
    OR (kind = 'project' AND parent_id IS NOT NULL AND parent_kind = 'team')
  ),
  -- The parent is a team of the same org.
  CONSTRAINT scopes_parent_fk FOREIGN KEY (org_id, parent_id, parent_kind)
    REFERENCES scopes (org_id, id, kind) ON DELETE CASCADE
);
CREATE INDEX scopes_org_id_parent_id_idx ON scopes (org_id, parent_id);

CREATE TABLE scope_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  scope_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scope_grants_role_format CHECK (role ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT scope_grants_unique UNIQUE (org_id, scope_id, membership_id, role),
  CONSTRAINT scope_grants_scope_fk FOREIGN KEY (org_id, scope_id)
    REFERENCES scopes (org_id, id) ON DELETE CASCADE,
  CONSTRAINT scope_grants_membership_fk FOREIGN KEY (org_id, membership_id)
    REFERENCES memberships (org_id, id) ON DELETE CASCADE
);
CREATE INDEX scope_grants_org_id_membership_id_idx ON scope_grants (org_id, membership_id);

CREATE TABLE scope_denies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  scope_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  permission text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scope_denies_permission_format
    CHECK (permission ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT scope_denies_unique UNIQUE (org_id, scope_id, membership_id, permission),
  CONSTRAINT scope_denies_scope_fk FOREIGN KEY (org_id, scope_id)
    REFERENCES scopes (org_id, id) ON DELETE CASCADE,
  CONSTRAINT scope_denies_membership_fk FOREIGN KEY (org_id, membership_id)
    REFERENCES memberships (org_id, id) ON DELETE CASCADE
);
CREATE INDEX scope_denies_org_id_membership_id_idx ON scope_denies (org_id, membership_id);

ALTER TABLE scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY scopes_tenant_isolation ON scopes
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE scope_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_grants_tenant_isolation ON scope_grants
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE scope_denies ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_denies FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_denies_tenant_isolation ON scope_denies
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
