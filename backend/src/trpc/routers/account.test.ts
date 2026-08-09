import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import { type PublicUser, passwordTokens, users } from "../../db/schema";
import { actorFor, seedUser } from "../../test/auth";
import { callerAs, callerWithHeaders } from "../../test/context";
import { createTestDatabase } from "../../test/db";
import { createTestMailer } from "../../test/mail";

describe("accounts", () => {
	let db: Database;
	let maintainer: PublicUser;
	let member: PublicUser;

	beforeEach(async () => {
		db = await createTestDatabase();

		maintainer = await seedUser(db, { email: "root@example.com", role: "admin" });
		member = await seedUser(db, { email: "member@example.com", name: "Member" });
	});

	describe("who may create one", () => {
		it("refuses a visitor and an ordinary account", async () => {
			await expect(
				callerAs(db, null).user.create({ email: "new@example.com", name: "New" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });

			await expect(
				callerAs(db, actorFor(member)).user.create({
					email: "new@example.com",
					name: "New",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("creates the account with no usable password and emails an invite", async () => {
			const mail = createTestMailer();
			const { trpc } = callerWithHeaders(db, { actor: actorFor(maintainer), mail });

			const created = await trpc.user.create({ email: "New@Example.com", name: "New" });

			expect(created.role).toBe("user");

			// The invite goes to the address as typed - that one is certainly
			// deliverable, whatever the canonical form works out to be.
			expect(mail.sent).toHaveLength(1);
			expect(mail.sent[0]?.to).toBe("New@Example.com");
			expect(mail.sent[0]?.subject).toContain("account");

			// Nobody, including the admin who made it, holds a password for this account:
			// the only way in is the link. Signing in is impossible until it is used.
			await expect(
				trpc.auth.login({ email: "new@example.com", password: "password123" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});

		it("can create another maintainer", async () => {
			const created = await callerAs(db, actorFor(maintainer)).user.create({
				email: "second@example.com",
				name: "Second",
				role: "admin",
			});

			expect(created.role).toBe("admin");
		});

		it("treats two spellings of one mailbox as one account", async () => {
			const admin = callerAs(db, actorFor(maintainer));

			const created = await admin.user.create({
				email: "John.Doe+termite@googlemail.com",
				name: "John",
			});

			// Kept as typed - that is where the invite is going, and what he will
			// recognise - but the identity underneath is the mailbox it reaches.
			expect(created.email).toBe("John.Doe+termite@googlemail.com");

			const stored = await db.query.users.findFirst({
				where: eq(users.id, created.id),
			});
			expect(stored?.emailCanonical).toBe("johndoe@gmail.com");

			// Gmail delivers all of these to the same inbox, so a second account for it
			// would mean two invites and two resets for one person.
			await expect(
				admin.user.create({ email: "johndoe@gmail.com", name: "John again" }),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("does not guess at plus-tags on domains it does not know", async () => {
			const admin = callerAs(db, actorFor(maintainer));

			await admin.user.create({ email: "ops@self-hosted.example", name: "Ops" });

			// On someone's own mail server "+" may be an ordinary character, and two real
			// mailboxes collapsing into one account is far worse than one person holding
			// two. Where the rules are not known facts, nothing is assumed.
			await expect(
				admin.user.create({ email: "ops+termite@self-hosted.example", name: "Ops tag" }),
			).resolves.toMatchObject({ role: "user" });
		});

		it("refuses an address that already has an account", async () => {
			await expect(
				callerAs(db, actorFor(maintainer)).user.create({
					email: member.email,
					name: "Twice",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});
	});

	describe("accepting an invite", () => {
		it("sets the password, and the link cannot be used twice", async () => {
			const mail = createTestMailer();
			const admin = callerWithHeaders(db, { actor: actorFor(maintainer), mail }).trpc;

			await admin.user.create({ email: "new@example.com", name: "New" });

			const token = mail.lastToken();
			expect(token).toBeTruthy();

			const { trpc } = callerWithHeaders(db);

			await expect(
				trpc.auth.setPassword({ token: token ?? "", password: "a-new-password" }),
			).resolves.toEqual({ ok: true });

			await expect(
				trpc.auth.login({ email: "new@example.com", password: "a-new-password" }),
			).resolves.toMatchObject({ email: "new@example.com" });

			// Single use: a forwarded mail is not a second key.
			await expect(
				trpc.auth.setPassword({ token: token ?? "", password: "another-password" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("does not sign the caller in", async () => {
			const mail = createTestMailer();
			const admin = callerWithHeaders(db, { actor: actorFor(maintainer), mail }).trpc;

			await admin.user.create({ email: "new@example.com", name: "New" });

			const { trpc, resHeaders } = callerWithHeaders(db);
			await trpc.auth.setPassword({
				token: mail.lastToken() ?? "",
				password: "a-new-password",
			});

			// Proving you can read an inbox is enough to set a password. It is not, on
			// its own, a reason to hand out a session.
			expect(resHeaders.getSetCookie()).toHaveLength(0);
		});

		it("rejects a made-up token", async () => {
			await expect(
				callerAs(db, null).auth.setPassword({
					token: "not-a-real-token",
					password: "12345678",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});

		it("rejects an expired one, and keeps rejecting it", async () => {
			const mail = createTestMailer();
			const admin = callerWithHeaders(db, { actor: actorFor(maintainer), mail }).trpc;

			await admin.user.create({ email: "new@example.com", name: "New" });

			// Reach past the service and age the link, rather than waiting seven days.
			await db.update(passwordTokens).set({ expiresAt: new Date(Date.now() - 1000) });

			const expired = { token: mail.lastToken() ?? "", password: "a-new-password" };

			await expect(callerAs(db, null).auth.setPassword(expired)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});

			// Claim and password write are one transaction, so a refused attempt leaves
			// nothing behind - and the expiry is what makes the link dead, so trying it
			// again gets the same answer rather than a second chance.
			await expect(callerAs(db, null).auth.setPassword(expired)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});

			await expect(
				callerAs(db, null).auth.login({
					email: "new@example.com",
					password: "a-new-password",
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});

		it("re-sends an invite and burns the old link", async () => {
			const mail = createTestMailer();
			const admin = callerWithHeaders(db, { actor: actorFor(maintainer), mail }).trpc;

			const created = await admin.user.create({ email: "new@example.com", name: "New" });
			const firstToken = mail.lastToken();

			await admin.user.resendInvite({ userId: created.id });
			const secondToken = mail.lastToken();

			expect(secondToken).not.toBe(firstToken);

			// Two live links would be two live keys, and the second one usually exists
			// because the first went astray.
			await expect(
				callerAs(db, null).auth.setPassword({
					token: firstToken ?? "",
					password: "a-new-password",
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });

			await expect(
				callerAs(db, null).auth.setPassword({
					token: secondToken ?? "",
					password: "a-new-password",
				}),
			).resolves.toEqual({ ok: true });
		});
	});

	describe("forgotten passwords", () => {
		it("answers the same whether or not the address has an account", async () => {
			const known = createTestMailer();
			const unknown = createTestMailer();

			await expect(
				callerWithHeaders(db, { mail: known }).trpc.auth.forgotPassword({
					email: member.email,
				}),
			).resolves.toEqual({ ok: true });

			await expect(
				callerWithHeaders(db, { mail: unknown }).trpc.auth.forgotPassword({
					email: "ghost@example.com",
				}),
			).resolves.toEqual({ ok: true });

			// The reply is identical either way; only the inbox differs, and only the
			// person who owns it can see that.
			expect(known.sent).toHaveLength(1);
			expect(unknown.sent).toHaveLength(0);
		});

		it("resets the password and signs the old sessions out", async () => {
			const mail = createTestMailer();

			// A live session, of the kind a thief would be holding.
			const session = callerWithHeaders(db);
			await session.trpc.auth.login({ email: member.email, password: "password123" });

			const refreshToken =
				session.resHeaders
					.getSetCookie()
					.find((cookie) => cookie.startsWith("refresh_token="))
					?.split(";")[0]
					?.split("=")[1] ?? "";

			await callerWithHeaders(db, { mail }).trpc.auth.forgotPassword({ email: member.email });

			await callerAs(db, null).auth.setPassword({
				token: mail.lastToken() ?? "",
				password: "brand-new-password",
			});

			await expect(
				callerAs(db, null).auth.login({
					email: member.email,
					password: "brand-new-password",
				}),
			).resolves.toMatchObject({ email: member.email });

			// The old password is gone...
			await expect(
				callerAs(db, null).auth.login({ email: member.email, password: "password123" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });

			// ...and so is the session that was open when it changed. This is the half
			// that actually evicts whoever took the account.
			await expect(
				callerWithHeaders(db, { refreshToken }).trpc.auth.refresh(),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});

		it("stores the link only as a hash", async () => {
			const mail = createTestMailer();

			await callerWithHeaders(db, { mail }).trpc.auth.forgotPassword({ email: member.email });

			const stored = await db.query.passwordTokens.findFirst();
			const token = mail.lastToken() ?? "";

			// Whoever reads this table cannot use what they find there.
			expect(stored?.tokenHash).not.toBe(token);
			expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
			expect(stored?.purpose).toBe("reset");
		});
	});
});
