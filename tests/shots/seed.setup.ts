/**
 * Seeds the e2e stack once, before the screenshots (the "seed" project in
 * playwright.shots.config.ts). SHOTS_SKIP_SEED=1 skips it, for another round
 * of screenshots on a stack that is already seeded (with SHOTS_REUSE_STACK=1).
 */
import { test } from '@playwright/test';
import { seedAll } from './seed';

test('seed the install', async ({ request }) => {
  test.skip(process.env.SHOTS_SKIP_SEED === '1', 'SHOTS_SKIP_SEED=1');
  test.setTimeout(600_000);
  const seeder = await seedAll(request);
  for (const problem of seeder.problems) console.log(`[shots] seed problem: ${problem}`);
  console.log(`[shots] seeded: ${JSON.stringify(seeder.ids)}`);
  if (!seeder.ids['host:shop']) throw new Error('The proxy hosts could not be created; see the problems above');
});
