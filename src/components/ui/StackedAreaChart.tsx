"use client";

import { StackedChartBase, type StackedChartProps } from "./chart-internals";

export type { ChartAnnotation, ChartSeries } from "./chart-internals";
export type StackedAreaChartProps = StackedChartProps;

/**
 * Stacked areas over time, as on the overview: the same data, tooltip,
 * previous-period line, annotations, legend and accessible table as
 * StackedBarChart, drawn as filled areas with a line on top of each series.
 */
export function StackedAreaChart(props: StackedAreaChartProps) {
  return <StackedChartBase {...props} variant="area" />;
}
