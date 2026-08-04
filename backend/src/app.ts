import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Elysia } from "elysia";
import { env } from "./config/env";
import type { Database } from "./db";
import { logger, requestIdFrom } from "./lib/logger";
import { createContextFactory } from "./trpc/context";
import { appRouter } from "./trpc/routers";

export interface AppDeps {
	db: Database;
}

export function createApp({ db }: AppDeps) {
	return (
		new Elysia()
			.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
			.use(openapi({ path: "/openapi" }))

			// Elysia's own surface: a request id per call, echoed back so a client can quote
			// it, and one access line. /trpc is skipped here - it logs itself, per procedure,
			// which is strictly more useful. See the note on `.mount` below.
			.derive(({ request }) => ({
				requestId: requestIdFrom(request.headers.get("x-request-id")),
				startedAt: performance.now(),
			}))
			.onAfterHandle(({ set, requestId }) => {
				set.headers["x-request-id"] = requestId;
			})
			.onAfterResponse(({ request, set, requestId, startedAt, path }) => {
				if (path.startsWith("/trpc")) return;

				logger.info(
					{
						requestId,
						transport: "http",
						method: request.method,
						path,
						status: set.status,
						durationMs: Math.round(performance.now() - startedAt),
					},
					"http",
				);
			})
			.onError(({ code, error, path, requestId }) => {
				logger.error({ requestId, code, path, err: error }, "unhandled request error");
			})

			// A plain Elysia REST route. Elysia and tRPC share the same server - use REST for
			// what the browser or a load balancer hits directly.
			.get("/health", () => ({ status: "ok", uptime: process.uptime() }))

			// Everything under /trpc is handed to tRPC's fetch adapter.
			//
			// `.mount` hands over the untouched Request, which is what a tRPC mutation needs
			// - Elysia parses the body of a POST before a normal handler runs, and tRPC would
			// then find the stream already consumed.
			//
			// It also strips the prefix, so the adapter sees `/post.create`, not
			// `/trpc/post.create`. Hence `endpoint: ""` - tRPC slices the endpoint off the
			// path to find the procedure name, and there is nothing left to slice. Setting it
			// to "/trpc" here silently 404s every call.
			//
			// And it rebuilds the Request, so the object Elysia's hooks saw is not the one
			// arriving here: no per-request state can be handed across. The request id is
			// therefore re-derived from the header, which is the one thing that does survive.
			.mount("/trpc", (request: Request) => {
				const requestId = requestIdFrom(request.headers.get("x-request-id"));
				const log = logger.child({ requestId, transport: "trpc" });

				return fetchRequestHandler({
					endpoint: "",
					req: request,
					router: appRouter,
					createContext: (options) => {
						options.resHeaders.set("x-request-id", requestId);

						return createContextFactory({ db, requestId, log })(options);
					},
					// The per-procedure middleware logs everything that reaches a resolver.
					// This catches what does not: an unknown procedure, a malformed body.
					onError({ error, path }) {
						if (error.code === "INTERNAL_SERVER_ERROR") {
							log.error({ procedure: path ?? "<none>", err: error }, "trpc failed");
						} else {
							log.info(
								{ procedure: path ?? "<none>", code: error.code },
								"trpc rejected",
							);
						}
					},
				});
			})
	);
}

export type App = ReturnType<typeof createApp>;
