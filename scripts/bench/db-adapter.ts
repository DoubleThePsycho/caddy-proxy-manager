/**
 * The only part of the database benchmark (scripts/bench/db-hot-paths.ts)
 * that depends on the database API: the asynchronous facade `appDb` here.
 * A copy of the harness on a commit from before the asynchronous conversion
 * swaps this file for one written against the synchronous Drizzle instance;
 * everything else, the seed included, is shared.
 */
import { eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { first } from "@/src/lib/db/ops";
import { proxyHosts, settings, users } from "@/src/lib/db/schema";

export const DB_API = "async (appDb, gated executor)";

/** One indexed single-row read: the smallest unit of database work. */
export async function pointQuery(userId: number): Promise<unknown> {
  return await first(
    appDb.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
  );
}

/** Read a row, update it and upsert a setting in one transaction (check, then act). */
export async function readModifyWrite(hostId: number, stamp: string): Promise<void> {
  await appDb.transaction(async (tx) => {
    const host = await first(
      tx.select({ id: proxyHosts.id, name: proxyHosts.name }).from(proxyHosts).where(eq(proxyHosts.id, hostId)).limit(1)
    );
    if (!host) throw new Error(`Proxy host ${hostId} not found`);
    await tx.update(proxyHosts).set({ updatedAt: stamp }).where(eq(proxyHosts.id, hostId));
    await tx
      .insert(settings)
      .values({ key: "bench_touch", value: JSON.stringify({ host: host.name }), updatedAt: stamp })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify({ host: host.name }), updatedAt: stamp } });
  });
}
