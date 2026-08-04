import {
	deleteUser,
	listUsers,
	SetRoleInput,
	setUserRole,
	UserIdInput,
} from "../../services/user.service";
import { adminProcedure, router } from "../trpc";

/**
 * The admin-only surface. Every procedure here is an `adminProcedure`, so a signed-in
 * ordinary user gets FORBIDDEN and an anonymous one gets UNAUTHORIZED.
 */
export const userRouter = router({
	/** trpc.user.list.query() */
	list: adminProcedure.query(({ ctx }) => listUsers(ctx.db, ctx.actor)),

	/** trpc.user.setRole.mutate({ userId, role: "admin" }) */
	setRole: adminProcedure
		.input(SetRoleInput)
		.mutation(({ ctx, input }) => setUserRole(ctx.db, ctx.log, ctx.actor, input)),

	/** trpc.user.delete.mutate({ userId }) */
	delete: adminProcedure
		.input(UserIdInput)
		.mutation(({ ctx, input }) => deleteUser(ctx.db, ctx.log, ctx.actor, input)),
});
