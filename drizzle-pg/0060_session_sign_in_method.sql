-- How the sign-in that created a dashboard session was made (drizzle/0060
-- has the same change for SQLite). The forward-auth portal reuses a
-- dashboard session only when it came from an identity provider.
ALTER TABLE "sessions" ADD COLUMN "signInMethod" text;
