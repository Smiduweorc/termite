import { voterCookies } from "../../lib/cookies";
import { generateCsrfToken } from "../../lib/csrf";
import { generateVoterToken, voterKeyFor } from "../../lib/voter";
import {
	deleteFeedback,
	EditFeedbackInput,
	editFeedback,
	FeedbackIdInput,
	getFeedback,
	ListFeedbackInput,
	listFeedback,
	SubmitFeedbackInput,
	submitFeedback,
	unvoteFeedback,
	voteForFeedback,
} from "../../services/feedback.service";
import type { Context } from "../context";
import { protectedProcedure, publicProcedure, router } from "../trpc";

/**
 * Hands this caller a voter identity, minting one if they arrived without.
 *
 * A first-time visitor has no cookie, so their first vote is also the moment they get
 * one - which is the closest thing to "signing up" this board has, and it happens
 * without them noticing. The CSRF token is minted in the same breath (see
 * lib/cookies.ts): from here on, that browser's mutations have to prove they can read it.
 */
function ensureVoter(ctx: Context): string {
	if (ctx.voterKey) return ctx.voterKey;

	const token = generateVoterToken();

	for (const cookie of voterCookies(token, generateCsrfToken())) {
		ctx.resHeaders.append("set-cookie", cookie);
	}

	// Same derivation the context would have done had the cookie already been there.
	const key = voterKeyFor(null, token);

	if (!key) {
		throw new Error("unreachable: a freshly minted voter token has a key");
	}

	return key;
}

/**
 * The board.
 *
 * Note how much of this is `publicProcedure`: reading, filing and voting are all open to
 * someone who has never made an account, because the alternative is a board that only
 * hears from people willing to make one. `protectedProcedure` starts where authorship
 * does - editing an item, which needs to know it is still you.
 */
export const feedbackRouter = router({
	/** trpc.feedback.list.query({ sort: "top" }) - the board itself. */
	list: publicProcedure
		.input(ListFeedbackInput)
		.query(({ ctx, input }) => listFeedback(ctx.db, ctx.voterKey, input)),

	/** trpc.feedback.byId.query({ id }) */
	byId: publicProcedure
		.input(FeedbackIdInput)
		.query(({ ctx, input }) => getFeedback(ctx.db, ctx.voterKey, input)),

	/** trpc.feedback.submit.mutate({ kind, title, body }) - no account required. */
	submit: publicProcedure
		.input(SubmitFeedbackInput)
		.mutation(({ ctx, input }) => submitFeedback(ctx.db, ctx.actor, ensureVoter(ctx), input)),

	/**
	 * trpc.feedback.edit.mutate({ id, title? })
	 *
	 * Wording is the author's, triage is the maintainer's. Which of the two you are
	 * allowed to touch is decided in the service, not here.
	 */
	edit: protectedProcedure
		.input(EditFeedbackInput)
		.mutation(({ ctx, input }) => editFeedback(ctx.db, ctx.actor, ctx.voterKey, input)),

	/** trpc.feedback.delete.mutate({ id }) - yours, or you are the maintainer. */
	delete: protectedProcedure
		.input(FeedbackIdInput)
		.mutation(({ ctx, input }) => deleteFeedback(ctx.db, ctx.actor, input)),

	/** trpc.feedback.vote.mutate({ id }) - idempotent; one vote per voter. */
	vote: publicProcedure
		.input(FeedbackIdInput)
		.mutation(({ ctx, input }) => voteForFeedback(ctx.db, ensureVoter(ctx), input)),

	/** trpc.feedback.unvote.mutate({ id }) */
	unvote: publicProcedure
		.input(FeedbackIdInput)
		.mutation(({ ctx, input }) => unvoteFeedback(ctx.db, ensureVoter(ctx), input)),
});
