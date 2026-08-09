import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import type { BoardContents, PublicUser } from "../../db/schema";
import { actorFor, seedUser } from "../../test/auth";
import { callerAs } from "../../test/context";
import { createTestDatabase } from "../../test/db";

/** The columns of a board, by title, in the order they are shown. */
const columnTitles = (board: BoardContents) => board.buckets.map((bucket) => bucket.title);

/** The cards in one column, by title, in the order they are shown. */
function cardsIn(board: BoardContents, title: string): string[] {
	return (
		board.buckets.find((bucket) => bucket.title === title)?.tasks.map((task) => task.title) ??
		[]
	);
}

function bucketId(board: BoardContents, title: string): string {
	const bucket = board.buckets.find((column) => column.title === title);

	if (!bucket) throw new Error(`no column called ${title}`);

	return bucket.id;
}

function taskId(board: BoardContents, title: string): string {
	const task = board.buckets.flatMap((bucket) => bucket.tasks).find((t) => t.title === title);

	if (!task) throw new Error(`no card called ${title}`);

	return task.id;
}

describe("task boards", () => {
	let db: Database;
	let maintainer: PublicUser;
	let member: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		maintainer = await seedUser(db, { email: "root@example.com", role: "admin" });
		member = await seedUser(db, { email: "member@example.com", name: "Member" });
	});

	const admin = () => callerAs(db, actorFor(maintainer));

	describe("shape", () => {
		it("starts with one column so a card has somewhere to land", async () => {
			const board = await admin().board.create({ title: "0.4" });

			expect(columnTitles(board)).toEqual(["To do"]);
			expect(board.buckets[0]?.isDefault).toBe(true);
			// Nothing is marked done. That is the default, and it stays that way unless
			// the maintainer asks for it.
			expect(board.buckets.every((bucket) => !bucket.isDone)).toBe(true);
		});

		it("takes as many columns as the work needs, named whatever it is called", async () => {
			const board = await admin().board.create({ title: "0.4" });

			for (const title of [
				"waiting on upstream",
				"needs a repro",
				"in the branch",
				"merged",
				"released",
			]) {
				await admin().board.addBucket({ boardId: board.id, title });
			}

			const wide = await admin().board.byId({ id: board.id });

			// Six columns, no fixed set, and no "Done" among them unless asked for.
			expect(columnTitles(wide)).toEqual([
				"To do",
				"waiting on upstream",
				"needs a repro",
				"in the branch",
				"merged",
				"released",
			]);
		});

		it("reorders columns without touching the others", async () => {
			const board = await admin().board.create({ title: "0.4" });
			await admin().board.addBucket({ boardId: board.id, title: "doing" });
			const withThree = await admin().board.addBucket({
				boardId: board.id,
				title: "done-ish",
			});

			// Move the last column to the front.
			const moved = await admin().board.moveBucket({
				id: bucketId(withThree, "done-ish"),
			});

			expect(columnTitles(moved)).toEqual(["done-ish", "To do", "doing"]);
		});
	});

	describe("the done column, which is optional", () => {
		it("ticks a card off by checkbox with no done column in sight", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withTask = await admin().board.addTask({ boardId: board.id, title: "A job" });

			const done = await admin().board.updateTask({
				id: taskId(withTask, "A job"),
				done: true,
			});

			const card = done.buckets.flatMap((bucket) => bucket.tasks)[0];

			expect(card?.done).toBe(true);
			expect(card?.doneAt).toBeInstanceOf(Date);
			// It did not move, because there is nowhere it is supposed to move to.
			expect(cardsIn(done, "To do")).toEqual(["A job"]);
		});

		it("keeps done and the marked column in step once one is marked", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "shipped",
			});

			await admin().board.updateBucket({
				id: bucketId(withColumn, "shipped"),
				isDone: true,
			});

			const withTask = await admin().board.addTask({ boardId: board.id, title: "A job" });
			const id = taskId(withTask, "A job");

			// Ticking it sends it there...
			const ticked = await admin().board.updateTask({ id, done: true });
			expect(cardsIn(ticked, "shipped")).toEqual(["A job"]);

			// ...and dragging it back out un-ticks it.
			const dragged = await admin().board.moveTask({
				id,
				bucketId: bucketId(ticked, "To do"),
			});

			expect(cardsIn(dragged, "To do")).toEqual(["A job"]);
			expect(dragged.buckets.flatMap((b) => b.tasks)[0]?.done).toBe(false);
		});

		it("drops the marker again, leaving a board with no done column", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "shipped",
			});
			const id = bucketId(withColumn, "shipped");

			await admin().board.updateBucket({ id, isDone: true });
			const plain = await admin().board.updateBucket({ id, isDone: false });

			// No column is mandatory, including this one - a board can go back to having
			// no notion of a finish line at all.
			expect(plain.buckets.every((bucket) => !bucket.isDone)).toBe(true);
		});

		it("allows only one done column at a time", async () => {
			const board = await admin().board.create({ title: "0.4" });
			await admin().board.addBucket({ boardId: board.id, title: "shipped" });
			const withTwo = await admin().board.addBucket({ boardId: board.id, title: "released" });

			await admin().board.updateBucket({ id: bucketId(withTwo, "shipped"), isDone: true });
			const moved = await admin().board.updateBucket({
				id: bucketId(withTwo, "released"),
				isDone: true,
			});

			expect(moved.buckets.filter((bucket) => bucket.isDone).map((b) => b.title)).toEqual([
				"released",
			]);
		});
	});

	describe("ordering", () => {
		let board: BoardContents;

		beforeEach(async () => {
			board = await admin().board.create({ title: "0.4" });

			for (const title of ["first", "second", "third"]) {
				board = await admin().board.addTask({ boardId: board.id, title });
			}
		});

		it("appends new cards to the bottom", async () => {
			expect(cardsIn(board, "To do")).toEqual(["first", "second", "third"]);
		});

		it("drops a card at the top when no anchor is named", async () => {
			const moved = await admin().board.moveTask({
				id: taskId(board, "third"),
				bucketId: bucketId(board, "To do"),
			});

			expect(cardsIn(moved, "To do")).toEqual(["third", "first", "second"]);
		});

		it("drops a card into a seam without renumbering its neighbours", async () => {
			const before = board.buckets[0]?.tasks ?? [];

			const moved = await admin().board.moveTask({
				id: taskId(board, "third"),
				bucketId: bucketId(board, "To do"),
				afterTaskId: taskId(board, "first"),
			});

			expect(cardsIn(moved, "To do")).toEqual(["first", "third", "second"]);

			// The point of fractional positions: one row changed, so a second person
			// dragging a different card cannot be fighting over the same numbers.
			const after = moved.buckets[0]?.tasks ?? [];
			const untouched = ["first", "second"].every((title) => {
				const was = before.find((task) => task.title === title)?.position;
				const is = after.find((task) => task.title === title)?.position;

				return was === is;
			});

			expect(untouched).toBe(true);
		});

		it("survives being dropped into the same seam over and over", async () => {
			const anchor = taskId(board, "first");
			const column = bucketId(board, "To do");
			const shuttle = taskId(board, "third");

			// Every drop halves the gap. Enough of them and a naive implementation runs
			// out of precision and starts losing the order; this one rebalances instead.
			for (let attempt = 0; attempt < 80; attempt++) {
				await admin().board.moveTask({
					id: shuttle,
					bucketId: column,
					afterTaskId: anchor,
				});
				await admin().board.moveTask({ id: shuttle, bucketId: column });
			}

			const final = await admin().board.moveTask({
				id: shuttle,
				bucketId: column,
				afterTaskId: anchor,
			});

			expect(cardsIn(final, "To do")).toEqual(["first", "third", "second"]);

			const positions = (final.buckets[0]?.tasks ?? []).map((task) => task.position);
			expect(new Set(positions).size).toBe(positions.length);
		});

		it("moves a card between columns", async () => {
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "doing",
			});

			const moved = await admin().board.moveTask({
				id: taskId(withColumn, "second"),
				bucketId: bucketId(withColumn, "doing"),
			});

			expect(cardsIn(moved, "To do")).toEqual(["first", "third"]);
			expect(cardsIn(moved, "doing")).toEqual(["second"]);
		});

		it("refuses a card dropped onto a column of another board", async () => {
			const other = await admin().board.create({ title: "Another" });

			await expect(
				admin().board.moveTask({
					id: taskId(board, "first"),
					bucketId: bucketId(other, "To do"),
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});
	});

	describe("WIP limits, for those who want one", () => {
		it("refuses a card that would overfill a limited column", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "doing",
				wipLimit: 1,
			});

			const doing = bucketId(withColumn, "doing");

			await admin().board.addTask({ boardId: board.id, title: "one", bucketId: doing });

			await expect(
				admin().board.addTask({ boardId: board.id, title: "two", bucketId: doing }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("leaves unlimited columns alone", async () => {
			const board = await admin().board.create({ title: "0.4" });

			for (const title of ["a", "b", "c", "d"]) {
				await admin().board.addTask({ boardId: board.id, title });
			}

			const full = await admin().board.byId({ id: board.id });
			expect(cardsIn(full, "To do")).toHaveLength(4);
		});
	});

	describe("deleting a column", () => {
		it("moves its cards rather than throwing the work away", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({ boardId: board.id, title: "doing" });
			const doing = bucketId(withColumn, "doing");

			await admin().board.addTask({ boardId: board.id, title: "in flight", bucketId: doing });

			const after = await admin().board.deleteBucket({ id: doing });

			expect(columnTitles(after)).toEqual(["To do"]);
			expect(cardsIn(after, "To do")).toEqual(["in flight"]);
		});

		it("will not remove the last one", async () => {
			const board = await admin().board.create({ title: "0.4" });

			await expect(
				admin().board.deleteBucket({ id: bucketId(board, "To do") }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("hands the default marker on when the default is removed", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({ boardId: board.id, title: "doing" });

			const after = await admin().board.deleteBucket({ id: bucketId(withColumn, "To do") });

			expect(after.buckets.find((bucket) => bucket.isDefault)?.title).toBe("doing");
		});
	});

	describe("who can see and touch a board", () => {
		it("keeps private boards out of sight entirely", async () => {
			const board = await admin().board.create({ title: "Private" });

			await expect(callerAs(db, null).board.list()).resolves.toEqual([]);

			// NOT_FOUND, not FORBIDDEN: the reply does not confirm it is there.
			await expect(callerAs(db, null).board.byId({ id: board.id })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("shows a published board to anyone, read-only", async () => {
			const board = await admin().board.create({ title: "What I am doing", isPublic: true });
			await admin().board.addTask({ boardId: board.id, title: "A job" });

			const seen = await callerAs(db, null).board.byId({ id: board.id });
			expect(cardsIn(seen, "To do")).toEqual(["A job"]);

			await expect(
				callerAs(db, actorFor(member)).board.addTask({
					boardId: board.id,
					title: "Mine now",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});
	});

	it("links a card to the request it came from", async () => {
		const visitor = callerAs(db, null);
		const item = await visitor.feedback.submit({ kind: "idea", title: "RSS", body: "x" });

		const board = await admin().board.create({ title: "0.4" });
		const withTask = await admin().board.addTask({
			boardId: board.id,
			title: "Add an RSS feed",
			feedbackId: item.id,
		});

		expect(withTask.buckets[0]?.tasks[0]?.feedbackId).toBe(item.id);
	});
});
