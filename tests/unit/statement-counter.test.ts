/**
 * tests/helpers/statement-counter.ts sees the statements a test database
 * runs, on either dialect, so a test asserting that a path runs none is not
 * vacuous.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers/db';
import { countStatements } from '../helpers/statement-counter';
import { settings } from '../../src/lib/db/schema';
import { first } from '../../src/lib/db/ops';

describe('countStatements', () => {
  it('records queries and transactions, and stops recording when stopped', async () => {
    const db = createTestDb();
    // The first query of a PostgreSQL test database waits for it to be emptied.
    await db.select().from(settings);

    const counter = countStatements(db);
    await first(db.select().from(settings).where(eq(settings.key, 'counted')));
    await db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: 'counted', value: '1', updatedAt: new Date().toISOString() });
    });
    expect(counter.statements.length).toBeGreaterThanOrEqual(2);
    expect(counter.statements[0]).toMatch(/select/i);

    counter.stop();
    const seen = counter.statements.length;
    await db.select().from(settings);
    expect(counter.statements).toHaveLength(seen);
  });
});
