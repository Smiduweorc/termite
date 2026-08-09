import { type } from "arktype";
import { count, eq, getTableColumns, sql } from "drizzle-orm";
import type { Database } from "../db";
import { feedback, type ReleaseSummary, releases } from "../db/schema";
import { type Actor, requireAdmin } from "../lib/actor";
import { AppError, isUniqueViolation, parseInput } from "../lib/errors";
import { markShipped, unplanForRelease } from "./feedback.service";

export const ListReleasesInput = type({
	"status?": "'planned' | 'merge_window' | 'released'",
	"limit?": "1 <= number.integer <= 100",
});

export const ReleaseIdInput = type({ id: "string.uuid" });

export const CreateReleaseInput = type({
	// Free text on purpose: semver, calver and "0.4-beta" are all real answers.
	version: "1 <= string <= 40",
	"name?": "string <= 80",
	"notes?": "string <= 10000",
	"status?": "'planned' | 'merge_window' | 'released'",
	/** ISO 8601, or null for "there will be another one, but not on a date yet". */
	"plannedFor?": "string.date | null",
});

export const UpdateReleaseInput = type({
	id: "string.uuid",
	"version?": "1 <= string <= 40",
	"name?": "string <= 80 | null",
	"notes?": "string <= 10000 | null",
	"status?": "'planned' | 'merge_window' | 'released'",
	"plannedFor?": "string.date | null",
});

/**
 * The calendar order.
 *
 * A release's date is whichever it has: the one it went out on, or the one it is aimed
 * at. Sorting on that descending puts the next window at the top, then the one before
 * it, then history - which is the order a reader actually wants. Undated plans sort last
 * rather than first (Postgres puts NULLs first under DESC), because "someday" is not
 * news.
 */
const CALENDAR_ORDER = sql`coalesce(${releases.releasedAt}, ${releases.plannedFor}) desc nulls last, ${releases.createdAt} desc`;

const summaryColumns = {
	...getTableColumns(releases),
	itemCount: count(feedback.id),
};

export async function listReleases(db: Database, input: unknown): Promise<ReleaseSummary[]> {
	const { status, limit } = parseInput(ListReleasesInput, input);

	return db
		.select(summaryColumns)
		.from(releases)
		.leftJoin(feedback, eq(feedback.releaseId, releases.id))
		.where(status ? eq(releases.status, status) : undefined)
		.groupBy(releases.id)
		.orderBy(CALENDAR_ORDER)
		.limit(limit ?? 25);
}

async function loadRelease(db: Database, id: string): Promise<ReleaseSummary> {
	const [release] = await db
		.select(summaryColumns)
		.from(releases)
		.leftJoin(feedback, eq(feedback.releaseId, releases.id))
		.where(eq(releases.id, id))
		.groupBy(releases.id)
		.limit(1);

	if (!release) {
		throw new AppError("NOT_FOUND", `No release with id ${id}`);
	}

	return release;
}

export async function getRelease(db: Database, input: unknown): Promise<ReleaseSummary> {
	const { id } = parseInput(ReleaseIdInput, input);

	return loadRelease(db, id);
}

/** Dates cross the wire as ISO strings; the column wants a Date. Null clears it. */
function toDate(value: string | null | undefined): Date | null | undefined {
	if (value === undefined) return undefined;

	return value === null ? null : new Date(value);
}

export async function createRelease(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<ReleaseSummary> {
	requireAdmin(actor);

	const { version, name, notes, status, plannedFor } = parseInput(CreateReleaseInput, input);

	try {
		const [release] = await db
			.insert(releases)
			.values({
				version,
				name: name || null,
				notes: notes || null,
				status: status ?? "planned",
				plannedFor: toDate(plannedFor) ?? null,
				// Creating something already marked released dates it now; there is no
				// point making the maintainer state the obvious.
				releasedAt: status === "released" ? new Date() : null,
			})
			.returning();

		if (!release) {
			throw new AppError("INTERNAL", "Insert returned no row");
		}

		return loadRelease(db, release.id);
	} catch (error) {
		// Let the UNIQUE index answer "does this version exist?" - see lib/errors.ts.
		if (isUniqueViolation(error)) {
			throw new AppError("CONFLICT", `Release ${version} already exists`);
		}

		throw error;
	}
}

export async function updateRelease(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<ReleaseSummary> {
	requireAdmin(actor);

	const { id, plannedFor, ...rest } = parseInput(UpdateReleaseInput, input);

	const release = await db.query.releases.findFirst({ where: eq(releases.id, id) });

	if (!release) {
		throw new AppError("NOT_FOUND", `No release with id ${id}`);
	}

	const changes = {
		...rest,
		...(plannedFor !== undefined ? { plannedFor: toDate(plannedFor) } : {}),
	};

	if (Object.keys(changes).length === 0) {
		throw new AppError("BAD_REQUEST", "Nothing to update");
	}

	// Marking a release released by hand still has to ship its items, or the board goes
	// out of step with the changelog. That is what ship() is for, so route through it.
	if (rest.status === "released" && release.status !== "released") {
		await shipRelease(db, actor, { id });
	}

	await db
		.update(releases)
		.set({ ...changes, updatedAt: new Date() })
		.where(eq(releases.id, id));

	return loadRelease(db, id);
}

/**
 * The merge window closes.
 *
 * This is the one action the whole model is built around: a maintainer works in bursts,
 * and when the burst ends everything that made it into the window ships at once. Doing
 * it in a transaction is what keeps "released" and "shipped" from disagreeing if the
 * process dies halfway.
 *
 * Declined items are left alone - they were answered before the window closed, and
 * shipping them would be a lie.
 */
export async function shipRelease(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<ReleaseSummary> {
	requireAdmin(actor);

	const { id } = parseInput(ReleaseIdInput, input);

	const release = await db.query.releases.findFirst({ where: eq(releases.id, id) });

	if (!release) {
		throw new AppError("NOT_FOUND", `No release with id ${id}`);
	}

	if (release.status === "released") {
		throw new AppError("CONFLICT", `Release ${release.version} has already shipped`);
	}

	await db.transaction(async (tx) => {
		await tx
			.update(releases)
			.set({ status: "released", releasedAt: new Date(), updatedAt: new Date() })
			.where(eq(releases.id, id));

		await markShipped(tx, id);
	});

	return loadRelease(db, id);
}

/**
 * Deleting a release must not delete the requests that were aimed at it - they were the
 * community's, not the maintainer's. Planned items go back to open and rejoin the board;
 * items already marked shipped keep that status, because they did ship.
 */
export async function deleteRelease(
	db: Database,
	actor: Actor | null,
	input: unknown,
): Promise<{ id: string }> {
	requireAdmin(actor);

	const { id } = parseInput(ReleaseIdInput, input);

	const release = await db.query.releases.findFirst({ where: eq(releases.id, id) });

	if (!release) {
		throw new AppError("NOT_FOUND", `No release with id ${id}`);
	}

	// A shipped release is history, and history is not editable away: deleting it would
	// cut every item's "shipped in 1.2" loose, leaving a board that cannot say when
	// anything landed. Cancel a plan, by all means. Cancel the past, no.
	if (release.status === "released") {
		throw new AppError("CONFLICT", `Release ${release.version} has already shipped`);
	}

	await db.transaction(async (tx) => {
		await unplanForRelease(tx, id);
		await tx.delete(releases).where(eq(releases.id, id));
	});

	return { id };
}
