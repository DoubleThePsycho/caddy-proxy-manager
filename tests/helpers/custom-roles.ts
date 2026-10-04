/**
 * Fixtures for the custom-role integration tests: users, roles, API tokens
 * and requests authenticated with a real token (src/lib/models/api-tokens.ts),
 * so the real guard resolves the token owner's role.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { TestDb } from './db';
import * as schema from '../../src/lib/db/schema';
import { resyncIdentity } from '../../src/lib/db/ops';

let tokenCounter = 0;

export function nowIso(): string {
  return new Date().toISOString();
}

export async function insertUser(db: TestDb, id: number, role: string, customRoleId: number | null = null, status = 'active'): Promise<number> {
  const now = nowIso();
  await db.insert(schema.users).values({
    id, email: `user${id}@example.com`, name: `User ${id}`, role, customRoleId, provider: 'credentials',
    subject: `user${id}@example.com`, status, createdAt: now, updatedAt: now,
  });
  // Explicit ids: the next generated one follows them (PostgreSQL).
  await resyncIdentity(schema.users, db);
  return id;
}

export async function insertRole(db: TestDb, id: number, permissions: readonly string[], scopeTags: readonly string[] = [], name = `role-${id}`): Promise<number> {
  const now = nowIso();
  await db.insert(schema.customRoles).values({
    id, name, permissions: JSON.stringify(permissions), scopeTags: JSON.stringify(scopeTags), createdAt: now, updatedAt: now,
  });
  await resyncIdentity(schema.customRoles, db);
  return id;
}

/** An API token for `userId`, stored as validateToken expects (SHA-256 of the raw token). */
export async function insertToken(db: TestDb, userId: number): Promise<string> {
  const raw = `cpm_test_${++tokenCounter}_${randomBytes(8).toString('hex')}`;
  await db.insert(schema.apiTokens).values({
    name: `token-${tokenCounter}`,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    createdBy: userId,
    createdAt: nowIso(),
  });
  return raw;
}

/** A request authenticated with an API token, with a JSON body. */
export function apiRequest(method: string, path: string, token: string, body?: unknown): any {
  const url = new URL(`https://dash.example.com${path}`);
  return {
    method,
    url: url.toString(),
    headers: new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
    nextUrl: url,
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

export function idParams(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

export async function json(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
