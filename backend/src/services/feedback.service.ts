import { type } from "arktype";
import { and, desc, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import type { Database, Executor } from "../db";
import { type FeedbackItem, feedback, releases, votes } from "../db/schema";
import { type Actor, requireActor } from "../lib/actor";
import { AppError, parseInput } from "../lib/errors";

export const ListFeedbackInput = type({
	"kind?": "'idea' | 'bug'",
	"status?": "'open' | 'planned' | 'shipped' | 'declined'",
	"releaseId?": "string.uuid",
	/** "top" is a show of hands, "new" is the firehose. The board defaults to hands. */
	"sort?": "'top' | 'new'",
	"limit?": "1 <= number.integer <= 100",
});

export const FeedbackIdInput = type({ id: "string.uuid" });

export const SubmitFeedbackInput = type({
	kind: "'idea' | 'bug'",
	title: "1 <= string <= 200",
	body: "1 <= string <= 10000",
	/**
	 * Optional, and free text. Nobody has to say who they are to file a bug, and the
	 * name is never treated as identity - it is a signature on a note, not a login.
	 */
	"authorName?": "string <= 80",
});

export const EditFeedbackInput = type({
	id: "string.uuid",
	"kind?": "'idea' | 'bug'",
	"title?": "1 <= string <= 200",
	"body?": "1 <= string <= 10000",
	// The three below are the maintainer's alone; the service enforces that.
	"status?": "'open' | 'planned' | 'shipped' | 'declined'",
	"releaseId?": "string.uuid | null",
	"maintainerNote?": "string <= 2000 | null",
});

/**
 * The vote columns, computed per viewer.
 *
 * `count` over the left join gives the tally. `bool_or` in the same pass answers "have I
 * already voted?" without a second round trip, and without ever sending the whole vote
 * list to the client - which would leak who voted for what.
 */
function voteColumns(voterKey: string | null) {
	return {
		votes: sql<number>`count(${votes.id})`.mapWith(Number),
		viewerHasVoted: voterKey
			? sql<boolean>`coalesce(bool_or(${votes.voterKey} = ${voterKey}), false)`
			: sql<boolean>`false`,
	};
}

function orderFor(sort: "top" | "new" | undefined): SQL[] {
	const newest = desc(feedback.createdAt);

	// Ties on votes fall back to newest, so a board full of 0-vote items still reads
	// like a board rather than like whatever order Postgres felt like.
	return sort === "new" ? [newest] : [desc(sql`count(${votes.id})`), newest];
}

/**
 * The board.
 *
 * Everything here is public: no drafts, no private items, nothing to hide from an
 * anonymous reader. That is the whole premise - a town hall people can read before they
 * decide whether it is worth speaking up in.
 */
export async function listFeedback(
	db: Database,
	voterKey: string | null,
	input: unknown,
): Promise<FeedbackItem[]> {
	const { kind, status, releaseId, sort, limit } = parseInput(ListFeedbackInput, input);

	return (
		db
			.select({ ...getTableColumns(feedback), ...voteColumns(voterKey) })
			.from(feedback)
			.leftJoin(votes, eq(votes.feedbackId, feedback.id))
			.where(
				and(
					kind ? eq(feedback.kind, kind) : undefined,
					status ? eq(feedback.status, status) : undefined,
					releaseId ? eq(feedback.releaseId, releaseId) : undefined,
				),
			)
			// Grouping by the primary key is enough: Postgres knows the rest of the row
			// depends on it, so every feedback column comes along without being listed.
			.groupBy(feedback.id)
			.orderBy(...orderFor(sort))
			.limit(limit ?? 50)
	);
}

/** One item, with the same per-viewer vote columns the list carries. */
async function loadItem(db: Database, voterKey: string | null, id: string): Promise<FeedbackItem> {
	const [item] = await db
		.select({ ...getTableColumns(feedback), ...voteColumns(voterKey) })
		.from(feedback)
		.leftJoin(votes, eq(votes.feedbackId, feedback.id))
		.where(eq(feedback.id, id))
		.groupBy(feedback.id)
		.limit(1);

	if (!item) {
		throw new AppError("NOT_FOUND", `No feedback with id ${id}`);
	}

	return item;
}

export async function getFeedback(
	db: Database,
	voterKey: string | null,
	input: unknown,
): Promise<FeedbackItem> {
	const { id } = parseInput(FeedbackIdInput, input);

	return loadItem(db, voterKey, id);
}

/**
 * Anyone can file. That is not an oversight.
 *
 * The submitter is recorded if they happen to be signed in - it is what lets them edit
 * their own wording later - but an account is never required, because the report you
 * lose to a signup form is the one you needed most.
 *
 * Filing also casts your vote. You obviously want the thing you just asked for, and
 * making people click again to say so only distorts the count.
 */
export async function submitFeedback(
	db: Database,
	actor: Actor | null,
	voterKey: string | null,
	input: unknown,
): Promise<FeedbackItem> {
	const { kind, title, body, authorName } = parseInput(SubmitFeedbackInput, input);

	const signature = authorName?.trim();

	const [row] = await db
		.insert(feedback)
		.values({
			kind,
			title,
			body,
			authorId: actor?.id ?? null,
			// A signed-in submitter is already named by their account; only an anonymous
			// one needs the free-text signature, and only if they bothered to give one.
			authorName: actor ? null : signature || null,
		})
		.returning();

	if (!row) {
		throw new AppError("INTERNAL", "Insert returned no row");
	}

	if (voterKey) {
		await db.insert(votes).values({ feedbackId: row.id, voterKey });
	}

	return loadItem(db, voterKey, row.id);
}

/**
 * Two different permissions live in one procedure.
 *
 * Wording (title, body, kind) belongs to whoever filed it, if they were signed in when
 * they did. Triage (status, release, the maintainer's note) belongs to the maintainer
 * alone - that is the entire point of the model: the community says what it wants, one
 * person decides what actually ships.
 */
export async function editFeedback(
	db: Database,
	actor: Actor | null,
	voterKey: string | null,
	input: unknown,
): Promise<FeedbackItem> {
	const { id, releaseId, ...rest } = parseInput(EditFeedbackInput, input);
	const current = requireActor(actor);
	const isAdmin = current.role === "admin";

	const item = await db.query.feedback.findFirst({ where: eq(feedback.id, id) });

	if (!item) {
		throw new AppError("NOT_FOUND", `No feedback with id ${id}`);
	}

	// An anonymous submission has no author, so nobody but the maintainer can edit it.
	// There is no way to prove you were the one who filed it, and a board that took your
	// word for it would be worse than one that says no.
	if (!isAdmin && item.authorId !== current.id) {
		throw new AppError("FORBIDDEN", "That item belongs to someone else");
	}

	const triaging =
		releaseId !== undefined || rest.status !== undefined || rest.maintainerNote !== undefined;

	if (triaging && !isAdmin) {
		throw new AppError("FORBIDDEN", "Only the maintainer decides what ships");
	}

	if (releaseId) {
		const release = await db.query.releases.findFirst({ where: eq(releases.id, releaseId) });

		if (!release) {
			throw new AppError("NOT_FOUND", `No release with id ${releaseId}`);
		}
	}

	const changes = { ...rest, ...(releaseId !== undefined ? { releaseId } : {}) };

	if (Object.keys(changes).length === 0) {
		throw new AppError("BAD_REQUEST", "Nothing to update");
	}

	// Putting an item in a merge window *is* planning it, and taking it back out
	// unplans it. Making the maintainer set the status by hand as well would only be a
	// way to get the two out of step.
	if (rest.status === undefined) {
		if (releaseId && item.status === "open") changes.status = "planned";
		if (releaseId === null && item.status === "planned") changes.status = "open";
	}

	await db
		.update(feedback)
		.set({ ...changes, updatedAt: new Date() })
		.where(eq(feedback.id, id));

	return loadItem(db, voterKey, id);
}

export async function deleteFeedback(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<{ id: string }> {
	const { id } = parseInput(FeedbackIdInput, input);
	const current = requireActor(actor);

	const item = await db.query.feedback.findFirst({ where: eq(feedback.id, id) });

	if (!item) {
		throw new AppError("NOT_FOUND", `No feedback with id ${id}`);
	}

	if (current.role !== "admin" && item.authorId !== current.id) {
		throw new AppError("FORBIDDEN", "That item belongs to someone else");
	}

	await db.delete(feedback).where(eq(feedback.id, id));

	return { id };
}

/** Both vote paths need to know who is asking; over gRPC, nobody may be. */
function requireVoter(voterKey: string | null): string {
	if (!voterKey) {
		throw new AppError("UNAUTHORIZED", "No voter identity for this request");
	}

	return voterKey;
}

/**
 * One vote per voter, enforced by the UNIQUE index rather than by a read-then-write.
 *
 * Checking first would be two statements with a race in the middle; `onConflictDoNothing`
 * lets the index be the referee, and makes a double-click idempotent instead of a 500.
 */
export async function voteForFeedback(
	db: Database,
	voterKey: string | null,
	input: unknown,
): Promise<FeedbackItem> {
	const { id } = parseInput(FeedbackIdInput, input);
	const voter = requireVoter(voterKey);

	// Checked rather than left to the foreign key, so a bad id is a 404 and not a 500.
	await loadItem(db, voterKey, id);

	await db.insert(votes).values({ feedbackId: id, voterKey: voter }).onConflictDoNothing();

	return loadItem(db, voterKey, id);
}

/** Changed your mind. Deleting a vote that is not there is fine - the end state is what matters. */
export async function unvoteFeedback(
	db: Database,
	voterKey: string | null,
	input: unknown,
): Promise<FeedbackItem> {
	const { id } = parseInput(FeedbackIdInput, input);
	const voter = requireVoter(voterKey);

	await loadItem(db, voterKey, id);

	await db.delete(votes).where(and(eq(votes.feedbackId, id), eq(votes.voterKey, voter)));

	return loadItem(db, voterKey, id);
}

/** Used by the release service when a window ships. Kept here so the table has one owner. */
export function markShipped(db: Executor, releaseId: string) {
	return db
		.update(feedback)
		.set({ status: "shipped", updatedAt: new Date() })
		.where(
			and(eq(feedback.releaseId, releaseId), inArray(feedback.status, ["open", "planned"])),
		);
}

/** And when a release is deleted, its items go back to being open requests. */
export function unplanForRelease(db: Executor, releaseId: string) {
	return db
		.update(feedback)
		.set({ status: "open", releaseId: null, updatedAt: new Date() })
		.where(and(eq(feedback.releaseId, releaseId), eq(feedback.status, "planned")));
}
