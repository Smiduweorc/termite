import type { AppRouter } from "@bevd/backend/trpc";
import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * The double-submit half the page owns: csrf_token is the one cookie the
 * server sets without httpOnly, precisely so this code can read it and echo
 * it back as a header. A cross-site page can make the browser *send* the
 * cookie, but it cannot *read* it - so it can never produce the header, and
 * the server refuses its mutations.
 */
function csrfToken(): string | undefined {
	return document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
}

/**
 * `AppRouter` is imported as a type, so none of the server ships to the browser -
 * but every procedure, input and return type below is checked against the real
 * router. Rename a field in the Drizzle schema and this file stops compiling.
 *
 * The explicit `TRPCClient<AppRouter>` annotation is required: without it TypeScript
 * infers a type it cannot name from inside this package and fails with TS2742.
 */
export const trpc: TRPCClient<AppRouter> = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${API_URL}/trpc`,
			// The tokens live in httpOnly cookies; this is what makes the browser
			// attach them.
			fetch: (url, options) => fetch(url, { ...options, credentials: "include" }),
			headers: () => {
				const token = csrfToken();

				return token ? { "x-csrf-token": token } : {};
			},
		}),
	],
});
