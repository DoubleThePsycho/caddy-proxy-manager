-- Virtual patching (ee/rule-feed) was withdrawn before it shipped: its table
-- and settings go. "virtual_patching" and "virtual_patching_state" held the
-- subscription and the installed feed, "virtual_patches" the patches a sync
-- replica got from its master.
DROP TABLE IF EXISTS `virtual_patches`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('virtual_patching', 'virtual_patching_state', 'virtual_patches');
