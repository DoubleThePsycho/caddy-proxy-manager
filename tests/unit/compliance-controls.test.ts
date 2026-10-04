/**
 * The control mapping (ee/compliance/controls.ts): every reference names a
 * real NIS2 measure or ISO/IEC 27001:2022 Annex A control, the wording stays
 * conservative, and the table in ee/docs/compliance-reports.md matches it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_STATEMENT,
  CONTROL_MAPPING,
  ISO27001_CONTROLS,
  NIS2_MEASURES,
  controlsFor,
  describeControlMapping,
  type MappedSubject,
} from '@/ee/compliance/controls';
import { REPORT_TYPE_LABELS, REPORT_TYPES, isReportType } from '@/ee/compliance/types';

const subjects = Object.keys(CONTROL_MAPPING) as MappedSubject[];

describe('control mapping', () => {
  it('maps every report and the incident drafts', () => {
    expect(subjects).toEqual([...REPORT_TYPES, 'incident_notification']);
    for (const subject of subjects) {
      expect(CONTROL_MAPPING[subject].nis2.length, subject).toBeGreaterThan(0);
      expect(CONTROL_MAPPING[subject].iso27001.length, subject).toBeGreaterThan(0);
    }
  });

  it('only references the NIS2 Article 21(2) measures (a) to (j), Article 23 and real Annex A controls', () => {
    expect(Object.keys(NIS2_MEASURES)).toEqual([
      ...'abcdefghij'.split('').map((letter) => `Art. 21(2)(${letter})`),
      'Art. 23',
    ]);
    for (const ref of Object.keys(ISO27001_CONTROLS)) {
      // Annex A of the 2022 edition: 5.1-5.37, 6.1-6.8, 7.1-7.14, 8.1-8.34.
      const [, theme, number] = ref.match(/^A\.(\d)\.(\d+)$/) ?? [];
      const max = { 5: 37, 6: 8, 7: 14, 8: 34 }[Number(theme) as 5 | 6 | 7 | 8];
      expect(max, ref).toBeDefined();
      expect(Number(number), ref).toBeLessThanOrEqual(max!);
    }
    expect(ISO27001_CONTROLS).toMatchObject({
      'A.5.15': 'Access control',
      'A.5.18': 'Access rights',
      'A.8.2': 'Privileged access rights',
      'A.8.5': 'Secure authentication',
      'A.8.9': 'Configuration management',
      'A.8.15': 'Logging',
      'A.8.24': 'Use of cryptography',
      'A.8.32': 'Change management',
    });
    for (const subject of subjects) {
      for (const control of controlsFor(subject)) {
        expect(control.title, control.ref).toBeTruthy();
        expect(control.how.length, control.ref).toBeGreaterThan(20);
      }
    }
  });

  it('says reports support controls, never that they make anyone compliant', () => {
    expect(COMPLIANCE_STATEMENT).toMatch(/evidence that can support/);
    expect(COMPLIANCE_STATEMENT).toMatch(/does not by itself show compliance/);
    const wording = JSON.stringify(describeControlMapping().mapping);
    expect(wording).not.toMatch(/\bcomplian(t|ce)\b|\bensures?\b|\bguarantee|\bcertif(y|ies|ied)\b|\bsatisf(y|ies)\b|\bmeets?\b/i);
  });

  it('matches the table in ee/docs/compliance-reports.md row for row', () => {
    const doc = readFileSync(join(process.cwd(), 'ee/docs/compliance-reports.md'), 'utf8');
    const table = doc.slice(doc.indexOf('<!-- control-mapping:start -->'), doc.indexOf('<!-- control-mapping:end -->'));
    const documented = table.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Report |') && !line.startsWith('| ---'));
    const expected = subjects.flatMap((subject) =>
      controlsFor(subject).map((control) =>
        `| ${isReportType(subject) ? REPORT_TYPE_LABELS[subject] : 'Incident notification drafts'} | ${control.framework} | ${control.ref} ${control.title} | ${control.how} |`
      )
    );
    expect(documented).toEqual(expected);
  });
});
