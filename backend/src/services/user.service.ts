import { type } from "arktype";
import { eq } from "drizzle-orm";
import type { Database } from "../db";
import { type PublicUser, toPublicUser, users } from "../db/schema";
import { type Actor, requireAdmin } from "../lib/actor";
import { AppError, parseInput } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { revokeAllSessions } from "./auth.service";

export const SetRoleInput = type({
	userId: "string.uuid",
	role: "'user' | 'admin'",
});

export const UserIdInput = type({ userId: "string.uuid" });

/**
 * Admin-only, all of it.
 *
 * The check lives in the service, not only in the `adminProcedure` wrapper, because two
 * transports reach this code. A guard bolted onto the tRPC router alone would leave the
 * gRPC door open. Transports reject early for a clean error; the service is what makes
 * the rule true.
 *
 * Every mutation here is also logged with the admin who did it. Privilege changes are
 * exactly the events you will want a record of after the fact.
 */
export async function listUsers(db: Database, actor: Actor | null): Promise<PublicUser[]> {
	requireAdmin(actor);

	const rows = await db.query.users.findMany({ orderBy: users.createdAt });

	return rows.map(toPublicUser);
}

export async function setUserRole(
	db: Database,
	log: Logger,
	actor: Actor | null,
	input: unknown,
): Promise<PublicUser> {
	const admin = requireAdmin(actor);
	const { userId, role } = parseInput(SetRoleInput, input);

	// Without this, the last admin can demote themselves and nobody can ever promote
	// anyone again - the system locks itself out with no way back in through the app.
	if (userId === admin.id && role !== "admin") {
		throw new AppError("BAD_REQUEST", "You cannot remove your own admin role");
	}

	const [updated] = await db
		.update(users)
		.set({ role, updatedAt: new Date() })
		.where(eq(users.id, userId))
		.returning();

	if (!updated) {
		throw new AppError("NOT_FOUND", `No user with id ${userId}`);
	}

	// The old access token still says "user" (or "admin") until it expires. Dropping the
	// refresh tokens means it cannot be renewed, so a demotion actually takes hold within
	// one access-token lifetime instead of lingering for a week.
	await revokeAllSessions(db, userId);

	log.warn({ event: "user.role_changed", actorId: admin.id, userId, role }, "role changed");

	return toPublicUser(updated);
}

export async function deleteUser(
	db: Database,
	log: Logger,
	actor: Actor | null,
	input: unknown,
): Promise<{ id: string }> {
	const admin = requireAdmin(actor);
	const { userId } = parseInput(UserIdInput, input);

	if (userId === admin.id) {
		throw new AppError("BAD_REQUEST", "You cannot delete your own account");
	}

	const [deleted] = await db.delete(users).where(eq(users.id, userId)).returning();

	if (!deleted) {
		throw new AppError("NOT_FOUND", `No user with id ${userId}`);
	}

	log.warn({ event: "user.deleted", actorId: admin.id, userId }, "user deleted");

	// Posts and refresh tokens go with them - see the cascade in db/schema.ts.
	return { id: deleted.id };
}
