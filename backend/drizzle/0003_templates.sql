-- A board that is kept to be copied rather than worked on (see db/schema.ts).
--
-- Safe on a populated table: every board that exists is a board someone is working on,
-- and the default says so without a backfill pass.
ALTER TABLE "boards" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;
