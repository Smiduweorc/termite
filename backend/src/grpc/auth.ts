import type { Metadata } from "@grpc/grpc-js";
import { parseBearer } from "lacewing";
import type { Actor } from "../lib/actor";
import { verifyAccessToken } from "../lib/jwt";

/**
 * The gRPC counterpart of the cookie read in trpc/context.ts.
 *
 * gRPC has no cookies, so the access token arrives as request metadata:
 *
 *   const metadata = new grpc.Metadata();
 *   metadata.set("authorization", `Bearer ${accessToken}`);
 *   client.CreatePost(request, metadata, callback);
 *
 * The header goes through lacewing's parseBearer - strict RFC 6750, exactly
 * one well-formed `Bearer <token>`, exact-case scheme, no smuggling a second
 * token in. (No CSRF check here: there is no cookie jar for a cross-site
 * page to ride, the caller had to hold the token to send it.)
 *
 * A missing or rotten token resolves to null - anonymous - and it is the service that
 * decides whether that is good enough (reads: yes; writes: no). Same rules as tRPC,
 * because it is the same service.
 */
export async function actorFromMetadata(metadata: Metadata): Promise<Actor | null> {
	const header = metadata.get("authorization")[0];

	if (typeof header !== "string") return null;

	try {
		const payload = await verifyAccessToken(parseBearer(header));

		return { id: payload.sub, email: payload.email, role: payload.role };
	} catch {
		return null;
	}
}
