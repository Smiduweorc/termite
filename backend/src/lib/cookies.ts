import { stringifySetCookie } from "cookie";
import { buildTokenCookie, clearTokenCookie } from "lacewing";
import { env } from "../config/env";
import { VOTER_COOKIE, VOTER_COOKIE_MAX_AGE_SECONDS } from "./voter";

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

/**
 * The CSRF cookie is the one cookie that must NOT be httpOnly - its whole job is to be
 * read back by the page and echoed in a header, which is why it is built with `cookie`
 * rather than lacewing. It carries no secret the server trusts on its own: only the
 * cookie+header pair together pass.
 *
 * It is also the only cookie that takes a Domain, and only when COOKIE_DOMAIN is set.
 * Being read by script is the whole point of this one, and a host-only cookie is readable
 * only on the host that set it - so a board on board.example.com talking to an API on
 * api.example.com cannot see it, sends no header, and has every mutation refused. The
 * session cookies have no such problem: the browser attaches those itself, and they stay
 * host-only on purpose. See config/env.ts for what widening this costs.
 */
function csrfCookie(value: string, maxAgeSeconds: number): string {
	return stringifySetCookie({
		name: CSRF_COOKIE,
		value,
		httpOnly: false,
		secure: true,
		sameSite: env.COOKIE_SAME_SITE,
		path: "/",
		maxAge: maxAgeSeconds,
		// Both the minting and the clearing go through here, which is what keeps them in
		// step: a Set-Cookie only replaces a cookie it matches on name, domain and path,
		// so a cleared cookie that dropped the Domain would leave the real one in place.
		...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
	});
}

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
		csrfCookie(csrfToken, env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60),
	];
}

/**
 * The anonymous half: a voter token, and the CSRF token that protects it.
 *
 * Both are minted together on the first mutation from a browser that has neither, which
 * is the only request that can reach a mutation without passing the double-submit check
 * (there is nothing to double-submit yet). From the response onwards the pair exists, so
 * every later vote from that browser has to prove it can read the CSRF cookie.
 *
 * The voter token itself is httpOnly: the page has no reason to read it, and a token the
 * page cannot see is a token injected script cannot copy to vote as someone else.
 */
export function voterCookies(voterToken: string, csrfToken: string): string[] {
	return [
		buildTokenCookie(voterToken, {
			name: VOTER_COOKIE,
			sameSite: SAME_SITE,
			maxAgeSeconds: VOTER_COOKIE_MAX_AGE_SECONDS,
		}),
		csrfCookie(csrfToken, VOTER_COOKIE_MAX_AGE_SECONDS),
	];
}

/** Max-Age=0 tells the browser to drop them now, rather than trusting it to forget. */
export function clearedCookies(): string[] {
	const headers = new Headers();
	clearTokenCookie(headers, { name: ACCESS_COOKIE });
	clearTokenCookie(headers, { name: REFRESH_COOKIE });

	// The voter cookie deliberately survives a sign-out: it is not a session, it is the
	// browser's claim on the votes it already cast, and logging out of the maintainer
	// account should not silently hand the same person a second ballot.
	return [...headers.getSetCookie(), csrfCookie("", 0)];
}
