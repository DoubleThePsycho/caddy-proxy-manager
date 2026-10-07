/**
 * Server-side render of the Approvals page and of the notice the host dialogs
 * show for a protected host: the field-level diff, which buttons the viewer
 * gets (never Approve on their own request) and the emergency switch only for
 * users who may use it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/approvals',
  useSearchParams: () => new URLSearchParams(),
}));

import ApprovalsClient from '@/ee/approvals/ui/ApprovalsClient';
import { ProtectedChangeNotice } from '@/ee/approvals/ui/ProtectedChangeNotice';
import type { ApprovalPolicyView, ChangeRequestView, PolicyRule } from '@/ee/approvals/types';

const stamp = '2026-10-05T08:00:00.000Z';

const policy: ApprovalPolicyView = {
  id: 1,
  name: 'Production',
  description: 'PCI scope',
  enabled: true,
  targetTypes: ['proxy_host'],
  operations: ['create', 'update', 'delete', 'enable', 'disable'],
  hostTags: ['prod'],
  requiredApprovals: 2,
  allowEmergency: true,
  timeZone: 'Europe/Rome',
  windows: [{ days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start: '09:00', end: '17:00' }],
  requestTtlHours: 72,
  createdAt: stamp,
  updatedAt: stamp,
};

function request(viewer: Partial<ChangeRequestView['viewer']> = {}): ChangeRequestView {
  return {
    id: 7,
    targetType: 'proxy_host',
    targetId: 3,
    targetName: 'App',
    operation: 'update',
    operations: ['update'],
    status: 'pending',
    requestedBy: { id: 2, name: 'Alice' },
    note: 'Ticket CHG-7',
    emergency: false,
    emergencyReason: null,
    emergencyBy: null,
    requiredApprovals: 2,
    approvals: 1,
    policies: [{ id: 1, name: 'Production' }],
    tags: ['prod'],
    input: { host: { upstreams: ['app-v2:8080'] } },
    changes: [{ path: 'host.upstreams', before: ['app:8080'], after: ['app-v2:8080'] }],
    reviews: [{ id: 1, userId: 3, userName: 'Bob', decision: 'approve', comment: 'Fine by me', createdAt: stamp }],
    window: { restricted: true, open: false, nextOpenAt: '2026-10-06T07:00:00.000Z', description: 'Mon–Fri 09:00–17:00 (Europe/Rome)' },
    expiresAt: '2026-10-08T08:00:00.000Z',
    decidedAt: null,
    appliedAt: null,
    appliedBy: null,
    error: null,
    createdAt: stamp,
    updatedAt: stamp,
    viewer: { isRequester: false, canApprove: true, canReject: true, canCancel: false, canApply: false, canEmergency: false, ...viewer },
    impact: {
      hosts: [{ type: 'proxy_host', id: 3, name: 'App', domains: ['app.example.com'], change: 'update', operations: ['update'] }],
      otherHosts: 0,
      caddy: { reloads: true, nodes: 1, instances: [], heldBack: [], certificateRequests: [], l4PortsChange: false },
      schedule: { state: 'next_window', at: '2026-10-06T07:00:00.000Z', windows: 'Mon–Fri 09:00–17:00 (Europe/Rome)', description: 'At the next change window after approval: 2026-10-06 07:00 UTC.' },
      lines: [
        { key: 'hosts', text: 'App. No other host changes.' },
        { key: 'caddy', text: 'Reloads its configuration on this node.' },
        { key: 'when', text: 'At the next change window after approval: 2026-10-06 07:00 UTC.' },
      ],
    },
  };
}

function render(requests: ChangeRequestView[], extra: { decided?: ChangeRequestView[]; alertChannels?: string[] | null } = {}) {
  const decided = extra.decided ?? [];
  return renderToStaticMarkup(
    createElement(ApprovalsClient, {
      initialTab: 'requests',
      open: { requests, total: requests.length, page: 1, perPage: 100 },
      recent: decided,
      decided: { requests: decided, total: decided.length, page: 1, perPage: 25 },
      policies: [policy],
      canManage: true,
      alertChannels: extra.alertChannels ?? null,
      now: '2026-10-05T09:00:00.000Z',
    })
  );
}

describe('Approvals page', () => {
  it('shows the request with its policy, diff, impact, discussion, window and the approver\'s buttons', () => {
    const html = render([request()]);
    expect(html).toContain('#7');
    expect(html).toContain('Change proxy host “App”');
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Waiting/s);
    expect(html).toContain('Requested by <span class="font-semibold text-foreground">Alice</span>');
    expect(html).toContain('Any change to proxy hosts tagged prod needs 2 approvers who are not the requester.');
    expect(html).toContain('Emergency changes allowed');
    expect(html).toContain('app-v2:8080');
    expect(html).toContain('Fine by me');
    expect(html).toContain('Ticket CHG-7');
    expect(html).toContain('Mon–Fri 09:00–17:00 (Europe/Rome)');
    expect(html).toContain('The change window is closed now.');
    expect(html).toContain('App. No other host changes.');
    expect(html).toMatch(/1 of 2/);
    expect(html).toMatch(/>\s*Approve\s*</);
    expect(html).toContain('Reject</button>');
    expect(html).toContain('Required to reject, optional to approve');
    expect(html).not.toContain('Emergency change</button>');
    // Tokens only, never Tailwind palette colours.
    expect(html).not.toMatch(/(red|emerald|amber)-\d{3}/);
  });

  it('never offers the requester an Approve button', () => {
    const html = render([request({ isRequester: true, canApprove: false, canReject: false, canCancel: true })]);
    expect(html).toContain('You made this request: someone else has to approve it.');
    expect(html).not.toMatch(/>\s*Approve\s*</);
    expect(html).toContain('Cancel request');
  });

  it('keeps Apply now closed outside the change window and offers an emergency change when allowed', () => {
    const approved: ChangeRequestView = {
      ...request({ canApprove: false, canApply: false, canEmergency: true }),
      status: 'approved',
      approvals: 2,
      impact: { ...request().impact, schedule: { state: 'waiting', at: '2026-10-06T07:00:00.000Z', windows: null, description: 'Approved; applied when the change window opens, 2026-10-06 07:00 UTC.' } },
    };
    const html = render([approved]);
    expect(html).toContain('Approved, waits for window');
    expect(html).toContain('Approved; applied when the change window opens, 2026-10-06 07:00 UTC.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="The change window is closed"[^>]*>Apply now/);
    expect(html).toContain('Emergency change</button>');
  });

  it('lists decided requests with the decision and its reason', () => {
    const rejected: ChangeRequestView = {
      ...request(),
      id: 5,
      status: 'rejected',
      decidedAt: '2026-10-05T08:30:00.000Z',
      reviews: [{ id: 2, userId: 3, userName: 'Bob', decision: 'reject', comment: 'Still in use until next week', createdAt: '2026-10-05T08:30:00.000Z' }],
      window: { restricted: false, open: true, nextOpenAt: null, description: null },
    };
    const html = render([], { decided: [rejected], alertChannels: ['Ops Slack'] });
    expect(html).toContain('Recently decided');
    expect(html).toContain('Rejected by Bob');
    expect(html).toContain('“Still in use until next week”');
    expect(html).toContain('Alerts go to Ops Slack');
    expect(html).toContain('1 policy on');
  });

  it('says when no change is waiting', () => {
    const html = render([]);
    expect(html).toContain('No change is waiting for approval.');
  });
});

describe('ProtectedChangeNotice', () => {
  const rule: PolicyRule = { ...policy };

  it('says before saving that the host is protected, and offers emergency changes only when allowed', () => {
    const protectedHtml = renderToStaticMarkup(
      createElement(ProtectedChangeNotice, { approval: { policies: [rule], canEmergency: false }, targetType: 'proxy_host', tags: ['prod'], operations: ['update'] })
    );
    expect(protectedHtml).toContain('This host is protected by the change approval policy &quot;Production&quot;');
    expect(protectedHtml).toContain('2 approvals from someone other than you');
    expect(protectedHtml).toContain('changeNote');
    expect(protectedHtml).not.toContain('Emergency change');

    const withEmergency = renderToStaticMarkup(
      createElement(ProtectedChangeNotice, { approval: { policies: [rule], canEmergency: true }, targetType: 'proxy_host', tags: ['prod'], operations: ['update'] })
    );
    expect(withEmergency).toContain('Emergency change: apply now without approval');
    const forbidden = renderToStaticMarkup(
      createElement(ProtectedChangeNotice, { approval: { policies: [{ ...rule, allowEmergency: false }], canEmergency: true }, targetType: 'proxy_host', tags: ['prod'], operations: ['update'] })
    );
    expect(forbidden).not.toContain('Emergency change');
  });

  it('shows nothing for an unprotected host and a hint for new hosts', () => {
    expect(
      renderToStaticMarkup(createElement(ProtectedChangeNotice, { approval: { policies: [rule], canEmergency: true }, targetType: 'proxy_host', tags: ['dev'], operations: ['update'] }))
    ).toBe('');
    expect(
      renderToStaticMarkup(createElement(ProtectedChangeNotice, { approval: { policies: [rule], canEmergency: true }, targetType: 'proxy_host', tags: [], operations: ['create'] }))
    ).toContain('A host tagged prod needs approval before it is created.');
  });
});
