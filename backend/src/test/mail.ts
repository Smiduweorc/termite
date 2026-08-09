import type { Mailer, Message } from "../lib/mailer";

export interface TestMailer extends Mailer {
	/** Everything that would have gone out, in order. */
	readonly sent: Message[];
	/** The one-time token out of the most recent link, which is what a test clicks. */
	lastToken(): string | undefined;
}

/**
 * A mailer that keeps the post instead of sending it.
 *
 * Tests care about two things: that a message went to the right person, and what the
 * link in it lets them do. Pulling the token back out here is what lets a test walk the
 * whole invite flow - create the account, read the mail, set the password, sign in -
 * without an SMTP server anywhere in sight.
 */
export function createTestMailer(): TestMailer {
	const sent: Message[] = [];

	return {
		sent,
		async send(message) {
			sent.push(message);
		},
		lastToken() {
			const body = sent.at(-1)?.text ?? "";

			return /[?&]token=([A-Za-z0-9_-]+)/.exec(body)?.[1];
		},
	};
}
