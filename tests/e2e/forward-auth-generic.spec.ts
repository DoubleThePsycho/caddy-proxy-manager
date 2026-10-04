/**
 * E2E: Generic Forward Auth (Authelia etc.) — issue #188.
 *
 * Covers the UI and persistence path:
 *  - The "Generic forward auth" card of Settings → Forward auth defaults saves provider/upstream/endpoint
 *  - The host editor is prefilled from those defaults when the provider is chosen
 *  - A host created in the editor persists the split browser/API settings
 *    (apiSplit, bypass headers) and they survive an edit round-trip
 */
import { test, expect } from '@playwright/test';
import { openCreateHostDialog, fillHostBasics, openEditorSection, openHostEditor, proxyHostIdByName, saveHostEditor, setEditorSwitch } from '../helpers/proxy-api';

const API_PROXY_HOSTS = 'http://localhost:3000/api/v1/proxy-hosts';
const API_FORWARD_AUTH_SETTINGS = 'http://localhost:3000/api/v1/settings/forward-auth';

test.describe('Generic Forward Auth UI', () => {
  test('forward auth defaults can be saved in settings and prefill the host editor', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const defaultSettings = {
      provider: 'authelia',
      authUpstream: 'http://authelia.internal:9091',
      authEndpoint: '/api/authz/forward-auth',
    };

    const originalSettings = await (await page.request.get(API_FORWARD_AUTH_SETTINGS)).json() as Record<string, unknown>;

    try {
      await page.goto('/settings?section=forward-auth');
      const generic = page.locator('section[data-settings-group="forward-auth"]').locator('#settings-generic-forward-auth');
      await expect(generic).toBeVisible({ timeout: 10_000 });

      await generic.getByRole('group', { name: 'Provider preset' }).getByRole('button', { name: 'Authelia' }).click();
      await generic.locator('input[name="authUpstream"]').fill(defaultSettings.authUpstream);
      await generic.locator('input[name="authEndpoint"]').fill(defaultSettings.authEndpoint);
      await page.getByTestId('settings-save-bar').getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText(/forward auth defaults saved successfully/i)).toBeVisible({ timeout: 10_000 });

      const saved = await (await page.request.get(API_FORWARD_AUTH_SETTINGS)).json();
      expect(saved).toEqual(defaultSettings);

      // The host editor is prefilled from the saved defaults.
      await openCreateHostDialog(page);
      await openEditorSection(page, 'Access');
      await page.getByRole('group', { name: 'Provider', exact: true }).getByRole('button', { name: 'Authelia or custom' }).click();

      await expect(page.locator('input[name="forwardAuthUpstream"]')).toHaveValue(defaultSettings.authUpstream);
      await expect(page.locator('input[name="forwardAuthEndpoint"]')).toHaveValue(defaultSettings.authEndpoint);
    } finally {
      if (originalSettings && Object.keys(originalSettings).length > 0) {
        await page.request.put(API_FORWARD_AUTH_SETTINGS, {
          headers: { Origin: origin },
          data: originalSettings,
        });
      }
    }
  });

  test('create host with generic forward auth — split API settings persist and survive an edit', async ({ page }) => {
    const origin = new URL(page.url()).origin;
    const hostName = 'Generic FA UI Test';
    const domain = 'generic-fa-ui.local';

    try {
      await openCreateHostDialog(page);
      await fillHostBasics(page, { name: hostName, domain, upstream: 'localhost:9988' });

      await openEditorSection(page, 'Access');
      await page.getByRole('group', { name: 'Provider', exact: true }).getByRole('button', { name: 'Authelia or custom' }).click();
      await page.locator('input[name="forwardAuthUpstream"]').fill('http://authelia:9091');
      await page.locator('input[name="forwardAuthEndpoint"]').fill('/api/authz/forward-auth');
      // Enable the API split (401 for non-browser clients).
      await setEditorSwitch(page, '401 for API clients', true);
      await page.locator('input[name="forwardAuthApiBypassHeaders"]').fill('X-Api-Key, Authorization');

      await saveHostEditor(page);

      // Verify persisted state via the API.
      const listResp = await page.request.get(API_PROXY_HOSTS);
      const hosts = await listResp.json() as Array<{ id: number; name: string; forwardAuth: Record<string, unknown> | null }>;
      const created = hosts.find((h) => h.name === hostName);
      expect(created).toBeTruthy();
      expect(created!.forwardAuth).not.toBeNull();
      expect(created!.forwardAuth!.enabled).toBe(true);
      expect(created!.forwardAuth!.provider).toBe('authelia');
      expect(created!.forwardAuth!.authUpstream).toBe('http://authelia:9091');
      expect(created!.forwardAuth!.authEndpoint).toBe('/api/authz/forward-auth');
      expect(created!.forwardAuth!.apiSplit).toBe(true);
      expect(created!.forwardAuth!.apiBypassHeaders).toEqual(['X-Api-Key', 'Authorization']);
      // Authelia preset defaults applied to copy headers.
      expect(created!.forwardAuth!.copyHeaders).toContain('Remote-User');

      // Edit round-trip: disable the split, verify the change persists.
      const createdId = await proxyHostIdByName(page, hostName);
      expect(createdId).toBe(created!.id);
      await openHostEditor(page, createdId, 'Access');
      await expect(page.locator('input[name="forwardAuthUpstream"]')).toHaveValue('http://authelia:9091');
      await expect(page.getByRole('switch', { name: '401 for API clients' })).toHaveAttribute('aria-checked', 'true');
      await setEditorSwitch(page, '401 for API clients', false);
      await saveHostEditor(page);

      const getResp = await page.request.get(`${API_PROXY_HOSTS}/${createdId}`);
      const updated = await getResp.json() as { forwardAuth: { apiSplit: boolean } | null };
      expect(updated.forwardAuth?.apiSplit).toBe(false);
    } finally {
      const listResp = await page.request.get(API_PROXY_HOSTS);
      const body = await listResp.json() as unknown;
      const hosts = Array.isArray(body) ? body as Array<{ id: number; name: string }> : [];
      for (const h of hosts.filter((h) => h.name === hostName)) {
        await page.request.delete(`${API_PROXY_HOSTS}/${h.id}`, { headers: { Origin: origin } });
      }
    }
  });
});
