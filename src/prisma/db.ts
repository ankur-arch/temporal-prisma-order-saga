import postgres from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

export const contract = contractFromJson<Contract>(contractJson);

/**
 * Builds a Prisma ORM client. The client owns a `pg` connection pool that is
 * opened lazily on the first query, so one client per worker process is enough.
 */
export function createDb(url: string) {
  return postgres({ contract, url });
}

export type Db = ReturnType<typeof createDb>;
