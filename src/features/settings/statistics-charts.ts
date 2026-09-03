import type { EChartsType } from "echarts/core";

export const echartsLoader = Promise.all([
  import("echarts/core"),
  import("echarts/components"),
  import("echarts/charts"),
  import("echarts/renderers"),
]).then(([echarts, components, charts, renderers]) => {
  echarts.use([
    components.CalendarComponent,
    components.GridComponent,
    charts.HeatmapChart,
    charts.BarChart,
    components.LegendComponent,
    components.TooltipComponent,
    components.VisualMapComponent,
    renderers.CanvasRenderer,
  ]);
  return echarts;
});

export const readThemeColor = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  fallback;

/**
 * ECharts renders text on its own canvas, so it does not inherit the
 * document's computed font family. Keep chart labels in sync with the UI
 * font preference by reading the resolved CSS variable at chart creation.
 */
export const readThemeFont = (fallback = "sans-serif") =>
  getComputedStyle(document.documentElement)
    .getPropertyValue("--font-sans")
    .trim() || fallback;

export type StatisticsChart = EChartsType;
