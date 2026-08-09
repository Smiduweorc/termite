-- Identity moves from the address as typed to the mailbox behind it (see lib/email.ts).
--
-- Hand-edited from what drizzle-kit generated, which was a bare `ADD COLUMN ... NOT NULL`
-- - correct against an empty database and a failure against any table that already has
-- users in it. The three steps below add the column, fill it, and only then make it a
-- constraint.
--
-- The backfill is `lower(email)`, which is what this codebase did before and is therefore
-- exactly right for every account it created. It is *not* the full canonical form: an
-- account stored as "john.doe+x@gmail.com" backfills to "john.doe+x@gmail.com" while a
-- new signup for the same mailbox would canonicalise to "johndoe@gmail.com". That is
-- deliberate. Rewriting existing rows to a stricter form could silently merge two
-- accounts into one identity; leaving them means the worst case is a duplicate that the
-- unique index below refuses loudly at migration time, with both rows still in front of
-- you to resolve by hand.
DROP INDEX "users_email_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_canonical" text;--> statement-breakpoint
UPDATE "users" SET "email_canonical" = lower("email") WHERE "email_canonical" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email_canonical" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_canonical_idx" ON "users" USING btree ("email_canonical");
