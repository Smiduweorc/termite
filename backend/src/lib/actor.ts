import type { UserRole } from "../db/schema";
import { AppError } from "./errors";

/**
 * Who is making this call. Null means nobody - an anonymous request.
 *
 * The actor is resolved once at the edge (from a cookie over HTTP, from metadata over
 * gRPC) and then handed to services, which is the only thing they know about identity.
 * No service ever sees a token, a header or a cookie.
 */
export interface Actor {
	id: string;
	email: string;
	role: UserRole;
}

/** Authentication: is there anyone there at all? */
export function requireActor(actor: Actor | null): Actor {
	if (!actor) {
		throw new AppError("UNAUTHORIZED", "You must be signed in");
	}

	return actor;
}

/** Authorization: are they allowed? */
export function requireAdmin(actor: Actor | null): Actor {
	const current = requireActor(actor);

	if (current.role !== "admin") {
		throw new AppError("FORBIDDEN", "Admins only");
	}

	return current;
}

/**
 * The rule behind every "you can edit your own, admins can edit anyone" check.
 * Kept in one place so a new resource cannot quietly get it wrong.
 */
export function canMutate(actor: Actor, ownerId: string): boolean {
	return actor.role === "admin" || actor.id === ownerId;
}
