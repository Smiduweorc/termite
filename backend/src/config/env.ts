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
});

// Defaults are applied before validation so the schema stays a plain shape check -
// no morphs, no surprises about whether a default is validated as input or output.
const result = Env({
	NODE_ENV: process.env.NODE_ENV ?? "development",
	PORT: Number(process.env.PORT ?? 3000),
	GRPC_PORT: Number(process.env.GRPC_PORT ?? 50051),
	LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
	SERVICE_NAME: process.env.SERVICE_NAME ?? "bevd-lacewing-backend",
	DATABASE_URL: process.env.DATABASE_URL ?? "",
	CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
	JWT_SECRET: process.env.JWT_SECRET ?? "",
	JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY ?? "15m",
	JWT_ISSUER: process.env.JWT_ISSUER ?? "http://localhost:3000",
	JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? "http://localhost:3000/trpc",
	REFRESH_TOKEN_TTL_DAYS: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
	COOKIE_SAME_SITE: process.env.COOKIE_SAME_SITE ?? "lax",
});

if (result instanceof type.errors) {
	throw new Error(
		`Invalid environment:\n${result.summary}\n\nDid you copy .env.example to .env?`,
	);
}

export const env = result;
export type Env = typeof env;
