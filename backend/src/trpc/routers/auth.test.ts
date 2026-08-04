import { unsafeDecode } from "lacewing";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../db";
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from "../../lib/cookies";
import { verifyAccessToken } from "../../lib/jwt";
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

const ALICE = { email: "alice@example.com", name: "Alice", password: "password123" };

describe("auth", () => {
	let db: Database;

	beforeEach(async () => {
		db = await createTestDatabase();
	});

	it("registers a user, sets httpOnly cookies, and never returns the hash", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		const user = await trpc.auth.register({ ...ALICE, email: "Alice@Example.com" });

		// Email is normalised, so Alice@ and alice@ are the same account.
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

		const user = await trpc.auth.register(ALICE);

		const token = cookiesFrom(resHeaders)[ACCESS_COOKIE];
		const payload = await verifyAccessToken(token ?? "");

		expect(payload).toMatchObject({ sub: user.id, email: "alice@example.com", role: "user" });
	});

	it("mints RFC 9068 access tokens: typ at+jwt, pinned iss/aud, unique jti", async () => {
		const { trpc, resHeaders } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

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

	it("cannot be tricked into registering an admin", async () => {
		const { trpc } = callerWithHeaders(db);

		// The extra field is not in the schema, so it never reaches the insert.
		const user = await trpc.auth.register({
			...ALICE,
			email: "sneaky@example.com",
			role: "admin",
		} as never);

		expect(user.role).toBe("user");
	});

	it("refuses a duplicate email", async () => {
		const { trpc } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

		await expect(trpc.auth.register(ALICE)).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("refuses a duplicate even when two registrations race", async () => {
		const { trpc } = callerWithHeaders(db);

		// There is no "is this taken?" check to lose the race against - the UNIQUE index
		// decides, and the loser is translated into a CONFLICT rather than blowing up as
		// an unhandled 500.
		const results = await Promise.allSettled([
			trpc.auth.register(ALICE),
			trpc.auth.register(ALICE),
			trpc.auth.register(ALICE),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(2);

		for (const failure of rejected) {
			expect(failure.reason).toMatchObject({ code: "CONFLICT" });
		}
	});

	it("gives the same error for a wrong password and an unknown email", async () => {
		const { trpc } = callerWithHeaders(db);

		await trpc.auth.register(ALICE);

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

		await trpc.auth.register(ALICE);

		await expect(
			trpc.auth.login({ email: "alice@example.com", password: "password123" }),
		).resolves.toMatchObject({ email: "alice@example.com" });
	});

	it("rotates the refresh token, and the old one stops working", async () => {
		const registration = callerWithHeaders(db);
		await registration.trpc.auth.register(ALICE);

		const firstToken = cookiesFrom(registration.resHeaders)[REFRESH_COOKIE];
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
		const registration = callerWithHeaders(db);
		await registration.trpc.auth.register(ALICE);

		const token = cookiesFrom(registration.resHeaders)[REFRESH_COOKIE];

		const session = callerWithHeaders(db, { refreshToken: token });
		await session.trpc.auth.logout();

		// Cookies are expired, not merely forgotten by the client.
		const cleared = session.resHeaders.getSetCookie();
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
