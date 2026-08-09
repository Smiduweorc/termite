import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "./actor";

/**
 * Who cast this vote, without asking them to sign up.
 *
 * Requiring an account before someone can say "this bug bit me too" is how a small
 * project loses the feedback it most needed, so a voter here is just a random token in
 * a cookie. The database never stores that token - only its SHA-256, keyed apart from
 * user ids by a prefix, so the two identity spaces cannot collide.
 *
 * This is deliberately not fraud-proof. Clearing cookies buys another vote, and no
 * amount of fingerprinting would change that without collecting things a feedback board
 * has no business collecting. The vote count is a rough show of hands, and that is all
 * it is being asked to be.
 */
export const VOTER_COOKIE = "termite_voter";

/** A year: long enough that the board remembers you between release cycles. */
export const VOTER_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function generateVoterToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * A signed-in person votes as their account, not as their browser.
 *
 * That is the stronger identity: it is one vote per item across every device they use,
 * and it survives a cookie purge. The cost is that voting anonymously and then signing
 * in and voting again counts twice - the board cannot tell those two apart, and the
 * alternative (linking a cookie to an account on login) is exactly the kind of
 * identity-stitching this project has no reason to do.
 */
export function voterKeyFor(actor: Actor | null, voterToken: string | undefined): string | null {
	if (actor) return `user:${actor.id}`;

	if (!voterToken) return null;

	return `anon:${createHash("sha256").update(voterToken).digest("hex")}`;
}
