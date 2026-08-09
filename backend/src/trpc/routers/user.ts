import {
	UserIdInput as AccountUserIdInput,
	CreateAccountInput,
	createAccount,
	resendInvite,
} from "../../services/account.service";
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
 *
 * This is also the only way an account comes into existence - there is no public
 * registration to pair it with.
 */
export const userRouter = router({
	/** trpc.user.list.query() */
	list: adminProcedure.query(({ ctx }) => listUsers(ctx.db, ctx.actor)),

	/**
	 * trpc.user.create.mutate({ email, name, role? })
	 *
	 * Creates the account with no usable password and emails an invite link. Nobody,
	 * including the admin who made it, ever holds a password for it.
	 */
	create: adminProcedure
		.input(CreateAccountInput)
		.mutation(({ ctx, input }) => createAccount(ctx.db, ctx.log, ctx.mail, ctx.actor, input)),

	/** trpc.user.resendInvite.mutate({ userId }) - for the link that expired. */
	resendInvite: adminProcedure
		.input(AccountUserIdInput)
		.mutation(({ ctx, input }) => resendInvite(ctx.db, ctx.log, ctx.mail, ctx.actor, input)),

	/** trpc.user.setRole.mutate({ userId, role: "admin" }) */
	setRole: adminProcedure
		.input(SetRoleInput)
		.mutation(({ ctx, input }) => setUserRole(ctx.db, ctx.log, ctx.actor, input)),

	/** trpc.user.delete.mutate({ userId }) */
	delete: adminProcedure
		.input(UserIdInput)
		.mutation(({ ctx, input }) => deleteUser(ctx.db, ctx.log, ctx.actor, input)),
});
