import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createDatabase, type Database } from "./db";
import { ACCESS_COOKIE, CSRF_COOKIE } from "./lib/cookies";
import { seedUser } from "./test/auth";
import { createTestDatabase } from "./test/db";
import { createTestMailer } from "./test/mail";

/**
 * The full HTTP path through Elysia with `app.handle()` - no port is bound. This is what
 * proves the browser's story works end to end: log in, get an httpOnly cookie back, and
 * have the next request authenticate with it.
 */
describe("app over http", () => {
	let app: ReturnType<typeof createApp>;
	let db: Database;

	beforeEach(async () => {
		db = await createTestDatabase();
		app = createApp({ db, mail: createTestMailer() });
	});

	function trpc(
		procedure: string,
		body?: unknown,
		cookie?: string,
		csrfHeader?: string,
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };

		if (cookie) headers.cookie = cookie;
		if (csrfHeader) headers["x-csrf-token"] = csrfHeader;

		return app.handle(
			new Request(`http://localhost/trpc/${procedure}`, {
				method: body === undefined ? "GET" : "POST",
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
	}

	interface BrowserSession {
		/** What a browser would send back on the next request. */
		cookie: string;
		/** What the page reads from the csrf_token cookie and echoes as a header. */
		csrfToken: string;
	}

	/**
	 * Signs in over real HTTP. There is no registration to do it with any more, so the
	 * account is seeded straight into the database - which is what an invite would have
	 * produced anyway (see account.test.ts for that path).
	 */
	async function signInAsAlice(): Promise<BrowserSession> {
		await seedUser(db, { email: "alice@example.com", name: "Alice" });

		const response = await trpc("auth.login", {
			email: "alice@example.com",
			password: "password123",
		});

		expect(response.status).toBe(200);

		const setCookies = response.headers.getSetCookie();
		const pairs = setCookies.map((cookie) => cookie.split(";")[0] ?? "");

		expect(pairs.some((pair) => pair.startsWith(`${ACCESS_COOKIE}=`))).toBe(true);

		const csrfToken =
			pairs
				.find((pair) => pair.startsWith(`${CSRF_COOKIE}=`))
				?.slice(CSRF_COOKIE.length + 1) ?? "";

		expect(csrfToken).not.toBe("");

		return { cookie: pairs.join("; "), csrfToken };
	}

	it("serves the REST health route", async () => {
		const response = await app.handle(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: "ok" });
	});

	it("serves a tRPC query over HTTP", async () => {
		const response = await trpc("health.ping");

		expect(response.status).toBe(200);

		const body = (await response.json()) as { result: { data: { status: string } } };
		expect(body.result.data.status).toBe("ok");
	});

	it("rejects a protected mutation with no cookie", async () => {
		// This is also the mutation that proves Elysia handed tRPC an intact request body
		// rather than consuming it - a 401 means it parsed, a 500 would mean it did not.
		const response = await trpc("feedback.edit", {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Nope",
		});

		expect(response.status).toBe(401);

		const body = (await response.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("UNAUTHORIZED");
	});

	it("authenticates the next request with the cookie it just set", async () => {
		const session = await signInAsAlice();

		const created = await trpc(
			"feedback.submit",
			{ kind: "bug", title: "With cookie", body: "x" },
			session.cookie,
			session.csrfToken,
		);
		expect(created.status).toBe(200);

		// Anyone can file anonymously, so a 200 alone proves nothing about the session.
		// The author id does: it comes from the cookie, and an anonymous submission
		// would have left it null.
		const body = (await created.json()) as {
			result: { data: { title: string; authorId: string | null } };
		};
		expect(body.result.data.title).toBe("With cookie");
		expect(body.result.data.authorId).not.toBeNull();
	});

	it("refuses a cookie-authenticated mutation without the CSRF header", async () => {
		// This is the cross-site request: the browser attached the cookies on
		// its own, but the page could not read csrf_token to set the header.
		const session = await signInAsAlice();

		const response = await trpc(
			"feedback.submit",
			{ kind: "idea", title: "Riding the session", body: "x" },
			session.cookie,
		);

		expect(response.status).toBe(403);

		const body = (await response.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("FORBIDDEN");
	});

	it("refuses a mutation when a second csrf_token cookie shadows the real one", async () => {
		// Cookie tossing. Double-submit rests on the attacker not being able to
		// read csrf_token - but an attacker who can *write* a cookie on this
		// domain (a subdomain they hold, a cookie-injection bug) does not need to
		// read it. They append a second csrf_token whose value they chose, then
		// echo that value in the header. Both copies ride along:
		//
		//   Cookie: csrf_token=<real>; csrf_token=<attacker's>
		//
		// Nothing decides which one a server takes, so a parser that returns one
		// is guessing, and on the wrong guess the header matches and the check
		// passes. lacewing's readTokenCookie refuses a duplicated name instead,
		// so the pair never gets compared and the mutation is denied.
		//
		// The attacker's copy is sent *first* here, which is the whole craft of
		// the attack rather than a detail of the test: browsers order cookies by
		// path specificity, so one set on a deeper path (/trpc) precedes the
		// legitimate /-scoped one. A first-match parser - which is what `cookie`
		// does - hands back exactly the value the attacker planted.
		const session = await signInAsAlice();
		const attackerToken = "attackerchosencsrfvalue";

		const response = await trpc(
			"feedback.submit",
			{ kind: "idea", title: "Tossed", body: "x" },
			`${CSRF_COOKIE}=${attackerToken}; ${session.cookie}`,
			attackerToken,
		);

		expect(response.status).toBe(403);

		const body = (await response.json()) as { error: { data: { code: string } } };
		expect(body.error.data.code).toBe("FORBIDDEN");
	});

	it("refuses a tampered cookie", async () => {
		const session = await signInAsAlice();

		// Corrupt the access token specifically; the other cookies come along
		// unchanged, as they would in a real browser.
		const tampered = session.cookie.replace(
			new RegExp(`${ACCESS_COOKIE}=([^;]+)`),
			(_, token: string) => `${ACCESS_COOKIE}=${token.slice(0, -3)}aaa`,
		);

		const response = await trpc(
			"feedback.edit",
			{ id: "11111111-1111-4111-8111-111111111111", title: "Nope" },
			tampered,
			session.csrfToken,
		);

		expect(response.status).toBe(401);
	});

	it("gives an anonymous voter a cookie, then holds them to CSRF", async () => {
		// The whole no-account path, over real HTTP. Nobody signs in at any point.
		const filed = await trpc("feedback.submit", {
			kind: "bug",
			title: "Filed by a stranger",
			body: "No account, no email, no signup form.",
		});

		expect(filed.status).toBe(200);

		const body = (await filed.json()) as {
			result: { data: { id: string; votes: number; viewerHasVoted: boolean } };
		};

		// Filing counts as wanting the thing.
		expect(body.result.data.votes).toBe(1);
		expect(body.result.data.viewerHasVoted).toBe(true);

		const pairs = filed.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "");
		const cookie = pairs.join("; ");

		expect(pairs.some((pair) => pair.startsWith("termite_voter="))).toBe(true);

		const csrfToken =
			pairs
				.find((pair) => pair.startsWith(`${CSRF_COOKIE}=`))
				?.slice(CSRF_COOKIE.length + 1) ?? "";

		expect(csrfToken).not.toBe("");

		// That first request was the one and only one that could skip the CSRF check -
		// there was nothing to double-submit yet. Now that the browser holds the pair,
		// a mutation that cannot echo it is refused, session or no session.
		const forged = await trpc("feedback.unvote", { id: body.result.data.id }, cookie);
		expect(forged.status).toBe(403);

		const honest = await trpc(
			"feedback.unvote",
			{ id: body.result.data.id },
			cookie,
			csrfToken,
		);
		expect(honest.status).toBe(200);

		const after = (await honest.json()) as { result: { data: { votes: number } } };
		expect(after.result.data.votes).toBe(0);
	});

	it("echoes an inbound x-request-id, so a trace survives the hop", async () => {
		const response = await app.handle(
			new Request("http://localhost/trpc/health.ping", {
				headers: { "x-request-id": "from-the-gateway" },
			}),
		);

		expect(response.headers.get("x-request-id")).toBe("from-the-gateway");
	});

	it("never leaks internals when a query blows up", async () => {
		// A database that is not there. The driver throws a real error deep inside a
		// procedure, which is exactly the case that used to hand the client the failing
		// SQL, its parameters and a stack trace.
		const { db: missing } = createDatabase("postgres://nobody:hunter2@127.0.0.1:59999/nope");
		const broken = createApp({ db: missing, mail: createTestMailer() });

		const response = await broken.handle(
			new Request("http://localhost/trpc/auth.login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
			}),
		);

		expect(response.status).toBe(500);

		const raw = await response.text();
		const body = JSON.parse(raw) as {
			error: { message: string; data: { code: string; requestId?: string; stack?: string } };
		};

		expect(body.error.data.code).toBe("INTERNAL_SERVER_ERROR");
		expect(body.error.message).toBe("Internal server error");

		// Nothing about the query, the connection, the credentials, or where it broke.
		expect(body.error.data.stack).toBeUndefined();
		expect(raw).not.toMatch(/select|insert into|password|hunter2|59999|\.ts:\d+/i);

		// But the caller does get an id they can quote, which ties to the full server log.
		expect(body.error.data.requestId).toEqual(expect.any(String));
	});
});
