import { router } from "../trpc";
import { authRouter } from "./auth";
import { healthRouter } from "./health";
import { postRouter } from "./post";
import { userRouter } from "./user";

export const appRouter = router({
	auth: authRouter,
	health: healthRouter,
	post: postRouter,
	/** Admin only. */
	user: userRouter,
});

/** The only thing the frontend imports. It is a type - nothing ships to the browser. */
export type AppRouter = typeof appRouter;
