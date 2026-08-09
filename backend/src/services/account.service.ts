import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../config/env";
import type { Database } from "../db";
import {
	type PasswordTokenPurpose,
	type PublicUser,
	passwordTokens,
	toPublicUser,
	users,
} from "../db/schema";
import { type Actor, requireAdmin } from "../lib/actor";
import { canonicalEmail } from "../lib/email";
import { AppError, isUniqueViolation, parseInput } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { Mailer } from "../lib/mailer";
import { hashPassword } from "../lib/password";
import { generateLinkToken, hashLinkToken } from "../lib/tokens";
import { revokeAllSessions } from "./auth.service";

export const CreateAccountInput = type({
	email: "string.email",
	name: "1 <= string <= 100",
	"role?": "'user' | 'admin'",
});

export const UserIdInput = type({ userId: "string.uuid" });

export const RequestResetInput = type({ email: "string.email" });

export const SetPasswordInput = type({
	token: "1 <= string <= 200",
	// argon2 has no length ceiling of its own - the cap is here only to stop someone
	// posting a megabyte and making us hash it.
	password: "8 <= string <= 128",
});

/**
 * How long each kind of link lives.
 *
 * An invite has to survive someone's weekend; a reset is a response to something the
 * person is doing right now, so it does not need to outlive the hour and should not.
 */
const TTL_MS: Record<PasswordTokenPurpose, number> = {
	invite: 7 * 24 * 60 * 60 * 1000,
	reset: 60 * 60 * 1000,
};

/**
 * Mints a one-time link and stores only its hash.
 *
 * Any outstanding links for the same person are burned first. Two live reset links mean
 * two live keys, and the second one usually exists because the first went astray.
 */
export async function issueLink(
	db: Database,
	userId: string,
	purpose: PasswordTokenPurpose,
): Promise<string> {
	const token = generateLinkToken();

	await db.transaction(async (tx) => {
		await tx
			.update(passwordTokens)
			.set({ usedAt: new Date() })
			.where(and(eq(passwordTokens.userId, userId), isNull(passwordTokens.usedAt)));

		await tx.insert(passwordTokens).values({
			userId,
			tokenHash: hashLinkToken(token),
			purpose,
			expiresAt: new Date(Date.now() + TTL_MS[purpose]),
		});
	});

	return token;
}

/** The link a person clicks. It points at the board, not at the API. */
export function linkFor(token: string): string {
	return `${env.APP_URL.replace(/\/$/, "")}/?token=${token}`;
}

async function sendLink(
	mail: Mailer,
	user: PublicUser,
	purpose: PasswordTokenPurpose,
	token: string,
): Promise<void> {
	const link = linkFor(token);

	const body =
		purpose === "invite"
			? [
					`Hello ${user.name},`,
					"",
					"An account has been created for you on this Termite board. Pick a password here:",
					"",
					link,
					"",
					"The link works once, and expires in seven days.",
				]
			: [
					`Hello ${user.name},`,
					"",
					"Someone asked to reset the password on your Termite account. If that was you:",
					"",
					link,
					"",
					"The link works once, and expires in an hour. If it was not you, ignore this - nothing has changed.",
				];

	await mail.send({
		to: user.email,
		subject: purpose === "invite" ? "Your Termite account" : "Reset your Termite password",
		text: body.join("\n"),
	});
}

/**
 * Creating an account is the maintainer's job now.
 *
 * There is no self-service registration: a feedback board takes anonymous input by
 * design, so an account exists only to give someone authority over the board, and
 * handing that out automatically to whoever fills in a form is not a thing anyone wants.
 *
 * The new account gets no usable password - just a random hash nobody holds the input
 * for - so the only way in is the invite link. That is better than a temporary password
 * emailed in the clear, and it means an unaccepted invite leaves no working credential
 * behind.
 */
export async function createAccount(
	db: Database,
	log: Logger,
	mail: Mailer,
	actor: Actor | null,
	input: unknown,
): Promise<PublicUser> {
	const admin = requireAdmin(actor);
	const { email, name, role } = parseInput(CreateAccountInput, input);

	try {
		const [created] = await db
			.insert(users)
			.values({
				// Kept as typed, because that is the address the invite is sent to and
				// the one they will recognise. Identity is the canonical form beside it.
				email: email.trim(),
				emailCanonical: canonicalEmail(email),
				name,
				passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
				role: role ?? "user",
			})
			.returning();

		if (!created) {
			throw new AppError("INTERNAL", "Insert returned no row");
		}

		const user = toPublicUser(created);

		await sendLink(mail, user, "invite", await issueLink(db, user.id, "invite"));

		log.warn(
			{ event: "account.created", actorId: admin.id, userId: user.id, role: user.role },
			"account created",
		);

		return user;
	} catch (error) {
		// The UNIQUE index on email decides this, not a lookup beforehand.
		if (isUniqueViolation(error)) {
			throw new AppError("CONFLICT", "That email already has an account");
		}

		throw error;
	}
}

/** Sends the invite again - for the link that expired, or the mail that never arrived. */
export async function resendInvite(
	db: Database,
	log: Logger,
	mail: Mailer,
	actor: Actor | null,
	input: unknown,
): Promise<{ ok: true }> {
	const admin = requireAdmin(actor);
	const { userId } = parseInput(UserIdInput, input);

	const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

	if (!user) {
		throw new AppError("NOT_FOUND", `No user with id ${userId}`);
	}

	await sendLink(mail, toPublicUser(user), "invite", await issueLink(db, user.id, "invite"));

	log.info({ event: "account.invite_resent", actorId: admin.id, userId }, "invite resent");

	return { ok: true };
}

/**
 * Always answers the same way.
 *
 * "No account with that email" would turn this form into a way to test which addresses
 * have accounts, so it says nothing either way - the mail is the only signal, and it
 * only reaches the person who owns the inbox.
 */
export async function requestPasswordReset(
	db: Database,
	log: Logger,
	mail: Mailer,
	input: unknown,
): Promise<{ ok: true }> {
	const { email } = parseInput(RequestResetInput, input);

	const user = await db.query.users.findFirst({
		where: eq(users.emailCanonical, canonicalEmail(email)),
	});

	if (!user) {
		log.info({ event: "account.reset_requested", known: false }, "reset requested");

		return { ok: true };
	}

	await sendLink(mail, toPublicUser(user), "reset", await issueLink(db, user.id, "reset"));

	log.info({ event: "account.reset_requested", known: true, userId: user.id }, "reset requested");

	return { ok: true };
}

/**
 * Spends the link and sets the password.
 *
 * The token is claimed with a single conditional UPDATE rather than a read followed by a
 * write: two clicks arriving together would both pass a "is it still unused?" check and
 * both go through. Here the database decides, once, and the loser gets a plain rejection.
 *
 * Claim and password write are one transaction, so the two cannot come apart - a link is
 * spent exactly when it actually changed a password. An expired link rolls the claim
 * back rather than consuming it, which costs nothing: the expiry is what makes it dead,
 * and a dead link stays dead however many times it is tried.
 */
export async function setPassword(
	db: Database,
	log: Logger,
	input: unknown,
): Promise<{ ok: true }> {
	const { token, password } = parseInput(SetPasswordInput, input);

	const passwordHash = await hashPassword(password);
	const rejected = new AppError("BAD_REQUEST", "That link is invalid, expired or already used");

	const userId = await db.transaction(async (tx) => {
		const [claimed] = await tx
			.update(passwordTokens)
			.set({ usedAt: new Date() })
			.where(
				and(
					eq(passwordTokens.tokenHash, hashLinkToken(token)),
					isNull(passwordTokens.usedAt),
				),
			)
			.returning();

		if (!claimed || claimed.expiresAt.getTime() < Date.now()) {
			throw rejected;
		}

		await tx
			.update(users)
			.set({ passwordHash, updatedAt: new Date() })
			.where(eq(users.id, claimed.userId));

		return claimed.userId;
	});

	// Whoever was signed in with the old password is signed out. If the reset happened
	// because the account was taken, this is the half that actually evicts them.
	await revokeAllSessions(db, userId);

	log.warn({ event: "account.password_set", userId }, "password set");

	return { ok: true };
}
