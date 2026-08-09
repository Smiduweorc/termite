import * as grpc from "@grpc/grpc-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db";
import type { PublicUser } from "../db/schema";
import { accessTokenFor, seedUser } from "../test/auth";
import { createTestDatabase } from "../test/db";
import { createTestMailer } from "../test/mail";
import { FeedbackServiceClient, ReleaseServiceClient, UserServiceClient } from "./proto";
import { createGrpcServer, startGrpcServer } from "./server";

/**
 * A real gRPC server on a real port, called by a real gRPC client with real signed
 * tokens in the metadata. Nothing is mocked: if the proto, the handlers and the
 * authorization rules disagree, this fails.
 */
interface WireFeedback {
	id: string;
	title: string;
	kind: string;
	status: string;
	author_id: string;
	release_id: string;
	votes: number;
	viewer_has_voted: boolean;
}

interface WireRelease {
	id: string;
	version: string;
	status: string;
	released_at: string;
	item_count: number;
}

interface WireUser {
	id: string;
	email: string;
	role: string;
}

type Client = grpc.Client & Record<string, (...args: unknown[]) => unknown>;

/** How a gRPC caller authenticates: bearer token in the request metadata. */
function bearer(token?: string): grpc.Metadata {
	const metadata = new grpc.Metadata();

	if (token) metadata.set("authorization", `Bearer ${token}`);

	return metadata;
}

function call<T>(client: Client, method: string, request: unknown, token?: string): Promise<T> {
	return new Promise((resolve, reject) => {
		client[method]?.(request, bearer(token), (error: grpc.ServiceError | null, reply: T) =>
			error ? reject(error) : resolve(reply),
		);
	});
}

describe("grpc", () => {
	let db: Database;
	let server: grpc.Server;
	let board: Client;
	let calendar: Client;
	let usersClient: Client;

	let alice: PublicUser;
	let bob: PublicUser;
	let admin: PublicUser;
	let aliceToken: string;
	let bobToken: string;
	let adminToken: string;

	beforeEach(async () => {
		db = await createTestDatabase();

		alice = await seedUser(db, { email: "alice@example.com", name: "Alice" });
		bob = await seedUser(db, { email: "bob@example.com", name: "Bob" });
		admin = await seedUser(db, { email: "root@example.com", name: "Root", role: "admin" });

		aliceToken = await accessTokenFor(alice);
		bobToken = await accessTokenFor(bob);
		adminToken = await accessTokenFor(admin);

		server = createGrpcServer(db, createTestMailer());

		const port = await startGrpcServer(server, 0);
		const address = `127.0.0.1:${port}`;
		const credentials = grpc.credentials.createInsecure();

		board = new FeedbackServiceClient(address, credentials) as Client;
		calendar = new ReleaseServiceClient(address, credentials) as Client;
		usersClient = new UserServiceClient(address, credentials) as Client;
	});

	afterEach(() => {
		board.close();
		calendar.close();
		usersClient.close();
		server.forceShutdown();
	});

	const file = (title: string, token?: string) =>
		call<WireFeedback>(board, "SubmitFeedback", { kind: "idea", title, body: "x" }, token);

	describe("FeedbackService", () => {
		it("reads the board without a token, because the board is public", async () => {
			await file("Filed by Alice", aliceToken);

			const { items } = await call<{ items: WireFeedback[] }>(board, "ListFeedback", {});

			expect(items.map((item) => item.title)).toEqual(["Filed by Alice"]);
			// No cookies out here, so nobody is "the viewer".
			expect(items[0]?.viewer_has_voted).toBe(false);
		});

		it("files as the token's owner, and counts their vote", async () => {
			const item = await file("Over gRPC", aliceToken);

			expect(item.author_id).toBe(alice.id);
			expect(item.status).toBe("open");
			expect(item.votes).toBe(1);
			expect(item.viewer_has_voted).toBe(true);
		});

		it("treats a forged token as nobody, not as its claimed owner", async () => {
			const item = await file("Alice's", aliceToken);
			const forged = `${aliceToken.slice(0, -3)}aaa`;

			// Filing still works - anyone may file, including nobody - but the forged
			// token buys none of Alice's authority over what she already filed.
			await expect(
				call(board, "EditFeedback", { id: item.id, title: "Hijacked" }, forged),
			).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });

			const anonymous = await file("Filed with a bad token", forged);
			expect(anonymous.author_id).toBe("");
		});

		it("has no voter to attribute an anonymous vote to", async () => {
			const item = await file("Something", aliceToken);

			await expect(call(board, "Vote", { id: item.id })).rejects.toMatchObject({
				code: grpc.status.UNAUTHENTICATED,
			});

			const voted = await call<WireFeedback>(board, "Vote", { id: item.id }, bobToken);
			expect(voted.votes).toBe(2);
		});

		it("stops one user rewording another's item", async () => {
			const item = await file("Alice's", aliceToken);

			await expect(
				call(board, "EditFeedback", { id: item.id, title: "Hijacked" }, bobToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
		});

		it("keeps triage to the maintainer, over this transport too", async () => {
			const item = await file("Alice's", aliceToken);

			await expect(
				call(board, "EditFeedback", { id: item.id, status: "planned" }, aliceToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });

			const declined = await call<WireFeedback>(
				board,
				"EditFeedback",
				{ id: item.id, status: "declined", maintainer_note: "Not this one." },
				adminToken,
			);

			expect(declined.status).toBe("declined");
		});

		it("maps a validation failure to INVALID_ARGUMENT", async () => {
			// protobuf is happy with an empty string. The service's arktype schema is not.
			await expect(
				call(board, "SubmitFeedback", { kind: "idea", title: "", body: "x" }, aliceToken),
			).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		});
	});

	describe("ReleaseService", () => {
		it("publishes the calendar to anyone and takes changes from the maintainer only", async () => {
			await expect(
				call(calendar, "CreateRelease", { version: "0.2" }, bobToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });

			const release = await call<WireRelease>(
				calendar,
				"CreateRelease",
				{ version: "0.2", status: "merge_window" },
				adminToken,
			);

			expect(release.status).toBe("merge_window");
			// Unset optional dates arrive as empty strings, not as nulls.
			expect(release.released_at).toBe("");

			const { releases } = await call<{ releases: WireRelease[] }>(
				calendar,
				"ListReleases",
				{},
			);
			expect(releases.map((r) => r.version)).toEqual(["0.2"]);
		});

		it("closes a merge window and ships what is in it", async () => {
			const release = await call<WireRelease>(
				calendar,
				"CreateRelease",
				{ version: "0.2", status: "merge_window" },
				adminToken,
			);

			const item = await file("In the window", aliceToken);

			await call(board, "EditFeedback", { id: item.id, release_id: release.id }, adminToken);

			const shipped = await call<WireRelease>(
				calendar,
				"ShipRelease",
				{ id: release.id },
				adminToken,
			);

			expect(shipped.status).toBe("released");
			expect(shipped.released_at).not.toBe("");
			expect(shipped.item_count).toBe(1);

			const after = await call<WireFeedback>(board, "GetFeedback", { id: item.id });
			expect(after.status).toBe("shipped");
		});

		it("rejects a duplicate version as ALREADY_EXISTS", async () => {
			await call(calendar, "CreateRelease", { version: "0.2" }, adminToken);

			await expect(
				call(calendar, "CreateRelease", { version: "0.2" }, adminToken),
			).rejects.toMatchObject({ code: grpc.status.ALREADY_EXISTS });
		});
	});

	describe("UserService (admin only)", () => {
		it("is UNAUTHENTICATED without a token", async () => {
			await expect(call(usersClient, "ListUsers", {})).rejects.toMatchObject({
				code: grpc.status.UNAUTHENTICATED,
			});
		});

		it("is PERMISSION_DENIED for an ordinary user", async () => {
			await expect(call(usersClient, "ListUsers", {}, bobToken)).rejects.toMatchObject({
				code: grpc.status.PERMISSION_DENIED,
			});

			await expect(
				call(usersClient, "SetUserRole", { user_id: bob.id, role: "admin" }, bobToken),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
		});

		it("lets an admin list and promote", async () => {
			const { users } = await call<{ users: WireUser[] }>(
				usersClient,
				"ListUsers",
				{},
				adminToken,
			);

			expect(users).toHaveLength(3);

			const promoted = await call<WireUser>(
				usersClient,
				"SetUserRole",
				{ user_id: bob.id, role: "admin" },
				adminToken,
			);

			expect(promoted.role).toBe("admin");
		});

		it("stops the last admin from demoting themselves", async () => {
			await expect(
				call(usersClient, "SetUserRole", { user_id: admin.id, role: "user" }, adminToken),
			).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		});
	});
});
