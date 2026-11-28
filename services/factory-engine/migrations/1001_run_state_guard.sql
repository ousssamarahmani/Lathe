-- Grants: this file does not grant table privileges. The app role gets DML on
-- every table the owner role creates from the default privileges in
-- infra/postgres/init/roles.sql.in (ALTER DEFAULT PRIVILEGES FOR ROLE owner ...
-- TO app), not from 0001_initial.sql. A fresh engine database must have the
-- same default privileges set before migrations run (see migrations/README.md).
---- P3-02 fix (#20): the database refuses illegal run state changes, so a bug or a
-- raw UPDATE by the app role cannot skip the state machine. New migration:
-- 1000_engine_core.sql is already applied wherever main has run.
--
-- The edge list between the markers must equal ALLOWED in
-- src/orchestrator/state-machine.ts; a unit test compares the two.
-- All violations raise SQLSTATE 23514 (check_violation).
CREATE FUNCTION runs_guard_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  edge_ok boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.spec_id IS DISTINCT FROM OLD.spec_id
     OR NEW.demo IS DISTINCT FROM OLD.demo
     OR NEW.fault_injection IS DISTINCT FROM OLD.fault_injection
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.plan_id IS NOT NULL AND NEW.plan_id IS DISTINCT FROM OLD.plan_id)
  THEN
    RAISE EXCEPTION 'runs: immutable column changed' USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('DELIVERED', 'FAILED', 'CANCELLED')
     AND (NEW.state IS DISTINCT FROM OLD.state
          OR NEW.repair_attempts IS DISTINCT FROM OLD.repair_attempts
          OR NEW.plan_id IS DISTINCT FROM OLD.plan_id)
  THEN
    RAISE EXCEPTION 'runs: % is terminal', OLD.state USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT EXISTS (
      SELECT 1 FROM (VALUES
        -- edges:begin
        ('DEFINED', 'PLANNED'),
        ('DEFINED', 'FAILED'),
        ('DEFINED', 'CANCELLED'),
        ('PLANNED', 'BUILDING'),
        ('PLANNED', 'FAILED'),
        ('PLANNED', 'CANCELLED'),
        ('BUILDING', 'VERIFYING'),
        ('BUILDING', 'FAILED'),
        ('BUILDING', 'CANCELLED'),
        ('VERIFYING', 'REPAIRING'),
        ('VERIFYING', 'AWAITING_APPROVAL'),
        ('VERIFYING', 'FAILED'),
        ('VERIFYING', 'CANCELLED'),
        ('REPAIRING', 'BUILDING'),
        ('REPAIRING', 'FAILED'),
        ('REPAIRING', 'CANCELLED'),
        ('AWAITING_APPROVAL', 'DELIVERED'),
        ('AWAITING_APPROVAL', 'FAILED'),
        ('AWAITING_APPROVAL', 'CANCELLED')
        -- edges:end
      ) AS e (from_state, to_state)
      WHERE e.from_state = OLD.state AND e.to_state = NEW.state
    ) INTO edge_ok;
    IF NOT edge_ok THEN
      RAISE EXCEPTION 'runs: illegal transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- repair_attempts: exactly +1 on VERIFYING -> REPAIRING, unchanged otherwise.
  IF OLD.state = 'VERIFYING' AND NEW.state = 'REPAIRING' THEN
    IF NEW.repair_attempts <> OLD.repair_attempts + 1 THEN
      RAISE EXCEPTION 'runs: a repair must add exactly one attempt' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.repair_attempts IS DISTINCT FROM OLD.repair_attempts THEN
    RAISE EXCEPTION 'runs: repair_attempts may only change on VERIFYING -> REPAIRING'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER runs_guard_update
  BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_guard_update();

REVOKE ALL ON FUNCTION runs_guard_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runs_guard_update() TO :"app_role";

-- A run starts as DEFINED with no attempts and no plan. Without this, the app
-- role could INSERT a run already in any state (for example DELIVERED).
CREATE FUNCTION runs_guard_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM 'DEFINED'
     OR NEW.repair_attempts IS DISTINCT FROM 0
     OR NEW.plan_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'runs: a new run must be DEFINED with 0 repair attempts and no plan'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER runs_guard_insert
  BEFORE INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_guard_insert();
REVOKE ALL ON FUNCTION runs_guard_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runs_guard_insert() TO :"app_role";