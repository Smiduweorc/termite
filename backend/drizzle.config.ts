import { defineConfig } from "drizzle-kit";

// `bun run` loads .env from this directory before the drizzle-kit binary starts,
// so process.env is already populated here.
const url = process.env.DATABASE_URL;

if (!url) {
	throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: { url },
	strict: true,
	verbose: true,
});
