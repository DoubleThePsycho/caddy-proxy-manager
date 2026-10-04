/**
 * Dashboard MFA: the browser-side contracts (login second step, setup page,
 * Users page reset, generic error messages, QR code drawn locally) and the
 * OpenAPI documentation of the MFA endpoints.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { GET } from '@/app/api/v1/openapi.json/route';
import { describeMfaError, manualEntryKey, signInChallengeEnded } from '@/src/components/mfa/mfa-api';
import MfaSetupClient from '@/app/(auth)/mfa-setup/MfaSetupClient';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('login page second step', () => {
  const client = read('app/(auth)/login/LoginClient.tsx');

  it('asks for a code when the password sign-in answers with a challenge, and offers backup codes', () => {
    expect(client).toContain('if (data?.twoFactorRedirect)');
    expect(client).toContain('mfaApi.verifyTotp(code)');
    expect(client).toContain('mfaApi.verifyBackupCode(code)');
    expect(client).toContain('Use a backup code');
  });

  it('never asks to trust the device', () => {
    expect(client).not.toMatch(/trustDevice/);
    expect(read('src/components/mfa/mfa-api.ts')).not.toMatch(/trustDevice/);
  });
});

describe('error messages', () => {
  it('do not tell a wrong backup code from a wrong authenticator code', () => {
    const totp = describeMfaError({ status: 401, code: 'INVALID_CODE', message: 'Invalid code' });
    const backup = describeMfaError({ status: 401, code: 'INVALID_BACKUP_CODE', message: 'Invalid backup code' });
    expect(totp).toBe(backup);
    expect(describeMfaError({ status: 401, code: 'SOMETHING_ELSE', message: 'internal detail' })).not.toContain('internal');
  });

  it('send the person back to the password when the challenge ended', () => {
    for (const code of ['INVALID_TWO_FACTOR_COOKIE', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE']) {
      expect(signInChallengeEnded({ status: 401, code, message: null })).toBe(true);
    }
    expect(signInChallengeEnded({ status: 401, code: 'INVALID_CODE', message: null })).toBe(false);
    expect(describeMfaError({ status: 429, code: 'ACCOUNT_TEMPORARILY_LOCKED', message: null })).toMatch(/Too many attempts/);
  });
});

describe('setup', () => {
  it('draws the QR code in the browser and shows the key for typing it in', () => {
    const qr = read('src/components/mfa/QrCode.tsx');
    expect(qr).toContain('from "uqr"');
    expect(qr).not.toMatch(/https?:\/\//);
    expect(manualEntryKey('otpauth://totp/Ingressi:a%40b?secret=ABCDEFGHIJKLMNOP&issuer=Ingressi'))
      .toBe('ABCD EFGH IJKL MNOP');
  });

  it('lets the person postpone setup only during the grace period', () => {
    const prompt = renderToStaticMarkup(createElement(MfaSetupClient, { gate: 'prompt', deadline: '2026-10-09T12:00:00.000Z' }));
    expect(prompt).toContain('Remind me later');
    expect(prompt).toContain('Confirm your password to start');
    const required = renderToStaticMarkup(createElement(MfaSetupClient, { gate: 'required', deadline: null }));
    expect(required).not.toContain('Remind me later');
    expect(required).toContain('Set it up to continue');
    expect(required).toContain('Sign out');
  });
});

describe('users page', () => {
  it('resets MFA through a handled action and never for the signed-in administrator', () => {
    expect(read('app/(dashboard)/users/UserCommandDialog.tsx')).toContain('runUserAction(() => resetUserMfaAction(command.user.id)');
    expect(read('app/(dashboard)/users/UsersTab.tsx')).toContain('hasFactor && !self');
    expect(read('app/(dashboard)/users/UserDetailSheet.tsx')).toContain('canWrite && !self && hasFactor');
  });
});

describe('OpenAPI: MFA', () => {
  it('documents every endpoint and every reference resolves', async () => {
    const spec = await (await GET({ headers: { get: () => null } } as any)).json();
    const expected: Record<string, string[]> = {
      '/api/v1/mfa': ['get'],
      '/api/v1/mfa/policy': ['get', 'put'],
      '/api/v1/users/{id}/mfa': ['get', 'delete'],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(Object.keys(spec.paths[path]).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        expect(spec.paths[path][method].tags).toEqual(['MFA']);
        expect(spec.paths[path][method].operationId).toBeTruthy();
      }
    }
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toContain('MFA');
    const schemas = ['MfaStatus', 'MfaPolicy', 'MfaPolicyInput'];
    const documented = JSON.stringify([
      ...Object.keys(expected).map((path) => spec.paths[path]),
      ...schemas.map((name) => spec.components.schemas[name]),
    ]);
    const refs = documented.match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of new Set(refs)) {
      const path = JSON.parse(`{${ref}}`).$ref.slice('#/'.length).split('/');
      expect(path.reduce((node: any, key: string) => node?.[key], spec), ref).toBeDefined();
    }
    expect(spec.components.schemas.MfaPolicyInput.properties.scope.enum).toEqual(['off', 'admins', 'password_users']);
    // The documented state carries flags and counts only.
    expect(Object.keys(spec.components.schemas.MfaStatus.properties).sort())
      .toEqual(['authenticatorApp', 'backupCodesRemaining', 'deadline', 'enabled', 'gate', 'hasPassword', 'passkeys', 'required']);
  });
});
