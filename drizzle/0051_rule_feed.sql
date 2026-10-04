-- Virtual patching (ee/rule-feed): the patches a verified rule feed
-- delivered, one row per pack, keyed by the pack id. `rules` holds the
-- pack's SecRule lines as published (validated again before every use),
-- `ruleIds` their ids in the reserved range 1800000000-1800999999, and the
-- other JSON columns the CVE details the dashboard shows. `mode` (off,
-- detect, block) is the administrator's choice; a pack missing from a newer
-- feed keeps its mode and gets `withdrawnAt`. The subscription settings and
-- the installed feed are the settings "virtual_patching" and
-- "virtual_patching_state".
CREATE TABLE `virtual_patches` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`severity` text NOT NULL,
	`cves` text DEFAULT '[]' NOT NULL,
	`affected` text DEFAULT '[]' NOT NULL,
	`referenceUrls` text DEFAULT '[]' NOT NULL,
	`rules` text DEFAULT '[]' NOT NULL,
	`ruleIds` text DEFAULT '[]' NOT NULL,
	`samples` text DEFAULT '{"positive":[],"negative":[]}' NOT NULL,
	`defaultMode` text DEFAULT 'detect' NOT NULL,
	`example` integer DEFAULT false NOT NULL,
	`publishedAt` text NOT NULL,
	`packUpdatedAt` text NOT NULL,
	`mode` text DEFAULT 'off' NOT NULL,
	`modeChangedAt` text,
	`feedSequence` integer,
	`withdrawnAt` text,
	`firstSeenAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
