import type { AppRouter } from "@termite/backend/trpc";
import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";

/** The literal that index.html ships with, before any container rewrites it. */
const PLACEHOLDER = "__TERMITE_API_URL__";

/**
 * Where the API lives, in the order the answer can be trusted:
 *
 *  1. `window.__TERMITE__.apiUrl`, written into index.html by the image's entrypoint at
 *     container start. This is the only source that can work for a *published* image:
 *     Vite inlines `import.meta.env` when the bundle is built, so a prebuilt frontend
 *     has no other way to learn an address that was unknown on the release runner.
 *  2. `VITE_API_URL`, for a bundle built on the machine that will serve it.
 *  3. The dev server's default.
 *
 * Checking for the placeholder is what keeps (1) from poisoning everything else: under
 * `vite dev` nothing rewrites index.html, so the raw "__TERMITE_API_URL__" is still
 * sitting in `window.__TERMITE__` and is a perfectly truthy string.
 */
function resolveApiUrl(): string {
	const injected = window.__TERMITE__?.apiUrl;
	const url = injected && injected !== PLACEHOLDER ? injected : import.meta.env.VITE_API_URL;

	// A trailing slash would build "https://api.example.com//trpc" below.
	return (url ?? "http://localhost:3000").replace(/\/+$/, "");
}

const API_URL = resolveApiUrl();

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
