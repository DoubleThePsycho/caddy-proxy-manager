/**
 * Notices through alert channels (ee/alerting/notice.ts): one payload per
 * channel type, PagerDuty refused, safe errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/ee/alerting/deliver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ee/alerting/deliver')>()),
  sendEmailMessage: sendMail,
}));

import { deliverNoticeToChannel, type Notice } from '@/ee/alerting/notice';
import type { ResolvedChannel } from '@/ee/alerting/channels';

const notice: Notice = {
  event: 'compliance_reports_generated',
  title: 'Monthly evidence: evidence for 2026-10-01 to 2026-10-31',
  lines: ['Access review: 1 medium (SHA-256 4be17c09d1e29a07…)', 'Change log: <b>no findings</b>'],
  link: 'https://dash.example.com/compliance',
  data: { packId: 'p1' },
  at: '2026-11-01T06:00:00.000Z',
};

const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  sendMail.mockClear();
});

function channel(type: ResolvedChannel['type'], extra: Record<string, unknown> = {}): ResolvedChannel {
  return { id: 1, name: 'c', type, config: {}, secrets: {}, ...extra } as unknown as ResolvedChannel;
}

describe('notices', () => {
  it('posts each channel type its own payload, escaping text', async () => {
    vi.stubGlobal('fetch', fetchMock);
    expect(await deliverNoticeToChannel(channel('slack', { secrets: { webhookUrl: 'https://hooks.slack.com/services/x' } }), notice)).toEqual({ ok: true, error: null });
    const slack = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(slack.text).toContain('&lt;b&gt;no findings&lt;/b&gt;');
    expect(slack.text).toContain('https://dash.example.com/compliance');

    await deliverNoticeToChannel(channel('webhook', { secrets: { url: 'https://hooks.example.com/in', hmacSecret: 'secret' } }), notice);
    const [, webhook] = fetchMock.mock.calls[1] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(JSON.parse(webhook.body)).toMatchObject({ event: 'compliance_reports_generated', data: { packId: 'p1' }, link: notice.link });
    expect(webhook.headers['X-Ingressi-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    await deliverNoticeToChannel(channel('ntfy', { config: { serverUrl: 'https://ntfy.example.com', topic: 'edge' }, secrets: {} }), notice);
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, { body: string }])[1].body)).toMatchObject({ topic: 'edge', click: notice.link });

    await deliverNoticeToChannel(channel('teams', { secrets: { webhookUrl: 'https://example.com/workflows/x' } }), notice);
    const teams = JSON.parse((fetchMock.mock.calls[3] as unknown as [string, { body: string }])[1].body);
    expect(teams.attachments[0].content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open', url: notice.link }]);
  });

  it('sends e-mail with escaped HTML', async () => {
    await deliverNoticeToChannel(channel('email'), notice);
    const message = (sendMail.mock.calls[0] as unknown as [unknown, { subject: string; html: string; text: string }])[1];
    expect(message.subject).toContain('Monthly evidence');
    expect(message.html).toContain('&lt;b&gt;no findings&lt;/b&gt;');
    expect(message.text).toContain('https://dash.example.com/compliance');
  });

  it('never sends to PagerDuty and reports failures without their details', async () => {
    expect(await deliverNoticeToChannel(channel('pagerduty'), notice)).toEqual({ ok: false, error: 'Notices are not sent to PagerDuty' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('token=abc', { status: 404 })));
    const result = await deliverNoticeToChannel(channel('slack', { secrets: { webhookUrl: 'https://hooks.slack.com/services/x' } }), notice);
    expect(result).toEqual({ ok: false, error: 'The endpoint answered with HTTP 404' });
  });
});
