import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AI_EXPLANATION_LABEL,
  buildEmail,
  buildNtfyMessage,
  buildPagerDutyEvent,
  buildSlackPayload,
  buildTeamsPayload,
  buildWebhookBody,
  cleanText,
  pagerDutyDedupKey,
  plainTextBody,
  signWebhook,
  testNotification,
  type AlertNotification,
} from '@/ee/alerting/format';

function notification(overrides: Partial<AlertNotification> = {}): AlertNotification {
  return {
    kind: 'firing',
    ruleId: 7,
    ruleName: 'Certificates',
    ruleType: 'cert_expiring',
    subjectKey: 'certificate:3',
    severity: 'warning',
    title: 'Certificate "shop" expires in 5 days (on 2026-10-07)',
    message: 'The certificate "shop" (shop.example.com) expires in 5 days (on 2026-10-07).',
    facts: { name: 'shop', daysLeft: 5 },
    explanation: null,
    eventId: 42,
    at: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('Slack', () => {
  it('escapes mrkdwn so names cannot ping channels or inject links', () => {
    const payload = buildSlackPayload(notification({ title: 'Upstream <!channel> & <https://evil.example|click>', message: 'x > y' }));
    expect(payload.text).toContain(':rotating_light: *[FIRING] Upstream &lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;*');
    expect(payload.text).not.toContain('<!channel>');
    expect(payload.text).toContain('x &gt; y');
    expect(payload.text).toContain('Rule: Certificates');
  });

  it('labels AI explanations', () => {
    const payload = buildSlackPayload(notification({ explanation: 'Renew <it> now.' }));
    expect(payload.text).toContain(`*${AI_EXPLANATION_LABEL}:* Renew &lt;it&gt; now.`);
    expect(buildSlackPayload(notification()).text).not.toContain(AI_EXPLANATION_LABEL);
  });

  it('marks resolved and test notifications', () => {
    expect(buildSlackPayload(notification({ kind: 'resolved', title: 'Resolved: x' })).text).toMatch(/^:white_check_mark: \*\[RESOLVED\] Resolved: x\*/);
    expect(buildSlackPayload(testNotification(new Date('2026-10-02T10:00:00Z'))).text).toMatch(/^:wave: \*\[TEST\] Test notification from Ingressi\*/);
  });
});

describe('Microsoft Teams', () => {
  it('builds an Adaptive Card message with escaped Markdown', () => {
    const payload = buildTeamsPayload(notification({ severity: 'critical', title: 'Host [click](https://evil.example)', explanation: 'Check *it*.' })) as any;
    expect(payload.type).toBe('message');
    const attachment = payload.attachments[0];
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    const [heading, message, facts, label, explanation] = attachment.content.body;
    expect(heading).toMatchObject({ type: 'TextBlock', color: 'Attention', weight: 'Bolder' });
    expect(heading.text).toBe('\\[FIRING\\] Host \\[click\\]\\(https://evil.example\\)');
    expect(message.type).toBe('TextBlock');
    expect(facts.facts).toContainEqual({ title: 'Severity', value: 'critical' });
    expect(label.text).toBe(AI_EXPLANATION_LABEL);
    expect(explanation.text).toBe('Check \\*it\\*.');
  });
});

describe('webhook', () => {
  it('sends a versioned JSON body with facts and a labeled explanation', () => {
    const body = buildWebhookBody(notification({ explanation: 'Renew it.' }));
    expect(body).toEqual({
      version: 1,
      source: 'ingressi',
      status: 'firing',
      severity: 'warning',
      rule: { id: 7, name: 'Certificates', type: 'cert_expiring' },
      subject: 'certificate:3',
      eventId: 42,
      title: 'Certificate "shop" expires in 5 days (on 2026-10-07)',
      message: 'The certificate "shop" (shop.example.com) expires in 5 days (on 2026-10-07).',
      facts: { name: 'shop', daysLeft: 5 },
      explanation: { label: AI_EXPLANATION_LABEL, text: 'Renew it.' },
      at: '2026-10-02T10:00:00.000Z',
    });
    expect(buildWebhookBody(testNotification()).rule).toBeNull();
  });

  it('signs timestamp + "." + body with HMAC-SHA256', () => {
    const body = JSON.stringify(buildWebhookBody(notification()));
    const expected = createHmac('sha256', 'hook-secret').update(`1790935200.${body}`).digest('hex');
    expect(signWebhook('hook-secret', '1790935200', body)).toBe(`sha256=${expected}`);
    expect(signWebhook('other-secret', '1790935200', body)).not.toBe(`sha256=${expected}`);
  });
});

describe('PagerDuty', () => {
  it('triggers with a stable dedup key and resolves with the same key', () => {
    const trigger = buildPagerDutyEvent(notification({ severity: 'critical', explanation: 'Renew it.' }), 'routing-key', 'trigger') as any;
    expect(trigger).toMatchObject({
      routing_key: 'routing-key',
      event_action: 'trigger',
      dedup_key: pagerDutyDedupKey(7, 'certificate:3'),
      payload: {
        summary: 'Certificate "shop" expires in 5 days (on 2026-10-07)',
        source: 'Ingressi',
        severity: 'critical',
        component: 'certificate:3',
        group: 'Certificates',
        class: 'cert_expiring',
      },
    });
    expect(trigger.payload.custom_details[AI_EXPLANATION_LABEL]).toBe('Renew it.');

    const resolve = buildPagerDutyEvent(notification({ kind: 'resolved' }), 'routing-key', 'resolve');
    expect(resolve).toEqual({ routing_key: 'routing-key', event_action: 'resolve', dedup_key: trigger.dedup_key });
  });

  it('keeps dedup keys distinct per rule and subject and within PagerDuty limits', () => {
    const key = pagerDutyDedupKey(7, 'upstream:' + 'a'.repeat(500));
    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).toMatch(/^ingressi-7-[0-9a-f]{24}$/);
    expect(pagerDutyDedupKey(7, 'certificate:3')).not.toBe(pagerDutyDedupKey(8, 'certificate:3'));
    expect(pagerDutyDedupKey(7, 'certificate:3')).not.toBe(pagerDutyDedupKey(7, 'certificate:4'));
  });
});

describe('ntfy', () => {
  it('publishes JSON with priority and tags', () => {
    expect(buildNtfyMessage(notification({ severity: 'critical' }), 'ops')).toMatchObject({ topic: 'ops', priority: 5, tags: ['rotating_light'], title: '[FIRING] Certificate "shop" expires in 5 days (on 2026-10-07)' });
    expect(buildNtfyMessage(notification({ kind: 'resolved' }), 'ops')).toMatchObject({ priority: 3, tags: ['white_check_mark'] });
  });
});

describe('e-mail', () => {
  it('escapes HTML, keeps the subject on one line and labels the explanation', () => {
    const email = buildEmail(notification({ title: 'Bad\r\nBcc: victim@example.com <b>', message: '<script>alert(1)</script>', explanation: 'Do <this>.' }));
    expect(email.subject).toBe('[Ingressi] [FIRING] Bad Bcc: victim@example.com <b>');
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain(`<strong>${AI_EXPLANATION_LABEL}:</strong><br>Do &lt;this&gt;.`);
    expect(email.text).toContain(`${AI_EXPLANATION_LABEL}:\nDo <this>.`);
  });
});

describe('plain text', () => {
  it('strips control characters and bounds lengths', () => {
    expect(cleanText('a\u0000b\u001b[31mc', 100)).toBe('a b [31mc');
    expect(cleanText('x'.repeat(50), 10)).toBe('xxxxxxxxx…');
    expect(cleanText('line 1\r\n\r\n\r\n\r\nline 2\u0007', 100, true)).toBe('line 1\n\nline 2');
    const body = plainTextBody(notification());
    expect(body).toContain('Rule: Certificates');
    expect(body).toContain('Time: 2026-10-02T10:00:00.000Z');
    expect(body.endsWith('Sent by Ingressi')).toBe(true);
  });
});
