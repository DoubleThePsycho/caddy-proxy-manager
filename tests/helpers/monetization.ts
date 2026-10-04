/**
 * Seeds API monetization rows (ee/monetization) into a test database.
 * Amounts are micro-units (1 USD = 1,000,000).
 */
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { generateConsumerKey } from '../../ee/monetization/keys';
import { first } from '@/src/lib/db/ops';

const now = () => new Date().toISOString();

export async function insertPlan(
  db: TestDb,
  values: Partial<typeof schema.monetizationPlans.$inferInsert> = {}
): Promise<typeof schema.monetizationPlans.$inferSelect> {
  return (await first(db
    .insert(schema.monetizationPlans)
    .values({ name: `Plan ${Math.random().toString(36).slice(2, 8)}`, pricePerRequestMicros: 1_000, createdAt: now(), updatedAt: now(), ...values })
    .returning()))!;
}

export async function insertConsumer(
  db: TestDb,
  values: Partial<typeof schema.monetizationConsumers.$inferInsert> = {}
): Promise<typeof schema.monetizationConsumers.$inferSelect> {
  return (await first(db
    .insert(schema.monetizationConsumers)
    .values({ name: 'Acme', createdAt: now(), updatedAt: now(), ...values })
    .returning()))!;
}

/** Inserts a key and returns the raw key with the row. */
export async function insertKey(db: TestDb, consumerId: number, values: Partial<typeof schema.monetizationKeys.$inferInsert> = {}) {
  const key = generateConsumerKey();
  const row = (await first(db
    .insert(schema.monetizationKeys)
    .values({ consumerId, prefix: key.prefix, keyHash: key.hash, createdAt: now(), ...values })
    .returning()))!;
  return { raw: key.raw, row };
}

export async function insertProxyHost(db: TestDb, values: Partial<typeof schema.proxyHosts.$inferInsert> = {}) {
  return (await first(db
    .insert(schema.proxyHosts)
    .values({
      name: 'API',
      domains: JSON.stringify(['api.example.com']),
      upstreams: JSON.stringify(['10.0.0.9:8080']),
      createdAt: now(),
      updatedAt: now(),
      ...values,
    })
    .returning()))!;
}

export async function insertMonetizedHost(
  db: TestDb,
  proxyHostId: number,
  values: Partial<typeof schema.monetizationHosts.$inferInsert> = {}
) {
  return (await first(db
    .insert(schema.monetizationHosts)
    .values({ proxyHostId, enabled: true, keyHeader: 'Authorization', allowedPlanIds: '[]', createdAt: now(), updatedAt: now(), ...values })
    .returning()))!;
}
