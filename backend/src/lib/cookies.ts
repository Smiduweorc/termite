import { stringifySetCookie } from "cookie";
import { buildTokenCookie, clearTokenCookie } from "lacewing";
import { env } from "../config/env";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
/** Not httpOnly - the double-submit CSRF check needs the page to read it. */
export const CSRF_COOKIE = "csrf_token";

/**
 * The token cookies come from lacewing's buildTokenCookie, where httpOnly,
 * Secure and SameSite are not options but facts: there is no way to emit a
 * weaker cookie, which is why this template has no COOKIE_SECURE switch.
 * JavaScript in the page cannot read the tokens, so an XSS bug cannot walk
 * off with the session - and the Vue app is never handed a token to lose.
 *
 * Browsers treat http://localhost as a secure context, so Secure cookies
 * work unchanged in dev.
 */
const SAME_SITE = env.COOKIE_SAME_SITE === "strict" ? "Strict" : "Lax";

export function sessionCookies(
	accessToken: string,
	refreshToken: string,
	csrfToken: string,
): string[] {
	return [
		buildTokenCookie(accessToken, {
			name: ACCESS_COOKIE,
			sameSite: SAME_SITE,
			maxAgeSeconds: 15 * 60,
		}),
		buildTokenCookie(refreshToken, {
			name: REFRESH_COOKIE,
			sameSite: SAME_SITE,
			maxAgeSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
		}),
		// The CSRF cookie is the one cookie that must NOT be httpOnly - its whole
		// job is to be read back by the page and echoed in a header, which is why
		// it is built with `cookie` rather than lacewing. It carries no secret the
		// server trusts on its own: only the cookie+header pair together pass.
		stringifySetCookie({
			name: CSRF_COOKIE,
			value: csrfToken,
			httpOnly: false,
			secure: true,
			sameSite: env.COOKIE_SAME_SITE,
			path: "/",
			maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
		}),
	];
}

/** Max-Age=0 tells the browser to drop them now, rather than trusting it to forget. */
export function clearedCookies(): string[] {
	const headers = new Headers();
	clearTokenCookie(headers, { name: ACCESS_COOKIE });
	clearTokenCookie(headers, { name: REFRESH_COOKIE });

	return [
		...headers.getSetCookie(),
		stringifySetCookie({
			name: CSRF_COOKIE,
			value: "",
			httpOnly: false,
			secure: true,
			sameSite: env.COOKIE_SAME_SITE,
			path: "/",
			maxAge: 0,
		}),
	];
}
