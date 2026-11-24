import { createDatabase } from '../../scripts/create-db';
import { migrate } from '../../scripts/migrate';

/**
 * Vitest global setup: creates this app's own database if needed, then applies the
 * foundation and app migrations once, as the owner role. The app's tables never go
 * into the foundation's test database.
 */
export default async function setup(): Promise<void> {
  const db = await createDatabase();
  const applied = await migrate();
  console.log(
    `app database ${db}; migrations applied: ${applied.length > 0 ? applied.join(', ') : 'none pending'}`,
  );
}
