-- P1-04: invitations and the last-owner rule.
-- Applied by the migration runner (src/db/migrate.ts) as the owner role.

-- Hash of the invite token presented in this transaction (set by the orgs module
-- with set_config(..., true)). Lets someone who is not a member yet read exactly
-- the one invitation whose secret they hold.
CREATE FUNCTION app_current_invite_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.invite_token_hash', true), '') $$;

-- invitations: tenant table (created through tenantTable()). The token itself is
-- never stored, only its sha256.
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role text NOT NULL,
  token_hash text NOT NULL,
  invited_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT invitations_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_role_format CHECK (role ~ '^[a-z][a-z0-9_-]{0,39}$'),
  CONSTRAINT invitations_accepted_pair CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

CREATE INDEX invitations_org_id_idx ON invitations (org_id);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_tenant_isolation ON invitations
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

-- Read-only lookup by token, and only while the invitation is still usable.
CREATE POLICY invitations_token_read ON invitations
  FOR SELECT
  USING (
    token_hash = app_current_invite_hash()
    AND accepted_at IS NULL
    AND expires_at > now()
  );

-- Role names follow the C1 RoleName format for memberships too.
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_format CHECK (role ~ '^[a-z][a-z0-9_-]{0,39}$');

-- An organization always keeps at least one owner.
--
-- Fires after any update or delete of an owner membership. It first locks the
-- organization row, so two transactions that each demote or remove a different
-- owner run their check one after the other: the second sees the first's
-- committed change and fails. If the organization row is not visible (being
-- deleted in this transaction, or no tenant context, as when a user is deleted),
-- the check is skipped.
CREATE FUNCTION memberships_keep_owner() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM 1 FROM organizations WHERE id = OLD.org_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = OLD.org_id AND role = 'owner') THEN
    RAISE EXCEPTION 'organization % must keep at least one owner', OLD.org_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'memberships_last_owner';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER memberships_keep_owner
  AFTER UPDATE OF role, org_id OR DELETE ON memberships
  FOR EACH ROW
  WHEN (OLD.role = 'owner')
  EXECUTE FUNCTION memberships_keep_owner();

-- A user can read their own audit events that have no org (for example a denied
-- org switch, written inside withUser). Never other users' events, never tenant events.
CREATE POLICY audit_events_self_read ON audit_events
  FOR SELECT
  USING (org_id IS NULL AND actor_id = app_current_user_id());
