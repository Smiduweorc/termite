import { sql } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	index,
	integer,
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
		/** As they typed it. This is what mail is addressed to, and what is shown back. */
		email: text("email").notNull(),
		/**
		 * The mailbox behind it, per lib/email.ts - this is the identity, and the thing
		 * the UNIQUE index is on. Two spellings of one inbox cannot become two accounts,
		 * and signing in works whichever spelling someone remembers.
		 */
		emailCanonical: text("email_canonical").notNull(),
		name: text("name").notNull(),
		// Never the password itself. See lib/password.ts.
		passwordHash: text("password_hash").notNull(),
		role: userRole("role").notNull().default("user"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [uniqueIndex("users_email_canonical_idx").on(table.emailCanonical)],
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

/**
 * Where a release is in its cycle.
 *
 * - planned:      on the calendar, nothing promised yet
 * - merge_window: the maintainer is taking work for it right now
 * - released:     shipped, and its items with it
 *
 * Three states because that is the whole model: projects that batch work into a window
 * and then ship. There is deliberately no "in progress" per item - see feedbackStatus.
 */
export const releaseStatus = pgEnum("release_status", ["planned", "merge_window", "released"]);

export type ReleaseStatus = (typeof releaseStatus.enumValues)[number];

export const releases = pgTable(
	"releases",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		// Free text rather than a parsed semver triple: calver, "0.3", "2026.1" and
		// "beta-4" are all things small projects actually ship under.
		version: text("version").notNull(),
		name: text("name"),
		status: releaseStatus("status").notNull().default("planned"),
		notes: text("notes"),
		// The calendar half of the board. Null is honest - "there will be another one,
		// eventually" is a real answer for a side project, and better than a fake date.
		plannedFor: timestamp("planned_for", { withTimezone: true }),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// One row per version, enforced by the database rather than by a check-then-insert.
		uniqueIndex("releases_version_idx").on(table.version),
		index("releases_planned_for_idx").on(table.plannedFor),
	],
);

/** An idea or a bug. Two kinds, because a board with a taxonomy stops being a board. */
export const feedbackKind = pgEnum("feedback_kind", ["idea", "bug"]);

export type FeedbackKind = (typeof feedbackKind.enumValues)[number];

/**
 * The only lifecycle an item has.
 *
 * - open:     said out loud, nobody has promised anything
 * - planned:  attached to a release the maintainer intends to ship
 * - shipped:  that release went out
 * - declined: answered, with a reason, and out of the way
 *
 * "Declined" is a feature. A board that can only accumulate becomes a backlog, and this
 * is explicitly not a backlog tool.
 */
export const feedbackStatus = pgEnum("feedback_status", ["open", "planned", "shipped", "declined"]);

export type FeedbackStatus = (typeof feedbackStatus.enumValues)[number];

export const feedback = pgTable(
	"feedback",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		kind: feedbackKind("kind").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		status: feedbackStatus("status").notNull().default("open"),
		/**
		 * Null for the anonymous submitter, which is the common case and the point:
		 * requiring an account is how a project loses the report it most needed. A
		 * signed-in author gets recorded so they can edit their own item later.
		 */
		authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
		/** Whatever name they typed, if any. Display only - it proves nothing. */
		authorName: text("author_name"),
		/**
		 * The merge window this is aimed at. `set null` rather than cascade: deleting a
		 * release must not delete the community's requests along with it.
		 */
		releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
		/** The maintainer's answer - why it was declined, or what it is waiting on. */
		maintainerNote: text("maintainer_note"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("feedback_created_at_idx").on(table.createdAt),
		index("feedback_status_idx").on(table.status),
		index("feedback_release_idx").on(table.releaseId),
		index("feedback_author_idx").on(table.authorId),
	],
);

/**
 * One row per voter per item, rather than a counter column.
 *
 * A counter cannot answer "have I already voted?", and it cannot be un-voted safely
 * under concurrency. Rows can do both, and the UNIQUE index below is what actually
 * enforces one vote each - not a check the service performs and hopes to win.
 *
 * `voterKey` is a signed-in user id or the hash of an anonymous voter cookie; see
 * lib/voter.ts. It is never the raw cookie, so this table leaks no usable identity.
 */
export const votes = pgTable(
	"votes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		feedbackId: uuid("feedback_id")
			.notNull()
			.references(() => feedback.id, { onDelete: "cascade" }),
		voterKey: text("voter_key").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("votes_feedback_voter_idx").on(table.feedbackId, table.voterKey),
		index("votes_feedback_idx").on(table.feedbackId),
	],
);

/**
 * Why a set-password link exists.
 *
 * Both kinds are one-shot links to the same form; only the wording and the lifetime
 * differ. An invite is the only way an account ever gets its first password now that
 * nobody can register - see services/account.service.ts.
 */
export const passwordTokenPurpose = pgEnum("password_token_purpose", ["invite", "reset"]);

export type PasswordTokenPurpose = (typeof passwordTokenPurpose.enumValues)[number];

/**
 * Stored the same way refresh tokens are: hashed, single-use, and with an expiry.
 *
 * The link that lands in someone's inbox is a bearer credential for their account, so
 * the row holds only its SHA-256 - a leaked database, or a leaked backup, hands over no
 * usable links. `usedAt` is what makes it single-use: a reset link that still worked
 * after the password changed would be a second key left under the mat.
 */
export const passwordTokens = pgTable(
	"password_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		purpose: passwordTokenPurpose("purpose").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("password_tokens_hash_idx").on(table.tokenHash),
		index("password_tokens_user_idx").on(table.userId),
	],
);

/**
 * A task board: the maintainer's own working surface, next to the public one.
 *
 * The board is where "we should do this" turns into "I am doing this". It is private by
 * default and can be published read-only, because some projects want to show what they
 * are working on and some would rather not promise anything.
 */
export const boards = pgTable("boards", {
	id: uuid("id").primaryKey().defaultRandom(),
	title: text("title").notNull(),
	description: text("description"),
	isPublic: boolean("is_public").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A kanban column, and nothing more opinionated than that.
 *
 * There is no fixed set and no mandatory "done" column: a board can have two buckets or
 * eleven, named whatever the work is actually called. `isDone` is an *opt-in* marker -
 * if a board has one, dropping a task there ticks it off and ticking it off moves it
 * there; if it has none, done is just a checkbox and no column is implied. `isDefault`
 * is where new tasks land. Both are at most one per board, enforced by the partial
 * unique indexes below rather than by hope.
 *
 * `wipLimit` is the one piece of process this thing will help you keep, and only because
 * you asked for it: null means no limit.
 */
export const buckets = pgTable(
	"buckets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		boardId: uuid("board_id")
			.notNull()
			.references(() => boards.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		position: doublePrecision("position").notNull(),
		wipLimit: integer("wip_limit"),
		isDone: boolean("is_done").notNull().default(false),
		isDefault: boolean("is_default").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("buckets_board_idx").on(table.boardId),
		uniqueIndex("buckets_one_done_idx").on(table.boardId).where(sql`is_done`),
		uniqueIndex("buckets_one_default_idx").on(table.boardId).where(sql`is_default`),
	],
);

/**
 * A task, ordered by a floating-point `position` rather than by an integer rank.
 *
 * This is the part worth being deliberate about. If order were 0,1,2,3 then dragging a
 * card to the top would renumber every card under it - one drag, N writes, and two
 * people dragging at once end up interleaved. With a float, a card dropped between two
 * neighbours takes the midpoint of their positions: one row changes, and nobody else's
 * order moves. It is the same trick Jira's LexoRank and Figma's fractional indexing use,
 * done with the numeric type Postgres already has.
 *
 * Halving a gap forever eventually runs out of mantissa, so the service rebalances a
 * bucket when two neighbours get too close to split. See lib/position.ts.
 *
 * `bucketId` has no ON DELETE clause on purpose: NO ACTION is checked at the end of the
 * statement, so deleting a whole board (which cascades to both tables) is fine, while
 * deleting a single bucket out from under its tasks is refused - the service has to say
 * where those tasks go first.
 */
export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		boardId: uuid("board_id")
			.notNull()
			.references(() => boards.id, { onDelete: "cascade" }),
		bucketId: uuid("bucket_id")
			.notNull()
			.references(() => buckets.id),
		title: text("title").notNull(),
		description: text("description"),
		done: boolean("done").notNull().default(false),
		doneAt: timestamp("done_at", { withTimezone: true }),
		position: doublePrecision("position").notNull(),
		/** Optional glue: the request this came from, and the release it is aimed at. */
		feedbackId: uuid("feedback_id").references(() => feedback.id, { onDelete: "set null" }),
		releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("tasks_board_idx").on(table.boardId),
		// The kanban query is "everything in this bucket, in order", so the index carries
		// the sort with it and Postgres never has to sort the column at read time.
		index("tasks_bucket_position_idx").on(table.bucketId, table.position),
		index("tasks_feedback_idx").on(table.feedbackId),
	],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
export type Vote = typeof votes.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type PasswordToken = typeof passwordTokens.$inferSelect;
export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
export type Bucket = typeof buckets.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

/** A board with its columns and their cards - one round trip, because the UI needs all of it. */
export interface BoardContents extends Board {
	buckets: (Bucket & { tasks: Task[] })[];
}

/**
 * A board item as the board shows it: the row, plus the two things that only make sense
 * per viewer - how many people wanted it, and whether you are one of them.
 */
export interface FeedbackItem extends Feedback {
	votes: number;
	viewerHasVoted: boolean;
}

/** A release with the size of its window attached. */
export interface ReleaseSummary extends Release {
	itemCount: number;
}

/** A user with the password hash stripped. Never send `User` itself to a client. */
export type PublicUser = Omit<User, "passwordHash">;

export function toPublicUser(user: User): PublicUser {
	const { passwordHash: _passwordHash, ...rest } = user;

	return rest;
}
