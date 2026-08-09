import { createApp } from "./app";
import { env } from "./config/env";
import { createDatabase } from "./db";
import { createGrpcServer, startGrpcServer } from "./grpc/server";
import { logger } from "./lib/logger";
import { createMailer } from "./lib/mailer";

const { db, pool } = createDatabase(env.DATABASE_URL);

// One transport for the whole process, so the SMTP connection pool is shared rather than
// rebuilt per message. With no SMTP_HOST set this is the log-only mailer - see
// lib/mailer.ts, and note the warning below.
const mail = createMailer();

if (!env.SMTP_HOST) {
	logger.warn(
		{ event: "mail.disabled" },
		"SMTP_HOST is not set: invite and reset links will be written to this log instead of emailed",
	);
}

// HTTP (Elysia: REST + tRPC) and gRPC are two doors into the same services.
const app = createApp({ db, mail });
const grpcServer = createGrpcServer(db, mail);

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
