import { dropTestDatabase } from '../scripts/create-db';

export default async function globalTeardown(): Promise<void> {
  await dropTestDatabase();
}
