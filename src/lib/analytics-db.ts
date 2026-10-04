import { existsSync } from 'node:fs';
import { querySummary, isAnalyticsEnabled, type AnalyticsSummary as CHSummary } from './clickhouse/client';

/**
 * The overview's traffic summary. The analytics page and its API use
 * src/lib/analytics instead.
 */

const LOG_FILE = '/logs/access.log';

export interface AnalyticsSummary extends CHSummary {
  loggingDisabled: boolean;
  analyticsDisabled: boolean;
}

export async function getAnalyticsSummary(from: number, to: number, hosts: string[]): Promise<AnalyticsSummary> {
  const loggingDisabled = !existsSync(LOG_FILE);
  const analyticsDisabled = !isAnalyticsEnabled();
  const summary = await querySummary(from, to, hosts);
  return { ...summary, loggingDisabled, analyticsDisabled };
}
