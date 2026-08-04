import { accessTokenProfile, importKey, JWTError, jwtVerify, newAccessToken } from "lacewing";
import { env } from "../config/env";
import type { UserRole } from "../db/schema";
import { AppError } from "./errors";

/**
 * Access tokens through lacewing, which turns the checklist the old jose
 * version had to get right by hand into things that cannot be gotten wrong:
 * the algorithm allowlist, issuer and audience pinning, a `typ` of `at+jwt`
 * (RFC 9068) that a differently-purposed token can never satisfy, a unique
 * `jti` on every token, and an entropy check on the secret itself - a
 * human-chosen JWT_SECRET refuses to import, so the app fails at boot, not
 * at audit time.
 *
 * (Refresh tokens are deliberately not JWTs - see lib/tokens.ts.)
 */
const secret = await importKey(env.JWT_SECRET, "HS256");

const profile = accessTokenProfile({
	issuer: env.JWT_ISSUER,
	audience: env.JWT_AUDIENCE,
	algorithms: ["HS256"],
	keys: secret,
	maxTokenAge: env.JWT_ACCESS_EXPIRY,
});

export interface AccessTokenPayload {
	/** The user id. `sub` is the registered JWT claim for it. */
	sub: string;
	email: string;
	role: UserRole;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
	return newAccessToken()
		.issuer(env.JWT_ISSUER)
		.audience(env.JWT_AUDIENCE)
		.subject(payload.sub)
		.claim("email", payload.email)
		.claim("role", payload.role)
		.expiresIn(env.JWT_ACCESS_EXPIRY)
		.sign(secret);
}

/**
 * Throws UNAUTHORIZED on anything suspect. jwtVerify(token, profile) is the
 * only verification path lacewing has: there is no decode-without-verify to
 * reach for, `alg: none` is unrepresentable, and the classic HMAC/RSA swap
 * fails the allowlist. One message for every failure mode, on purpose - the
 * caller gets no oracle for *why* a token was rejected.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
	try {
		const { payload } = await jwtVerify(token, profile);

		const { sub, email, role } = payload;

		if (typeof sub !== "string" || typeof email !== "string" || typeof role !== "string") {
			throw new AppError("UNAUTHORIZED", "Malformed access token");
		}

		return { sub, email, role: role as UserRole };
	} catch (error) {
		if (error instanceof AppError) throw error;
		if (error instanceof JWTError) {
			throw new AppError("UNAUTHORIZED", "Invalid or expired access token");
		}

		throw error;
	}
}
