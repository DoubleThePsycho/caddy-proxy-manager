-- PostgreSQL replicas (src/lib/cluster-nodes.ts; drizzle/0055 is the same
-- column for SQLite): the process that last wrote a replica's row, a random
-- token each web process draws when it starts. Another live token on the
-- same node id means a second process uses that id: the newer one refuses to
-- run as a replica.
ALTER TABLE "cluster_nodes" ADD COLUMN "instanceToken" text;
