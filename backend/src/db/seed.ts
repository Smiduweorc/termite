import { env } from "../config/env";
import { logger } from "../lib/logger";
import { hashPassword } from "../lib/password";
import { createDatabase } from "./index";
import { posts, users } from "./schema";

/**
 * Development seed. Two accounts, so you can watch authorization actually bite:
 * sign in as alice and try to edit bob's post.
 *
 * Passwords are hashed here exactly as registration would hash them - nothing in the
 * database, not even a seeded row, ever holds a plaintext password.
 */
const { db, pool } = createDatabase(env.DATABASE_URL);

const [admin, member] = await db
	.insert(users)
	.values([
		{
			email: "alice@example.com",
			name: "Alice",
			passwordHash: await hashPassword("password123"),
			role: "admin",
		},
		{
			email: "bob@example.com",
			name: "Bob",
			passwordHash: await hashPassword("password123"),
			role: "user",
		},
	])
	.returning();

if (!admin || !member) {
	throw new Error("Seed failed: users were not inserted");
}

await db.insert(posts).values([
	{
		title: "Hello Elysia",
		body: "Bun is the runtime, Elysia is the server.",
		published: true,
		authorId: admin.id,
	},
	{
		title: "Typed end to end",
		body: "tRPC carries the router types into Vue.",
		published: true,
		authorId: member.id,
	},
	{
		// Only Bob and admins can see this one. Sign in as each and watch it appear.
		title: "Bob's draft",
		body: "Not published yet.",
		published: false,
		authorId: member.id,
	},
]);

// pino's signature is (fields, message) - the object comes first.
logger.info(
	{ admin: `${admin.email} / password123`, user: `${member.email} / password123` },
	"seeded",
);

await pool.end();
