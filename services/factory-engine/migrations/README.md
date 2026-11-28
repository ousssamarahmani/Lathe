# Engine migrations

Run as the owner role, never as the app role. `1000_engine_core.sql` creates the tables, `1001_run_state_guard.sql` adds the run state triggers.

## Where the app role gets its table grants

Migrations do not grant table privileges. `0001_initial.sql` (foundation) mentions granting DML to the app role, but the grant comes from default privileges set by `infra/postgres/init/roles.sql.in`: `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <app>` (and USAGE, SELECT on sequences). Tables created by the owner role inherit them.

A fresh engine database needs the same default privileges, set before migrations run. Without them the app role gets `permission denied` on every table. The infra init script does this for the standard database. For another database, run the same statements for it (plus schema USAGE and database CONNECT for the app role).
