import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "../db";
import * as schema from "../db/schema";

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/**
 * A real Postgres, compiled to WASM and run in this process. Same SQL dialect as
 * the server in docker-compose, but no daemon, no port, no cleanup between runs.
 *
 * The cast is the one concession: PGlite and node-postgres are different drivers,
 * so their Drizzle types differ by driver generic even though every query in this
 * codebase is identical across the two. Migrations run from the same `drizzle/`
 * folder production uses, so a schema drift still fails the test suite.
 */
export async function createTestDatabase(): Promise<Database> {
	const client = new PGlite();
	const db = drizzle(client, { schema });

	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

	return db as unknown as Database;
}
