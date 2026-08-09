import { createTransport, type Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "./logger";

export interface Message {
	to: string;
	subject: string;
	text: string;
}

export interface Mailer {
	send(message: Message): Promise<void>;
}

/**
 * Mail without a mail server.
 *
 * A self-hosted board on a box with no SMTP relay is a normal situation, not a
 * misconfiguration, and the alternative - refusing to boot, or failing every invite with
 * a 500 - would be worse than useless. So an unset SMTP_HOST is a supported setup: the
 * message goes to the log at info, where the maintainer can copy the link out and send
 * it however they already talk to people.
 *
 * It is logged in full, deliberately. The link *is* the credential, so this is only
 * acceptable because it is the maintainer's own log on the maintainer's own box - which
 * is exactly the deployment this mode exists for. Set SMTP_HOST for anything else.
 */
function logOnlyMailer(): Mailer {
	return {
		async send({ to, subject, text }) {
			logger.info(
				{ event: "mail.not_sent", to, subject, body: text },
				"no SMTP_HOST configured - the message was not sent, only logged",
			);
		},
	};
}

function smtpMailer(transport: Transporter): Mailer {
	return {
		async send({ to, subject, text }) {
			await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });

			// The subject and recipient, never the body: the body holds a one-time link,
			// and logs get shipped, indexed and kept.
			logger.info({ event: "mail.sent", to, subject }, "mail sent");
		},
	};
}

/**
 * Built once at boot rather than per message, so the SMTP connection pool is reused -
 * a fresh TCP + TLS handshake per email is slow and looks like abuse to some relays.
 */
export function createMailer(): Mailer {
	if (!env.SMTP_HOST) return logOnlyMailer();

	const transport = createTransport({
		host: env.SMTP_HOST,
		port: env.SMTP_PORT,
		// false here does not mean plaintext: nodemailer still upgrades with STARTTLS
		// when the server offers it, which is what port 587 expects. `true` is implicit
		// TLS from the first byte, which is port 465.
		secure: env.SMTP_SECURE,
		pool: true,
		...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
	});

	return smtpMailer(transport);
}
