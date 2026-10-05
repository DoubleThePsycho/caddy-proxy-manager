/**
 * Server-side render of the Backups page (its destinations and runs, the
 * license notice, what stays possible without a license) and of the backups
 * line on the Change history page, which links to it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/history',
  useSearchParams: () => new URLSearchParams(),
}));

import HistoryClient from '@/ee/config-history/ui/HistoryClient';
import BackupsTab from '@/ee/backups/ui/BackupsTab';
import type { BackupDestinationView, BackupRunView } from '@/ee/backups/types';

const stamp = '2026-10-02T03:00:00.000Z';
const destination: BackupDestinationView = {
  id: 1, name: 'Offsite R2', enabled: true, endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'cfg',
  prefix: 'prod', pathStyle: true, accessKeyId: 'AKIA', hasSecretAccessKey: true, hasPassphrase: true,
  schedule: { kind: 'weekly', day: 'monday', time: '03:00' }, timeZone: 'Europe/Rome', retention: 14,
  nextRunAt: '2026-10-05T01:00:00.000Z', lastRunAt: stamp, lastStatus: 'failed', lastError: 'Upload failed: HTTP 403 (AccessDenied) from the storage',
  lastSuccessAt: null, consecutiveFailures: 2, running: false, createdAt: stamp, updatedAt: stamp,
};
const run: BackupRunView = {
  id: 7, destinationId: 1, destinationName: 'Offsite R2', trigger: 'schedule', status: 'success', startedAt: stamp, finishedAt: stamp,
  objectKey: 'prod/ingressi-config-2026-10-02T03-00-00.000Z.json', sizeBytes: 2048, sha256: 'ab'.repeat(32), prunedCount: 1, error: null, warning: null,
};

function renderBackups(configurable: boolean) {
  return renderToStaticMarkup(
    createElement(BackupsTab, {
      destinations: [destination],
      runs: { runs: [run], total: 1, page: 1, perPage: 25 },
      configurable,
      isSlave: false,
      editionLabel: 'Business',
      minPassphraseLength: 12,
      paginateRuns: true,
    })
  );
}

function renderHistory(destinations: BackupDestinationView[]) {
  // Without React's text separators, so sentences read as one.
  return renderToStaticMarkup(
    createElement(HistoryClient, {
      backups: { destinations },
      now: Date.parse(stamp),
      versions: { versions: [], total: 0, limit: 25, offset: 0, liveId: null, recording: { enabled: false, retention: 200 } },
      page: 1,
      perPage: 25,
      settings: { enabled: false, retention: 200 },
      configurable: true,
      isSlave: false,
      editionLabel: 'Homelab',
      limits: { minRetention: 1, maxRetention: 10000, minPassphraseLength: 12 },
    })
  ).replace(/<!-- -->/g, '');
}

describe('Backups page', () => {
  it('shows destinations, their schedule, failures and recent runs', () => {
    const html = renderBackups(true);
    expect(html).toContain('Offsite R2');
    expect(html).toContain('Mondays at 03:00 (Europe/Rome)');
    expect(html).toContain('Upload failed: HTTP 403 (AccessDenied) from the storage');
    expect(html).toContain('ingressi-config-2026-10-02T03-00-00.000Z.json');
    expect(html).not.toContain('needs a');
  });

  it('explains what works without a license', () => {
    const html = renderBackups(false);
    expect(html).toContain('Scheduled backups need an active Ingressi Business license or higher');
    expect(html).toContain('Enabled destinations keep backing up on schedule; you can still disable and delete them.');
    expect(html).toContain('free import');
  });
});

describe('Change history page, backups line', () => {
  it('summarises the backups and links to the Backups page', () => {
    const html = renderHistory([destination]);
    expect(html).toContain('Recording off');
    expect(html).toMatch(/<a [^>]*href="\/backups"[^>]*>Backups to Offsite R2, mondays at 03:00 \(europe\/rome\)/);
    expect(html).toContain('last failed');
    expect(html).not.toContain('role="tab"');
    expect(renderHistory([])).toMatch(/<a [^>]*href="\/backups"[^>]*>No scheduled backups<\/a>/);
  });
});
