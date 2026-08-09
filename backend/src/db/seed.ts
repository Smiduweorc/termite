import { count } from "drizzle-orm";
import { env } from "../config/env";
import { canonicalEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { hashPassword } from "../lib/password";
import { POSITION_STEP } from "../lib/position";
import { createDatabase } from "./index";
import {
	boards,
	buckets,
	feedback,
	passwordTokens,
	refreshTokens,
	releases,
	tasks,
	users,
	votes,
} from "./schema";

/**
 * Development seed: one maintainer, one signed-in regular, and a board with a shipped
 * release behind it and a merge window open in front of it.
 *
 * Most of the feedback has no author at all, which is the normal case here - the board
 * is meant to work for people who will never make an account. Sign in as the maintainer
 * to see the triage controls appear.
 *
 *   bun run db:seed            - only on an empty board; refuses otherwise
 *   bun run db:seed --reset    - clears Termite's own rows first, then seeds
 */
const { db, pool } = createDatabase(env.DATABASE_URL);

const reset = process.argv.includes("--reset");

/**
 * Seeding twice used to end in a raw unique-violation stack trace from Postgres, which
 * says "duplicate key value violates users_email_canonical_idx" when what it means is
 * "you have already seeded this". So: look first, and say so in words.
 */
const [existing] = await db.select({ users: count() }).from(users);

if ((existing?.users ?? 0) > 0 && !reset) {
	logger.error(
		{ users: existing?.users },
		"this database already has accounts - re-run with `bun run db:seed --reset` to clear Termite's data and seed it fresh",
	);

	await pool.end();
	process.exit(1);
}

if (reset) {
	/**
	 * Deletes only Termite's own tables, named one by one and in foreign-key order.
	 *
	 * Deliberately not a `TRUNCATE ... CASCADE` and deliberately not a loop over
	 * whatever tables happen to be in the schema: a Termite database may be sharing
	 * its Postgres with something else entirely, and a seed script has no business
	 * touching a table it did not create.
	 */
	await db.transaction(async (tx) => {
		await tx.delete(votes);
		await tx.delete(tasks);
		await tx.delete(buckets);
		await tx.delete(boards);
		await tx.delete(feedback);
		await tx.delete(releases);
		await tx.delete(passwordTokens);
		await tx.delete(refreshTokens);
		await tx.delete(users);
	});

	logger.info("cleared Termite's tables");
}

const [maintainer, regular] = await db
	.insert(users)
	.values([
		{
			email: "maintainer@example.com",
			emailCanonical: canonicalEmail("maintainer@example.com"),
			name: "Maintainer",
			passwordHash: await hashPassword("password123"),
			role: "admin",
		},
		{
			email: "contributor@example.com",
			emailCanonical: canonicalEmail("contributor@example.com"),
			name: "Contributor",
			passwordHash: await hashPassword("password123"),
			role: "user",
		},
	])
	.returning();

if (!maintainer || !regular) {
	throw new Error("Seed failed: users were not inserted");
}

const day = 24 * 60 * 60 * 1000;

const [shipped, window, later] = await db
	.insert(releases)
	.values([
		{
			version: "0.1",
			name: "First light",
			status: "released",
			notes: "The board, votes, and nothing else.",
			plannedFor: new Date(Date.now() - 30 * day),
			releasedAt: new Date(Date.now() - 28 * day),
		},
		{
			// The burst the maintainer is in right now.
			version: "0.2",
			name: "Merge window",
			status: "merge_window",
			notes: "Taking small things until it closes.",
			plannedFor: new Date(Date.now() + 10 * day),
		},
		{
			// No date, on purpose: "eventually" is an honest answer for a side project.
			version: "0.3",
			status: "planned",
		},
	])
	.returning();

if (!shipped || !window || !later) {
	throw new Error("Seed failed: releases were not inserted");
}

const items = await db
	.insert(feedback)
	.values([
		{
			kind: "bug",
			title: "Votes disappear after a hard refresh",
			body: "Voted on three items, refreshed, and two of them came back unvoted.",
			status: "open",
			authorName: "passer-by",
		},
		{
			kind: "idea",
			title: "RSS feed for releases",
			body: "So I can follow the calendar without opening the site.",
			status: "planned",
			releaseId: window.id,
			authorName: "wren",
		},
		{
			kind: "idea",
			title: "Markdown in bodies",
			body: "Code blocks would make bug reports much easier to read.",
			status: "open",
			authorId: regular.id,
		},
		{
			kind: "bug",
			title: "Long titles overflow on mobile",
			body: "Anything past about sixty characters runs off the edge.",
			status: "shipped",
			releaseId: shipped.id,
		},
		{
			kind: "idea",
			title: "Assignees and sprint planning",
			body: "Could we get story points and a burndown chart?",
			status: "declined",
			maintainerNote: "Not what this is for. See the README.",
			authorName: "someone from a large company",
		},
		{
			kind: "idea",
			title: "Dark mode that follows the system",
			body: "It already does on my machine, but not on my phone.",
			status: "open",
			authorName: null,
		},
	])
	.returning();

// A show of hands, so "top" has something to sort. Anonymous voters are hashes of a
// cookie in real life; here they are just distinct strings standing in for six people.
const voters = Array.from({ length: 6 }, (_, index) => `anon:seed-voter-${index}`);

await db.insert(votes).values(
	items.flatMap((item, index) =>
		// The first item gets every vote, the next fewer, and so on down the board.
		voters.slice(0, Math.max(0, voters.length - index)).map((voterKey) => ({
			feedbackId: item.id,
			voterKey,
		})),
	),
);

/**
 * A task board with columns that are not the usual three.
 *
 * That is the point of the seed: nothing here is a fixed stage, "shipped" is marked as
 * the done column only because this board wanted one, and a board that marks none is
 * equally valid.
 */
const [board] = await db
	.insert(boards)
	.values({
		title: "0.2 merge window",
		description: "What is actually being worked on for the open window.",
		isPublic: true,
	})
	.returning();

if (!board) {
	throw new Error("Seed failed: board was not inserted");
}

const columns = await db
	.insert(buckets)
	.values(
		[
			{ title: "To do", isDefault: true },
			{ title: "In the branch", wipLimit: 3 },
			{ title: "Waiting on upstream" },
			{ title: "Shipped", isDone: true },
		].map((column, index) => ({
			...column,
			boardId: board.id,
			position: (index + 1) * POSITION_STEP,
		})),
	)
	.returning();

const [todo, inBranch, waiting, done] = columns;

if (!todo || !inBranch || !waiting || !done) {
	throw new Error("Seed failed: buckets were not inserted");
}

const rss = items.find((item) => item.title.startsWith("RSS"));

await db.insert(tasks).values([
	{
		boardId: board.id,
		bucketId: todo.id,
		title: "Write the RSS template",
		description: "One entry per release, notes as the body.",
		position: POSITION_STEP,
		// The glue: this card exists because somebody asked for it on the board.
		releaseId: window.id,
		...(rss ? { feedbackId: rss.id } : {}),
	},
	{
		boardId: board.id,
		bucketId: inBranch.id,
		title: "Fix the mobile overflow",
		position: POSITION_STEP,
		releaseId: window.id,
	},
	{
		boardId: board.id,
		bucketId: waiting.id,
		title: "Bump the driver once upstream tags",
		description: "Nothing to do here until they cut a release.",
		position: POSITION_STEP,
	},
	{
		boardId: board.id,
		bucketId: done.id,
		title: "Set up the merge window",
		done: true,
		doneAt: new Date(),
		position: POSITION_STEP,
	},
]);

// pino's signature is (fields, message) - the object comes first.
logger.info(
	{
		maintainer: `${maintainer.email} / password123`,
		user: `${regular.email} / password123`,
		releases: 3,
		feedback: items.length,
		board: board.title,
	},
	"seeded",
);

await pool.end();
