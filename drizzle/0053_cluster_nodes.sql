-- PostgreSQL replicas (src/lib/cluster-nodes.ts, ee/docs/high-availability.md):
-- the web replicas sharing one PostgreSQL database. Each registers when it
-- starts and records a heartbeat every few seconds; `leader` marks the one
-- that runs the background jobs (src/lib/db/leader.ts). On SQLite the table
-- exists and stays empty: there is one process.
CREATE TABLE `cluster_nodes` (
	`nodeId` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`version` text NOT NULL,
	`schemaVersion` text NOT NULL,
	`firstSeenAt` text NOT NULL,
	`startedAt` text NOT NULL,
	`lastHeartbeatAt` text NOT NULL,
	`stoppedAt` text,
	`leader` integer DEFAULT false NOT NULL,
	`leaderSince` text
);
