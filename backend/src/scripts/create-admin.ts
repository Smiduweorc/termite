import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../config/env";
import { createDatabase } from "../db";
import { users } from "../db/schema";
import { canonicalEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { hashPassword } from "../lib/password";
import { issueLink, linkFor } from "../services/account.service";

/**
 * The way in, for a board that has nobody to let you in.
 *
 * Nobody can register, and only an admin can create an account - which is a closed loop
 * on a fresh install. This is the one door outside it, and it is deliberately a console
 * tool: it proves you hold the database rather than proving anything over the network,
 * which is the only credential that makes sense for "there is no administrator yet".
 *
 *   bun run admin:create you@example.com "Your Name"
 *
 * It never sets a password. It prints a one-time link, exactly like an invite, so no
 * password is ever typed into a shell, stored in history, or read out of a log.
 *
 * Run it again for an account that already exists and it re-keys that account: promote
 * to admin if needed, new link, every outstanding link burned. That is the recovery path
 * for a locked-out maintainer.
 */
const [email, name] = process.argv.slice(2);

if (!email?.includes("@")) {
	logger.error('usage: bun run admin:create <email> "<name>"');
	process.exit(1);
}

const { db, pool } = createDatabase(env.DATABASE_URL);

const canonical = canonicalEmail(email);
const existing = await db.query.users.findFirst({
	where: eq(users.emailCanonical, canonical),
});

let userId: string;
let created: boolean;

if (existing) {
	userId = existing.id;
	created = false;

	if (existing.role !== "admin") {
		await db
			.update(users)
			.set({ role: "admin", updatedAt: new Date() })
			.where(eq(users.id, existing.id));
	}
} else {
	const [user] = await db
		.insert(users)
		.values({
			email: email.trim(),
			emailCanonical: canonical,
			name: name || email.trim(),
			// No usable password: a random one nobody holds the input for. The link is
			// the only way in, and an unaccepted invite leaves no working credential.
			passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
			role: "admin",
		})
		.returning();

	if (!user) throw new Error("insert returned no row");

	userId = user.id;
	created = true;
}

const token = await issueLink(db, userId, "invite");

logger.info(
	{
		email: canonical,
		created,
		// Printed rather than emailed: whoever runs this is standing at the machine, and
		// a fresh install usually has no SMTP configured yet.
		link: linkFor(token),
		expires: "7 days",
	},
	created ? "admin created - open the link to set a password" : "admin re-keyed",
);

await pool.end();
