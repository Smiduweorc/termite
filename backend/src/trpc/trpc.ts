import { initTRPC, TRPCError } from "@trpc/server";
import { csrfTokensMatch } from "../lib/csrf";
import { AppError, type ErrorCode } from "../lib/errors";
import type { Context } from "./context";

const TRPC_CODE: Record<ErrorCode, TRPCError["code"]> = {
	BAD_REQUEST: "BAD_REQUEST",
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	CONFLICT: "CONFLICT",
	INTERNAL: "INTERNAL_SERVER_ERROR",
};

const t = initTRPC.context<Context>().create({
	/**
	 * What the client is allowed to be told.
	 *
	 * tRPC's default is to pass a thrown error's message straight through - so an
	 * unhandled Postgres error reaches an anonymous caller as the failing SQL, its
	 * parameters and a stack trace. Internal errors are therefore flattened to a fixed
	 * string here, and the stack is stripped from every response.
	 *
	 * The real error is not lost: it is logged in full, against the same requestId that is
	 * handed back to the caller, so a support ticket maps onto exactly one log line.
	 */
	errorFormatter({ shape, error, ctx }) {
		const isInternal = error.code === "INTERNAL_SERVER_ERROR";
		const { stack: _stack, ...data } = shape.data as typeof shape.data & { stack?: string };

		return {
			...shape,
			message: isInternal ? "Internal server error" : shape.message,
			data: { ...data, requestId: ctx?.requestId },
		};
	},
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * One line per procedure call, and the translation of AppError into a tRPC code.
 *
 * Without the mapping tRPC would wrap anything it does not recognise as a 500, so "you
 * are not an admin" would reach the client as an internal error instead of a 403.
 *
 * Note the two log levels: an AppError is the system working (a 403 is not an incident),
 * so it is logged at info. Anything else is a bug, and gets the stack at error.
 */
const observe = t.middleware(async ({ ctx, next, path, type }) => {
	const startedAt = performance.now();
	const result = await next();
	const durationMs = Math.round(performance.now() - startedAt);

	if (result.ok) {
		ctx.log.info({ procedure: path, type, durationMs }, "trpc ok");

		return result;
	}

	const { error } = result;
	const cause = error.cause;

	if (cause instanceof AppError) {
		ctx.log.info({ procedure: path, type, durationMs, code: cause.code }, "trpc rejected");

		throw new TRPCError({ code: TRPC_CODE[cause.code], message: cause.message, cause });
	}

	if (error.code === "INTERNAL_SERVER_ERROR") {
		ctx.log.error({ procedure: path, type, durationMs, err: cause ?? error }, "trpc failed");
	} else {
		// Input that failed validation lands here, as do the guards below: expected, and
		// not worth a stack.
		ctx.log.info({ procedure: path, type, durationMs, code: error.code }, "trpc rejected");
	}

	return result;
});

/**
 * Double-submit CSRF, applied exactly where the attack exists: mutations
 * whose caller was authenticated by a cookie. A cross-site page can make the
 * browser send our cookies, but it cannot read them - so it can never echo
 * the csrf_token cookie back in the x-csrf-token header.
 *
 * Bearer-authenticated calls are exempt (attaching the header proves the
 * caller could read the token, which a cross-site page cannot), as are
 * anonymous mutations like login and register - those have no session to
 * ride, and SameSite already keeps them same-origin.
 */
const csrfGuard = t.middleware(({ ctx, type, next }) => {
	if (
		type === "mutation" &&
		ctx.actorSource === "cookie" &&
		!csrfTokensMatch(ctx.csrf.cookie, ctx.csrf.header)
	) {
		ctx.log.warn({ event: "csrf.denied" }, "mutation refused: bad or missing CSRF token");

		throw new TRPCError({ code: "FORBIDDEN", message: "CSRF token missing or invalid" });
	}

	return next();
});

/** Anonymous callers welcome. `ctx.actor` may be null. */
export const publicProcedure = t.procedure.use(observe).use(csrfGuard);

/**
 * Requires a signed-in caller, and narrows `ctx.actor` from `Actor | null` to `Actor` - so
 * inside a protected procedure the type system stops you from forgetting the check.
 */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
	if (!ctx.actor) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "You must be signed in" });
	}

	return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/**
 * Requires the admin role.
 *
 * This is a fast rejection at the edge, not the security boundary - the services enforce
 * the same rule (see lib/actor.ts), because a gRPC call never passes through here.
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
	if (ctx.actor.role !== "admin") {
		ctx.log.warn({ event: "authz.denied" }, "admin procedure refused");

		throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
	}

	return next({ ctx });
});
