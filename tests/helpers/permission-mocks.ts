/**
 * For tests that mock the administrator guards: requireApiPermission and
 * requirePermission answer like the test's own requireApiAdmin / requireAdmin
 * mock (so a mocked rejection still applies) and add the caller's access,
 * built from the role the mock returns.
 *
 * Use inside a vi.mock factory:
 *   requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
 */
import { builtInAccess } from '@/src/lib/permissions';

export async function viaRequireApiAdmin(request: unknown) {
  const auth = await import('@/src/lib/api-auth');
  const result = await auth.requireApiAdmin(request as never);
  return { ...result, access: builtInAccess(result.userId, result.role ?? 'admin') };
}

export async function viaRequireAdmin() {
  const auth = await import('@/src/lib/auth');
  const session = await auth.requireAdmin();
  return {
    ...session,
    access: builtInAccess(Number(session.user.id), (session.user as { role?: string }).role ?? 'admin'),
  };
}
