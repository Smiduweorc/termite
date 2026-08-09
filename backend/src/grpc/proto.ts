import { join } from "node:path";
import type { ServiceDefinition } from "@grpc/grpc-js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// Relative to this file, so it does not matter where the process was launched from -
// backend/, the repo root, or a test runner with a cwd of its own.
const PROTO_DIR = join(import.meta.dirname, "..", "..", "proto");

const definition = protoLoader.loadSync(
	[join(PROTO_DIR, "board.proto"), join(PROTO_DIR, "auth.proto"), join(PROTO_DIR, "user.proto")],
	{
		// Keep snake_case field names exactly as the .proto declares them, so what you read
		// here matches what a Go or Python client sends.
		keepCase: true,
		longs: String,
		enums: String,
		defaults: true,
		oneofs: true,
		// user.proto does `import "auth.proto"`, which is resolved from here.
		includeDirs: [PROTO_DIR],
	},
);

const loaded = grpc.loadPackageDefinition(definition) as unknown as {
	termite: {
		board: {
			v1: {
				FeedbackService: grpc.ServiceClientConstructor;
				ReleaseService: grpc.ServiceClientConstructor;
			};
		};
		auth: { v1: { AuthService: grpc.ServiceClientConstructor } };
		user: { v1: { UserService: grpc.ServiceClientConstructor } };
	};
};

export const FeedbackServiceClient = loaded.termite.board.v1.FeedbackService;
export const ReleaseServiceClient = loaded.termite.board.v1.ReleaseService;
export const AuthServiceClient = loaded.termite.auth.v1.AuthService;
export const UserServiceClient = loaded.termite.user.v1.UserService;

export const feedbackServiceDefinition: ServiceDefinition = FeedbackServiceClient.service;
export const releaseServiceDefinition: ServiceDefinition = ReleaseServiceClient.service;
export const authServiceDefinition: ServiceDefinition = AuthServiceClient.service;
export const userServiceDefinition: ServiceDefinition = UserServiceClient.service;
