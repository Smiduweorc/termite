import { readonly, ref } from "vue";
import { trpc } from "../lib/trpc";

/** Whatever auth.me returns - inferred from the router, never re-declared here. */
export type CurrentUser = Awaited<ReturnType<typeof trpc.auth.me.query>>;

// Module scope, so every component that calls useAuth() shares one session rather than
// each holding its own copy that can drift out of step.
const user = ref<CurrentUser | null>(null);
const ready = ref(false);

/**
 * The app never sees a token. They live in httpOnly cookies the browser attaches on its
 * own (that is what `credentials: "include"` in lib/trpc.ts is for), so "am I signed in?"
 * is answered by asking the server, not by reading storage.
 */
async function load(): Promise<void> {
	try {
		user.value = await trpc.auth.me.query();
	} catch {
		// The access token is good for 15 minutes; the refresh cookie lasts days. A 401
		// here usually just means the short one lapsed, so try to trade up before giving
		// up and showing the login form.
		try {
			user.value = await trpc.auth.refresh.mutate();
		} catch {
			user.value = null;
		}
	} finally {
		ready.value = true;
	}
}

export function useAuth() {
	async function login(email: string, password: string): Promise<void> {
		user.value = await trpc.auth.login.mutate({ email, password });
	}

	// There is no register(): accounts are created by a maintainer and activated with an
	// emailed link, so the only way a session starts here is login().

	/**
	 * The local half happens in `finally`, on purpose.
	 *
	 * Revoking the refresh token is the server's job and it can fail - the network is
	 * down, the session had already lapsed, the mutation is refused. None of that is a
	 * reason to leave someone looking signed in after they asked not to be: the button
	 * would appear to do nothing at all, since the rejection is thrown into a click
	 * handler nobody is watching. Clearing here means sign-out always visibly happens,
	 * and the worst case is a refresh token that outlives the session it belonged to -
	 * which is what its expiry is for.
	 */
	async function logout(): Promise<void> {
		try {
			await trpc.auth.logout.mutate();
		} catch {
			// Swallowed rather than rethrown: the only caller is a click handler on the
			// masthead, so a rejection here has nowhere to go but an unhandled promise -
			// and the `finally` below is the answer the person actually asked for. The
			// server logs its own reason for refusing, against the request id.
		} finally {
			user.value = null;
		}
	}

	return {
		user: readonly(user),
		ready: readonly(ready),
		load,
		login,
		logout,
	};
}
