import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		// Tests never touch the docker-compose database - they run against PGlite, an
		// in-process Postgres. These values only exist to satisfy env validation.
		env: {
			NODE_ENV: "test",
			PORT: "3000",
			GRPC_PORT: "50051",
			// The logging middleware still runs, it just does not print. Set this to
			// "debug" when a test fails and you want to see what the server saw.
			LOG_LEVEL: "silent",
			SERVICE_NAME: "bevd-lacewing-backend-test",
			DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
			CORS_ORIGIN: "http://localhost:5173",
			// A throwaway signing key. It has to be random-looking, not just long -
			// lacewing's entropy check has no test-mode bypass, which is the point.
			JWT_SECRET: "KxTa6t5hnM9lWSWZclyiVjcc+E+s7smif8Tvvrorh0TgxU5lzqpu1AsVsQTjMMZb",
			JWT_ACCESS_EXPIRY: "15m",
			JWT_ISSUER: "http://localhost:3000",
			JWT_AUDIENCE: "http://localhost:3000/trpc",
			REFRESH_TOKEN_TTL_DAYS: "7",
			COOKIE_SAME_SITE: "lax",
		},
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/test/**", "src/db/seed.ts"],
		},
	},
});
