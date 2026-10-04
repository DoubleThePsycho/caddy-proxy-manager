"use client";

import { StackedChartBase, type StackedChartProps } from "./chart-internals";

export type { ChartAnnotation, ChartSeries } from "./chart-internals";
export type StackedBarChartProps = StackedChartProps;

/**
 * Stacked bars per time bucket, as on the analytics page: series stacked in
 * order, hover or arrow keys for a tooltip with each series, the total and
 * the previous period, an optional dashed previous-period line, annotation
 * markers and a legend that hides series. Screen readers get a data table.
 */
export function StackedBarChart(props: StackedBarChartProps) {
  return <StackedChartBase {...props} variant="bar" />;
}
