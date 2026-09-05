import { useEffect, useMemo, useRef, useState } from "react";

import type { StatisticsActivityDay } from "@/domain/statistics";

import {
  activityCalendarCellSize,
  buildActivitySeries,
  compactNumber,
  dateKey,
  type ActivityView,
} from "./statistics-utils";
import {
  echartsLoader,
  readThemeColor,
  readThemeFont,
} from "./statistics-charts";

export function ActivityHeatmap({
  activity,
  view,
}: {
  activity: StatisticsActivityDay[];
  view: ActivityView;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const series = useMemo(
    () => buildActivitySeries(activity, view),
    [activity, view],
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((current) => current + 1);
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let chart: import("echarts/core").EChartsType | undefined;
    let resizeObserver: ResizeObserver | undefined;
    void echartsLoader
      .then((echarts) => {
        if (disposed) return;
        chart = echarts.init(container, undefined, { renderer: "canvas" });
        const initialCellSize = activityCalendarCellSize(container);
        const initialCellRadius = Math.min(3, initialCellSize * 0.2);
        const heatmapData = (cellRadius: number) =>
          series.map((item) => ({
            ...item,
            itemStyle: {
              borderRadius: cellRadius,
            },
          }));
        const updateCalendarLayout = () => {
          if (!chart) return;
          const cellSize = activityCalendarCellSize(container);
          const cellRadius = Math.min(3, cellSize * 0.2);
          chart.setOption({
            calendar: {
              cellSize: [cellSize, cellSize],
              itemStyle: {
                borderRadius: cellRadius,
              },
            },
            series: [
              {
                data: heatmapData(cellRadius),
                itemStyle: {
                  borderRadius: cellRadius,
                },
              },
            ],
          });
          chart.resize();
        };
        const chartBorder = readThemeColor("--harness-chart-border", "#dfe2e5");
        const chartBackground = readThemeColor("--harness-bg-base", "#ffffff");
        const chartText = readThemeColor("--harness-label-caption", "#707276");
        const chartFont = readThemeFont();
        const chartTooltip = readThemeColor("--harness-bg-layer-1", "#ffffff");
        const chartTooltipText = readThemeColor(
          "--harness-label-primary",
          "#26272a",
        );
        const chartLow = readThemeColor("--harness-chart-low", "#edf2f7");
        const chartMid = readThemeColor("--harness-chart-mid", "#a8c8e8");
        const chartHigh = readThemeColor("--harness-chart-high", "#5c91c5");
        const chartAccent = readThemeColor("--harness-chart-accent", "#245fba");
        const max = Math.max(
          1,
          ...series.map((item) => item.value[1] as number),
        );
        chart.setOption({
          animationDuration: 240,
          textStyle: {
            fontFamily: chartFont,
          },
          calendar: {
            range: [
              series[0]?.value[0] ?? dateKey(new Date()),
              series.at(-1)?.value[0] ?? dateKey(new Date()),
            ],
            left: 10,
            right: 10,
            top: 4,
            bottom: 30,
            cellSize: [initialCellSize, initialCellSize],
            splitLine: { show: false },
            itemStyle: {
              borderColor: chartBackground,
              borderWidth: 3,
              borderRadius: initialCellRadius,
              color: chartBackground,
            },
            yearLabel: { show: false },
            dayLabel: { show: false },
            monthLabel: {
              color: chartText,
              fontFamily: chartFont,
              fontSize: 11,
              margin: 8,
              nameMap: "ZH",
              position: "end",
            },
          },
          tooltip: {
            backgroundColor: chartTooltip,
            borderColor: chartBorder,
            borderWidth: 1,
            textStyle: {
              color: chartTooltipText,
              fontFamily: chartFont,
              fontSize: 12,
            },
            formatter: (params: {
              data?: {
                value: [string, number];
                tokens: number;
                tasks: number;
              };
            }) => {
              const item = params.data;
              if (!item) return "";
              return `${item.value[0]}<br/>${compactNumber(item.tokens)} Token · ${item.tasks} 个任务`;
            },
          },
          visualMap: {
            show: false,
            min: 0,
            max,
            inRange: {
              color: [chartLow, chartMid, chartHigh, chartAccent],
            },
          },
          series: [
            {
              type: "heatmap",
              coordinateSystem: "calendar",
              data: heatmapData(initialCellRadius),
              itemStyle: {
                borderRadius: initialCellRadius,
              },
            },
          ],
        });
        resizeObserver = new ResizeObserver(updateCalendarLayout);
        resizeObserver.observe(container);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chart?.dispose();
    };
  }, [series, themeVersion]);

  return <div className="h-44 w-full" ref={containerRef} />;
}
