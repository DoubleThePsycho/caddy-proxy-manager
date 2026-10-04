-- PostgreSQL replicas (src/lib/cluster-nodes.ts): the process that last
-- wrote a replica's row, a random token each web process draws when it
-- starts. Another live token on the same node id means a second process uses
-- that id (two containers on one data volume, or a copied INGRESSI_NODE_ID):
-- the newer one refuses to run as a replica. On SQLite the table stays empty.
ALTER TABLE `cluster_nodes` ADD `instanceToken` text;
