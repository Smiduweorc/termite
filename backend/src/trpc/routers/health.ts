import { sql } from "drizzle-orm";
import { publicProcedure, router } from "../trpc";

export const healthRouter = router({
	/** trpc.health.ping.query() */
	ping: publicProcedure.query(() => ({
		status: "ok" as const,
		ts: new Date().toISOString(),
	})),

	/** trpc.health.db.query() - proves the pool can actually reach Postgres. */
	db: publicProcedure.query(async ({ ctx }) => {
		await ctx.db.execute(sql`select 1`);

		return { database: "reachable" as const };
	}),
});
