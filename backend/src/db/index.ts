import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

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
