import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import type { PublicUser } from "../../db/schema";
import { actorFor, seedUser } from "../../test/auth";
import { callerAs } from "../../test/context";
import { createTestDatabase } from "../../test/db";

describe("admin-only user router", () => {
	let db: Database;
	let member: PublicUser;
	let admin: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		member = await seedUser(db, { email: "bob@example.com", name: "Bob" });
		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });
	});

	it("is UNAUTHORIZED for anonymous callers", async () => {
		await expect(callerAs(db, null).user.list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("is FORBIDDEN for signed-in non-admins", async () => {
		const bob = callerAs(db, actorFor(member));

		await expect(bob.user.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(bob.user.setRole({ userId: member.id, role: "admin" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(bob.user.delete({ userId: admin.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("cannot be escalated by a user promoting themselves", async () => {
		await expect(
			callerAs(db, actorFor(member)).user.setRole({ userId: member.id, role: "admin" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// And the database did not budge.
		const bob = await db.query.users.findFirst();
		expect(bob?.role).not.toBe("admin");
	});

	it("lets an admin list users, without password hashes", async () => {
		const users = await callerAs(db, actorFor(admin)).user.list();

		expect(users).toHaveLength(2);
		expect(users.every((user) => !("passwordHash" in user))).toBe(true);
	});

	it("lets an admin promote someone", async () => {
		const promoted = await callerAs(db, actorFor(admin)).user.setRole({
			userId: member.id,
			role: "admin",
		});

		expect(promoted.role).toBe("admin");

		// And now Bob really can act as one.
		await expect(callerAs(db, actorFor(promoted)).user.list()).resolves.toHaveLength(2);
	});

	it("stops the last admin from locking everyone out", async () => {
		await expect(
			callerAs(db, actorFor(admin)).user.setRole({ userId: admin.id, role: "user" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await expect(
			callerAs(db, actorFor(admin)).user.delete({ userId: admin.id }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("revokes sessions when a role changes", async () => {
		// Bob signs in...
		const session = await callerAs(db, null).auth.login({
			email: "bob@example.com",
			password: "password123",
		});
		expect(session.role).toBe("user");

		const before = await db.query.refreshTokens.findFirst();
		expect(before?.revokedAt).toBeNull();

		// ...an admin changes his role...
		await callerAs(db, actorFor(admin)).user.setRole({ userId: member.id, role: "admin" });

		// ...and his refresh token is dead, so the stale "user" access token cannot be
		// renewed. Without this, a demotion would linger for the life of the token.
		const after = await db.query.refreshTokens.findFirst();
		expect(after?.revokedAt).toBeInstanceOf(Date);
	});

	it("deletes a user but leaves the feedback they filed on the board", async () => {
		await callerAs(db, actorFor(member)).feedback.submit({
			kind: "bug",
			title: "Bob's report",
			body: "x",
		});

		await expect(
			callerAs(db, actorFor(admin)).user.delete({ userId: member.id }),
		).resolves.toEqual({ id: member.id });

		// `set null` rather than cascade, deliberately: a bug report is the board's, not
		// the account's, and closing an account should not quietly delete what the
		// project learned from it. It just becomes anonymous, like most of the board.
		const [item] = await callerAs(db, actorFor(admin)).feedback.list({});

		expect(item?.title).toBe("Bob's report");
		expect(item?.authorId).toBeNull();
	});
});
