/**
 * Server-side render of the Provisioning, Access Reviews and My reviews
 * pages: controls for writers only, no token secret anywhere, and
 * reviewers' own access shown but not decidable.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/scim',
  useSearchParams: () => new URLSearchParams(),
}));

import ScimClient, { type ScimClientProps } from '@/ee/scim/ui/ScimClient';
import AccessReviewsClient from '@/ee/access-reviews/ui/AccessReviewsClient';
import MyReviewsClient from '@/ee/access-reviews/ui/MyReviewsClient';
import type { AssignmentView, CampaignSummary } from '@/ee/access-reviews/types';

const stamp = '2026-10-03T10:00:00.000Z';

function scimProps(overrides: Partial<ScimClientProps> = {}): ScimClientProps {
  return {
    settings: {
      enabled: true, providerId: 'corp', deleteMode: 'disable', defaultRole: 'user', manageRoles: true,
      requireVerifiedEmail: true, externalIdClaim: 'sub', endpointUrl: 'https://dash.example.com/scim/v2',
      providers: [{ id: 'corp', name: 'Corp IdP', enabled: true, autoLink: false }],
      counts: { users: 1, groups: 1, tokens: 1, mappings: 1 },
    },
    tokens: [{ id: 1, name: 'Okta', prefix: 'scim_AbCdEf', createdBy: 1, createdAt: stamp, lastUsedAt: null, expiresAt: null, expired: false }],
    mappings: [{ id: 1, groupId: 3, groupName: 'Engineering', role: 'admin', customRoleId: null, customRoleName: null, priority: 10, createdAt: stamp, updatedAt: stamp }],
    managedUsers: [{
      userId: 5, email: 'alice@example.com', name: 'Alice', status: 'active', role: 'user', customRoleId: null, userName: 'Alice@Example.com',
      externalId: '00u1', origin: 'scim', deletedAt: null, linkedAt: null, createdAt: stamp, updatedAt: stamp,
    }],
    managedGroups: [{ groupId: 3, name: 'Engineering', externalId: null, origin: 'scim', scimMemberCount: 1, memberCount: 2, createdAt: stamp, updatedAt: stamp }],
    userOptions: [{ id: 9, email: 'bob@example.com', name: 'Bob' }],
    groupOptions: [{ id: 4, name: 'Local' }],
    customRoles: [],
    canWrite: true,
    isAdmin: true,
    ...overrides,
  };
}

describe('Provisioning page', () => {
  it('shows the endpoint, the token prefix and the directory', () => {
    const html = renderToStaticMarkup(createElement(ScimClient, scimProps()));
    expect(html).toContain('https://dash.example.com/scim/v2');
    expect(html).toContain('scim_AbCdEf…');
    expect(html).toContain('Alice@Example.com');
    expect(html).toContain('Engineering');
    expect(html).toContain('>Save<');
    expect(html).toContain('New token');
  });

  it('offers no changes without scim:write', () => {
    const html = renderToStaticMarkup(createElement(ScimClient, scimProps({ canWrite: false })));
    expect(html).toContain('https://dash.example.com/scim/v2');
    expect(html).not.toContain('>Save<');
    expect(html).not.toContain('New token');
  });
});

describe('Access Reviews pages', () => {
  const campaign: CampaignSummary = {
    id: 3, name: 'Q4 review', status: 'open', overdue: true, scope: { type: 'all' },
    reviewers: [{ id: 2, email: 'reviewer@example.com', name: 'Reviewer' }], dueAt: stamp, startedAt: stamp,
    completedAt: null, cancelledAt: null, scheduleId: null, createdBy: 1,
    counts: { total: 4, pending: 3, drafted: 0, kept: 1, revoked: 0, unchanged: 0, failed: 0, notReviewed: 0, unreviewable: 0 },
  };

  it('lists campaigns with their overdue state', () => {
    const html = renderToStaticMarkup(createElement(AccessReviewsClient, {
      campaigns: [campaign], schedules: [], users: [], customRoles: [], groups: [], canWrite: true, myPending: 2,
    }));
    expect(html).toContain('Q4 review');
    expect(html).toContain('Overdue');
    expect(html).toContain('1 of 4</span> decided');
    expect(html).toContain('Start review');
    expect(html).toContain('You have 2 items to review');
  });

  it('shows a reviewer their own access without a decision control', () => {
    const item = (id: number, subjectUserId: number, ownAccess: boolean) => ({
      id, campaignId: 3, subjectUserId, subjectEmail: `user${subjectUserId}@example.com`, subjectName: null, kind: 'account' as const,
      targetId: null, targetLabel: 'Dashboard account', decision: null, comment: null, decidedBy: null, decidedByEmail: null,
      decidedAt: null, confirmedAt: null, outcome: null, outcomeDetail: null, overdue: false, ownAccess,
    });
    const assignments: AssignmentView[] = [{ campaign: { id: 3, name: 'Q4 review', dueAt: stamp, overdue: false }, items: [item(1, 2, true), item(2, 7, false)] }];
    const html = renderToStaticMarkup(createElement(MyReviewsClient, { assignments, currentUserId: 2 }));
    expect(html).toContain('Your own access: another reviewer decides');
    expect(html).not.toContain('Decision for user2@example.com');
    expect(html).toContain('aria-label="Decision for user7@example.com, account"');
  });
});
