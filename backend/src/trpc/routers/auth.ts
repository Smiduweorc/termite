import type { PublicUser } from "../../db/schema";
import { clearedCookies, sessionCookies } from "../../lib/cookies";
import { generateCsrfToken } from "../../lib/csrf";
import {
	LoginInput,
	login,
	logout,
	me,
	RegisterInput,
	refresh,
	register,
	type Session,
} from "../../services/auth.service";
import type { Context } from "../context";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/**
 * Puts the session in httpOnly cookies and returns only the user.
 *
 * The tokens deliberately do not appear in the response body: if the browser cannot read
 * them, neither can injected script. The Vue app never holds a token - it just gets 401s
 * when the cookie is gone, which is all it needs to know.
 */
function commitSession(ctx: Context, session: Session): PublicUser {
	// A fresh CSRF token with every session: it rides in the one readable
	// cookie, and mutations must echo it in the x-csrf-token header. See
	// lib/csrf.ts and the csrfGuard in ../trpc.ts.
	const csrfToken = generateCsrfToken();

	for (const cookie of sessionCookies(session.accessToken, session.refreshToken, csrfToken)) {
		ctx.resHeaders.append("set-cookie", cookie);
	}

	return session.user;
}

export const authRouter = router({
	/** trpc.auth.register.mutate({ email, name, password }) */
	register: publicProcedure
		.input(RegisterInput)
		.mutation(async ({ ctx, input }) =>
			commitSession(ctx, await register(ctx.db, ctx.log, input)),
		),

	/** trpc.auth.login.mutate({ email, password }) */
	login: publicProcedure
		.input(LoginInput)
		.mutation(async ({ ctx, input }) =>
			commitSession(ctx, await login(ctx.db, ctx.log, input)),
		),

	/**
	 * trpc.auth.refresh.mutate()
	 *
	 * Takes no input: the refresh token comes from the cookie, so a page in another tab
	 * cannot pass one in. Rotates the token - see auth.service.ts.
	 */
	refresh: publicProcedure.mutation(async ({ ctx }) =>
		commitSession(ctx, await refresh(ctx.db, ctx.log, ctx.refreshToken)),
	),

	/** trpc.auth.logout.mutate() - revokes the refresh token and clears both cookies. */
	logout: publicProcedure.mutation(async ({ ctx }) => {
		await logout(ctx.db, ctx.log, ctx.refreshToken);

		for (const cookie of clearedCookies()) {
			ctx.resHeaders.append("set-cookie", cookie);
		}

		return { ok: true as const };
	}),

	/** trpc.auth.me.query() - 401 when signed out, which is how the client knows. */
	me: protectedProcedure.query(({ ctx }) => me(ctx.db, ctx.actor)),
});
