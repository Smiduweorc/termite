import { unsafeDecode } from "lacewing";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from "../../lib/cookies";
import { verifyAccessToken } from "../../lib/jwt";
import { seedUser } from "../../test/auth";
import { callerWithHeaders } from "../../test/context";
import { createTestDatabase } from "../../test/db";

function cookiesFrom(headers: Headers): Record<string, string> {
	return Object.fromEntries(
		headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0]?.split("=") ?? [])
			.map(([name, value]) => [name ?? "", value ?? ""]),
	);
}

const CREDENTIALS = { email: "alice@example.com", password: "password123" };

describe("auth", () => {
	let db: Database;

	beforeEach(async () => {
		db = await createTestDatabase();

		// Seeded rather than registered: there is no registration. Accounts come from a
		// maintainer, and the invite that activates them is covered in account.test.ts.
		await seedUser(db, { email: "alice@example.com", name: "Alice" });
	});

	it("has no register procedure at all", () => {
		const { trpc } = callerWithHeaders(db);

		// Not merely guarded - absent. There is no self-service path to an account, so
		// there is no endpoint to find, rate-limit or forget to lock down later.
		expect("register" in trpc.auth).toBe(false);
	});

	it("signs in, sets httpOnly cookies, and never returns the hash", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		// Email is normalised, so Alice@ and alice@ are the same account.
		const user = await trpc.auth.login({ ...CREDENTIALS, email: "Alice@Example.com" });

		expect(user.email).toBe("alice@example.com");
		expect(user.role).toBe("user");
		expect(user).not.toHaveProperty("passwordHash");

		const setCookies = resHeaders.getSetCookie();
		expect(setCookies.some((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toBe(true);
		expect(setCookies.some((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);

		// The whole point: script in the page cannot read the token cookies
		// (lacewing's buildTokenCookie cannot even express anything weaker) -
		// while the CSRF cookie alone must be readable, or the page could
		// never echo it back as a header.
		const tokenCookies = setCookies.filter((c) => !c.startsWith(`${CSRF_COOKIE}=`));
		const csrfCookie = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
		expect(tokenCookies.every((c) => c.includes("HttpOnly"))).toBe(true);
		expect(tokenCookies.every((c) => c.includes("Secure"))).toBe(true);
		expect(csrfCookie).toBeDefined();
		expect(csrfCookie).not.toContain("HttpOnly");

		// The tokens are in the cookies, not in the response body.
		expect(user).not.toHaveProperty("accessToken");
	});

	it("issues an access token that carries the user's id and role", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		const user = await trpc.auth.login(CREDENTIALS);

		const token = cookiesFrom(resHeaders)[ACCESS_COOKIE];
		const payload = await verifyAccessToken(token ?? "");

		expect(payload).toMatchObject({ sub: user.id, email: "alice@example.com", role: "user" });
	});

	it("mints RFC 9068 access tokens: typ at+jwt, pinned iss/aud, unique jti", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		await trpc.auth.login(CREDENTIALS);

		// unsafeDecode is lacewing's inspection hatch: it parses without
		// verifying and returns an UntrustedJwt that the type system refuses
		// wherever a VerifiedJwt is required - fine for a test's assertions,
		// useless for auth logic. Every one of these claims is enforced, not
		// decorative: verification rejects a token missing any of them.
		const token = cookiesFrom(resHeaders)[ACCESS_COOKIE];
		const decoded = unsafeDecode(token ?? "");

		expect(decoded.header.typ).toBe("at+jwt");
		expect(decoded.payload.iss).toBe("http://localhost:3000");
		expect(decoded.payload.aud).toBe("http://localhost:3000/trpc");
		expect(decoded.payload.jti).toEqual(expect.any(String));
	});

	it("gives the same error for a wrong password and an unknown email", async () => {
		const { trpc } = callerWithHeaders(db);

		// Identical, so login cannot be used to discover which emails have accounts.
		// (Each call is asserted where it is made: holding a rejected promise around for
		// later reads to vitest as an unhandled rejection.)
		await expect(
			trpc.auth.login({ email: "alice@example.com", password: "nope12345" }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Invalid email or password",
		});

		await expect(
			trpc.auth.login({ email: "ghost@example.com", password: "password123" }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Invalid email or password",
		});
	});

	it("logs in with the right password", async () => {
		const { trpc } = callerWithHeaders(db);

		await expect(trpc.auth.login(CREDENTIALS)).resolves.toMatchObject({
			email: "alice@example.com",
		});
	});

	it("finds the account from any spelling that reaches the same mailbox", async () => {
		await seedUser(db, { email: "John.Doe@gmail.com", name: "John" });

		// Gmail ignores dots and everything after a "+", so all three of these are one
		// inbox and therefore one account. See lib/email.ts.
		for (const email of ["johndoe@gmail.com", "j.o.h.n.doe@gmail.com", "johndoe+x@gmail.com"]) {
			await expect(
				callerWithHeaders(db).trpc.auth.login({ email, password: "password123" }),
			).resolves.toMatchObject({ email: "John.Doe@gmail.com" });
		}
	});

	it("rotates the refresh token, and the old one stops working", async () => {
		const session = callerWithHeaders(db);
		await session.trpc.auth.login(CREDENTIALS);

		const firstToken = cookiesFrom(session.resHeaders)[REFRESH_COOKIE];
		expect(firstToken).toBeTruthy();

		const first = callerWithHeaders(db, { refreshToken: firstToken });
		await first.trpc.auth.refresh();

		const secondToken = cookiesFrom(first.resHeaders)[REFRESH_COOKIE];
		expect(secondToken).toBeTruthy();
		expect(secondToken).not.toBe(firstToken);

		// Replaying the old token - what a thief would have - is dead on arrival.
		const replay = callerWithHeaders(db, { refreshToken: firstToken });
		await expect(replay.trpc.auth.refresh()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		// The new one still works.
		const third = callerWithHeaders(db, { refreshToken: secondToken });
		await expect(third.trpc.auth.refresh()).resolves.toMatchObject({
			email: "alice@example.com",
		});
	});

	it("revokes the refresh token on logout and clears the cookies", async () => {
		const session = callerWithHeaders(db);
		await session.trpc.auth.login(CREDENTIALS);

		const token = cookiesFrom(session.resHeaders)[REFRESH_COOKIE];

		const out = callerWithHeaders(db, { refreshToken: token });
		await out.trpc.auth.logout();

		// Cookies are expired, not merely forgotten by the client.
		const cleared = out.resHeaders.getSetCookie();
		expect(cleared.every((c) => c.includes("Max-Age=0"))).toBe(true);

		const stored = await db.query.refreshTokens.findFirst();
		expect(stored?.revokedAt).toBeInstanceOf(Date);

		await expect(
			callerWithHeaders(db, { refreshToken: token }).trpc.auth.refresh(),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects auth.me without a session", async () => {
		await expect(callerWithHeaders(db).trpc.auth.me()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
