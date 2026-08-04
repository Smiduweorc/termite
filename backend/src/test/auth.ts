import type { Database } from "../db";
import { type PublicUser, toPublicUser, type UserRole, users } from "../db/schema";
import type { Actor } from "../lib/actor";
import { signAccessToken } from "../lib/jwt";
import { hashPassword } from "../lib/password";

interface SeedUserOptions {
	email?: string;
	name?: string;
	password?: string;
	role?: UserRole;
}

/** Inserts a user directly, skipping registration. Returns them without the hash. */
export async function seedUser(
	db: Database,
	{
		email = "user@example.com",
		name = "User",
		password = "password123",
		role = "user",
	}: SeedUserOptions = {},
): Promise<PublicUser> {
	const [user] = await db
		.insert(users)
		.values({ email, name, passwordHash: await hashPassword(password), role })
		.returning();

	if (!user) throw new Error("seedUser: insert returned no row");

	return toPublicUser(user);
}

export function actorFor(user: PublicUser): Actor {
	return { id: user.id, email: user.email, role: user.role };
}

/** A real signed token, for the gRPC tests that go over the wire as a client would. */
export function accessTokenFor(user: PublicUser): Promise<string> {
	return signAccessToken({ sub: user.id, email: user.email, role: user.role });
}
