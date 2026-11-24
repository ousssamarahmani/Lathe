import { createDatabase, dropTestDatabase } from '../scripts/create-db';
import { migrate } from '../scripts/migrate';
import { seed } from '../scripts/seed';

/** A clean throwaway database for this run: drop leftovers, create, migrate, seed. */
export default async function globalSetup(): Promise<void> {
  await dropTestDatabase();
  await createDatabase();
  await migrate();
  await seed();
}
