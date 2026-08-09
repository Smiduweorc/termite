import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import type { PublicUser } from "../../db/schema";
import { actorFor, seedUser } from "../../test/auth";
import { callerAs, callerWithHeaders } from "../../test/context";
import { createTestDatabase } from "../../test/db";

describe("the release calendar", () => {
	let db: Database;
	let maintainer: PublicUser;
	let member: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		maintainer = await seedUser(db, { email: "root@example.com", role: "admin" });
		member = await seedUser(db, { email: "member@example.com", name: "Member" });
	});

	const admin = () => callerAs(db, actorFor(maintainer));

	it("is readable by anyone, and writable by the maintainer alone", async () => {
		await admin().release.create({ version: "0.1", name: "First light" });

		await expect(callerAs(db, null).release.list({})).resolves.toHaveLength(1);

		await expect(
			callerAs(db, actorFor(member)).release.create({ version: "9.9" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await expect(callerAs(db, null).release.create({ version: "9.9" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("refuses a version that already exists", async () => {
		await admin().release.create({ version: "0.1" });

		await expect(admin().release.create({ version: "0.1" })).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("accepts a plan with no date, because 'eventually' is a real answer", async () => {
		const release = await admin().release.create({ version: "0.3" });

		expect(release.plannedFor).toBeNull();
		expect(release.status).toBe("planned");
	});

	it("puts the next window at the top and history below it", async () => {
		const day = 24 * 60 * 60 * 1000;

		await admin().release.create({
			version: "0.1",
			plannedFor: new Date(Date.now() - 30 * day).toISOString(),
		});
		await admin().release.create({
			version: "0.2",
			plannedFor: new Date(Date.now() + 10 * day).toISOString(),
		});
		// Undated: real, but not news.
		await admin().release.create({ version: "0.3" });

		const calendar = await callerAs(db, null).release.list({});

		expect(calendar.map((release) => release.version)).toEqual(["0.2", "0.1", "0.3"]);
	});

	describe("closing a merge window", () => {
		let releaseId: string;
		let plannedItem: string;
		let declinedItem: string;

		beforeEach(async () => {
			const release = await admin().release.create({
				version: "0.2",
				status: "merge_window",
			});

			releaseId = release.id;

			const visitor = callerWithHeaders(db, { voterToken: "passer-by" }).trpc;

			const planned = await visitor.feedback.submit({
				kind: "idea",
				title: "In the window",
				body: "x",
			});
			const declined = await visitor.feedback.submit({
				kind: "idea",
				title: "Answered already",
				body: "x",
			});
			const untouched = await visitor.feedback.submit({
				kind: "bug",
				title: "Not in this one",
				body: "x",
			});

			plannedItem = planned.id;
			declinedItem = declined.id;

			await admin().feedback.edit({ id: planned.id, releaseId });
			await admin().feedback.edit({
				id: declined.id,
				releaseId,
				status: "declined",
				maintainerNote: "No.",
			});

			expect(untouched.status).toBe("open");
		});

		it("ships everything in it, in one step", async () => {
			const shipped = await admin().release.ship({ id: releaseId });

			expect(shipped.status).toBe("released");
			expect(shipped.releasedAt).not.toBeNull();
			expect(shipped.itemCount).toBe(2);

			const board = await callerAs(db, null).feedback.list({});
			const byTitle = new Map(board.map((item) => [item.title, item.status]));

			expect(byTitle.get("In the window")).toBe("shipped");
			// Declined before the window closed, and shipping it would be a lie.
			expect(byTitle.get("Answered already")).toBe("declined");
			expect(byTitle.get("Not in this one")).toBe("open");
		});

		it("will not ship the same release twice", async () => {
			await admin().release.ship({ id: releaseId });

			await expect(admin().release.ship({ id: releaseId })).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});

		it("ships the window when the status is set by hand, too", async () => {
			await admin().release.update({ id: releaseId, status: "released" });

			const item = await callerAs(db, null).feedback.byId({ id: plannedItem });

			expect(item.status).toBe("shipped");
		});

		it("is refused to everyone but the maintainer", async () => {
			await expect(
				callerAs(db, actorFor(member)).release.ship({ id: releaseId }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("cancels a plan by putting its items back on the board", async () => {
			await expect(admin().release.delete({ id: releaseId })).resolves.toEqual({
				id: releaseId,
			});

			const planned = await callerAs(db, null).feedback.byId({ id: plannedItem });
			expect(planned.status).toBe("open");
			expect(planned.releaseId).toBeNull();

			// The maintainer's answer survives the plan being dropped.
			const declined = await callerAs(db, null).feedback.byId({ id: declinedItem });
			expect(declined.status).toBe("declined");
		});

		it("will not delete a release that already shipped", async () => {
			await admin().release.ship({ id: releaseId });

			await expect(admin().release.delete({ id: releaseId })).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});
	});

	it("counts what is aimed at each window", async () => {
		const release = await admin().release.create({ version: "0.2" });
		const visitor = callerWithHeaders(db, { voterToken: "passer-by" }).trpc;

		const item = await visitor.feedback.submit({ kind: "idea", title: "One", body: "x" });
		await admin().feedback.edit({ id: item.id, releaseId: release.id });

		const [summary] = await callerAs(db, null).release.list({});

		expect(summary?.itemCount).toBe(1);
	});

	it("404s an unknown release rather than pretending", async () => {
		await expect(
			callerAs(db, null).release.byId({ id: "11111111-1111-4111-8111-111111111111" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
