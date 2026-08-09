import { router } from "../trpc";
import { authRouter } from "./auth";
import { boardRouter } from "./board";
import { feedbackRouter } from "./feedback";
import { healthRouter } from "./health";
import { releaseRouter } from "./release";
import { userRouter } from "./user";

export const appRouter = router({
	auth: authRouter,
	/** The maintainer's task boards: list and kanban over the same cards. */
	board: boardRouter,
	/** The board: ideas, bugs and votes. Open to anyone, account or not. */
	feedback: feedbackRouter,
	health: healthRouter,
	/** The calendar: merge windows and what shipped in them. */
	release: releaseRouter,
	/** Admin only. */
	user: userRouter,
});

/** The only thing the frontend imports. It is a type - nothing ships to the browser. */
export type AppRouter = typeof appRouter;
