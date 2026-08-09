import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import type { PublicUser } from "../../db/schema";
import { voteForFeedback } from "../../services/feedback.service";
import { actorFor, seedUser } from "../../test/auth";
import { callerAs, callerWithHeaders } from "../../test/context";
import { createTestDatabase } from "../../test/db";

/** An anonymous visitor whose browser is holding a voter cookie. */
const visitor = (db: Database, voterToken: string) => callerWithHeaders(db, { voterToken }).trpc;

describe("the board", () => {
	let db: Database;
	let maintainer: PublicUser;
	let member: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		maintainer = await seedUser(db, { email: "root@example.com", role: "admin" });
		member = await seedUser(db, { email: "member@example.com", name: "Member" });
	});

	describe("filing", () => {
		it("takes a report from someone with no account at all", async () => {
			const item = await visitor(db, "first-timer").feedback.submit({
				kind: "bug",
				title: "Crashes on an empty board",
				body: "Fresh install, no items, blank page.",
				authorName: "passer-by",
			});

			expect(item.authorId).toBeNull();
			expect(item.authorName).toBe("passer-by");
			expect(item.status).toBe("open");

			// Filing is itself a vote: you obviously want the thing you just asked for.
			expect(item.votes).toBe(1);
			expect(item.viewerHasVoted).toBe(true);
		});

		it("records a signed-in submitter, and ignores any name they typed", async () => {
			const item = await callerAs(db, actorFor(member)).feedback.submit({
				kind: "idea",
				title: "Signed in",
				body: "x",
				authorName: "not-my-real-name",
			});

			expect(item.authorId).toBe(member.id);
			// Their account already names them; a second, unverified name would only be
			// a way to sign someone else's name to a request.
			expect(item.authorName).toBeNull();
		});

		it("still validates what it is handed", async () => {
			await expect(
				visitor(db, "spammer").feedback.submit({ kind: "bug", title: "", body: "x" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});
	});

	describe("voting", () => {
		let itemId: string;

		beforeEach(async () => {
			const item = await visitor(db, "author").feedback.submit({
				kind: "idea",
				title: "Something worth wanting",
				body: "x",
			});

			itemId = item.id;
		});

		it("counts one vote per voter, however many times they click", async () => {
			const voter = visitor(db, "keen");

			await voter.feedback.vote({ id: itemId });
			const after = await voter.feedback.vote({ id: itemId });

			// The submitter's vote plus this one. The second click changed nothing -
			// the UNIQUE index absorbed it rather than throwing.
			expect(after.votes).toBe(2);
			expect(after.viewerHasVoted).toBe(true);
		});

		it("counts different visitors separately", async () => {
			await visitor(db, "one").feedback.vote({ id: itemId });
			const item = await visitor(db, "two").feedback.vote({ id: itemId });

			expect(item.votes).toBe(3);
		});

		it("lets a voter take it back", async () => {
			const voter = visitor(db, "changed-my-mind");

			await voter.feedback.vote({ id: itemId });
			const after = await voter.feedback.unvote({ id: itemId });

			expect(after.votes).toBe(1);
			expect(after.viewerHasVoted).toBe(false);
		});

		it("shows the tally to everyone but 'you voted' only to the voter", async () => {
			await visitor(db, "one").feedback.vote({ id: itemId });

			const asStranger = await visitor(db, "stranger").feedback.byId({ id: itemId });

			expect(asStranger.votes).toBe(2);
			expect(asStranger.viewerHasVoted).toBe(false);
		});

		it("counts a signed-in person as their account, not their browser", async () => {
			// Same browser cookie, two different sessions: the votes do not merge, and
			// the account's vote follows them to another machine. See lib/voter.ts.
			const inBrowser = callerWithHeaders(db, {
				actor: actorFor(member),
				voterToken: "shared-browser",
			}).trpc;

			await inBrowser.feedback.vote({ id: itemId });

			const anonymously = await visitor(db, "shared-browser").feedback.byId({ id: itemId });

			expect(anonymously.votes).toBe(2);
			expect(anonymously.viewerHasVoted).toBe(false);
		});

		it("mints a voter for a first-timer instead of dropping their vote", async () => {
			// No session, no cookie: the click still has to count, so the router hands
			// them an identity on the way through and sets it on the response.
			const { trpc, resHeaders } = callerWithHeaders(db);

			const after = await trpc.feedback.vote({ id: itemId });

			expect(after.votes).toBe(2);
			expect(resHeaders.getSetCookie().some((c) => c.startsWith("termite_voter="))).toBe(
				true,
			);
		});

		it("refuses a vote it cannot attribute to anyone", async () => {
			// The service's own rule, reached over gRPC: no cookies out there, so an
			// anonymous caller has no voter identity and no vote to cast. Over HTTP the
			// router mints one first, which is the test above.
			await expect(voteForFeedback(db, null, { id: itemId })).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("404s a vote for something that is not there", async () => {
			await expect(
				visitor(db, "one").feedback.vote({ id: "11111111-1111-4111-8111-111111111111" }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	describe("reading", () => {
		beforeEach(async () => {
			const quiet = await visitor(db, "a").feedback.submit({
				kind: "bug",
				title: "Quiet",
				body: "x",
			});
			const loud = await visitor(db, "b").feedback.submit({
				kind: "idea",
				title: "Loud",
				body: "x",
			});

			for (const voter of ["c", "d", "e"]) {
				await visitor(db, voter).feedback.vote({ id: loud.id });
			}

			expect(quiet.votes).toBe(1);
		});

		it("sorts by hands raised, not by who shouted last", async () => {
			const board = await visitor(db, "reader").feedback.list({});

			expect(board.map((item) => item.title)).toEqual(["Loud", "Quiet"]);
			expect(board[0]?.votes).toBe(4);
		});

		it("can show the firehose instead", async () => {
			const board = await visitor(db, "reader").feedback.list({ sort: "new" });

			expect(board.map((item) => item.title)).toEqual(["Loud", "Quiet"]);
		});

		it("filters by kind", async () => {
			const bugs = await visitor(db, "reader").feedback.list({ kind: "bug" });

			expect(bugs.map((item) => item.title)).toEqual(["Quiet"]);
		});

		it("is readable by someone who has never voted or signed in", async () => {
			const board = await callerAs(db, null).feedback.list({});

			expect(board).toHaveLength(2);
			expect(board.every((item) => item.viewerHasVoted === false)).toBe(true);
		});
	});

	describe("triage", () => {
		let itemId: string;

		beforeEach(async () => {
			const item = await callerAs(db, actorFor(member)).feedback.submit({
				kind: "idea",
				title: "Mine",
				body: "x",
			});

			itemId = item.id;
		});

		it("lets an author fix their own wording", async () => {
			const edited = await callerAs(db, actorFor(member)).feedback.edit({
				id: itemId,
				title: "Mine, better put",
			});

			expect(edited.title).toBe("Mine, better put");
		});

		it("does not let an author decide their own request is planned", async () => {
			await expect(
				callerAs(db, actorFor(member)).feedback.edit({ id: itemId, status: "planned" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("does not let one person edit another's item", async () => {
			const other = await seedUser(db, { email: "other@example.com" });

			await expect(
				callerAs(db, actorFor(other)).feedback.edit({ id: itemId, title: "Hijacked" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("leaves anonymous submissions to the maintainer alone", async () => {
			const anonymous = await visitor(db, "passer-by").feedback.submit({
				kind: "bug",
				title: "Anonymous",
				body: "x",
			});

			// Nobody can prove they filed it, so nobody but the maintainer may touch it.
			await expect(
				callerAs(db, actorFor(member)).feedback.edit({
					id: anonymous.id,
					title: "Mine now",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });

			await expect(
				callerAs(db, actorFor(maintainer)).feedback.edit({
					id: anonymous.id,
					title: "Retitled by the maintainer",
				}),
			).resolves.toMatchObject({ title: "Retitled by the maintainer" });
		});

		it("plans an item by putting it in a merge window, and unplans it by taking it out", async () => {
			const admin = callerAs(db, actorFor(maintainer));

			const release = await admin.release.create({ version: "0.2" });

			const planned = await admin.feedback.edit({ id: itemId, releaseId: release.id });
			expect(planned.status).toBe("planned");
			expect(planned.releaseId).toBe(release.id);

			const unplanned = await admin.feedback.edit({ id: itemId, releaseId: null });
			expect(unplanned.status).toBe("open");
			expect(unplanned.releaseId).toBeNull();
		});

		it("refuses to aim an item at a release that does not exist", async () => {
			await expect(
				callerAs(db, actorFor(maintainer)).feedback.edit({
					id: itemId,
					releaseId: "11111111-1111-4111-8111-111111111111",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("declines with a reason, and the item stays on the board saying so", async () => {
			const declined = await callerAs(db, actorFor(maintainer)).feedback.edit({
				id: itemId,
				status: "declined",
				maintainerNote: "Not what this is for.",
			});

			expect(declined.status).toBe("declined");
			expect(declined.maintainerNote).toBe("Not what this is for.");

			const board = await visitor(db, "reader").feedback.list({ status: "declined" });
			expect(board).toHaveLength(1);
		});

		it("lets an author delete their own item, and the maintainer delete anyone's", async () => {
			const other = await seedUser(db, { email: "other@example.com" });

			await expect(
				callerAs(db, actorFor(other)).feedback.delete({ id: itemId }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });

			await expect(
				callerAs(db, actorFor(maintainer)).feedback.delete({ id: itemId }),
			).resolves.toEqual({ id: itemId });
		});

		it("takes the votes with a deleted item rather than orphaning them", async () => {
			await visitor(db, "voter").feedback.vote({ id: itemId });

			await callerAs(db, actorFor(maintainer)).feedback.delete({ id: itemId });

			expect(await db.query.votes.findMany()).toHaveLength(0);
		});

		it("refuses an edit from someone who is not signed in at all", async () => {
			await expect(
				visitor(db, "passer-by").feedback.edit({ id: itemId, title: "x" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});
	});
});
