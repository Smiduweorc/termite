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
});

export const UpdateBoardInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 120",
	"description?": "string <= 2000 | null",
	"isPublic?": "boolean",
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

	const { title, description, isPublic } = parseInput(CreateBoardInput, input);

	const board = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(boards)
			.values({
				title,
				description: description || null,
				isPublic: isPublic ?? false,
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

	const board = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });

	if (!board) {
		throw new AppError("NOT_FOUND", `No board with id ${boardId}`);
	}

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
	const siblings = (await bucketsOf(db, bucket.boardId)).filter((other) => other.id !== id);

	const index = afterBucketId
		? siblings.findIndex((other) => other.id === afterBucketId)
		: undefined;

	if (afterBucketId && index === -1) {
		throw new AppError("NOT_FOUND", `No bucket with id ${afterBucketId} on this board`);
	}

	const before = index === undefined ? undefined : siblings[index]?.position;
	const after = index === undefined ? siblings[0]?.position : siblings[index + 1]?.position;

	await db
		.update(buckets)
		.set({ position: positionBetween(before, after), updatedAt: new Date() })
		.where(eq(buckets.id, id));

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
		const orphans = await tx.query.tasks.findMany({
			where: eq(tasks.bucketId, id),
			orderBy: asc(tasks.position),
		});

		const last = await tx.query.tasks.findMany({
			where: eq(tasks.bucketId, fallback.id),
			orderBy: asc(tasks.position),
		});

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
	const board = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });

	if (!board) {
		throw new AppError("NOT_FOUND", `No board with id ${boardId}`);
	}

	return loadBoard(db, board);
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

	const board = await db.query.boards.findFirst({ where: eq(boards.id, boardId) });

	if (!board) {
		throw new AppError("NOT_FOUND", `No board with id ${boardId}`);
	}

	const columns = await bucketsOf(db, boardId);
	const target = bucketId
		? columns.find((bucket) => bucket.id === bucketId)
		: (columns.find((bucket) => bucket.isDefault) ?? columns[0]);

	if (!target) {
		throw new AppError("NOT_FOUND", "That column is not on this board");
	}

	await assertRoom(db, target);

	const siblings = await db.query.tasks.findMany({
		where: eq(tasks.bucketId, target.id),
		orderBy: asc(tasks.position),
	});

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
	const siblings = await db.query.tasks.findMany({
		where: eq(tasks.bucketId, bucketId),
		orderBy: asc(tasks.position),
	});

	return positionAfterLast(siblings.at(-1)?.position);
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
		let siblings = (
			await tx.query.tasks.findMany({
				where: eq(tasks.bucketId, bucketId),
				orderBy: asc(tasks.position),
			})
		).filter((other) => other.id !== id);

		const indexOfAnchor = afterTaskId
			? siblings.findIndex((other) => other.id === afterTaskId)
			: -1;

		if (afterTaskId && indexOfAnchor === -1) {
			throw new AppError("NOT_FOUND", `No task with id ${afterTaskId} in that column`);
		}

		const neighbours = (list: Task[]) => {
			const before = indexOfAnchor === -1 ? undefined : list[indexOfAnchor]?.position;
			const after =
				indexOfAnchor === -1 ? list[0]?.position : list[indexOfAnchor + 1]?.position;

			return { before, after };
		};

		let { before, after } = neighbours(siblings);

		// The seam has been split too many times to split again. Spread this column back
		// out and take the neighbours afresh - one extra write pass, rarely.
		if (needsRebalance(before, after)) {
			const spread = rebalancedPositions(siblings.length);

			for (const [index, sibling] of siblings.entries()) {
				const position = spread[index];

				if (position === undefined) continue;

				await tx.update(tasks).set({ position }).where(eq(tasks.id, sibling.id));
			}

			siblings = siblings.map((sibling, index) => ({
				...sibling,
				position: spread[index] ?? sibling.position,
			}));

			({ before, after } = neighbours(siblings));
		}

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
				position: positionBetween(before, after),
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
