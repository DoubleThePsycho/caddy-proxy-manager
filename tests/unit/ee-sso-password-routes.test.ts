/**
 * Enforced SSO is applied where Better Auth creates a session (see
 * ee-sso-enforcement-sign-in.test.ts), so it covers every Better Auth
 * password endpoint. This tripwire lists the application's own server code
 * that checks a password, so that a new custom dashboard login route cannot
 * appear without someone deciding how enforced SSO applies to it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(__dirname, '../..');

function serverFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...serverFiles(path));
    else if (/^(route|actions)\.tsx?$/.test(entry)) files.push(path);
  }
  return files;
}

/** The route handlers and server actions of paid features (ee/<feature>/routes, ee/<feature>/ui/*actions.ts). */
function eeServerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...eeServerFiles(path));
    else if (/\.tsx?$/.test(entry) && (/\/routes\//.test(path) || /actions\.tsx?$/.test(entry))) files.push(path);
  }
  return files;
}

const PASSWORD_CHECK = /\.compare\(|verifyAndLinkOAuth|password\.verify\(|internalAdapter\.createSession|setSessionCookie/;

/** Server code that checks a password, and why it is not a dashboard sign-in. */
const KNOWN = {
  // The forward-auth portal for protected applications; out of scope by design.
  'app/api/forward-auth/login/route.ts': 'portal',
  // Needs a signed-in session already.
  'app/api/user/change-password/route.ts': 'session',
  // Links an OAuth identity proven by the IdP to a local account; creates no session.
  'app/api/auth/link-account/route.ts': 'link',
};

describe('custom password checks', () => {
  it('are limited to the known routes, none of which signs in to the dashboard', () => {
    const found = [...serverFiles(join(root, 'app')), ...eeServerFiles(join(root, 'ee'))]
      .filter((file) => PASSWORD_CHECK.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).split('\\').join('/'))
      .sort();
    expect(found).toEqual(Object.keys(KNOWN).sort());
  });

  it('never create a Better Auth session in those routes', () => {
    for (const file of Object.keys(KNOWN)) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/createSession|setSessionCookie|signInUsername|signInEmail/);
    }
  });
});
