/**
 * Server-side render of the Branding page (ee/white-label/ui): read-only
 * without a license (removal and reset stay available), the live preview,
 * and the dashboard shell showing the product name and logo it is given.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/branding',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }) }));

import BrandingClient from '@/ee/white-label/ui/BrandingClient';
import DashboardLayoutClient from '@/app/(dashboard)/DashboardLayoutClient';
import { BrandingProvider } from '@/ee/white-label/ui/BrandingProvider';
import { ASSET_LIMITS, DEFAULT_BRANDING_SETTINGS, DEFAULT_PUBLIC_BRANDING, MAX_ASSET_BYTES, type BrandingView } from '@/ee/white-label/types';

function view(overrides: Partial<BrandingView> = {}): BrandingView {
  return {
    settings: { ...DEFAULT_BRANDING_SETTINGS },
    effective: { productName: 'Ingressi', loginHeading: 'Ingressi', emailSenderName: null, accent: null, poweredByShown: false },
    assets: { logoLight: null, logoDark: null, favicon: null },
    source: 'default',
    updatedAt: null,
    defaultProductName: 'Ingressi',
    limits: { maxBytes: MAX_ASSET_BYTES, assets: ASSET_LIMITS },
    configurable: false,
    ...overrides,
  };
}

/** The attributes of the button whose text ends with `label`. */
function buttonAttributes(html: string, label: string): string {
  const match = new RegExp(`<button([^>]*)>(?:(?!<button)[\\s\\S])*?${label}</button>`).exec(html);
  if (!match) throw new Error(`no ${label} button`);
  return match[1];
}

function render(v: BrandingView, canWrite = true) {
  const action = vi.fn();
  return renderToStaticMarkup(
    createElement(BrandingClient, { view: v, canWrite, isSlave: false, editionLabel: 'MSP', save: action, upload: action, removeAsset: action, reset: action })
  );
}

describe('Branding page', () => {
  it('is read-only without a license and says why', () => {
    const html = render(view());
    expect(html).toContain('Changing the branding needs an active MSP license');
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it('keeps removing images and resetting available without a license', () => {
    const html = render(view({
      source: 'local',
      settings: { ...DEFAULT_BRANDING_SETTINGS, productName: 'Example Edge' },
      assets: { logoLight: { type: 'image/png', width: 10, height: 10, bytes: 100, url: '/api/branding/logo-light?v=0123456789abcdef' }, logoDark: null, favicon: null },
    }));
    expect(buttonAttributes(html, 'Remove')).not.toContain('disabled=""');
    expect(buttonAttributes(html, 'Reset to defaults')).not.toContain('disabled=""');
    expect(buttonAttributes(html, 'Replace')).toContain('disabled=""');
  });

  it('previews the sign-in page in both themes with the values in the form', () => {
    const html = render(view({
      configurable: true,
      source: 'local',
      settings: { ...DEFAULT_BRANDING_SETTINGS, productName: 'Example Edge', accentColor: '#1d4ed8', loginFooter: 'Managed by Example IT.' },
    }));
    expect(html).toContain('data-testid="branding-preview-light"');
    expect(html).toContain('data-testid="branding-preview-dark"');
    expect(html).toContain('Example Edge');
    expect(html).toContain('Managed by Example IT.');
    expect(html).toContain('background:#1d4ed8');
    expect(html).toContain('Powered by Ingressi');
  });

  it('flags an accent colour without enough contrast', () => {
    const html = render(view({ configurable: true, settings: { ...DEFAULT_BRANDING_SETTINGS, accentColor: '#fde047' } }));
    expect(html).toMatch(/#fde047 has a contrast of 1\.\d:1 against the light theme/);
  });
});

describe('dashboard shell', () => {
  it('shows the product name and logo from the branding context', () => {
    const html = renderToStaticMarkup(
      createElement(BrandingProvider, {
        value: { ...DEFAULT_PUBLIC_BRANDING, productName: 'Example Edge', logoLightUrl: '/api/branding/logo-light?v=1', logoDarkUrl: '/api/branding/logo-dark?v=2', supportEmail: 'help@example.com', poweredBy: { name: 'Ingressi', url: 'https://example.com' } },
        children: createElement(DashboardLayoutClient, { user: { id: '1', name: 'Admin', permissions: [], isAdmin: true }, children: 'content' }),
      })
    );
    expect(html).toContain('Example Edge');
    expect(html).toContain('class="brand-logo-light');
    expect(html).toContain('class="brand-logo-dark');
    expect(html).toContain('mailto:help@example.com');
    expect(html).toContain('Powered by');
  });

  it('shows the real name without a provider', () => {
    const html = renderToStaticMarkup(
      createElement(DashboardLayoutClient, { user: { id: '1', name: 'Admin', permissions: [], isAdmin: true }, children: 'content' })
    );
    expect(html).toContain('Ingressi');
    expect(html).not.toContain('Powered by');
  });
});
