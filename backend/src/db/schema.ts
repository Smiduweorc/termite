import {
	boolean,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/** Everything authorization hangs off. Add roles here and the TS union follows. */
export const userRole = pgEnum("user_role", ["user", "admin"]);

export type UserRole = (typeof userRole.enumValues)[number];

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		email: text("email").notNull(),
		name: text("name").notNull(),
		// Never the password itself. See lib/password.ts.
		passwordHash: text("password_hash").notNull(),
		role: userRole("role").notNull().default("user"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [uniqueIndex("users_email_idx").on(table.email)],
);

/**
 * Refresh tokens are rows, not JWTs.
 *
 * A signed refresh JWT cannot be taken back - it stays valid until it expires, so "log
 * out everywhere" would be a lie. Storing a hash of each token means logout can revoke
 * it. Only the hash is kept: a leaked database still does not hand over usable tokens.
 */
export const refreshTokens = pgTable(
	"refresh_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("refresh_tokens_hash_idx").on(table.tokenHash),
		index("refresh_tokens_user_idx").on(table.userId),
	],
);

export const posts = pgTable(
	"posts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		published: boolean("published").notNull().default(false),
		// Who is allowed to edit this post. Deleting a user takes their posts with them.
		authorId: uuid("author_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("posts_created_at_idx").on(table.createdAt),
		index("posts_author_idx").on(table.authorId),
	],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;

/** A user with the password hash stripped. Never send `User` itself to a client. */
export type PublicUser = Omit<User, "passwordHash">;

export function toPublicUser(user: User): PublicUser {
	const { passwordHash: _passwordHash, ...rest } = user;

	return rest;
}
