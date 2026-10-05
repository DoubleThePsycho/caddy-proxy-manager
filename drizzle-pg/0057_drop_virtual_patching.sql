-- Virtual patching withdrawn (drizzle/0057_drop_virtual_patching.sql has the
-- same change for SQLite): its table and settings go.
DROP TABLE "virtual_patches" CASCADE;--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('virtual_patching', 'virtual_patching_state', 'virtual_patches');
