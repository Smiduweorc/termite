import * as grpc from "@grpc/grpc-js";
import type { Database } from "../db";
import type { FeedbackItem, PublicUser, ReleaseSummary } from "../db/schema";
import type { Actor } from "../lib/actor";
import { AppError, type ErrorCode } from "../lib/errors";
import { type Logger, logger, requestIdFrom } from "../lib/logger";
import type { Mailer } from "../lib/mailer";
import { voterKeyFor } from "../lib/voter";
import {
	createAccount,
	requestPasswordReset,
	resendInvite,
	setPassword,
} from "../services/account.service";
import { login, logout, me, refresh, type Session } from "../services/auth.service";
import {
	deleteFeedback,
	editFeedback,
	getFeedback,
	listFeedback,
	submitFeedback,
	unvoteFeedback,
	voteForFeedback,
} from "../services/feedback.service";
import {
	createRelease,
	deleteRelease,
	getRelease,
	listReleases,
	shipRelease,
	updateRelease,
} from "../services/release.service";
import { deleteUser, listUsers, setUserRole } from "../services/user.service";
import { actorFromMetadata } from "./auth";
import {
	authServiceDefinition,
	feedbackServiceDefinition,
	releaseServiceDefinition,
	userServiceDefinition,
} from "./proto";

const GRPC_CODE: Record<ErrorCode, grpc.status> = {
	BAD_REQUEST: grpc.status.INVALID_ARGUMENT,
	UNAUTHORIZED: grpc.status.UNAUTHENTICATED,
	FORBIDDEN: grpc.status.PERMISSION_DENIED,
	NOT_FOUND: grpc.status.NOT_FOUND,
	CONFLICT: grpc.status.ALREADY_EXISTS,
	INTERNAL: grpc.status.INTERNAL,
};

function serviceError(code: grpc.status, message: string): grpc.ServiceError {
	return Object.assign(new Error(message), {
		code,
		details: message,
		metadata: new grpc.Metadata(),
		name: "ServiceError",
	});
}

/**
 * The gRPC twin of the tRPC error middleware: one AppError, two transports - and the same
 * rule about what a caller is told. An AppError carries a message meant for the client;
 * anything else is a bug, gets logged with its stack, and goes out as a bare "Internal
 * error" rather than a Postgres error string.
 */
function toServiceError(error: unknown, log: Logger, durationMs: number): grpc.ServiceError {
	if (error instanceof AppError) {
		log.info({ durationMs, code: error.code }, "grpc rejected");

		return serviceError(GRPC_CODE[error.code], error.message);
	}

	log.error({ durationMs, err: error }, "grpc failed");

	return serviceError(grpc.status.INTERNAL, "Internal error");
}

/**
 * Drizzle hands back Date objects and nulls; protobuf wants RFC 3339 strings and, for a
 * plain string field, "" rather than an absent value. Null becomes empty in both
 * directions - see `orNull` below for the way back.
 */
function toWireFeedback(item: FeedbackItem) {
	return {
		id: item.id,
		kind: item.kind,
		title: item.title,
		body: item.body,
		status: item.status,
		author_id: item.authorId ?? "",
		author_name: item.authorName ?? "",
		release_id: item.releaseId ?? "",
		maintainer_note: item.maintainerNote ?? "",
		votes: item.votes,
		viewer_has_voted: item.viewerHasVoted,
		created_at: item.createdAt.toISOString(),
		updated_at: item.updatedAt.toISOString(),
	};
}

function toWireRelease(release: ReleaseSummary) {
	return {
		id: release.id,
		version: release.version,
		name: release.name ?? "",
		status: release.status,
		notes: release.notes ?? "",
		planned_for: release.plannedFor?.toISOString() ?? "",
		released_at: release.releasedAt?.toISOString() ?? "",
		item_count: release.itemCount,
		created_at: release.createdAt.toISOString(),
		updated_at: release.updatedAt.toISOString(),
	};
}

function toWireUser(user: PublicUser) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		created_at: user.createdAt.toISOString(),
		updated_at: user.updatedAt.toISOString(),
	};
}

function toWireSession(session: Session) {
	return {
		user: toWireUser(session.user),
		access_token: session.accessToken,
		refresh_token: session.refreshToken,
	};
}

/**
 * Every handler goes through here: pick up the request id, resolve the caller from the
 * metadata, time the call, translate AppErrors into gRPC statuses, log one line either way.
 *
 * The actor may be null. That is not the wrapper's problem - the service decides whether
 * an anonymous caller is acceptable, exactly as it does for tRPC.
 */
function unary<Request, Reply>(
	method: string,
	handler: (request: Request, actor: Actor | null, log: Logger) => Promise<Reply>,
) {
	return (
		call: grpc.ServerUnaryCall<Request, Reply>,
		callback: grpc.sendUnaryData<Reply>,
	): void => {
		const requestId = requestIdFrom(call.metadata.get("x-request-id")[0]?.toString());
		const startedAt = performance.now();
		const elapsed = () => Math.round(performance.now() - startedAt);

		let log = logger.child({ requestId, transport: "grpc", method });

		actorFromMetadata(call.metadata)
			.then((actor) => {
				// Same as tRPC: the id, never the email. Logs get shipped and kept.
				if (actor) log = log.child({ userId: actor.id, role: actor.role });

				return handler(call.request, actor, log);
			})
			.then((reply) => {
				log.info({ durationMs: elapsed() }, "grpc ok");
				callback(null, reply);
			})
			.catch((error: unknown) => {
				callback(toServiceError(error, log, elapsed()), null);
			});
	};
}

/**
 * proto3 has no way to say "absent" for a plain scalar: an unset string arrives as "",
 * an unset int32 as 0. Both are values arktype would reject, so they are spread into the
 * service input only when they are real - never set to undefined, because to arktype an
 * optional key means *absent*, and `{ limit: undefined }` is a present key holding an
 * invalid value.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
	return value ? ({ [key]: value } as Partial<Record<K, V>>) : {};
}

/** On an `optional` field, "" is how a gRPC caller says "clear this". */
function orNull(value: string | undefined): string | null | undefined {
	if (value === undefined) return undefined;

	return value === "" ? null : value;
}

interface ListFeedbackRequest {
	limit?: number;
	kind?: string;
	status?: string;
	release_id?: string;
	sort?: string;
}

interface SubmitFeedbackRequest {
	kind: string;
	title: string;
	body: string;
}

interface EditFeedbackRequest {
	id: string;
	kind?: string;
	title?: string;
	body?: string;
	status?: string;
	release_id?: string;
	maintainer_note?: string;
}

interface ListReleasesRequest {
	limit?: number;
	status?: string;
}

interface CreateReleaseRequest {
	version: string;
	name?: string;
	notes?: string;
	status?: string;
	planned_for?: string;
}

interface UpdateReleaseRequest {
	id: string;
	version?: string;
	name?: string;
	notes?: string;
	status?: string;
	planned_for?: string;
}

export function createGrpcServer(db: Database, mail: Mailer): grpc.Server {
	const server = new grpc.Server();

	/**
	 * gRPC carries no cookies, so an anonymous caller has no voter identity at all:
	 * they can read the board, but a vote has to come from an account. That is the one
	 * place the two transports genuinely differ, and it is the browser - not the
	 * script - that the "no account required" promise is about.
	 */
	const voterFor = (actor: Actor | null) => voterKeyFor(actor, undefined);

	server.addService(feedbackServiceDefinition, {
		ListFeedback: unary("ListFeedback", async (request: ListFeedbackRequest, actor) => {
			const items = await listFeedback(db, voterFor(actor), {
				...optional("limit", request.limit && request.limit > 0 ? request.limit : 0),
				...optional("kind", request.kind),
				...optional("status", request.status),
				...optional("releaseId", request.release_id),
				...optional("sort", request.sort),
			});

			return { items: items.map(toWireFeedback) };
		}),

		GetFeedback: unary("GetFeedback", async (request: { id: string }, actor) =>
			toWireFeedback(await getFeedback(db, voterFor(actor), request)),
		),

		SubmitFeedback: unary("SubmitFeedback", async (request: SubmitFeedbackRequest, actor) =>
			toWireFeedback(await submitFeedback(db, actor, voterFor(actor), request)),
		),

		EditFeedback: unary("EditFeedback", async (request: EditFeedbackRequest, actor) =>
			toWireFeedback(
				await editFeedback(db, actor, voterFor(actor), {
					id: request.id,
					...optional("kind", request.kind),
					...optional("title", request.title),
					...optional("body", request.body),
					...optional("status", request.status),
					// These two are nullable in the service: "" unassigns.
					...(request.release_id !== undefined
						? { releaseId: orNull(request.release_id) }
						: {}),
					...(request.maintainer_note !== undefined
						? { maintainerNote: orNull(request.maintainer_note) }
						: {}),
				}),
			),
		),

		DeleteFeedback: unary("DeleteFeedback", (request: { id: string }, actor) =>
			deleteFeedback(db, actor, request),
		),

		Vote: unary("Vote", async (request: { id: string }, actor) =>
			toWireFeedback(await voteForFeedback(db, voterFor(actor), request)),
		),

		Unvote: unary("Unvote", async (request: { id: string }, actor) =>
			toWireFeedback(await unvoteFeedback(db, voterFor(actor), request)),
		),
	});

	// The calendar. Reading is open; the guards on the rest live in the service, so they
	// hold here exactly as they do for the tRPC adminProcedure.
	server.addService(releaseServiceDefinition, {
		ListReleases: unary("ListReleases", async (request: ListReleasesRequest) => {
			const rows = await listReleases(db, {
				...optional("limit", request.limit && request.limit > 0 ? request.limit : 0),
				...optional("status", request.status),
			});

			return { releases: rows.map(toWireRelease) };
		}),

		GetRelease: unary("GetRelease", async (request: { id: string }) =>
			toWireRelease(await getRelease(db, request)),
		),

		CreateRelease: unary("CreateRelease", async (request: CreateReleaseRequest, actor) =>
			toWireRelease(
				await createRelease(db, actor, {
					version: request.version,
					...optional("name", request.name),
					...optional("notes", request.notes),
					...optional("status", request.status),
					...optional("plannedFor", request.planned_for),
				}),
			),
		),

		UpdateRelease: unary("UpdateRelease", async (request: UpdateReleaseRequest, actor) =>
			toWireRelease(
				await updateRelease(db, actor, {
					id: request.id,
					...optional("version", request.version),
					...optional("status", request.status),
					...(request.name !== undefined ? { name: orNull(request.name) } : {}),
					...(request.notes !== undefined ? { notes: orNull(request.notes) } : {}),
					...(request.planned_for !== undefined
						? { plannedFor: orNull(request.planned_for) }
						: {}),
				}),
			),
		),

		ShipRelease: unary("ShipRelease", async (request: { id: string }, actor) =>
			toWireRelease(await shipRelease(db, actor, request)),
		),

		DeleteRelease: unary("DeleteRelease", (request: { id: string }, actor) =>
			deleteRelease(db, actor, request),
		),
	});

	server.addService(authServiceDefinition, {
		Login: unary("Login", async (request: unknown, _actor, log) =>
			toWireSession(await login(db, log, request)),
		),

		Refresh: unary("Refresh", async (request: { refresh_token?: string }, _actor, log) =>
			toWireSession(await refresh(db, log, request.refresh_token)),
		),

		Logout: unary("Logout", (request: { refresh_token?: string }, _actor, log) =>
			logout(db, log, request.refresh_token),
		),

		Me: unary("Me", async (_request: unknown, actor) => toWireUser(await me(db, actor))),

		ForgotPassword: unary("ForgotPassword", (request: unknown, _actor, log) =>
			requestPasswordReset(db, log, mail, request),
		),

		SetPassword: unary("SetPassword", (request: unknown, _actor, log) =>
			setPassword(db, log, request),
		),
	});

	// Admin only. The guard is inside the service, so it holds here exactly as it does for
	// the tRPC adminProcedure - there is no second copy of the rule to get wrong.
	server.addService(userServiceDefinition, {
		ListUsers: unary("ListUsers", async (_request: unknown, actor) => ({
			users: (await listUsers(db, actor)).map(toWireUser),
		})),

		CreateUser: unary(
			"CreateUser",
			async (request: { email: string; name: string; role?: string }, actor, log) =>
				toWireUser(
					await createAccount(db, log, mail, actor, {
						email: request.email,
						name: request.name,
						...optional("role", request.role),
					}),
				),
		),

		ResendInvite: unary("ResendInvite", (request: { user_id: string }, actor, log) =>
			resendInvite(db, log, mail, actor, { userId: request.user_id }),
		),

		SetUserRole: unary(
			"SetUserRole",
			async (request: { user_id: string; role: string }, actor, log) =>
				toWireUser(
					await setUserRole(db, log, actor, {
						userId: request.user_id,
						role: request.role,
					}),
				),
		),

		DeleteUser: unary("DeleteUser", (request: { user_id: string }, actor, log) =>
			deleteUser(db, log, actor, { userId: request.user_id }),
		),
	});

	return server;
}

/** Binds the server. Pass port 0 to get a free one - that is what the tests do. */
export function startGrpcServer(server: grpc.Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.bindAsync(
			`0.0.0.0:${port}`,
			grpc.ServerCredentials.createInsecure(),
			(error, boundPort) => (error ? reject(error) : resolve(boundPort)),
		);
	});
}
