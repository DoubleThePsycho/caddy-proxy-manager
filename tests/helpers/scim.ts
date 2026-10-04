/**
 * Fixtures for the SCIM tests: SCIM tokens stored as the server stores them,
 * SCIM requests, settings and users.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { first, resyncIdentity } from '@/src/lib/db/ops';

export function now(): string {
  return new Date().toISOString();
}

/** A SCIM token row; returns the raw token. */
export async function insertScimToken(db: TestDb, options: { name?: string; expiresAt?: string | null } = {}): Promise<{ id: number; raw: string }> {
  const raw = `scim_${randomBytes(32).toString('base64url')}`;
  const row = (await first(db.insert(schema.scimTokens).values({
    name: options.name ?? 'Entra ID',
    prefix: raw.slice(0, 11),
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    createdBy: 1,
    createdAt: now(),
    expiresAt: options.expiresAt ?? null,
  }).returning()))!;
  return { id: row.id, raw };
}

/** An API token row (api_tokens) for `userId`; returns the raw token. */
export async function insertApiToken(db: TestDb, userId: number): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await db.insert(schema.apiTokens).values({
    name: 'automation',
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    createdBy: userId,
    createdAt: now(),
  });
  return raw;
}

export async function setScimSettings(db: TestDb, value: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify({ enabled: true, ...value });
  await db.insert(schema.settings)
    .values({ key: 'scim', value: serialized, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: serialized, updatedAt: now() } });
}

export async function insertLocalUser(
  db: TestDb,
  values: { id?: number; email: string; role?: string; status?: string; name?: string; customRoleId?: number | null }
): Promise<number> {
  const row = (await first(db.insert(schema.users).values({
    ...(values.id ? { id: values.id } : {}),
    email: values.email,
    name: values.name ?? values.email,
    role: values.role ?? 'user',
    customRoleId: values.customRoleId ?? null,
    provider: 'credentials',
    subject: values.email,
    status: values.status ?? 'active',
    createdAt: now(),
    updatedAt: now(),
  }).returning()))!;
  // An explicit id: the next generated one follows it (PostgreSQL).
  if (values.id) await resyncIdentity(schema.users, db);
  return row.id;
}

/** A SCIM request with a bearer token (or none) and a JSON body. */
export function scimRequest(method: string, path: string, token: string | null, body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/scim+json';
  return new NextRequest(`https://dash.example.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const idParams = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

export async function body(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** A create body as Microsoft Entra ID sends it. */
export function entraUser(userName: string, overrides: Record<string, unknown> = {}) {
  return {
    schemas: [USER_SCHEMA, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
    externalId: `${userName.split('@')[0]}-nick`,
    userName,
    active: true,
    displayName: 'Entra User',
    emails: [{ primary: true, type: 'work', value: userName }],
    name: { formatted: 'Entra User', familyName: 'User', givenName: 'Entra' },
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Engineering' },
    ...overrides,
  };
}

/** A create body as Okta sends it. */
export function oktaUser(userName: string, overrides: Record<string, unknown> = {}) {
  return {
    schemas: [USER_SCHEMA],
    userName,
    name: { givenName: 'Okta', familyName: 'User' },
    emails: [{ primary: true, value: userName, type: 'work' }],
    displayName: 'Okta User',
    locale: 'en-US',
    externalId: '00u1abcdEFGH',
    groups: [],
    password: 'Okta-Sends-This-1!',
    active: true,
    ...overrides,
  };
}
