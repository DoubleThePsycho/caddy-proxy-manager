import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The settings page's own group list, separate from the dashboard sidebar. */
const SETTINGS_NAV = 'aside[aria-label="Settings navigation"]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A group's button in the group list; its name can be followed by a note such as "Off" or "Unsaved". */
function groupButton(page: Page, name: string) {
  return page.locator(SETTINGS_NAV).getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}(\\s|$)`) });
}

/** The pane of one group (only the open one is visible). */
function pane(page: Page, id: string) {
  return page.locator(`section[data-settings-group="${id}"]`);
}

/** Open a group from the group list. */
async function goToGroup(page: Page, name: string) {
  await page.goto('/settings');
  const button = groupButton(page, name);
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
}

function saveBar(page: Page, id: string) {
  return pane(page, id).getByTestId('settings-save-bar');
}

// ─── Page load & layout ──────────────────────────────────────────────────────

test.describe('Settings — page load & layout', () => {
  test('settings page loads without redirecting to login', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  test('opens on General', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('System');
  });

  test('the group list shows every section heading', async ({ page }) => {
    await page.goto('/settings');
    const nav = page.locator(SETTINGS_NAV);
    await expect(nav).toBeVisible();
    for (const title of ['System', 'Networking', 'Security defaults', 'Observability', 'Appearance']) {
      await expect(nav.getByRole('list', { name: title })).toBeVisible();
    }
  });

  test('the group list shows every group', async ({ page }) => {
    await page.goto('/settings');
    const groups = [
      'General', 'Certificates and ACME', 'Instance sync', 'High availability', 'Backups', 'Usage ping',
      'Trusted proxies', 'Upstream DNS pinning',
      'Geo blocking and GeoIP', 'Rate limiting', 'Error pages', 'Forward auth defaults', 'OAuth providers',
      'Analytics and logs', 'Branding',
    ];
    for (const name of groups) {
      await expect(groupButton(page, name)).toBeVisible();
    }
  });
});

// ─── Group list ──────────────────────────────────────────────────────────────

test.describe('Settings — group list', () => {
  test('clicking a group switches the pane', async ({ page }) => {
    await page.goto('/settings');
    await groupButton(page, 'Instance sync').click();
    await expect(page.getByRole('heading', { level: 2, name: 'Instance sync' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).not.toBeVisible();
    await expect(page).toHaveURL(/section=sync/);
  });

  test('the breadcrumb follows the group', async ({ page }) => {
    await goToGroup(page, 'Upstream DNS pinning');
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(breadcrumb).toContainText('Settings');
    await expect(breadcrumb).toContainText('Networking');
    await expect(breadcrumb).toContainText('Upstream DNS pinning');
  });

  test('search filters groups by name, description and keywords', async ({ page }) => {
    await page.goto('/settings');
    const search = page.getByRole('searchbox', { name: 'Search settings' });
    await search.fill('redis');
    await expect(groupButton(page, 'Certificates and ACME')).toBeVisible();
    await expect(groupButton(page, 'High availability')).toBeVisible();
    await expect(groupButton(page, 'General')).toHaveCount(0);
    await expect(page.locator(SETTINGS_NAV).getByRole('status')).toHaveText('2 matches');

    await search.fill('prometheus');
    await expect(groupButton(page, 'Analytics and logs')).toBeVisible();

    await search.fill('zzzzxyzzy');
    await expect(page.getByText('No setting matches “zzzzxyzzy”.')).toBeVisible();
    await page.locator(SETTINGS_NAV).getByRole('button', { name: 'Clear search' }).last().click();
    await expect(search).toHaveValue('');
    await expect(groupButton(page, 'General')).toBeVisible();
  });

  test('old section links open the group that holds them', async ({ page }) => {
    await page.goto('/settings?section=dns-providers');
    await expect(page.getByRole('heading', { level: 2, name: 'Certificates and ACME' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'DNS-01 providers' })).toBeVisible();

    await page.goto('/settings?section=logging');
    await expect(page.getByRole('heading', { level: 2, name: 'Analytics and logs' })).toBeVisible();

    await page.goto('/settings?section=default-response');
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Requests for unknown hosts' })).toBeVisible();

    await page.goto('/settings?section=authentik');
    await expect(page.getByRole('heading', { level: 2, name: 'Forward auth defaults' })).toBeVisible();
  });
});

// ─── Save bar ────────────────────────────────────────────────────────────────

test.describe('Settings — save bar', () => {
  test('counts unsaved changes, marks the group and discards them', async ({ page }) => {
    await goToGroup(page, 'General');
    const domain = pane(page, 'general').locator('input[name="primaryDomain"]');
    const original = await domain.inputValue();
    await domain.fill('unsaved-change.example.com');

    await expect(saveBar(page, 'general')).toContainText('1 unsaved change in General');
    await expect(groupButton(page, 'General')).toContainText('Unsaved');

    // Unsaved changes stay while another group is open.
    await groupButton(page, 'Usage ping').click();
    await groupButton(page, 'General').click();
    await expect(domain).toHaveValue('unsaved-change.example.com');

    await saveBar(page, 'general').getByRole('button', { name: 'Discard' }).click();
    await expect(pane(page, 'general').locator('input[name="primaryDomain"]')).toHaveValue(original);
    await expect(saveBar(page, 'general')).toContainText('No unsaved changes');
    await expect(saveBar(page, 'general').getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

// ─── Command palette ─────────────────────────────────────────────────────────

/** The dashboard's command palette (src/components/command-palette). */
function commandPalette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  return { dialog, input: dialog.getByRole('combobox', { name: 'Search hosts, actions, settings and documentation' }) };
}

test.describe('Settings — command palette', () => {
  test('Cmd+K opens the command palette', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('palette finds settings groups and the cards they hold', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('dns');
    await expect(dialog.getByRole('option', { name: /^DNS-01 providers/ })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /^DNS-01 resolvers/ })).toBeVisible();
  });

  test('typing in the palette filters results', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('geo bl');
    await expect(dialog.getByRole('option', { name: /Geo blocking and GeoIP/ })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Instance sync/ })).toHaveCount(0);
  });

  test('selecting a palette result opens its group', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('access log');
    await dialog.getByRole('option', { name: /Access log/ }).first().click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Analytics and logs' })).toBeVisible();
    await expect(page).toHaveURL(/section=logging/);
  });

  test('Enter opens the selected result, also from another group of the page', async ({ page }) => {
    await page.goto('/settings?section=general');
    await expect(page.getByRole('heading', { level: 2, name: 'General' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('trusted prox');
    await expect(dialog.getByRole('option', { name: /Trusted proxies/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Trusted proxies' })).toBeVisible();
  });

  test('Escape clears the query first, then closes the palette', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('geob');
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue('');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('palette shows "nothing matches" for gibberish query', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('zzzzxyzzy');
    await expect(dialog.getByText(/Nothing matches “zzzzxyzzy”/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear the search' }).first().click();
    await expect(input).toHaveValue('');
  });
});

// ─── Instance sync ───────────────────────────────────────────────────────────

test.describe('Settings — Instance sync', () => {
  test('shows the mode as Standalone, Master or Replica', async ({ page }) => {
    await goToGroup(page, 'Instance sync');
    const mode = pane(page, 'sync').getByRole('group', { name: 'Instance mode' });
    await expect(mode.getByRole('button', { name: 'Standalone' })).toBeVisible();
    await expect(mode.getByRole('button', { name: 'Master' })).toBeVisible();
    await expect(mode.getByRole('button', { name: 'Replica' })).toBeVisible();
    await expect(saveBar(page, 'sync').getByRole('button', { name: 'Save changes' })).toBeVisible();
  });
});

// ─── General ─────────────────────────────────────────────────────────────────

test.describe('Settings — General', () => {
  test('shows the primary domain and the dashboard address', async ({ page }) => {
    await goToGroup(page, 'General');
    const general = pane(page, 'general');
    await expect(general.getByLabel('Primary domain')).toBeVisible();
    await expect(general.getByText('Set by BASE_URL in the environment')).toBeVisible();
  });

  test('primary domain persists after save and page reload', async ({ page }) => {
    await goToGroup(page, 'General');
    await pane(page, 'general').getByLabel('Primary domain').fill('persist-test.local');
    await saveBar(page, 'general').getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page, 'general').getByText('General settings saved successfully')).toBeVisible({ timeout: 10_000 });

    await goToGroup(page, 'General');
    await expect(pane(page, 'general').getByLabel('Primary domain')).toHaveValue('persist-test.local');

    await pane(page, 'general').getByLabel('Primary domain').fill('example.com');
    await saveBar(page, 'general').getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page, 'general').getByText('General settings saved successfully')).toBeVisible({ timeout: 10_000 });
  });

  test('the ACME contact e-mail is under Certificates and ACME', async ({ page }) => {
    await goToGroup(page, 'Certificates and ACME');
    const email = pane(page, 'acme').getByLabel('Contact e-mail');
    await email.fill('test@example.com');
    await expect(email).toHaveValue('test@example.com');
    await expect(saveBar(page, 'acme')).toContainText('1 unsaved change in Certificates and ACME');
  });
});

// ─── Requests for unknown hosts (issue #241) ────────────────────────────────

test.describe('Settings — Requests for unknown hosts', () => {
  test('shows all supported answers and the custom response fields', async ({ page }) => {
    await goToGroup(page, 'General');
    const general = pane(page, 'general');
    for (const name of ['Caddy default', 'Custom response', 'Redirect', 'Close the connection']) {
      await expect(general.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await general.getByRole('radio', { name: /^Custom response/ }).check();
    await expect(general.locator('input[name="status"]')).toHaveValue('404');
    await expect(general.locator('textarea[name="body"]')).toBeVisible();
    await expect(general.locator('textarea[name="headers"]')).toBeVisible();
  });

  test('saves and reloads a custom response', async ({ page }) => {
    await goToGroup(page, 'General');
    let general = pane(page, 'general');
    await general.getByRole('radio', { name: /^Custom response/ }).check();
    await general.locator('input[name="status"]').fill('451');
    await general.locator('textarea[name="body"]').fill('Unavailable for legal reasons');
    await general.locator('textarea[name="headers"]').fill('Content-Type: text/plain; charset=utf-8\nX-Test-Ui: saved');
    await saveBar(page, 'general').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Default response saved and applied successfully')).toBeVisible({ timeout: 10_000 });

    await goToGroup(page, 'General');
    general = pane(page, 'general');
    await expect(general.getByRole('radio', { name: /^Custom response/ })).toBeChecked();
    await expect(general.locator('input[name="status"]')).toHaveValue('451');
    await expect(general.locator('textarea[name="body"]')).toHaveValue('Unavailable for legal reasons');
    await expect(general.locator('textarea[name="headers"]')).toHaveValue('Content-Type: text/plain; charset=utf-8\nX-Test-Ui: saved');

    await general.getByRole('radio', { name: /^Caddy default/ }).check();
    await saveBar(page, 'general').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Default response saved and applied successfully')).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Certificate authority (custom ACME directory URL — issue #192) ─────────

test.describe('Settings — Certificate authority', () => {
  const API_SETTINGS_ACME = 'http://localhost:3000/api/v1/settings/acme';
  const CUSTOM_DIR = 'https://ca.internal.example.com/acme/acme/directory';

  test.afterEach(async ({ page }) => {
    // Reset to the Let's Encrypt default so other tests/runs start clean.
    await page.request.put(API_SETTINGS_ACME, { data: { caUrl: '', caRootPem: '' } });
  });

  async function chooseCustom(page: Page) {
    await goToGroup(page, 'Certificates and ACME');
    await pane(page, 'acme').getByRole('group', { name: 'Issuer' }).getByRole('button', { name: 'Custom ACME directory' }).click();
  }

  test('shows the directory URL and CA root fields for a custom directory', async ({ page }) => {
    await chooseCustom(page);
    await expect(pane(page, 'acme').locator('input[name="caUrl"]')).toBeVisible();
    await expect(pane(page, 'acme').locator('textarea[name="caRootPem"]')).toBeVisible();
  });

  test('saves a custom directory URL and persists it', async ({ page }) => {
    await chooseCustom(page);
    await pane(page, 'acme').locator('input[name="caUrl"]').fill(CUSTOM_DIR);
    await saveBar(page, 'acme').getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page, 'acme').getByText('ACME settings saved successfully')).toBeVisible({ timeout: 10_000 });

    const res = await page.request.get(API_SETTINGS_ACME);
    expect((await res.json()).caUrl).toBe(CUSTOM_DIR);

    await goToGroup(page, 'Certificates and ACME');
    await expect(pane(page, 'acme').locator('input[name="caUrl"]')).toHaveValue(CUSTOM_DIR);
  });

  test('rejects a non-HTTPS directory URL', async ({ page }) => {
    await chooseCustom(page);
    await pane(page, 'acme').locator('input[name="caUrl"]').fill('http://ca.internal.example.com/directory');
    await saveBar(page, 'acme').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/must use HTTPS/i)).toBeVisible({ timeout: 10_000 });
  });
});

// ─── DNS-01 providers and resolvers ─────────────────────────────────────────

test.describe('Settings — DNS-01', () => {
  test('adding a provider reveals its credential fields', async ({ page }) => {
    await goToGroup(page, 'Certificates and ACME');
    await pane(page, 'acme').getByRole('button', { name: 'Add provider' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'DNS provider' }).click();
    await page.getByRole('option').filter({ hasNotText: /choose a provider/i }).first().click();
    const formInputs = page.locator('form#dnsp-add-form input[type="text"], form#dnsp-add-form input[type="password"]');
    await expect(formInputs.first()).toBeVisible({ timeout: 3000 });
  });

  test('own resolvers show their fields when turned on', async ({ page }) => {
    await goToGroup(page, 'Certificates and ACME');
    const acme = pane(page, 'acme');
    const toggle = acme.getByRole('switch', { name: 'Use my own resolvers' });
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) await toggle.click();
    await expect(acme.locator('textarea[name="resolvers"]')).toBeVisible();
    await expect(acme.locator('textarea[name="fallbacks"]')).toBeVisible();
    await expect(acme.locator('input[name="timeout"]')).toBeVisible();
  });
});

// ─── Upstream DNS pinning ────────────────────────────────────────────────────

test.describe('Settings — Upstream DNS pinning', () => {
  test('shows the switch and the address family choices', async ({ page }) => {
    await goToGroup(page, 'Upstream DNS pinning');
    const group = pane(page, 'upstream-dns');
    await expect(group.getByRole('switch', { name: 'Resolve upstream hostnames when applying' })).toBeVisible();
    const family = group.getByRole('group', { name: 'Address family' });
    await expect(family.getByRole('button', { name: /both/i })).toBeVisible();
    await expect(family.getByRole('button', { name: /ipv6 only/i })).toBeVisible();
    await expect(family.getByRole('button', { name: /ipv4 only/i })).toBeVisible();
  });
});

// ─── Forward auth defaults ───────────────────────────────────────────────────

test.describe('Settings — Forward auth defaults', () => {
  test('shows the Authentik fields with their placeholders', async ({ page }) => {
    await goToGroup(page, 'Forward auth defaults');
    const group = pane(page, 'forward-auth');
    await expect(group.getByRole('heading', { name: 'Authentik' })).toBeVisible();
    await expect(group.locator('input[name="outpostDomain"]')).toHaveAttribute('placeholder', 'outpost.goauthentik.io');
    await expect(group.locator('input[name="outpostUpstream"]')).toHaveAttribute('placeholder', 'http://authentik-server:9000');
    await expect(group.getByRole('heading', { name: 'Generic forward auth' })).toBeVisible();
    await expect(group.locator('input[name="authUpstream"]')).toBeVisible();
  });
});

// ─── OAuth providers ─────────────────────────────────────────────────────────

test.describe('Settings — OAuth providers', () => {
  test('group renders with an Add provider button', async ({ page }) => {
    await goToGroup(page, 'OAuth providers');
    await expect(page.getByRole('heading', { level: 2, name: 'OAuth providers' })).toBeVisible();
    await expect(pane(page, 'oauth').getByRole('button', { name: /add provider/i })).toBeVisible();
  });

  test('clicking Add provider opens the dialog', async ({ page }) => {
    await goToGroup(page, 'OAuth providers');
    await pane(page, 'oauth').getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/name/i)).toBeVisible();
    await expect(dialog.getByLabel(/client id/i)).toBeVisible();
    await expect(dialog.getByLabel(/client secret/i)).toBeVisible();
  });

  test('create and delete an OAuth provider', async ({ page }) => {
    await goToGroup(page, 'OAuth providers');
    await pane(page, 'oauth').getByRole('button', { name: /add provider/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^name/i).fill('E2E Test Provider');
    await dialog.getByLabel(/client id/i).fill('test-client-id-12345');
    await dialog.getByLabel(/client secret/i).fill('test-client-secret-12345');
    // Skip issuer URL — it's optional and avoids potential OIDC discovery issues
    await dialog.getByRole('button', { name: /create provider/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });

    const providerRow = page.getByTestId('oauth-provider').filter({ hasText: 'E2E Test Provider' });
    await expect(providerRow).toBeVisible({ timeout: 10_000 });
    await providerRow.getByRole('button', { name: 'Delete E2E Test Provider' }).click();
    await providerRow.getByRole('button', { name: /^confirm$/i }).click();
    await expect(page.getByText('E2E Test Provider')).not.toBeVisible({ timeout: 10_000 });
  });

  test('existing OAuth secrets never cross the API or React browser boundary', async ({ page }) => {
    await page.goto('/settings');
    const origin = new URL(page.url()).origin;
    const secret = `oauth-browser-secret-${Date.now()}`;
    const providerName = `Write-only OAuth ${Date.now()}`;
    const createResponse = await page.request.post(`${origin}/api/v1/oauth-providers`, {
      headers: { Origin: origin },
      data: {
        name: providerName,
        type: 'oidc',
        clientId: 'browser-boundary-client-id',
        clientSecret: secret,
        scopes: 'openid email profile',
      },
    });
    const createBody = await createResponse.text();
    const created = JSON.parse(createBody) as { id: string; hasClientSecret: boolean };

    expect(createResponse.ok()).toBeTruthy();
    expect(created.hasClientSecret).toBe(true);
    expect(createBody).not.toContain(secret);
    expect(createBody).not.toContain('clientSecret');

    try {
      const navigation = await page.goto('/settings?section=oauth');
      const initialRscHtml = await navigation!.text();
      expect(initialRscHtml).not.toContain(secret);
      expect(initialRscHtml).not.toContain('clientSecret');
      expect(await page.content()).not.toContain(secret);

      const itemResponse = await page.request.get(`${origin}/api/v1/oauth-providers/${created.id}`);
      const itemBody = await itemResponse.text();
      expect(itemResponse.ok()).toBeTruthy();
      expect(itemBody).not.toContain(secret);
      expect(itemBody).not.toContain('clientSecret');

      const providerRow = page.getByTestId('oauth-provider').filter({ hasText: providerName });
      await providerRow.getByTitle('Edit provider').click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(/existing value cannot be viewed/i)).toBeVisible();
      await expect(dialog.getByLabel(/client secret/i)).toHaveCount(0);
      await dialog.getByRole('button', { name: /rotate secret/i }).click();
      await expect(dialog.getByLabel(/new client secret/i)).toHaveValue('');
      await dialog.getByRole('button', { name: /keep existing/i }).click();

      await dialog.getByLabel(/^name/i).fill(`${providerName} renamed`);
      await dialog.getByRole('button', { name: /update provider/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      const preservedResponse = await page.request.get(`${origin}/api/v1/oauth-providers/${created.id}`);
      const preserved = await preservedResponse.json() as { hasClientSecret: boolean };
      expect(preserved.hasClientSecret).toBe(true);
    } finally {
      await page.request.delete(`${origin}/api/v1/oauth-providers/${created.id}`, {
        headers: { Origin: origin },
      }).catch(() => undefined);
    }
  });
});

// ─── Geo blocking and GeoIP ──────────────────────────────────────────────────

test.describe('Settings — Geo blocking and GeoIP', () => {
  test('shows the GeoIP databases and the default rules', async ({ page }) => {
    await goToGroup(page, 'Geo blocking and GeoIP');
    const group = pane(page, 'geoblock');
    await expect(group.getByRole('heading', { name: 'GeoIP databases' })).toBeVisible();
    await expect(group.getByText('/usr/share/GeoIP/GeoLite2-Country.mmdb')).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Default rules' })).toBeVisible();
    await expect(saveBar(page, 'geoblock').getByRole('button', { name: 'Save changes' })).toBeVisible();
  });
});

// ─── Analytics and logs ──────────────────────────────────────────────────────

test.describe('Settings — Analytics and logs', () => {
  test('shows ClickHouse retention read-only', async ({ page }) => {
    await goToGroup(page, 'Analytics and logs');
    const group = pane(page, 'analytics');
    await expect(group.getByRole('heading', { name: 'Traffic analytics' })).toBeVisible();
    await expect(group.getByText('Keep events for')).toBeVisible();
    await expect(group.getByText(/CLICKHOUSE_RETENTION_DAYS/)).toBeVisible();
  });

  test('access log: switch, format and where the log is', async ({ page }) => {
    await goToGroup(page, 'Analytics and logs');
    const group = pane(page, 'analytics');
    await expect(group.getByRole('switch', { name: 'Log every proxied request' })).toBeVisible();
    const format = group.getByRole('group', { name: 'Log format' });
    await expect(format.getByRole('button', { name: 'JSON' })).toBeVisible();
    await expect(format.getByRole('button', { name: /console/i })).toBeVisible();
    await expect(group.getByText(/docker exec/)).toBeVisible();
  });

  test('metrics: switch, port 9090 and the scrape address', async ({ page }) => {
    await goToGroup(page, 'Analytics and logs');
    const group = pane(page, 'analytics');
    await expect(group.getByRole('switch', { name: 'Expose /metrics on its own port' })).toBeVisible();
    await expect(group.locator('input[name="port"]')).toHaveValue('9090');
    await expect(group.getByText(/ingressi-caddy/).first()).toBeVisible();
  });
});

// ─── Mobile layout ───────────────────────────────────────────────────────────

test.describe('Settings — mobile layout', () => {
  test.use({ viewport: { width: 393, height: 852 } });

  test('the group list becomes a select', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator(SETTINGS_NAV)).not.toBeVisible();
    const select = page.getByTestId('mobile-settings-nav').getByLabel('Settings group');
    await expect(select).toBeVisible();
    await select.selectOption('analytics');
    await expect(page.getByRole('heading', { level: 2, name: 'Analytics and logs' })).toBeVisible();
  });

  test('command palette works on mobile', async ({ page }) => {
    await page.goto('/settings');
    await page.keyboard.press('ControlOrMeta+k');
    const { dialog, input } = commandPalette(page);
    await input.fill('prometheus');
    await dialog.getByRole('option', { name: /^Prometheus metrics/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Analytics and logs' })).toBeVisible();
  });

  test('content does not overflow the viewport width', async ({ page }) => {
    for (const section of ['general', 'acme', 'sync', 'analytics']) {
      await page.goto(`/settings?section=${section}`);
      await page.waitForLoadState('networkidle');
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      const viewportWidth = page.viewportSize()?.width ?? 393;
      expect(bodyWidth, section).toBeLessThanOrEqual(viewportWidth + 5);
    }
  });
});

// ─── Form submissions via API ────────────────────────────────────────────────

test.describe('Settings — form data round-trip via API', () => {
  const API_SETTINGS_GENERAL = 'http://localhost:3000/api/v1/settings/general';
  const API_SETTINGS_METRICS = 'http://localhost:3000/api/v1/settings/metrics';
  const API_SETTINGS_LOGGING = 'http://localhost:3000/api/v1/settings/logging';

  test('general settings: UI save is reflected in API', async ({ page }) => {
    await goToGroup(page, 'General');
    await pane(page, 'general').getByLabel('Primary domain').fill('api-roundtrip.local');
    await saveBar(page, 'general').getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page, 'general').getByText('General settings saved successfully')).toBeVisible({ timeout: 10_000 });

    const res = await page.request.get(API_SETTINGS_GENERAL);
    expect((await res.json()).primaryDomain).toBe('api-roundtrip.local');

    await page.request.put(API_SETTINGS_GENERAL, { data: { primaryDomain: 'example.com', acmeEmail: '' } });
  });

  test('metrics and access log saved together in one save', async ({ page }) => {
    await goToGroup(page, 'Analytics and logs');
    const group = pane(page, 'analytics');
    const metricsSwitch = group.getByRole('switch', { name: 'Expose /metrics on its own port' });
    if (!(await metricsSwitch.isChecked())) await metricsSwitch.click();
    await group.locator('input[name="port"]').fill('9191');
    const logSwitch = group.getByRole('switch', { name: 'Log every proxied request' });
    if (!(await logSwitch.isChecked())) await logSwitch.click();
    await group.getByRole('group', { name: 'Log format' }).getByRole('button', { name: /console/i }).click();

    await saveBar(page, 'analytics').getByRole('button', { name: 'Save changes' }).click();
    await expect(saveBar(page, 'analytics').getByText('Metrics settings saved and applied successfully')).toBeVisible({ timeout: 10_000 });
    await expect(saveBar(page, 'analytics').getByText('Logging settings saved and applied successfully')).toBeVisible();

    const metrics = await (await page.request.get(API_SETTINGS_METRICS)).json();
    expect(metrics.enabled).toBe(true);
    expect(metrics.port).toBe(9191);
    const logging = await (await page.request.get(API_SETTINGS_LOGGING)).json();
    expect(logging.format).toBe('console');

    await page.request.put(API_SETTINGS_METRICS, { data: { enabled: false, port: 9090 } });
    await page.request.put(API_SETTINGS_LOGGING, { data: { enabled: false, format: 'json' } });
  });
});
