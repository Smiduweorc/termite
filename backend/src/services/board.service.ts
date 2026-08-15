import { type } from "arktype";
import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Database, Executor } from "../db";
import {
	type Board,
	type BoardContents,
	type Bucket,
	boards,
	buckets,
	type Task,
	tasks,
} from "../db/schema";
import { type Actor, requireAdmin } from "../lib/actor";
import { AppError, parseInput } from "../lib/errors";
import {
	needsRebalance,
	positionAfterLast,
	positionBetween,
	rebalancedPositions,
} from "../lib/position";

export const BoardIdInput = type({ id: "string.uuid" });

export const CreateBoardInput = type({
	title: "1 <= string <= 120",
	"description?": "string <= 2000",
	"isPublic?": "boolean",
	"isTemplate?": "boolean",
});

export const UpdateBoardInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 120",
	"description?": "string <= 2000 | null",
	"isPublic?": "boolean",
	/** A board can be promoted to a template, or demoted back to one you work on. */
	"isTemplate?": "boolean",
});

export const CreateBucketInput = type({
	boardId: "string.uuid",
	title: "1 <= string <= 80",
	"wipLimit?": "1 <= number.integer <= 1000 | null",
});

export const UpdateBucketInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 80",
	"wipLimit?": "1 <= number.integer <= 1000 | null",
	"isDone?": "boolean",
	"isDefault?": "boolean",
});

export const MoveBucketInput = type({
	id: "string.uuid",
	/** The bucket to sit after. Absent means "first". */
	"afterBucketId?": "string.uuid | null",
});

export const DeleteBucketInput = type({
	id: "string.uuid",
	/** Where its cards go. Absent means the board's default bucket. */
	"moveTasksTo?": "string.uuid",
});

export const CreateTaskInput = type({
	boardId: "string.uuid",
	title: "1 <= string <= 200",
	"description?": "string <= 10000",
	"bucketId?": "string.uuid",
	"feedbackId?": "string.uuid",
	"releaseId?": "string.uuid",
});

export const UpdateTaskInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 200",
	"description?": "string <= 10000 | null",
	"done?": "boolean",
	"feedbackId?": "string.uuid | null",
	"releaseId?": "string.uuid | null",
});

export const MoveTaskInput = type({
	id: "string.uuid",
	bucketId: "string.uuid",
	/** The card to sit under. Absent means the top of the column. */
	"afterTaskId?": "string.uuid | null",
});

export const TaskIdInput = type({ id: "string.uuid" });

/**
 * The copies.
 *
 * All four of these are the same operation at different sizes - a card, a column, a
 * board, and a board kept to be copied again - so they share their inputs' shape too:
 * what to copy, what to call the copy, and whether the cards come with it.
 */
export const DuplicateTaskInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 200",
	/** Where the copy lands. Absent means directly under the card it came from. */
	"bucketId?": "string.uuid",
});

export const DuplicateBucketInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 80",
	/** Which board the copy goes on. Absent means the one it came from. */
	"boardId?": "string.uuid",
	/** Cards come with the column unless you say otherwise. */
	"includeTasks?": "boolean",
});

export const DuplicateBoardInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 120",
	"includeTasks?": "boolean",
	"isPublic?": "boolean",
});

export const SaveAsTemplateInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 120",
	"includeTasks?": "boolean",
});

export const UseTemplateInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 120",
	"includeTasks?": "boolean",
	"isPublic?": "boolean",
});

/** Long enough to say what it is, short enough to leave room for the suffix. */
const TITLE_LIMITS = { board: 120, bucket: 80, task: 200 } as const;

const COPY_SUFFIX = " (copy)";

/**
 * What a copy is called when nobody named it.
 *
 * Trimmed from the front rather than the back so the suffix always survives: a copy that
 * silently kept the original's exact title would be the one thing you cannot tell apart
 * from it in a column, which is the entire reason the word is there.
 */
function copyTitle(title: string, limit: number): string {
	const room = limit - COPY_SUFFIX.length;

	return `${title.length > room ? title.slice(0, room).trimEnd() : title}${COPY_SUFFIX}`;
}

/** The board row itself, for the admin-only operations that already know who is asking. */
async function loadBoardRow(db: Executor, id: string): Promise<Board> {
	const board = await db.query.boards.findFirst({ where: eq(boards.id, id) });

	if (!board) {
		throw new AppError("NOT_FOUND", `No board with id ${id}`);
	}

	return board;
}

/**
 * A private board does not exist as far as anyone but the maintainer is concerned -
 * NOT_FOUND rather than FORBIDDEN, so the reply does not confirm it is there.
 */
async function readableBoard(db: Database, actor: Actor | null, id: string): Promise<Board> {
	const board = await db.query.boards.findFirst({ where: eq(boards.id, id) });

	if (!board || (!board.isPublic && actor?.role !== "admin")) {
		throw new AppError("NOT_FOUND", `No board with id ${id}`);
	}

	return board;
}

/** The whole board in one go: columns in their order, cards in theirs. */
async function loadBoard(db: Database, board: Board): Promise<BoardContents> {
	const columns = await db.query.buckets.findMany({
		where: eq(buckets.boardId, board.id),
		orderBy: asc(buckets.position),
	});

	const cards = await db.query.tasks.findMany({
		where: eq(tasks.boardId, board.id),
		orderBy: asc(tasks.position),
	});

	return {
		...board,
		buckets: columns.map((bucket) => ({
			...bucket,
			tasks: cards.filter((task) => task.bucketId === bucket.id),
		})),
	};
}

export async function listBoards(db: Database, actor: Actor | null): Promise<Board[]> {
	const rows = await db.query.boards.findMany({ orderBy: asc(boards.createdAt) });

	return actor?.role === "admin" ? rows : rows.filter((board) => board.isPublic);
}

export async function getBoard(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	const { id } = parseInput(BoardIdInput, input);

	return loadBoard(db, await readableBoard(db, actor, id));
}

/**
 * A new board comes with one column, and that column is the default.
 *
 * Not because a board must look a particular way - rename it, add ten more, delete this
 * one once another exists - but because a card has to land somewhere, and a board with
 * no columns would be a board you cannot put anything on.
 */
export async function createBoard(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { title, description, isPublic, isTemplate } = parseInput(CreateBoardInput, input);

	const board = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(boards)
			.values({
				title,
				description: description || null,
				isPublic: isPublic ?? false,
				isTemplate: isTemplate ?? false,
			})
			.returning();

		if (!created) {
			throw new AppError("INTERNAL", "Insert returned no row");
		}

		await tx.insert(buckets).values({
			boardId: created.id,
			title: "To do",
			position: positionAfterLast(undefined),
			isDefault: true,
		});

		return created;
	});

	return loadBoard(db, board);
}

export async function updateBoard(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, ...changes } = parseInput(UpdateBoardInput, input);

	if (Object.keys(changes).length === 0) {
		throw new AppError("BAD_REQUEST", "Nothing to update");
	}

	const [updated] = await db
		.update(boards)
		.set({ ...changes, updatedAt: new Date() })
		.where(eq(boards.id, id))
		.returning();

	if (!updated) {
		throw new AppError("NOT_FOUND", `No board with id ${id}`);
	}

	return loadBoard(db, updated);
}

export async function deleteBoard(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<{ id: string }> {
	requireAdmin(actor);

	const { id } = parseInput(BoardIdInput, input);

	const [deleted] = await db.delete(boards).where(eq(boards.id, id)).returning();

	if (!deleted) {
		throw new AppError("NOT_FOUND", `No board with id ${id}`);
	}

	return { id: deleted.id };
}

/** Loads a column and the board it belongs to, for the admin-only operations. */
async function loadBucket(db: Database, id: string): Promise<Bucket> {
	const bucket = await db.query.buckets.findFirst({ where: eq(buckets.id, id) });

	if (!bucket) {
		throw new AppError("NOT_FOUND", `No bucket with id ${id}`);
	}

	return bucket;
}

async function bucketsOf(db: Executor, boardId: string): Promise<Bucket[]> {
	return db.query.buckets.findMany({
		where: eq(buckets.boardId, boardId),
		orderBy: asc(buckets.position),
	});
}

async function tasksOf(db: Executor, bucketId: string): Promise<Task[]> {
	return db.query.tasks.findMany({
		where: eq(tasks.bucketId, bucketId),
		orderBy: asc(tasks.position),
	});
}

/**
 * Where a row lands when it should sit directly after `afterId` - or first in the list,
 * when there is no anchor to sit after.
 *
 * Columns and cards are ordered the same way for the same reason, so the arithmetic lives
 * here once. The row takes the midpoint between its two neighbours: one row is written,
 * and nobody else's order moves. When a seam has been split so often that the midpoint
 * would no longer be distinguishable, `renumber` spreads the list back onto clean spacing
 * first and the neighbours are taken again. See lib/position.ts.
 */
async function place<Row extends { id: string; position: number }>(
	rows: Row[],
	afterId: string | null | undefined,
	missingAnchor: () => AppError,
	renumber: (id: string, position: number) => PromiseLike<unknown>,
): Promise<number> {
	const anchor = afterId ? rows.findIndex((row) => row.id === afterId) : -1;

	if (afterId && anchor === -1) throw missingAnchor();

	const neighbours = (list: Row[]) => ({
		before: anchor === -1 ? undefined : list[anchor]?.position,
		after: anchor === -1 ? list[0]?.position : list[anchor + 1]?.position,
	});

	let { before, after } = neighbours(rows);

	if (needsRebalance(before, after)) {
		const respaced = rows.map((row, index) => ({
			...row,
			position: rebalancedPositions(rows.length)[index] ?? row.position,
		}));

		for (const row of respaced) {
			await renumber(row.id, row.position);
		}

		({ before, after } = neighbours(respaced));
	}

	return positionBetween(before, after);
}

/** Placing a column: moving one and copying one both land in a seam between two others. */
async function placeBucket(
	tx: Executor,
	boardId: string,
	afterBucketId: string | null | undefined,
	excludeId?: string,
): Promise<number> {
	const siblings = (await bucketsOf(tx, boardId)).filter((other) => other.id !== excludeId);

	return place(
		siblings,
		afterBucketId,
		() => new AppError("NOT_FOUND", `No bucket with id ${afterBucketId} on this board`),
		(id, position) => tx.update(buckets).set({ position }).where(eq(buckets.id, id)),
	);
}

/** Placing a card: the drop, and the copy that lands directly under what it came from. */
async function placeTask(
	tx: Executor,
	bucketId: string,
	afterTaskId: string | null | undefined,
	excludeId?: string,
): Promise<number> {
	const siblings = (await tasksOf(tx, bucketId)).filter((other) => other.id !== excludeId);

	return place(
		siblings,
		afterTaskId,
		() => new AppError("NOT_FOUND", `No task with id ${afterTaskId} in that column`),
		(id, position) => tx.update(tasks).set({ position }).where(eq(tasks.id, id)),
	);
}

/**
 * Columns are added at the end, and there is no limit on how many.
 *
 * That is the whole point of the design: the columns are whatever this project's work is
 * actually called. Two of them, or nine, named "waiting on upstream" and "needs a repro".
 */
export async function createBucket(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { boardId, title, wipLimit } = parseInput(CreateBucketInput, input);

	const board = await loadBoardRow(db, boardId);
	const existing = await bucketsOf(db, boardId);

	await db.insert(buckets).values({
		boardId,
		title,
		wipLimit: wipLimit ?? null,
		position: positionAfterLast(existing.at(-1)?.position),
		// The first column on a board has to be the default one - see createBoard.
		isDefault: existing.length === 0,
	});

	return loadBoard(db, board);
}

/**
 * Renaming, WIP limits, and the two optional markers.
 *
 * `isDone` and `isDefault` are at most one per board, so setting either clears it
 * elsewhere in the same transaction - the partial unique indexes in db/schema.ts would
 * otherwise reject the second one. Setting `isDone` to false is a supported end state:
 * a board with no done column is the default shape, not a broken one.
 */
export async function updateBucket(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, ...changes } = parseInput(UpdateBucketInput, input);

	if (Object.keys(changes).length === 0) {
		throw new AppError("BAD_REQUEST", "Nothing to update");
	}

	const bucket = await loadBucket(db, id);

	if (changes.isDefault === false && bucket.isDefault) {
		throw new AppError(
			"BAD_REQUEST",
			"Point the default at another column instead of removing it",
		);
	}

	await db.transaction(async (tx) => {
		if (changes.isDone === true) {
			await tx
				.update(buckets)
				.set({ isDone: false })
				.where(and(eq(buckets.boardId, bucket.boardId), ne(buckets.id, id)));
		}

		if (changes.isDefault === true) {
			await tx
				.update(buckets)
				.set({ isDefault: false })
				.where(and(eq(buckets.boardId, bucket.boardId), ne(buckets.id, id)));
		}

		await tx
			.update(buckets)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(buckets.id, id));
	});

	return getBoardById(db, bucket.boardId);
}

export async function moveBucket(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, afterBucketId } = parseInput(MoveBucketInput, input);

	const bucket = await loadBucket(db, id);

	await db.transaction(async (tx) => {
		const position = await placeBucket(tx, bucket.boardId, afterBucketId, id);

		await tx.update(buckets).set({ position, updatedAt: new Date() }).where(eq(buckets.id, id));
	});

	return getBoardById(db, bucket.boardId);
}

/**
 * Deleting a column never deletes the work in it.
 *
 * The cards move - to the column you name, or to the board's default one - because a
 * column is a label for where something is, and dropping the label is not a decision to
 * throw the work away. The last column cannot go: cards have to live somewhere.
 */
export async function deleteBucket(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, moveTasksTo } = parseInput(DeleteBucketInput, input);

	const bucket = await loadBucket(db, id);
	const siblings = (await bucketsOf(db, bucket.boardId)).filter((other) => other.id !== id);

	if (siblings.length === 0) {
		throw new AppError("BAD_REQUEST", "A board needs at least one column");
	}

	const fallback = moveTasksTo
		? siblings.find((other) => other.id === moveTasksTo)
		: (siblings.find((other) => other.isDefault) ?? siblings[0]);

	if (!fallback) {
		throw new AppError("NOT_FOUND", `No bucket with id ${moveTasksTo} on this board`);
	}

	await db.transaction(async (tx) => {
		const orphans = await tasksOf(tx, id);
		const last = await tasksOf(tx, fallback.id);

		let position = positionAfterLast(last.at(-1)?.position);

		for (const orphan of orphans) {
			await tx
				.update(tasks)
				.set({ bucketId: fallback.id, position, updatedAt: new Date() })
				.where(eq(tasks.id, orphan.id));

			position = positionAfterLast(position);
		}

		await tx.delete(buckets).where(eq(buckets.id, id));

		// If the deleted column was the default, the fallback inherits the job - a board
		// with no default has nowhere to put a new card. This has to happen *after* the
		// delete: "at most one default per board" is a unique index, and for a moment
		// either side of that line there would be two.
		if (bucket.isDefault) {
			await tx.update(buckets).set({ isDefault: true }).where(eq(buckets.id, fallback.id));
		}
	});

	return getBoardById(db, bucket.boardId);
}

/** Internal reload, for the operations that already know the board exists. */
async function getBoardById(db: Database, boardId: string): Promise<BoardContents> {
	return loadBoard(db, await loadBoardRow(db, boardId));
}

/** A WIP limit is a promise the board keeps for you, so it is checked, not decorative. */
async function assertRoom(db: Executor, bucket: Bucket, movingTaskId?: string): Promise<void> {
	if (bucket.wipLimit === null) return;

	const [row] = await db
		.select({ held: count() })
		.from(tasks)
		.where(
			movingTaskId
				? and(eq(tasks.bucketId, bucket.id), ne(tasks.id, movingTaskId))
				: eq(tasks.bucketId, bucket.id),
		);

	if ((row?.held ?? 0) >= bucket.wipLimit) {
		throw new AppError("CONFLICT", `"${bucket.title}" is at its limit of ${bucket.wipLimit}`);
	}
}

export async function createTask(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { boardId, title, description, bucketId, feedbackId, releaseId } = parseInput(
		CreateTaskInput,
		input,
	);

	const board = await loadBoardRow(db, boardId);
	const columns = await bucketsOf(db, boardId);
	const target = bucketId
		? columns.find((bucket) => bucket.id === bucketId)
		: (columns.find((bucket) => bucket.isDefault) ?? columns[0]);

	if (!target) {
		throw new AppError("NOT_FOUND", "That column is not on this board");
	}

	await assertRoom(db, target);

	const siblings = await tasksOf(db, target.id);

	await db.insert(tasks).values({
		boardId,
		bucketId: target.id,
		title,
		description: description || null,
		position: positionAfterLast(siblings.at(-1)?.position),
		done: target.isDone,
		doneAt: target.isDone ? new Date() : null,
		feedbackId: feedbackId ?? null,
		releaseId: releaseId ?? null,
	});

	return loadBoard(db, board);
}

async function loadTask(db: Database, id: string): Promise<Task> {
	const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });

	if (!task) {
		throw new AppError("NOT_FOUND", `No task with id ${id}`);
	}

	return task;
}

/**
 * Ticking a card off.
 *
 * If the board has a done column, done and "in that column" are kept in step in both
 * directions - ticking a card sends it there, and dragging it there ticks it. If the
 * board has no done column, `done` is simply a checkbox and the card stays where it is.
 * Neither arrangement is more correct; the board decides which it is by whether any
 * column is marked, and by default none is.
 */
export async function updateTask(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, done, ...rest } = parseInput(UpdateTaskInput, input);

	if (done === undefined && Object.keys(rest).length === 0) {
		throw new AppError("BAD_REQUEST", "Nothing to update");
	}

	const task = await loadTask(db, id);
	const columns = await bucketsOf(db, task.boardId);
	const doneColumn = columns.find((bucket) => bucket.isDone);
	const defaultColumn = columns.find((bucket) => bucket.isDefault) ?? columns[0];

	const changes: Partial<Task> = { ...rest };

	if (done !== undefined && done !== task.done) {
		changes.done = done;
		changes.doneAt = done ? new Date() : null;

		if (doneColumn && done && task.bucketId !== doneColumn.id) {
			changes.bucketId = doneColumn.id;
			changes.position = await endOf(db, doneColumn.id);
		}

		if (doneColumn && !done && task.bucketId === doneColumn.id && defaultColumn) {
			changes.bucketId = defaultColumn.id;
			changes.position = await endOf(db, defaultColumn.id);
		}
	}

	await db
		.update(tasks)
		.set({ ...changes, updatedAt: new Date() })
		.where(eq(tasks.id, id));

	return getBoardById(db, task.boardId);
}

async function endOf(db: Executor, bucketId: string): Promise<number> {
	return positionAfterLast((await tasksOf(db, bucketId)).at(-1)?.position);
}

/**
 * The drag-and-drop operation, and the only place positions are computed.
 *
 * The card lands between the one named by `afterTaskId` and whatever follows it, taking
 * the midpoint of their positions - so a drag writes one row, and two people dragging
 * different cards never fight over the same numbers. When a seam has been split so often
 * that the midpoint would no longer be distinguishable, the column is renumbered onto
 * clean spacing first. See lib/position.ts for why it is done this way.
 */
export async function moveTask(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, bucketId, afterTaskId } = parseInput(MoveTaskInput, input);

	const task = await loadTask(db, id);
	const target = await loadBucket(db, bucketId);
	const doneColumn = (await bucketsOf(db, task.boardId)).find((bucket) => bucket.isDone);

	if (target.boardId !== task.boardId) {
		throw new AppError("BAD_REQUEST", "That column is on a different board");
	}

	if (afterTaskId === id) {
		throw new AppError("BAD_REQUEST", "A card cannot be dropped after itself");
	}

	await assertRoom(db, target, id);

	await db.transaction(async (tx) => {
		const position = await placeTask(tx, bucketId, afterTaskId, id);

		// Dropping a card in the done column ticks it off, and dragging it back out of
		// that column un-ticks it - but only on a board that has said which column that
		// is. Where no column is marked, moving a card says nothing about whether the
		// work is finished, which is the default and the reason none is mandatory.
		const ticked = target.isDone && !task.done ? { done: true, doneAt: new Date() } : {};
		const unticked =
			doneColumn && task.bucketId === doneColumn.id && target.id !== doneColumn.id
				? { done: false, doneAt: null }
				: {};

		await tx
			.update(tasks)
			.set({
				bucketId,
				position,
				...ticked,
				...unticked,
				updatedAt: new Date(),
			})
			.where(eq(tasks.id, id));
	});

	return getBoardById(db, task.boardId);
}

export async function deleteTask(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<{ id: string }> {
	requireAdmin(actor);

	const { id } = parseInput(TaskIdInput, input);

	const [deleted] = await db.delete(tasks).where(eq(tasks.id, id)).returning();

	if (!deleted) {
		throw new AppError("NOT_FOUND", `No task with id ${id}`);
	}

	return { id: deleted.id };
}

/**
 * Copying, at four sizes.
 *
 * The same work arrives again and again - the same three cards for every release, the
 * same column of checks before a tag - and typing it out each time is the sort of chore
 * that ends with it not being tracked at all. So: copy a card, copy a column with its
 * cards, copy a whole board, or keep a board aside as a template and start from it.
 *
 * A template is not a separate kind of thing. It is a board with `isTemplate` set: you
 * edit it with the same procedures, and starting from one is the same copy that
 * duplicates a board. That is the whole feature, and it is deliberately that small.
 */

/**
 * What a copied card says about being finished.
 *
 * A copy keeps the state of what it was copied from - duplicating a board mid-flight
 * should give you the board as it stands, ticks and all. The exception is the one place
 * the board has an opinion: a card landing in a column marked as done is done, the same
 * way it would be if you dragged it there.
 */
function doneFor(target: Bucket, card: Task): { done: boolean; doneAt: Date | null } {
	if (target.isDone && !card.done) return { done: true, doneAt: new Date() };

	return { done: card.done, doneAt: card.doneAt };
}

/**
 * Every card of one column, copied into another, in the order they were in.
 *
 * The copies take fresh, evenly spaced positions rather than the originals': a new column
 * has nothing for them to collide with, and clean spacing is what a column nobody has
 * dragged in yet looks like anyway.
 *
 * A copied column keeps the WIP limit of the one it came from, and this deliberately does
 * not check it. The cards fit by construction - the source column was already holding
 * them - and a limit that refused to copy a column onto itself would be enforcing a rule
 * nobody broke.
 */
async function copyTasksInto(tx: Executor, source: Bucket, target: Bucket): Promise<void> {
	const cards = await tasksOf(tx, source.id);

	if (cards.length === 0) return;

	const spread = rebalancedPositions(cards.length);

	await tx.insert(tasks).values(
		cards.map((card, index) => ({
			boardId: target.boardId,
			bucketId: target.id,
			title: card.title,
			description: card.description,
			position: spread[index] ?? positionAfterLast(undefined),
			...doneFor(target, card),
			// The glue comes with the card: a copy of "fix the overflow" is still about
			// the request that asked for it and the release it is aimed at.
			feedbackId: card.feedbackId,
			releaseId: card.releaseId,
		})),
	);
}

/**
 * One card again.
 *
 * The copy lands directly under the original, where you are already looking - not at the
 * bottom of the column, which on a long column means the card you just made is offscreen.
 * Naming a `bucketId` puts it in that column instead, at the end, and that column may be
 * on another board: pulling a card off a template board onto the one you are working on
 * is the same operation as copying one in place.
 */
export async function duplicateTask(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, title, bucketId } = parseInput(DuplicateTaskInput, input);

	const task = await loadTask(db, id);
	const target = await loadBucket(db, bucketId ?? task.bucketId);

	// One more card in that column is one more card: a WIP limit that let you past it by
	// copying rather than typing would not be a limit.
	await assertRoom(db, target);

	await db.transaction(async (tx) => {
		const position =
			target.id === task.bucketId
				? await placeTask(tx, target.id, task.id)
				: await endOf(tx, target.id);

		await tx.insert(tasks).values({
			boardId: target.boardId,
			bucketId: target.id,
			title: title ?? copyTitle(task.title, TITLE_LIMITS.task),
			description: task.description,
			position,
			...doneFor(target, task),
			feedbackId: task.feedbackId,
			releaseId: task.releaseId,
		});
	});

	// The board the copy is on, which is not always the board it came from.
	return getBoardById(db, target.boardId);
}

/**
 * A column, its settings, and by default its cards.
 *
 * The copy sits immediately to the right of the original, or at the end of another board
 * when one is named. Neither marker comes along: there is at most one done column and one
 * default column per board, the original still holds them, and a copy of a column is a
 * column - not a second finish line.
 */
export async function duplicateBucket(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, title, boardId, includeTasks } = parseInput(DuplicateBucketInput, input);

	const source = await loadBucket(db, id);
	const onto = boardId ?? source.boardId;

	if (onto !== source.boardId) {
		await loadBoardRow(db, onto);
	}

	await db.transaction(async (tx) => {
		const position =
			onto === source.boardId
				? await placeBucket(tx, onto, source.id)
				: positionAfterLast((await bucketsOf(tx, onto)).at(-1)?.position);

		const [copy] = await tx
			.insert(buckets)
			.values({
				boardId: onto,
				title: title ?? copyTitle(source.title, TITLE_LIMITS.bucket),
				wipLimit: source.wipLimit,
				position,
				isDone: false,
				// Every board is created with a default column and cannot have its last one
				// deleted, so there is always one already - and it is not this.
				isDefault: false,
			})
			.returning();

		if (!copy) {
			throw new AppError("INTERNAL", "Insert returned no row");
		}

		if (includeTasks !== false) {
			await copyTasksInto(tx, source, copy);
		}
	});

	return getBoardById(db, onto);
}

/** What the three board-sized copies differ by, which is not much. */
interface CopyBoardOptions {
	title?: string;
	isPublic?: boolean;
	isTemplate: boolean;
	includeTasks: boolean;
}

/**
 * A board, its columns, and optionally the cards on them.
 *
 * Nothing is published by the act of copying, whatever the original was. Publishing is a
 * decision about a particular board, and a copy is a different board - inheriting it
 * would mean a duplicate made to try something out is public before anyone looked at it.
 */
async function copyBoard(
	db: Database,
	source: Board,
	options: CopyBoardOptions,
): Promise<BoardContents> {
	const copy = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(boards)
			.values({
				title: options.title ?? copyTitle(source.title, TITLE_LIMITS.board),
				description: source.description,
				isPublic: options.isPublic ?? false,
				isTemplate: options.isTemplate,
			})
			.returning();

		if (!created) {
			throw new AppError("INTERNAL", "Insert returned no row");
		}

		for (const column of await bucketsOf(tx, source.id)) {
			const [copiedColumn] = await tx
				.insert(buckets)
				.values({
					boardId: created.id,
					title: column.title,
					position: column.position,
					wipLimit: column.wipLimit,
					// Both markers do come across here, unlike a single copied column:
					// they are one per *board*, and this is a new board, so the copy can
					// hold them without the original giving anything up.
					isDone: column.isDone,
					isDefault: column.isDefault,
				})
				.returning();

			if (!copiedColumn) {
				throw new AppError("INTERNAL", "Insert returned no row");
			}

			if (options.includeTasks) {
				await copyTasksInto(tx, column, copiedColumn);
			}
		}

		return created;
	});

	return loadBoard(db, copy);
}

/** The whole board again, cards and all unless you ask for just the shape. */
export async function duplicateBoard(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, title, includeTasks, isPublic } = parseInput(DuplicateBoardInput, input);

	const source = await loadBoardRow(db, id);

	return copyBoard(db, source, {
		title,
		isPublic,
		// Duplicating a template gives you another template. Turning one into a board is
		// what `useTemplate` is for, and saying so is better than guessing from context.
		isTemplate: source.isTemplate,
		includeTasks: includeTasks !== false,
	});
}

/**
 * Keep this shape.
 *
 * The copy is set aside as a template and the board you were working on is untouched, so
 * this is safe to do to a live board in the middle of a release. Cards come across by
 * default - a template is usually the checklist as much as the columns - and
 * `includeTasks: false` keeps only the shape.
 */
export async function saveAsTemplate(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, title, includeTasks } = parseInput(SaveAsTemplateInput, input);

	const source = await loadBoardRow(db, id);

	return copyBoard(db, source, {
		// Templates are listed apart from boards, so a template may keep the name of the
		// board it came from without either being ambiguous.
		title: title ?? source.title,
		isTemplate: true,
		includeTasks: includeTasks !== false,
	});
}

/** Start a board from one. The template stays a template; the new board is yours. */
export async function useTemplate(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<BoardContents> {
	requireAdmin(actor);

	const { id, title, includeTasks, isPublic } = parseInput(UseTemplateInput, input);

	const source = await loadBoardRow(db, id);

	if (!source.isTemplate) {
		throw new AppError(
			"BAD_REQUEST",
			`"${source.title}" is a board, not a template - duplicate it instead`,
		);
	}

	return copyBoard(db, source, {
		title: title ?? source.title,
		isPublic,
		isTemplate: false,
		includeTasks: includeTasks !== false,
	});
}
