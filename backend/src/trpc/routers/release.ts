import {
	CreateReleaseInput,
	createRelease,
	deleteRelease,
	getRelease,
	ListReleasesInput,
	listReleases,
	ReleaseIdInput,
	shipRelease,
	UpdateReleaseInput,
	updateRelease,
} from "../../services/release.service";
import { adminProcedure, publicProcedure, router } from "../trpc";

/**
 * The calendar half of the board.
 *
 * Reading is public - the point of publishing a release schedule is that people can see
 * it without asking. Everything that changes one is `adminProcedure`: there is exactly
 * one person deciding what ships and when, which is the model, not a limitation.
 */
export const releaseRouter = router({
	/** trpc.release.list.query() - next window first, then history. */
	list: publicProcedure
		.input(ListReleasesInput)
		.query(({ ctx, input }) => listReleases(ctx.db, input)),

	/** trpc.release.byId.query({ id }) */
	byId: publicProcedure
		.input(ReleaseIdInput)
		.query(({ ctx, input }) => getRelease(ctx.db, input)),

	/** trpc.release.create.mutate({ version: "0.4", plannedFor }) */
	create: adminProcedure
		.input(CreateReleaseInput)
		.mutation(({ ctx, input }) => createRelease(ctx.db, ctx.actor, input)),

	/** trpc.release.update.mutate({ id, status: "merge_window" }) - opens the window. */
	update: adminProcedure
		.input(UpdateReleaseInput)
		.mutation(({ ctx, input }) => updateRelease(ctx.db, ctx.actor, input)),

	/** trpc.release.ship.mutate({ id }) - closes it, and ships everything in it. */
	ship: adminProcedure
		.input(ReleaseIdInput)
		.mutation(({ ctx, input }) => shipRelease(ctx.db, ctx.actor, input)),

	/** trpc.release.delete.mutate({ id }) - cancels a plan. Shipped releases stay. */
	delete: adminProcedure
		.input(ReleaseIdInput)
		.mutation(({ ctx, input }) => deleteRelease(ctx.db, ctx.actor, input)),
});
