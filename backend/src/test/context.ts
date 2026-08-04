import type { Database } from "../db";
import type { Actor } from "../lib/actor";
import { logger } from "../lib/logger";
import type { ActorSource } from "../trpc/context";
import { appRouter } from "../trpc/routers";
import { createCallerFactory } from "../trpc/trpc";

const createCaller = createCallerFactory(appRouter);

interface CallerOptions {
	actor?: Actor | null;
	/** Defaults to "direct", which the CSRF guard ignores - HTTP-level CSRF is
	 * exercised in app.test.ts, where a real cookie round-trips. Pass "cookie"
	 * (plus csrf values) to point the guard at a direct caller. */
	actorSource?: ActorSource | null;
	refreshToken?: string;
	csrf?: { cookie?: string; header?: string };
}

/**
 * A tRPC caller with no server and no network, plus the response headers it writes - which
 * is how the auth tests read back the cookies the router set.
 *
 * LOG_LEVEL is `silent` in vitest.config.ts, so the real logger is passed through rather
 * than stubbed: the logging middleware still runs (and would still fail on a bad call), it
 * just does not print.
 */
export function callerWithHeaders(
	db: Database,
	{ actor = null, actorSource, refreshToken, csrf }: CallerOptions = {},
) {
	const resHeaders = new Headers();

	const trpc = createCaller({
		db,
		actor,
		actorSource: actorSource !== undefined ? actorSource : actor ? "direct" : null,
		resHeaders,
		refreshToken,
		csrf: { cookie: csrf?.cookie, header: csrf?.header },
		req: new Request("http://localhost/trpc"),
		requestId: "test-request-id",
		log: logger,
	});

	return { trpc, resHeaders };
}

/** The common case: act as this user (or as nobody) and ignore the response headers. */
export function callerAs(db: Database, actor: Actor | null) {
	return callerWithHeaders(db, { actor }).trpc;
}
