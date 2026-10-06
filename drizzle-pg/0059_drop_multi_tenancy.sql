-- Multi-tenancy withdrawn (drizzle/0059_drop_multi_tenancy.sql has the same
-- change for SQLite): organisations and every organizationId column go, and
-- the rows they held belong to the install. Organisation users are disabled
-- and become viewers; their sessions end. A group that shares its name with
-- another gets its organisation's slug appended (then its id, if that still
-- clashes).
DROP TRIGGER IF EXISTS "users_organization_role_insert" ON "users";--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_organization_role_update" ON "users";--> statement-breakpoint
DROP FUNCTION IF EXISTS "users_organization_role_guard"();--> statement-breakpoint
DELETE FROM "forward_auth_exchanges" WHERE "sessionId" IN (
	SELECT "id" FROM "forward_auth_sessions" WHERE "userId" IN (SELECT "id" FROM "users" WHERE "organizationId" IS NOT NULL)
);--> statement-breakpoint
DELETE FROM "forward_auth_sessions" WHERE "userId" IN (SELECT "id" FROM "users" WHERE "organizationId" IS NOT NULL);--> statement-breakpoint
DELETE FROM "sessions" WHERE "userId" IN (SELECT "id" FROM "users" WHERE "organizationId" IS NOT NULL);--> statement-breakpoint
UPDATE "users"
SET "role" = 'viewer', "customRoleId" = NULL, "status" = 'disabled',
	"updatedAt" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE "organizationId" IS NOT NULL;--> statement-breakpoint
UPDATE "groups"
SET "name" = "groups"."name" || ' (' || coalesce(
	(SELECT "slug" FROM "organizations" WHERE "organizations"."id" = "groups"."organizationId"),
	'organisation ' || "groups"."organizationId"
) || ')'
WHERE "organizationId" IS NOT NULL
	AND "name" IN (SELECT "name" FROM "groups" GROUP BY "name" HAVING count(*) > 1);--> statement-breakpoint
UPDATE "groups"
SET "name" = "name" || ' #' || "id"
WHERE "organizationId" IS NOT NULL
	AND "name" IN (SELECT "name" FROM "groups" GROUP BY "name" HAVING count(*) > 1);--> statement-breakpoint
DROP TABLE "organizations" CASCADE;--> statement-breakpoint
DROP INDEX "access_lists_organization_idx";--> statement-breakpoint
DROP INDEX "audit_events_organization_idx";--> statement-breakpoint
DROP INDEX "certificates_organization_idx";--> statement-breakpoint
DROP INDEX "groups_organization_name_unique";--> statement-breakpoint
DROP INDEX "proxy_hosts_organization_idx";--> statement-breakpoint
DROP INDEX "users_organization_idx";--> statement-breakpoint
DROP INDEX "analytics_questions_shared_idx";--> statement-breakpoint
DROP INDEX "analytics_saved_views_shared_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_unique" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE INDEX "analytics_questions_shared_idx" ON "analytics_questions" USING btree ("shared");--> statement-breakpoint
CREATE INDEX "analytics_saved_views_shared_idx" ON "analytics_saved_views" USING btree ("shared");--> statement-breakpoint
ALTER TABLE "access_lists" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "analytics_questions" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "analytics_saved_views" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "certificates" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "proxy_hosts" DROP COLUMN "organizationId";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organizationId";
