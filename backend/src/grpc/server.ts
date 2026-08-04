import * as grpc from "@grpc/grpc-js";
import type { Database } from "../db";
import type { Post, PublicUser } from "../db/schema";
import type { Actor } from "../lib/actor";
import { AppError, type ErrorCode } from "../lib/errors";
import { type Logger, logger, requestIdFrom } from "../lib/logger";
import { login, logout, me, refresh, register, type Session } from "../services/auth.service";
import { createPost, deletePost, getPost, listPosts, updatePost } from "../services/post.service";
import { deleteUser, listUsers, setUserRole } from "../services/user.service";
import { actorFromMetadata } from "./auth";
import { authServiceDefinition, postServiceDefinition, userServiceDefinition } from "./proto";

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

/** Drizzle hands back Date objects; protobuf wants RFC 3339 strings. */
function toWirePost(post: Post) {
	return {
		id: post.id,
		title: post.title,
		body: post.body,
		published: post.published,
		author_id: post.authorId,
		created_at: post.createdAt.toISOString(),
		updated_at: post.updatedAt.toISOString(),
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

interface ListPostsRequest {
	limit?: number;
	published_only?: boolean;
}

interface CreatePostRequest {
	title: string;
	body: string;
	published?: boolean;
}

interface UpdatePostRequest {
	id: string;
	title?: string;
	body?: string;
	published?: boolean;
}

export function createGrpcServer(db: Database): grpc.Server {
	const server = new grpc.Server();

	server.addService(postServiceDefinition, {
		ListPosts: unary("ListPosts", async (request: ListPostsRequest, actor) => {
			// proto3 sends 0 for an unset int32, which is not a valid limit. The key is
			// spread in only when it is real, never set to undefined: to arktype an optional
			// key means *absent*, and `{ limit: undefined }` is a present key holding an
			// invalid value - it fails validation.
			const limit = request.limit && request.limit > 0 ? { limit: request.limit } : {};

			const rows = await listPosts(db, actor, {
				...limit,
				publishedOnly: request.published_only ?? false,
			});

			return { posts: rows.map(toWirePost) };
		}),

		GetPost: unary("GetPost", async (request: { id: string }, actor) =>
			toWirePost(await getPost(db, actor, request)),
		),

		CreatePost: unary("CreatePost", async (request: CreatePostRequest, actor) =>
			toWirePost(await createPost(db, actor, request)),
		),

		UpdatePost: unary("UpdatePost", async (request: UpdatePostRequest, actor) =>
			toWirePost(await updatePost(db, actor, request)),
		),

		DeletePost: unary("DeletePost", (request: { id: string }, actor) =>
			deletePost(db, actor, request),
		),
	});

	server.addService(authServiceDefinition, {
		Register: unary("Register", async (request: unknown, _actor, log) =>
			toWireSession(await register(db, log, request)),
		),

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
	});

	// Admin only. The guard is inside the service, so it holds here exactly as it does for
	// the tRPC adminProcedure - there is no second copy of the rule to get wrong.
	server.addService(userServiceDefinition, {
		ListUsers: unary("ListUsers", async (_request: unknown, actor) => ({
			users: (await listUsers(db, actor)).map(toWireUser),
		})),

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
