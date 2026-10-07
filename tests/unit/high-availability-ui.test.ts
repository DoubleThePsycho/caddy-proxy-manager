/**
 * Server-side render of the Certificate storage section of Certificate settings
 * (ee/high-availability/ui): editing, enabling and going back to local
 * storage, read-only for a read-only role and on a slave, the migration
 * commands, and no secret in the markup.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/certificates/settings',
  useSearchParams: () => new URLSearchParams(),
}));

import CertificateStorageSection from '@/ee/high-availability/ui/CertificateStorageSection';
import type { CertificateStorageView } from '@/ee/high-availability/types';

const redisView = {
  mode: 'standalone' as const,
  addresses: ['valkey.example.com:6379'],
  masterName: null,
  db: 0,
  username: null,
  keyPrefix: 'caddy/eu',
  hasPassword: true,
  passwordEnv: null,
  hasSentinelPassword: false,
  sentinelPasswordEnv: null,
  hasEncryptionKey: false,
  encryptionKeyEnv: 'CADDY_STORAGE_ENCRYPTION_KEY',
  tls: { enabled: false, insecureSkipVerify: false, caPem: null },
};

function view(overrides: Partial<CertificateStorageView> = {}): CertificateStorageView {
  return {
    backend: 'redis',
    redis: redisView,
    source: 'local',
    updatedAt: '2026-10-01T00:00:00.000Z',
    editable: true,
    error: null,
    migration: {
      config: { storage: { module: 'redis', password: '{env.CADDY_STORAGE_PASSWORD}', encryption_key: '{env.CADDY_STORAGE_ENCRYPTION_KEY}' } },
      environment: ['CADDY_STORAGE_PASSWORD', 'CADDY_STORAGE_ENCRYPTION_KEY'],
    },
    envPrefix: 'CADDY_STORAGE_',
    ...overrides,
  };
}

function render(v: CertificateStorageView, canWrite = true) {
  const action = vi.fn();
  return renderToStaticMarkup(
    createElement(CertificateStorageSection, { view: v, canWrite, save: action, remove: action, test: action })
  );
}

function hasButton(html: string, label: string): boolean {
  return new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`).test(html);
}

describe('Certificate Storage section', () => {
  it('edits shared storage, and offers switching back and removing', () => {
    const html = render(view());
    expect(html).not.toMatch(/license/i);
    expect(html).not.toMatch(/<fieldset disabled=""/);
    expect(hasButton(html, 'Switch back to local storage')).toBe(true);
    expect(hasButton(html, 'Remove setting')).toBe(true);
    expect(hasButton(html, 'Test connection')).toBe(true);
    expect(hasButton(html, 'Save</button>')).toBe(true);
  });

  it('offers to set shared storage up when nothing is set up', () => {
    const html = render(view({ backend: 'local', redis: null, migration: null }));
    expect(html).toContain('<fieldset');
    expect(html).not.toMatch(/<fieldset disabled=""/);
    expect(hasButton(html, 'Enable shared storage')).toBe(true);
    expect(hasButton(html, 'Test connection')).toBe(true);
  });

  it('is read-only for a role without high_availability:write', () => {
    const html = render(view(), false);
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(hasButton(html, 'Save</button>')).toBe(false);
    expect(hasButton(html, 'Switch back to local storage')).toBe(false);
    expect(hasButton(html, 'Test connection')).toBe(false);
  });

  it('offers to enable, or to save without enabling', () => {
    const html = render(view({ backend: 'local' }));
    expect(hasButton(html, 'Enable shared storage')).toBe(true);
    expect(hasButton(html, 'Save without enabling')).toBe(true);
    expect(html).not.toMatch(/<fieldset disabled=""/);
  });

  it('is read-only on a replica', () => {
    const html = render(view({ editable: false, source: 'master' }));
    expect(html).toContain('This instance is a sync replica');
    expect(html).toContain('From the master');
    expect(hasButton(html, 'Switch back to local storage')).toBe(false);
  });

  it('shows the migration commands with variables, never secrets', () => {
    const html = render(view());
    expect(html).toContain('caddy storage export --config /config/caddy/autosave.json --output -');
    expect(html).toContain('-e CADDY_STORAGE_PASSWORD=');
    expect(html).toContain('{env.CADDY_STORAGE_PASSWORD}');
    expect(html).toContain('Stored; leave empty to keep');
    expect(html).not.toContain('enc:v1:');
  });
});
