import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from ".";

/**
 * Applies everything in backend/drizzle to the database named by DATABASE_URL, then
 * exits. Run it once per deploy, before the server starts - the released image has no
 * other way to create its schema.
 *
 * `drizzle-kit migrate` is what does this in development, but drizzle-kit is a
 * devDependency and the runtime image installs with --production, so the binary is not
 * there. The migrator imported above ships inside drizzle-orm itself, which is a
 * production dependency, and reads the same drizzle/ folder and the same
 * meta/_journal.json that drizzle-kit generates. Nothing about the development workflow
 * changes.
 */

// Relative to this file, matching grpc/proto.ts: the folder has to be found whether the
// process was launched from backend/, from the repo root, or as a one-shot container.
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "drizzle");

// config/env.ts is deliberately not imported. Its schema refuses to hand back anything
// until JWT_SECRET, the mail settings and the rest are present and valid, and a container
// whose entire job is to run four SQL files should not have to carry the application's
// full configuration to do it. DATABASE_URL is the only thing a migration needs.
const url = process.env.DATABASE_URL;

if (!url) {
	throw new Error("DATABASE_URL is not set: nothing to migrate against.");
}

const { db, pool } = createDatabase(url);

try {
	await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
	// Not the pino logger: that imports config/env, which is exactly the dependency this
	// script exists without. process.stdout is enough for a process that prints one line.
	process.stdout.write(`migrations applied from ${MIGRATIONS_DIR}\n`);
} finally {
	// Without this the pool keeps the event loop alive and the container never exits,
	// which for a one-shot service means `depends_on: service_completed_successfully`
	// waits forever.
	await pool.end();
}
