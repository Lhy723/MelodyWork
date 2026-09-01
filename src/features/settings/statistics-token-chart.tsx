import { useEffect, useMemo, useRef, useState } from "react";

import type { StatisticsActivityDay } from "@/domain/statistics";

import { echartsLoader, readThemeColor } from "./statistics-charts";
import { compactNumber, buildTokenBreakdownDays } from "./statistics-utils";

export function TokenBreakdownChart({
  activity,
}: {
  activity: StatisticsActivityDay[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const days = useMemo(() => buildTokenBreakdownDays(activity), [activity]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeVersion((current) => current + 1);
    });
    observer.observe(document.documentElement, {
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
        const textColor = readThemeColor("--harness-label-caption", "#696c70");
        const splitColor = readThemeColor("--harness-bg-layer-2", "#edf0f2");
        const chartTooltip = readThemeColor("--harness-bg-layer-1", "#ffffff");
        const chartTooltipText = readThemeColor(
          "--harness-label-primary",
          "#26272a",
        );
        const chartBorder = readThemeColor("--harness-chart-border", "#dfe2e5");
        const chartColors = [
          readThemeColor("--harness-chart-1", "#4f8fca"),
          readThemeColor("--harness-chart-2", "#6b3c8a"),
          readThemeColor("--harness-chart-3", "#157a45"),
          readThemeColor("--harness-chart-4", "#8a5316"),
        ];
        const hasUsage = days.some(
          (day) => day.inputTokens > 0 || day.outputTokens > 0,
        );
        chart.setOption({
          animationDuration: 240,
          color: chartColors,
          grid: {
            left: 4,
            right: 4,
            top: 38,
            bottom: 24,
            outerBoundsMode: "same",
            outerBoundsContain: "axisLabel",
          },
          legend: {
            top: 0,
            right: 0,
            itemWidth: 8,
            itemHeight: 8,
            textStyle: { color: textColor, fontSize: 11 },
            data: ["非缓存输入", "缓存读取", "普通输出", "推理"],
          },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: chartTooltip,
            borderColor: chartBorder,
            textStyle: { color: chartTooltipText, fontSize: 12 },
            valueFormatter: (value: number) => `${compactNumber(value)} Token`,
          },
          xAxis: {
            type: "category",
            data: days.map((day) => day.label),
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: textColor,
              fontSize: 10,
              interval: 4,
            },
          },
          yAxis: {
            type: "value",
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              show: hasUsage,
              color: textColor,
              fontSize: 10,
              formatter: (value: number) => compactNumber(value),
            },
            splitLine: {
              show: hasUsage,
              lineStyle: { color: splitColor },
            },
          },
          series: [
            {
              name: "非缓存输入",
              type: "bar",
              stack: "usage",
              barMaxWidth: 18,
              data: days.map((day) =>
                Math.max(0, day.inputTokens - day.cachedReadTokens),
              ),
            },
            {
              name: "缓存读取",
              type: "bar",
              stack: "usage",
              barMaxWidth: 18,
              data: days.map((day) => day.cachedReadTokens),
            },
            {
              name: "普通输出",
              type: "bar",
              stack: "usage",
              barMaxWidth: 18,
              data: days.map((day) =>
                Math.max(0, day.outputTokens - day.reasoningTokens),
              ),
            },
            {
              name: "推理",
              type: "bar",
              stack: "usage",
              barMaxWidth: 18,
              data: days.map((day) => day.reasoningTokens),
            },
          ],
        });
        resizeObserver = new ResizeObserver(() => chart?.resize());
        resizeObserver.observe(container);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chart?.dispose();
    };
  }, [days, themeVersion]);

  return <div className="h-60 w-full" ref={containerRef} />;
}
