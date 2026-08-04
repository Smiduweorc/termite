import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { env } from "../config/env";

export type { Logger };

/**
 * Fields that must never reach the logs, at any nesting depth we actually use.
 *
 * This is a safety net, not a licence to log secrets: pino only redacts the paths listed
 * here, so `log.info({ user })` with a new secret-bearing field would still spill. Prefer
 * logging ids over objects.
 */
const REDACT = [
	"password",
	"*.password",
	"passwordHash",
	"*.passwordHash",
	"token",
	"*.token",
	"accessToken",
	"*.accessToken",
	"refreshToken",
	"*.refreshToken",
	"authorization",
	"*.authorization",
	"cookie",
	"*.cookie",
	"headers.authorization",
	"headers.cookie",
];

/**
 * NDJSON on stdout - one object per line, which is what every log shipper wants and what
 * `docker logs` will hand them. In development that is unreadable, so it goes through
 * pino-pretty instead.
 *
 * The pretty transport runs on a worker thread. That is fine under Bun and under Node,
 * but it is deliberately off outside development: it costs a thread, and production
 * wants the raw JSON anyway.
 */
export const logger: Logger = pino({
	level: env.LOG_LEVEL,
	base: { service: env.SERVICE_NAME, env: env.NODE_ENV },
	redact: { paths: REDACT, censor: "[redacted]" },
	...(env.NODE_ENV === "development"
		? {
				transport: {
					target: "pino-pretty",
					options: {
						colorize: true,
						translateTime: "HH:MM:ss.l",
						ignore: "pid,hostname,service,env",
					},
				},
			}
		: {}),
});

/**
 * One id per request, carried through every log line that request produces.
 *
 * An id arriving in `x-request-id` is trusted and reused, so a trace survives the hop
 * from a gateway or another service. It is length-capped because it is attacker-supplied
 * and ends up in your log storage.
 */
export function requestIdFrom(inbound: string | null | undefined): string {
	if (inbound && inbound.length > 0 && inbound.length <= 200) {
		return inbound;
	}

	return randomUUID();
}
