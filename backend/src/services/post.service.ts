import { type } from "arktype";
import { and, desc, eq, or } from "drizzle-orm";
import type { Database } from "../db";
import { type Post, posts } from "../db/schema";
import { type Actor, canMutate, requireActor } from "../lib/actor";
import { AppError, parseInput } from "../lib/errors";

export const ListPostsInput = type({
	"limit?": "1 <= number.integer <= 100",
	"publishedOnly?": "boolean",
});

export const PostIdInput = type({ id: "string.uuid" });

export const CreatePostInput = type({
	title: "1 <= string <= 200",
	body: "1 <= string <= 10000",
	"published?": "boolean",
});

export const UpdatePostInput = type({
	id: "string.uuid",
	"title?": "1 <= string <= 200",
	"body?": "1 <= string <= 10000",
	"published?": "boolean",
});

/**
 * What this actor is allowed to see.
 *
 * - anonymous: published posts only
 * - signed in: published posts, plus their own drafts
 * - admin:     everything
 *
 * Expressed as SQL rather than a filter after the fact, so a draft never leaves the
 * database in the first place - and `limit` counts the rows you may actually see.
 */
function visibleTo(actor: Actor | null) {
	if (actor?.role === "admin") return undefined;

	if (actor) {
		return or(eq(posts.published, true), eq(posts.authorId, actor.id));
	}

	return eq(posts.published, true);
}

export async function listPosts(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<Post[]> {
	const { limit, publishedOnly } = parseInput(ListPostsInput, input);

	const visible = visibleTo(actor);
	const onlyPublished = publishedOnly ? eq(posts.published, true) : undefined;

	return db.query.posts.findMany({
		where: and(visible, onlyPublished),
		orderBy: desc(posts.createdAt),
		limit: limit ?? 20,
	});
}

export async function getPost(db: Database, actor: Actor | null, input: unknown): Promise<Post> {
	const { id } = parseInput(PostIdInput, input);

	const post = await db.query.posts.findFirst({ where: eq(posts.id, id) });

	// NOT_FOUND rather than FORBIDDEN for someone else's draft. FORBIDDEN would confirm
	// the post exists, which is itself a leak.
	if (!post || (!post.published && !(actor && canMutate(actor, post.authorId)))) {
		throw new AppError("NOT_FOUND", `No post with id ${id}`);
	}

	return post;
}

export async function createPost(db: Database, actor: Actor | null, input: unknown): Promise<Post> {
	const current = requireActor(actor);
	const { title, body, published } = parseInput(CreatePostInput, input);

	const [post] = await db
		.insert(posts)
		.values({
			title,
			body,
			published: published ?? false,
			// Authorship comes from the token, never from the request body.
			authorId: current.id,
		})
		.returning();

	if (!post) {
		throw new AppError("INTERNAL", "Insert returned no row");
	}

	return post;
}

/** Loads a post and checks the actor may change it: their own, or they are an admin. */
async function loadMutable(db: Database, actor: Actor | null, id: string): Promise<Post> {
	const current = requireActor(actor);

	const post = await db.query.posts.findFirst({ where: eq(posts.id, id) });

	if (!post) {
		throw new AppError("NOT_FOUND", `No post with id ${id}`);
	}

	if (!canMutate(current, post.authorId)) {
		throw new AppError("FORBIDDEN", "That post belongs to someone else");
	}

	return post;
}

export async function updatePost(db: Database, actor: Actor | null, input: unknown): Promise<Post> {
	const { id, ...changes } = parseInput(UpdatePostInput, input);

	await loadMutable(db, actor, id);

	if (Object.keys(changes).length === 0) {
		throw new AppError("BAD_REQUEST", "Nothing to update");
	}

	const [post] = await db
		.update(posts)
		.set({ ...changes, updatedAt: new Date() })
		.where(eq(posts.id, id))
		.returning();

	if (!post) {
		throw new AppError("NOT_FOUND", `No post with id ${id}`);
	}

	return post;
}

export async function deletePost(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<{ id: string }> {
	const { id } = parseInput(PostIdInput, input);

	await loadMutable(db, actor, id);

	await db.delete(posts).where(eq(posts.id, id));

	return { id };
}
