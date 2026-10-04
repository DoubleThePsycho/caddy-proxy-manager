# Charts

The dashboard draws its charts with its own components in `src/components/ui/`,
plain React with SVG and positioned elements. There is no charting library, so
no third-party license terms and no extra chunk to load.

## Components

| Component | Used for |
| --- | --- |
| `StackedBarChart` | Requests per time bucket stacked by outcome (analytics, a host's traffic, security events, monetization). |
| `StackedAreaChart` | The same data as filled areas (overview traffic). |
| `Sparkline` | The small trend line in a `KpiTile`. |
| `TopList` | Ranked rows with share bars (top hosts, paths, countries, rules). |
| `ExpiryTimeline` | Certificate expiry markers on a time axis. |

`StackedBarChart` and `StackedAreaChart` share `chart-internals.tsx`: scales,
axes, the tooltip, the dashed previous-period line, annotation pills and the
legend. Number and time formatting lives in `chart-format.ts`, which has no
React code. Both are covered by `tests/unit/ui-charts.test.ts`.

## Behaviour

- Series colours are CSS tokens (`--served`, `--waf`, `--err5`, …) defined in
  `app/globals.css` for the light and dark themes.
- Hover, or focus the chart and use the arrow keys, Home, End and Escape, to
  read one bucket: each series, the total and the previous period with the
  change. A live region announces the same text.
- Every chart has a visually hidden table with each bucket and series, so
  screen readers can read all of it.
- Legend buttons hide and show series; the axis is recalculated.
- Charts adapt to the width they are given (container queries), not to the
  window: under 24rem the plot is shorter, the x axis keeps 3 labels and the
  tooltip spans the plot; up to 36rem the axis keeps 4 labels.

## Content Security Policy

Charts render as React elements and inline `style` attributes; nothing uses
`eval` or injects `<style>` elements. Request-derived labels such as user
agents and paths are escaped like any other React text.
