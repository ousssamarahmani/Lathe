-- Support Desk tickets and comments (task P6-01). Runs after the foundation migrations,
-- as the owner role, in the app's own database.
--
-- Tenant table checklist (security.md): org_id NOT NULL, RLS enabled and forced, one
-- policy on app_current_org_id(), accessed only through withTenant(). Cross-table
-- references include org_id, so a comment or an assignment can never point into
-- another org, whatever the application code does.

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  requester_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The assignee is a membership of the same org (unique (org_id, id) from foundation 0005).
  assignee_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT tickets_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT tickets_assignee_fk FOREIGN KEY (org_id, assignee_membership_id)
    REFERENCES memberships (org_id, id) ON DELETE SET NULL (assignee_membership_id),
  CONSTRAINT tickets_closed_at_matches_status CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX tickets_org_id_created_at_idx ON tickets (org_id, created_at, id);
CREATE INDEX tickets_org_id_requester_id_idx ON tickets (org_id, requester_id);
CREATE INDEX tickets_org_id_assignee_idx ON tickets (org_id, assignee_membership_id);

CREATE TABLE ticket_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  -- Internal notes are visible to staff only (tickets.read_all), never to the requester.
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_comments_ticket_fk FOREIGN KEY (org_id, ticket_id)
    REFERENCES tickets (org_id, id) ON DELETE CASCADE
);
CREATE INDEX ticket_comments_org_id_ticket_id_idx ON ticket_comments (org_id, ticket_id, created_at);

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tickets_tenant_isolation ON tickets
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_comments_tenant_isolation ON ticket_comments
  FOR ALL
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

-- Tickets are closed, never deleted; comments are a record. No DELETE for the app role,
-- and comments cannot be edited.
GRANT SELECT, INSERT, UPDATE ON tickets TO :"app_role";
REVOKE DELETE ON tickets FROM :"app_role";
GRANT SELECT, INSERT ON ticket_comments TO :"app_role";
REVOKE UPDATE, DELETE ON ticket_comments FROM :"app_role";
