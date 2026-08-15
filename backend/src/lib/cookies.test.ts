import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_COOKIE } from "./cookies";

/**
 * COOKIE_DOMAIN is read once, when config/env.ts is first imported, so a test that wants
 * a different value has to reset the module graph and import again rather than reach into
 * a live object. Hence the dynamic imports below.
 */
async function cookiesWith(domain: string | undefined) {
	vi.resetModules();

	if (domain === undefined) vi.stubEnv("COOKIE_DOMAIN", "");
	else vi.stubEnv("COOKIE_DOMAIN", domain);

	return import("./cookies");
}

function csrfFrom(headers: string[]): string {
	const found = headers.find((header) => header.startsWith(`${CSRF_COOKIE}=`));

	if (!found) throw new Error(`no ${CSRF_COOKIE} in ${JSON.stringify(headers)}`);

	return found;
}

describe("the CSRF cookie's Domain", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("is absent by default, leaving the cookie host-only", async () => {
		const { sessionCookies } = await cookiesWith(undefined);

		expect(csrfFrom(sessionCookies("access", "refresh", "csrf"))).not.toContain("Domain");
	});

	/**
	 * The reason this option exists: script on board.example.com cannot read a cookie
	 * scoped to api.example.com, so without a Domain it has no token to echo and every
	 * mutation is refused.
	 */
	it("scopes the cookie to the parent domain when one is configured", async () => {
		const { sessionCookies } = await cookiesWith("example.com");
		const cookie = csrfFrom(sessionCookies("access", "refresh", "csrf"));

		expect(cookie).toContain("Domain=example.com");
		expect(cookie).toContain("Secure");
		// Still readable by the page - widening it would be pointless otherwise.
		expect(cookie).not.toContain("HttpOnly");
	});

	it("leaves the session cookies host-only, which is the point of doing only this one", async () => {
		const { sessionCookies } = await cookiesWith("example.com");
		const tokens = sessionCookies("access", "refresh", "csrf").filter(
			(header) => !header.startsWith(`${CSRF_COOKIE}=`),
		);

		expect(tokens).toHaveLength(2);
		for (const cookie of tokens) expect(cookie).not.toContain("Domain");
	});

	it("clears with the same Domain it set, or the browser would keep the cookie", async () => {
		const { clearedCookies } = await cookiesWith("example.com");
		const cookie = csrfFrom(clearedCookies());

		// A Set-Cookie only replaces one it matches on name, domain and path.
		expect(cookie).toContain("Domain=example.com");
		expect(cookie).toContain("Max-Age=0");
	});

	it("puts it on the anonymous voter's token too, which needs reading just the same", async () => {
		const { voterCookies } = await cookiesWith("example.com");

		expect(csrfFrom(voterCookies("voter", "csrf"))).toContain("Domain=example.com");
	});

	it("takes a leading dot, because that is how people write it", async () => {
		const { sessionCookies } = await cookiesWith(".example.com");

		expect(csrfFrom(sessionCookies("access", "refresh", "csrf"))).toContain(
			"Domain=example.com",
		);
	});

	it("refuses a value that is not a domain, at boot rather than in a browser", async () => {
		await expect(cookiesWith("not a domain")).rejects.toThrow(/Invalid environment/);
		await expect(cookiesWith("localhost")).rejects.toThrow(/Invalid environment/);
	});
});
