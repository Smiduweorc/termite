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

	describe("copying a card", () => {
		it("puts the copy directly under the card it came from", async () => {
			let board = await admin().board.create({ title: "0.4" });

			for (const title of ["first", "second"]) {
				board = await admin().board.addTask({ boardId: board.id, title });
			}

			const copied = await admin().board.duplicateTask({ id: taskId(board, "first") });

			// Under the original, not at the bottom of the column - on a long column the
			// bottom is offscreen, and the card you just made is the one you want to see.
			expect(cardsIn(copied, "To do")).toEqual(["first", "first (copy)", "second"]);
		});

		it("brings the description and the links across", async () => {
			const visitor = callerAs(db, null);
			const item = await visitor.feedback.submit({ kind: "idea", title: "RSS", body: "x" });

			const board = await admin().board.create({ title: "0.4" });
			const withTask = await admin().board.addTask({
				boardId: board.id,
				title: "Add an RSS feed",
				description: "One entry per release.",
				feedbackId: item.id,
			});

			const copied = await admin().board.duplicateTask({
				id: taskId(withTask, "Add an RSS feed"),
			});

			const copy = copied.buckets[0]?.tasks.find((task) => task.title.endsWith("(copy)"));

			expect(copy?.description).toBe("One entry per release.");
			// A copy of "add an RSS feed" is still about the request that asked for it.
			expect(copy?.feedbackId).toBe(item.id);
		});

		it("takes the name it is given instead of inventing one", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withTask = await admin().board.addTask({ boardId: board.id, title: "Tag it" });

			const copied = await admin().board.duplicateTask({
				id: taskId(withTask, "Tag it"),
				title: "Tag 0.5",
			});

			expect(cardsIn(copied, "To do")).toEqual(["Tag it", "Tag 0.5"]);
		});

		it("counts against a WIP limit like any other card", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "doing",
				wipLimit: 1,
			});

			const doing = bucketId(withColumn, "doing");
			const filled = await admin().board.addTask({
				boardId: board.id,
				title: "one",
				bucketId: doing,
			});

			await expect(
				admin().board.duplicateTask({ id: taskId(filled, "one") }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("pulls a card off one board onto a column of another", async () => {
			const template = await admin().board.create({ title: "Release checklist" });
			const withTask = await admin().board.addTask({
				boardId: template.id,
				title: "Write the changelog",
			});

			const working = await admin().board.create({ title: "0.4" });

			const landed = await admin().board.duplicateTask({
				id: taskId(withTask, "Write the changelog"),
				bucketId: bucketId(working, "To do"),
				title: "Write the changelog",
			});

			// The answer is the board the copy landed on, not the one it came from.
			expect(landed.id).toBe(working.id);
			expect(cardsIn(landed, "To do")).toEqual(["Write the changelog"]);

			const source = await admin().board.byId({ id: template.id });
			expect(cardsIn(source, "To do")).toEqual(["Write the changelog"]);
		});

		it("survives the same card being copied into the same seam over and over", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withTasks = await admin().board.addTask({ boardId: board.id, title: "first" });
			const id = taskId(withTasks, "first");

			// Every copy lands in the gap under the original and halves it. Enough of them
			// and a naive implementation runs out of precision; this one rebalances, on
			// the same path a drag uses.
			for (let attempt = 0; attempt < 60; attempt++) {
				await admin().board.duplicateTask({ id });
			}

			const column = (await admin().board.byId({ id: board.id })).buckets[0];
			const positions = (column?.tasks ?? []).map((task) => task.position);

			expect(positions).toHaveLength(61);
			expect(new Set(positions).size).toBe(positions.length);
			expect(column?.tasks[0]?.title).toBe("first");
		});

		it("is the maintainer's to make", async () => {
			const board = await admin().board.create({ title: "0.4", isPublic: true });
			const withTask = await admin().board.addTask({ boardId: board.id, title: "A job" });

			await expect(
				callerAs(db, actorFor(member)).board.duplicateTask({
					id: taskId(withTask, "A job"),
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});
	});

	describe("copying a column", () => {
		it("sits the copy next to the original, cards and all", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "checks",
				wipLimit: 5,
			});

			const checks = bucketId(withColumn, "checks");

			for (const title of ["lint", "typecheck"]) {
				await admin().board.addTask({ boardId: board.id, title, bucketId: checks });
			}

			await admin().board.addBucket({ boardId: board.id, title: "after" });

			const copied = await admin().board.duplicateBucket({ id: checks });

			expect(columnTitles(copied)).toEqual(["To do", "checks", "checks (copy)", "after"]);
			expect(cardsIn(copied, "checks (copy)")).toEqual(["lint", "typecheck"]);

			const copy = copied.buckets.find((column) => column.title === "checks (copy)");

			expect(copy?.wipLimit).toBe(5);
			// Neither marker comes along: there is one of each per board, and the
			// original still holds them.
			expect(copy?.isDefault).toBe(false);
			expect(copy?.isDone).toBe(false);
		});

		it("copies just the shape when the cards are not wanted", async () => {
			const board = await admin().board.create({ title: "0.4" });
			await admin().board.addTask({ boardId: board.id, title: "A job" });

			const copied = await admin().board.duplicateBucket({
				id: bucketId(board, "To do"),
				title: "Next time",
				includeTasks: false,
			});

			expect(cardsIn(copied, "Next time")).toEqual([]);
			expect(cardsIn(copied, "To do")).toEqual(["A job"]);
		});

		it("copies a column onto another board, at the end", async () => {
			const template = await admin().board.create({ title: "Release checklist" });
			const withColumn = await admin().board.addBucket({
				boardId: template.id,
				title: "before tagging",
			});

			await admin().board.addTask({
				boardId: template.id,
				title: "bump the version",
				bucketId: bucketId(withColumn, "before tagging"),
			});

			const working = await admin().board.create({ title: "0.4" });

			const landed = await admin().board.duplicateBucket({
				id: bucketId(withColumn, "before tagging"),
				boardId: working.id,
				title: "before tagging",
			});

			expect(landed.id).toBe(working.id);
			expect(columnTitles(landed)).toEqual(["To do", "before tagging"]);
			expect(cardsIn(landed, "before tagging")).toEqual(["bump the version"]);
		});

		it("does not let a copied column stand in for the done one", async () => {
			const board = await admin().board.create({ title: "0.4" });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "shipped",
			});
			const shipped = bucketId(withColumn, "shipped");

			await admin().board.updateBucket({ id: shipped, isDone: true });

			const copied = await admin().board.duplicateBucket({ id: shipped });

			// One done column, still - the copy is a column, not a second finish line.
			expect(copied.buckets.filter((column) => column.isDone).map((c) => c.title)).toEqual([
				"shipped",
			]);
		});
	});

	describe("copying a board", () => {
		it("brings the columns, the cards and the markers", async () => {
			const board = await admin().board.create({ title: "0.4", isPublic: true });
			const withColumn = await admin().board.addBucket({
				boardId: board.id,
				title: "shipped",
			});

			await admin().board.updateBucket({
				id: bucketId(withColumn, "shipped"),
				isDone: true,
			});
			await admin().board.addTask({ boardId: board.id, title: "A job" });

			const copy = await admin().board.duplicate({ id: board.id });

			expect(copy.title).toBe("0.4 (copy)");
			expect(columnTitles(copy)).toEqual(["To do", "shipped"]);
			expect(cardsIn(copy, "To do")).toEqual(["A job"]);
			// The markers are one per board, and this is a new board, so the copy holds
			// its own without the original giving anything up.
			expect(copy.buckets.find((column) => column.isDone)?.title).toBe("shipped");
			expect(copy.buckets.find((column) => column.isDefault)?.title).toBe("To do");
			// Publishing is a decision about a particular board. A copy is not that board.
			expect(copy.isPublic).toBe(false);
		});

		it("leaves the board it copied exactly as it was", async () => {
			const board = await admin().board.create({ title: "0.4" });
			await admin().board.addTask({ boardId: board.id, title: "A job" });

			await admin().board.duplicate({ id: board.id });

			const original = await admin().board.byId({ id: board.id });

			expect(columnTitles(original)).toEqual(["To do"]);
			expect(cardsIn(original, "To do")).toEqual(["A job"]);
		});
	});

	describe("templates, which are boards kept to be copied", () => {
		it("keeps a shape aside without touching the board it came from", async () => {
			const board = await admin().board.create({ title: "Release checklist" });
			await admin().board.addTask({ boardId: board.id, title: "Write the changelog" });

			const template = await admin().board.saveAsTemplate({ id: board.id });

			expect(template.isTemplate).toBe(true);
			// Templates are listed apart from boards, so the name can be the same one.
			expect(template.title).toBe("Release checklist");
			expect(cardsIn(template, "To do")).toEqual(["Write the changelog"]);

			const original = await admin().board.byId({ id: board.id });
			expect(original.isTemplate).toBe(false);
		});

		it("starts a board from one, and stays a template", async () => {
			const board = await admin().board.create({ title: "Release checklist" });
			await admin().board.addTask({ boardId: board.id, title: "Write the changelog" });

			const template = await admin().board.saveAsTemplate({ id: board.id });

			const started = await admin().board.useTemplate({
				id: template.id,
				title: "0.5 merge window",
			});

			expect(started.isTemplate).toBe(false);
			expect(started.title).toBe("0.5 merge window");
			expect(cardsIn(started, "To do")).toEqual(["Write the changelog"]);

			const stillATemplate = await admin().board.byId({ id: template.id });
			expect(stillATemplate.isTemplate).toBe(true);
		});

		it("duplicating a template gives another template", async () => {
			const board = await admin().board.create({ title: "Checklist", isTemplate: true });

			const copy = await admin().board.duplicate({ id: board.id });

			expect(copy.isTemplate).toBe(true);
		});

		it("says so when asked to start from something that is not a template", async () => {
			const board = await admin().board.create({ title: "0.4" });

			await expect(admin().board.useTemplate({ id: board.id })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it("can be demoted back to a board you work on", async () => {
			const board = await admin().board.create({ title: "Checklist", isTemplate: true });

			const promoted = await admin().board.update({ id: board.id, isTemplate: false });

			expect(promoted.isTemplate).toBe(false);
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
