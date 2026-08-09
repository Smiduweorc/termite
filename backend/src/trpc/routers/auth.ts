import type { PublicUser } from "../../db/schema";
import { clearedCookies, sessionCookies } from "../../lib/cookies";
import { generateCsrfToken } from "../../lib/csrf";
import {
	RequestResetInput,
	requestPasswordReset,
	SetPasswordInput,
	setPassword,
} from "../../services/account.service";
import { LoginInput, login, logout, me, refresh, type Session } from "../../services/auth.service";
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

/**
 * No register procedure, on purpose.
 *
 * Accounts come from the maintainer (user.create) and are picked up with an emailed
 * link (auth.setPassword). The two procedures below are the only public way to touch a
 * password, and neither of them can create an account or reveal whether one exists.
 */
export const authRouter = router({
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

	/**
	 * trpc.auth.forgotPassword.mutate({ email })
	 *
	 * Answers `{ ok: true }` whether or not the address has an account - otherwise this
	 * form would be a way to find out which ones do.
	 */
	forgotPassword: publicProcedure
		.input(RequestResetInput)
		.mutation(({ ctx, input }) => requestPasswordReset(ctx.db, ctx.log, ctx.mail, input)),

	/**
	 * trpc.auth.setPassword.mutate({ token, password })
	 *
	 * Spends an invite or reset link. It does not sign the caller in: proving you can
	 * read an inbox is enough to set a password, and a session on top of that is one
	 * more thing a forwarded email could hand away. They sign in normally afterwards.
	 */
	setPassword: publicProcedure
		.input(SetPasswordInput)
		.mutation(({ ctx, input }) => setPassword(ctx.db, ctx.log, input)),

	/** trpc.auth.me.query() - 401 when signed out, which is how the client knows. */
	me: protectedProcedure.query(({ ctx }) => me(ctx.db, ctx.actor)),
});
