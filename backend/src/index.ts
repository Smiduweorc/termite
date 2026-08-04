import { createApp } from "./app";
import { env } from "./config/env";
import { createDatabase } from "./db";
import { createGrpcServer, startGrpcServer } from "./grpc/server";
import { logger } from "./lib/logger";

const { db, pool } = createDatabase(env.DATABASE_URL);

// HTTP (Elysia: REST + tRPC) and gRPC are two doors into the same services.
const app = createApp({ db });
const grpcServer = createGrpcServer(db);

app.listen(env.PORT, (server) => {
	logger.info(
		{
			rest: `http://${server.hostname}:${server.port}/health`,
			trpc: `http://${server.hostname}:${server.port}/trpc`,
			openapi: `http://${server.hostname}:${server.port}/openapi`,
		},
		"http listening",
	);
});

const grpcPort = await startGrpcServer(grpcServer, env.GRPC_PORT);

logger.info({ address: `0.0.0.0:${grpcPort}` }, "grpc listening");

/** How long to let in-flight work finish before pulling the rug. */
const DRAIN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	// A second Ctrl-C should not start a second teardown.
	if (shuttingDown) return;
	shuttingDown = true;

	logger.info({ signal }, "shutting down");

	await app.stop();

	// tryShutdown lets open RPCs finish; forceShutdown cuts them off. Give the first one
	// a deadline, then stop being polite - otherwise one hung stream keeps the pod alive
	// until the orchestrator kills it anyway.
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			logger.warn({ timeoutMs: DRAIN_TIMEOUT_MS }, "grpc drain timed out, forcing");
			grpcServer.forceShutdown();
			resolve();
		}, DRAIN_TIMEOUT_MS);

		grpcServer.tryShutdown(() => {
			clearTimeout(timer);
			resolve();
		});
	});

	await pool.end();

	logger.info("stopped");
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void shutdown(signal));
}

export type { AppRouter } from "./trpc/routers";
