import { type } from "arktype";

const Env = type({
	NODE_ENV: "'development' | 'test' | 'production'",
	PORT: "1 <= number <= 65535",
	GRPC_PORT: "1 <= number <= 65535",
	LOG_LEVEL: "'debug' | 'info' | 'warn' | 'error' | 'silent'",
	// Tags every log line, so one stream can carry more than one service.
	SERVICE_NAME: "string > 0",
	DATABASE_URL: "string > 0",
	CORS_ORIGIN: "string > 0",

	// 32 characters is only the first gate. lacewing entropy-checks the secret
	// when it imports the key: a human-chosen passphrase - even a long one -
	// throws EntropyCheckFailed and the app refuses to boot. Generate one with
	//   openssl rand -base64 48
	JWT_SECRET: "string >= 32",
	// Anything lacewing's duration parser accepts: "15m", "1h". Capped at 1h -
	// access tokens above that refuse to sign, and that cap is the point.
	JWT_ACCESS_EXPIRY: "string > 0",
	// `iss`/`aud` are pinned at verification; a token minted for another
	// deployment fails here regardless of its signature.
	JWT_ISSUER: "string > 0",
	JWT_AUDIENCE: "string > 0",
	REFRESH_TOKEN_TTL_DAYS: "1 <= number <= 365",

	// No COOKIE_SECURE switch: every cookie this app sets is Secure,
	// unconditionally (lacewing will not emit anything weaker, and the CSRF
	// cookie matches it). http://localhost counts as a secure context, so dev
	// works; anything non-local must be https. "none" is likewise not an
	// option - cross-site token cookies are how CSRF happens.
	COOKIE_SAME_SITE: "'lax' | 'strict'",

	/**
	 * The Domain to put on the CSRF cookie, and only on that one. Empty means host-only,
	 * which is the default and the right answer when the board and the API share a host.
	 *
	 * It exists because the CSRF cookie is the one cookie the *page* has to read (see
	 * lib/csrf.ts): a host-only cookie set by api.example.com is invisible to script on
	 * board.example.com, so the page cannot echo the header and every mutation is refused.
	 * Widening that one cookie to the parent domain is what makes a split deployment work.
	 *
	 * The cost is real and worth stating: any subdomain of this value can then read *and
	 * write* the token, so a hostile or compromised one can plant a value it knows and
	 * echo it back, which is exactly the double-submit bypass context.ts refuses to guess
	 * its way into. Set this only across hosts you control, and leave it empty otherwise.
	 * The session cookies are deliberately not widened - they stay host-only.
	 */
	COOKIE_DOMAIN: type("string == 0").or(
		// Lowercase LDH labels, at least two of them: a single label ("localhost") is not
		// a domain a browser will scope a cookie to, and no dot means no sharing to do.
		type(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
	),

	// Where the board is served to people, which is what an invite or reset link has to
	// point at. It is the frontend's origin, not the API's.
	APP_URL: "string > 0",

	// --- Mail -----------------------------------------------------------------------
	// SMTP is optional, and an empty host is a supported configuration rather than a
	// broken one: a self-hosted board with no mail server still works, it just prints
	// the link to the log for the maintainer to pass on by hand. See lib/mailer.ts.
	SMTP_HOST: "string",
	SMTP_PORT: "1 <= number <= 65535",
	// Implicit TLS on connect (port 465). Leave it off for 587, which upgrades with
	// STARTTLS - nodemailer does that on its own, and refuses to send in the clear.
	SMTP_SECURE: "boolean",
	SMTP_USER: "string",
	SMTP_PASSWORD: "string",
	// What the recipient sees in From:. Plain address or "Name <address>".
	MAIL_FROM: "string > 0",
});

// Defaults are applied before validation so the schema stays a plain shape check -
// no morphs, no surprises about whether a default is validated as input or output.
const result = Env({
	NODE_ENV: process.env.NODE_ENV ?? "development",
	PORT: Number(process.env.PORT ?? 3000),
	GRPC_PORT: Number(process.env.GRPC_PORT ?? 50051),
	LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
	SERVICE_NAME: process.env.SERVICE_NAME ?? "termite-backend",
	DATABASE_URL: process.env.DATABASE_URL ?? "",
	CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
	JWT_SECRET: process.env.JWT_SECRET ?? "",
	JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY ?? "15m",
	JWT_ISSUER: process.env.JWT_ISSUER ?? "http://localhost:3000",
	JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? "http://localhost:3000/trpc",
	REFRESH_TOKEN_TTL_DAYS: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
	COOKIE_SAME_SITE: process.env.COOKIE_SAME_SITE ?? "lax",
	// A leading dot is how this was written for years and browsers still strip it, so it
	// is accepted and normalised rather than rejected on a technicality.
	COOKIE_DOMAIN: (process.env.COOKIE_DOMAIN ?? "").trim().toLowerCase().replace(/^\./, ""),
	APP_URL: process.env.APP_URL ?? "http://localhost:5173",
	SMTP_HOST: process.env.SMTP_HOST ?? "",
	SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
	SMTP_SECURE: (process.env.SMTP_SECURE ?? "false") === "true",
	SMTP_USER: process.env.SMTP_USER ?? "",
	SMTP_PASSWORD: process.env.SMTP_PASSWORD ?? "",
	MAIL_FROM: process.env.MAIL_FROM ?? "Termite <termite@localhost>",
});

if (result instanceof type.errors) {
	throw new Error(
		`Invalid environment:\n${result.summary}\n\nDid you copy .env.example to .env?`,
	);
}

export const env = result;
export type Env = typeof env;
