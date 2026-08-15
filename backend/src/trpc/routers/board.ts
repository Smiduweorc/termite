import {
	BoardIdInput,
	CreateBoardInput,
	CreateBucketInput,
	CreateTaskInput,
	createBoard,
	createBucket,
	createTask,
	DeleteBucketInput,
	DuplicateBoardInput,
	DuplicateBucketInput,
	DuplicateTaskInput,
	deleteBoard,
	deleteBucket,
	deleteTask,
	duplicateBoard,
	duplicateBucket,
	duplicateTask,
	getBoard,
	listBoards,
	MoveBucketInput,
	MoveTaskInput,
	moveBucket,
	moveTask,
	SaveAsTemplateInput,
	saveAsTemplate,
	TaskIdInput,
	UpdateBoardInput,
	UpdateBucketInput,
	UpdateTaskInput,
	UseTemplateInput,
	updateBoard,
	updateBucket,
	updateTask,
	useTemplate,
} from "../../services/board.service";
import { adminProcedure, publicProcedure, router } from "../trpc";

/**
 * The maintainer's own working surface, next to the public one.
 *
 * Reading is public *only* for boards the maintainer published - `listBoards` filters
 * and `getBoard` 404s the rest, so a private board does not even confirm it exists.
 * Everything that changes anything is `adminProcedure`: this is one person's workspace,
 * not a place the community edits.
 *
 * Every mutation answers with the whole board. A drag is a change to an ordering, and
 * ordering is the one thing a client should not be left to reconstruct from a partial
 * reply - one round trip, one authoritative layout, no divergence to reconcile.
 */
export const boardRouter = router({
	/** trpc.board.list.query() - published boards, or all of them for the maintainer. */
	list: publicProcedure.query(({ ctx }) => listBoards(ctx.db, ctx.actor)),

	/** trpc.board.byId.query({ id }) - the board with its columns and cards. */
	byId: publicProcedure
		.input(BoardIdInput)
		.query(({ ctx, input }) => getBoard(ctx.db, ctx.actor, input)),

	create: adminProcedure
		.input(CreateBoardInput)
		.mutation(({ ctx, input }) => createBoard(ctx.db, ctx.actor, input)),

	update: adminProcedure
		.input(UpdateBoardInput)
		.mutation(({ ctx, input }) => updateBoard(ctx.db, ctx.actor, input)),

	delete: adminProcedure
		.input(BoardIdInput)
		.mutation(({ ctx, input }) => deleteBoard(ctx.db, ctx.actor, input)),

	/**
	 * Copying, at four sizes: a card, a column, a board, and a board kept aside to start
	 * others from. A template is only a board with `isTemplate` set - `list` returns both
	 * and the client shows them apart - so all four of these are the same copy underneath.
	 */
	duplicate: adminProcedure
		.input(DuplicateBoardInput)
		.mutation(({ ctx, input }) => duplicateBoard(ctx.db, ctx.actor, input)),

	/** trpc.board.saveAsTemplate.mutate({ id }) - the live board is left alone. */
	saveAsTemplate: adminProcedure
		.input(SaveAsTemplateInput)
		.mutation(({ ctx, input }) => saveAsTemplate(ctx.db, ctx.actor, input)),

	/** trpc.board.useTemplate.mutate({ id, title }) - a new board with that shape. */
	useTemplate: adminProcedure
		.input(UseTemplateInput)
		.mutation(({ ctx, input }) => useTemplate(ctx.db, ctx.actor, input)),

	/** Columns: any number, named anything, none of them mandatory. */
	addBucket: adminProcedure
		.input(CreateBucketInput)
		.mutation(({ ctx, input }) => createBucket(ctx.db, ctx.actor, input)),

	/** trpc.board.updateBucket.mutate({ id, isDone: true }) - or false, to have none. */
	updateBucket: adminProcedure
		.input(UpdateBucketInput)
		.mutation(({ ctx, input }) => updateBucket(ctx.db, ctx.actor, input)),

	moveBucket: adminProcedure
		.input(MoveBucketInput)
		.mutation(({ ctx, input }) => moveBucket(ctx.db, ctx.actor, input)),

	/** The copy sits next to the original, with its cards unless you say otherwise. */
	duplicateBucket: adminProcedure
		.input(DuplicateBucketInput)
		.mutation(({ ctx, input }) => duplicateBucket(ctx.db, ctx.actor, input)),

	/** Deleting a column moves its cards; it never throws work away. */
	deleteBucket: adminProcedure
		.input(DeleteBucketInput)
		.mutation(({ ctx, input }) => deleteBucket(ctx.db, ctx.actor, input)),

	addTask: adminProcedure
		.input(CreateTaskInput)
		.mutation(({ ctx, input }) => createTask(ctx.db, ctx.actor, input)),

	updateTask: adminProcedure
		.input(UpdateTaskInput)
		.mutation(({ ctx, input }) => updateTask(ctx.db, ctx.actor, input)),

	/** trpc.board.moveTask.mutate({ id, bucketId, afterTaskId }) - the drop. */
	moveTask: adminProcedure
		.input(MoveTaskInput)
		.mutation(({ ctx, input }) => moveTask(ctx.db, ctx.actor, input)),

	/** The copy lands under the original, or in the column named - on any board. */
	duplicateTask: adminProcedure
		.input(DuplicateTaskInput)
		.mutation(({ ctx, input }) => duplicateTask(ctx.db, ctx.actor, input)),

	deleteTask: adminProcedure
		.input(TaskIdInput)
		.mutation(({ ctx, input }) => deleteTask(ctx.db, ctx.actor, input)),
});
