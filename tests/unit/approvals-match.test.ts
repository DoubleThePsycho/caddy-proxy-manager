/**
 * Which approval policies cover a change (ee/approvals/match.ts): target
 * types, tags before and after a change, operations (an update that also
 * enables or disables), and how several policies combine to the strictest.
 */
import { describe, expect, it } from 'vitest';
import {
  describePolicies,
  policiesCovering,
  policiesForbiddingEmergency,
  requestTtlHoursFor,
  requiredApprovalsFor,
  updateOperations,
} from '@/ee/approvals/match';
import type { PolicyRule } from '@/ee/approvals/types';

function policy(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 1,
    name: 'Production',
    enabled: true,
    targetTypes: ['proxy_host', 'l4_proxy_host'],
    operations: ['create', 'update', 'delete', 'enable', 'disable'],
    hostTags: [],
    requiredApprovals: 1,
    allowEmergency: true,
    timeZone: 'UTC',
    windows: [],
    requestTtlHours: 72,
    ...overrides,
  };
}

describe('policiesCovering', () => {
  it('covers every host without tags, and hosts with one of its tags otherwise', () => {
    const all = policy();
    const prod = policy({ id: 2, hostTags: ['prod', 'pci'] });
    expect(policiesCovering([all, prod], 'proxy_host', [], ['update'])).toEqual([all]);
    expect(policiesCovering([all, prod], 'proxy_host', ['pci'], ['update'])).toEqual([all, prod]);
    expect(policiesCovering([prod], 'proxy_host', ['staging'], ['update'])).toEqual([]);
  });

  it('ignores disabled policies, other target types and other operations', () => {
    expect(policiesCovering([policy({ enabled: false })], 'proxy_host', [], ['update'])).toEqual([]);
    expect(policiesCovering([policy({ targetTypes: ['l4_proxy_host'] })], 'proxy_host', [], ['update'])).toEqual([]);
    const deletesOnly = policy({ operations: ['delete'] });
    expect(policiesCovering([deletesOnly], 'proxy_host', [], ['update'])).toEqual([]);
    expect(policiesCovering([deletesOnly], 'proxy_host', [], ['delete'])).toEqual([deletesOnly]);
    // An update that also disables the host is covered by a policy on disabling.
    const disables = policy({ operations: ['disable'] });
    expect(policiesCovering([disables], 'proxy_host', [], ['update', 'disable'])).toEqual([disables]);
  });
});

describe('updateOperations', () => {
  it('reads a change of `enabled` alone as enabling or disabling', () => {
    expect(updateOperations({ enabled: false }, true)).toEqual({ operation: 'disable', operations: ['disable'] });
    expect(updateOperations({ enabled: true, name: undefined }, false)).toEqual({ operation: 'enable', operations: ['enable'] });
  });

  it('reads anything else as a change, plus enabling or disabling when that changes too', () => {
    expect(updateOperations({ upstreams: ['b:80'] }, true)).toEqual({ operation: 'update', operations: ['update'] });
    expect(updateOperations({ name: 'x', enabled: true }, true)).toEqual({ operation: 'update', operations: ['update'] });
    expect(updateOperations({ name: 'x', enabled: false }, true)).toEqual({ operation: 'update', operations: ['update', 'disable'] });
    expect(updateOperations({}, true)).toEqual({ operation: 'update', operations: ['update'] });
  });

  it('reads forward-auth access and mTLS rule changes as changes of the host', () => {
    expect(updateOperations({ enabled: false }, true, true)).toEqual({ operation: 'update', operations: ['update', 'disable'] });
    expect(updateOperations({}, true, true)).toEqual({ operation: 'update', operations: ['update'] });
  });
});

describe('combining policies', () => {
  it('takes the most approvals, the shortest expiry and any refusal of emergency changes', () => {
    const a = policy({ id: 1, name: 'A', requiredApprovals: 2, requestTtlHours: 48 });
    const b = policy({ id: 2, name: 'B', requiredApprovals: 3, requestTtlHours: 96, allowEmergency: false });
    expect(requiredApprovalsFor([a, b])).toBe(3);
    expect(requiredApprovalsFor([])).toBe(1);
    expect(requestTtlHoursFor([a, b])).toBe(48);
    expect(policiesForbiddingEmergency([a, b])).toEqual([b]);
    expect(describePolicies([a])).toBe('the change approval policy "A"');
    expect(describePolicies([a, b])).toBe('the change approval policies "A", "B"');
  });
});
