import { type Type, type } from "arktype";

/**
 * One error vocabulary for the whole app.
 *
 * Services throw these. They know nothing about tRPC or gRPC - each transport translates
 * an AppError into its own status (see trpc/trpc.ts and grpc/server.ts). That is what
 * lets a single service back both APIs without leaking either.
 *
 * The corollary matters just as much: anything that is *not* an AppError is a bug, and
 * both transports treat it as one - logged in full with its stack, and reported to the
 * caller as a bare "internal error" carrying nothing but a request id.
 */
export type ErrorCode =
	| "BAD_REQUEST"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "CONFLICT"
	| "INTERNAL";

export class AppError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "AppError";
		this.code = code;
	}
}

/**
 * Validates with arktype and throws a BAD_REQUEST on failure.
 *
 * Services validate their own input rather than trusting the transport: tRPC checks
 * `.input()` before the call, but protobuf only guarantees field *shapes* - it has no
 * idea a title must be 1-200 characters. Validating here means both transports get the
 * same rules from the same schema.
 */
export function parseInput<T extends Type>(schema: T, input: unknown): T["infer"] {
	const result = schema(input);

	if (result instanceof type.errors) {
		throw new AppError("BAD_REQUEST", result.summary);
	}

	return result as T["infer"];
}

/** Postgres: unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Did this error come from a UNIQUE index?
 *
 * Catching it beats checking first. "Is this email taken?" followed by an insert is two
 * statements with a gap in the middle: two concurrent signups both pass the check, and
 * then one of them explodes - as a 500, because nobody was expecting it. The index is the
 * only thing that can answer atomically, so let it answer, and translate what it throws.
 *
 * Drizzle wraps driver errors, so the code can sit a level or two down the cause chain.
 */
export function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;

	for (let depth = 0; current && depth < 5; depth++) {
		const { code, cause } = current as { code?: unknown; cause?: unknown };

		if (code === UNIQUE_VIOLATION) return true;

		current = cause;
	}

	return false;
}
