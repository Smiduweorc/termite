import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/** The handle a `db.transaction(...)` callback is given. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Anything a query can run on.
 *
 * Drizzle types a transaction as its own thing rather than as a Database, so a helper
 * that has to work both inside and outside one takes this instead - which is how
 * "shipping a release also ships its items" can be a single atomic step without every
 * helper being duplicated.
 */
export type Executor = Database | Transaction;

/**
 * Nothing connects at import time - `pg` only opens a socket on the first query.
 * The app builds its database in `src/index.ts` and passes it down, which is what
 * lets the tests swap in PGlite without touching a real server.
 */
export function createDatabase(connectionString: string): { db: Database; pool: Pool } {
	const pool = new Pool({ connectionString });
	const db = drizzle(pool, { schema });

	return { db, pool };
}

export { schema };
