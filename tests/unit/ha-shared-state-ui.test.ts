/**
 * Server-side render of the Shared state card of Settings
 * (ee/high-availability/ui/SharedStateSection.tsx): turning on needs the
 * license and the certificate storage connection, read-only on a slave,
 * turning off stays possible without a license, and the error when shared
 * state is on but not usable.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
}));

import SharedStateSection from '@/ee/high-availability/ui/SharedStateSection';
import type { SharedStateView } from '@/ee/high-availability/shared-state/types';

function view(overrides: Partial<SharedStateView> = {}): SharedStateView {
  return {
    enabled: false,
    backend: 'local',
    keyPrefix: 'ingressi',
    namespace: null,
    connection: { source: 'certificate_storage', configured: true, mode: 'Single server', addresses: ['valkey.example.com:6379'], tls: true },
    updatedAt: null,
    configurable: true,
    editable: true,
    error: null,
    ...overrides,
  };
}

function render(v: SharedStateView, canWrite = true) {
  const action = vi.fn();
  return renderToStaticMarkup(
    createElement(SharedStateSection, { view: v, canWrite, editionLabel: 'Enterprise', save: action, remove: action, loadStatus: vi.fn(async () => ({ ok: false as const, error: 'x' })) })
  );
}

function button(html: string, label: string): string | null {
  const match = new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*${label}`).exec(html);
  return match ? match[1] : null;
}

describe('Shared state section', () => {
  it('offers to turn on with the license and a connection, and shows the connection', () => {
    const html = render(view());
    expect(button(html, 'Turn on')).not.toBeNull();
    expect(button(html, 'Turn on')).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('valkey.example.com:6379');
    expect(html).toContain('Off');
  });

  it('cannot be turned on without a license or without the certificate storage connection', () => {
    const unlicensed = render(view({ configurable: false }));
    expect(unlicensed).toContain('Shared state needs an active Enterprise license');
    expect(button(unlicensed, 'Turn on')).toMatch(/\sdisabled=""/);
    const unconfigured = render(view({ connection: { source: 'certificate_storage', configured: false, mode: null, addresses: [], tls: false } }));
    expect(unconfigured).toContain('save Redis or Valkey settings for the certificate storage first');
    expect(button(unconfigured, 'Turn on')).toMatch(/\sdisabled=""/);
  });

  it('keeps turning off and removing available without a license', () => {
    const html = render(view({ enabled: true, backend: 'redis', configurable: false, namespace: 'ingressi:0123abcdef01:', updatedAt: '2026-10-01T00:00:00.000Z' }));
    expect(button(html, 'Turn off')).not.toBeNull();
    expect(button(html, 'Turn off')).not.toMatch(/\sdisabled=""/);
    expect(button(html, 'Remove setting')).not.toBeNull();
    expect(html).toContain('ingressi:0123abcdef01:');
  });

  it('is read-only on a slave and for read-only roles', () => {
    expect(render(view({ editable: false }))).toContain('replicas keep request-path state in their own database');
    expect(button(render(view({ editable: false })), 'Turn on')).toBeNull();
    expect(button(render(view(), false), 'Turn on')).toBeNull();
  });

  it('says when shared state is on but cannot be used', () => {
    const html = render(view({ enabled: true, backend: 'local', error: 'CADDY_STORAGE_PASSWORD is not set in this web container\'s environment' }));
    expect(html).toContain('On, not usable');
    expect(html).toContain('refused on this node');
  });
});
