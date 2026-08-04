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

	async function register(email: string, name: string, password: string): Promise<void> {
		user.value = await trpc.auth.register.mutate({ email, name, password });
	}

	async function logout(): Promise<void> {
		await trpc.auth.logout.mutate();
		user.value = null;
	}

	return {
		user: readonly(user),
		ready: readonly(ready),
		load,
		login,
		register,
		logout,
	};
}
