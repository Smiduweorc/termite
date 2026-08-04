import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import type { PublicUser } from "../../db/schema";
import { actorFor, seedUser } from "../../test/auth";
import { callerAs } from "../../test/context";
import { createTestDatabase } from "../../test/db";

describe("post authorization", () => {
	let db: Database;
	let alice: PublicUser;
	let bob: PublicUser;
	let admin: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		alice = await seedUser(db, { email: "alice@example.com", name: "Alice" });
		bob = await seedUser(db, { email: "bob@example.com", name: "Bob" });
		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });
	});

	it("refuses to create a post for an anonymous caller", async () => {
		const anon = callerAs(db, null);

		await expect(anon.post.create({ title: "Nope", body: "x" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("takes the author from the token, not from the request", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({ title: "Mine", body: "x" });

		expect(post.authorId).toBe(alice.id);
	});

	it("hides other people's drafts but shows your own", async () => {
		await callerAs(db, actorFor(alice)).post.create({ title: "Alice draft", body: "x" });
		await callerAs(db, actorFor(bob)).post.create({
			title: "Bob published",
			body: "y",
			published: true,
		});

		const anonSees = await callerAs(db, null).post.list({});
		expect(anonSees.map((p) => p.title)).toEqual(["Bob published"]);

		const bobSees = await callerAs(db, actorFor(bob)).post.list({});
		expect(bobSees.map((p) => p.title)).toEqual(["Bob published"]);

		const aliceSees = await callerAs(db, actorFor(alice)).post.list({});
		expect(aliceSees.map((p) => p.title).sort()).toEqual(["Alice draft", "Bob published"]);

		const adminSees = await callerAs(db, actorFor(admin)).post.list({});
		expect(adminSees).toHaveLength(2);
	});

	it("reports someone else's draft as NOT_FOUND, not FORBIDDEN", async () => {
		const draft = await callerAs(db, actorFor(alice)).post.create({
			title: "Secret",
			body: "x",
		});

		// FORBIDDEN would confirm the post exists. That is itself a leak.
		await expect(callerAs(db, actorFor(bob)).post.byId({ id: draft.id })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);

		await expect(
			callerAs(db, actorFor(admin)).post.byId({ id: draft.id }),
		).resolves.toMatchObject({ title: "Secret" });
	});

	it("stops one user editing another's post", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({
			title: "Alice's",
			body: "x",
			published: true,
		});

		await expect(
			callerAs(db, actorFor(bob)).post.update({ id: post.id, title: "Hijacked" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await expect(
			callerAs(db, actorFor(bob)).post.delete({ id: post.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// Untouched.
		await expect(
			callerAs(db, actorFor(alice)).post.byId({ id: post.id }),
		).resolves.toMatchObject({
			title: "Alice's",
		});
	});

	it("lets the author edit their own post", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({ title: "Draft", body: "x" });

		const updated = await callerAs(db, actorFor(alice)).post.update({
			id: post.id,
			title: "Better",
		});

		expect(updated.title).toBe("Better");
	});

	it("lets an admin edit and delete anyone's post", async () => {
		const post = await callerAs(db, actorFor(alice)).post.create({
			title: "Alice's",
			body: "x",
			published: true,
		});

		const updated = await callerAs(db, actorFor(admin)).post.update({
			id: post.id,
			published: false,
		});
		expect(updated.published).toBe(false);

		await expect(callerAs(db, actorFor(admin)).post.delete({ id: post.id })).resolves.toEqual({
			id: post.id,
		});
	});

	it("still validates input", async () => {
		await expect(
			callerAs(db, actorFor(alice)).post.create({ title: "", body: "x" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
