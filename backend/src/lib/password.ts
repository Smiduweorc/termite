import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id, via a native module that hashes on a background thread.
 *
 * The thread is the whole point. Bun runs your JavaScript on one thread, so a hash that
 * computes *in* JavaScript stops the entire process while it runs - every other request,
 * every health check, every gRPC call. Measured on this codebase:
 *
 *   bcryptjs (cost 12): 8 concurrent logins -> a trivial /ping took 1364ms
 *   argon2id (here):    8 concurrent logins -> the same /ping took 0-4ms
 *
 * bcryptjs has no true async: its "async" API chops the work into setImmediate slices on
 * the main thread. It is not a threading problem you can configure away, and it turns
 * login into a denial-of-service lever - doubly so because `login()` deliberately hashes
 * even for an unknown email (see auth.service.ts), which would otherwise hand an attacker
 * a free way to burn your CPU without an account.
 *
 * Defaults are @node-rs/argon2's, which follow the OWASP recommendation (argon2id,
 * m=19456 KiB, t=2, p=1). Raise them if your hardware allows; ~250ms is the usual target.
 * Changing them does not invalidate existing hashes: the parameters are encoded in the
 * hash string, so old ones keep verifying and new ones use the new cost.
 */
export function hashPassword(password: string): Promise<string> {
	return hash(password);
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
	try {
		return await verify(digest, password);
	} catch {
		// A malformed or truncated hash in the database - not a match, and not a crash.
		return false;
	}
}
