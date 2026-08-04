import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Double-submit CSRF, the stateless flavour.
 *
 * A cross-site page can make the browser *send* our cookies, but it cannot
 * *read* them - so a random value that must arrive twice, once as a cookie
 * and once as a header the page had to read the cookie to set, proves the
 * request came from our own origin. The server stores nothing and compares
 * the two copies, timing-safe.
 *
 * The token is minted alongside each session (see auth router) and lives in
 * the one deliberately non-httpOnly cookie, CSRF_COOKIE. SameSite is the
 * first line of defence; this is the second, for the browsers and subdomain
 * corners SameSite does not cover.
 */
export function generateCsrfToken(): string {
	return randomBytes(32).toString("base64url");
}

export function csrfTokensMatch(cookie: string | undefined, header: string | undefined): boolean {
	if (!cookie || !header) return false;

	const a = Buffer.from(cookie);
	const b = Buffer.from(header);

	// Length leaks are fine - the length is not the secret.
	if (a.length !== b.length) return false;

	return timingSafeEqual(a, b);
}
