import {
	CreatePostInput,
	createPost,
	deletePost,
	getPost,
	ListPostsInput,
	listPosts,
	PostIdInput,
	UpdatePostInput,
	updatePost,
} from "../../services/post.service";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/**
 * Note which procedures are public and which are not.
 *
 * Reading is public - but `ctx.actor` still travels into the service, because *what* you
 * can read depends on who you are (drafts are yours alone until published). Writing needs
 * a session, and who may touch an existing post is the service's call: its author, or an
 * admin. See post.service.ts.
 */
export const postRouter = router({
	/** trpc.post.list.query({ limit: 10 }) - published posts, plus your own drafts. */
	list: publicProcedure
		.input(ListPostsInput)
		.query(({ ctx, input }) => listPosts(ctx.db, ctx.actor, input)),

	/** trpc.post.byId.query({ id }) */
	byId: publicProcedure
		.input(PostIdInput)
		.query(({ ctx, input }) => getPost(ctx.db, ctx.actor, input)),

	/** trpc.post.create.mutate({ title, body }) - author comes from the token. */
	create: protectedProcedure
		.input(CreatePostInput)
		.mutation(({ ctx, input }) => createPost(ctx.db, ctx.actor, input)),

	/** trpc.post.update.mutate({ id, title? }) - yours, or you are an admin. */
	update: protectedProcedure
		.input(UpdatePostInput)
		.mutation(({ ctx, input }) => updatePost(ctx.db, ctx.actor, input)),

	/** trpc.post.delete.mutate({ id }) - yours, or you are an admin. */
	delete: protectedProcedure
		.input(PostIdInput)
		.mutation(({ ctx, input }) => deletePost(ctx.db, ctx.actor, input)),
});
