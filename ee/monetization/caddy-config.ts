// SPDX-License-Identifier: Elastic-2.0
/**
 * What the Caddy configuration builder (src/lib/caddy.ts) needs for API
 * monetization: the monetized proxy hosts and the gate token that Caddy sends
 * with every gate subrequest. A slave gates only the monetized hosts its
 * master sent in the replica section (replica-index.ts); without one it
 * serves none. Never checks the license.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationHosts } from "@/src/lib/db/schema";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { adoptGateSecret } from "./engine";
import { ensureGateSecret } from "./settings";
import { readReplicaSection } from "./replica-sync";

export type MonetizationCaddyOptions = {
  gateToken: string;
  /** Proxy host ids with monetization on. */
  hostIds: ReadonlySet<number>;
};

export async function loadMonetizationForCaddy(): Promise<MonetizationCaddyOptions | null> {
  if ((await getInstanceMode()) === "slave") {
    // A replica gates the monetized hosts its master sent with their gate (replica-index.ts), with its own gate token.
    const section = await readReplicaSection();
    if (!section || section.hosts.length === 0) return null;
    const secret = await ensureGateSecret();
    adoptGateSecret(secret);
    return { gateToken: secret.token, hostIds: new Set(section.hosts.map((host) => host.proxyHostId)) };
  }
  const rows = await appDb
    .select({ proxyHostId: monetizationHosts.proxyHostId })
    .from(monetizationHosts)
    .where(eq(monetizationHosts.enabled, true));
  if (rows.length === 0) return null;
  const secret = await ensureGateSecret();
  adoptGateSecret(secret);
  return { gateToken: secret.token, hostIds: new Set(rows.map((row) => row.proxyHostId)) };
}
