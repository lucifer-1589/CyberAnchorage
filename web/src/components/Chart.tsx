import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, AriaComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { useUi } from "@/store/ui";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer]);

/** Read a CSS custom property so charts follow the active theme. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function chartTheme() {
  const fg = `rgb(${cssVar("--fg")})`;
  const muted = cssVar("--chart-axis");
  return {
    fg,
    muted,
    grid: cssVar("--chart-grid"),
    s1: cssVar("--chart-1"),
    s2: cssVar("--chart-2"),
    ord: [cssVar("--chart-ord-1"), cssVar("--chart-ord-2"), cssVar("--chart-ord-3"), cssVar("--chart-ord-4")],
    tooltip: {
      backgroundColor: `rgb(${cssVar("--glass-strong")} / 0.96)`,
      borderColor: `rgb(${cssVar("--glass-border")} / 0.15)`,
      textStyle: { color: fg, fontFamily: "Inter Variable, Inter, sans-serif", fontSize: 12 },
      extraCssText: "border-radius:10px;backdrop-filter:blur(12px);box-shadow:0 8px 24px rgb(0 0 0 / .25);",
    },
  };
}

export type ChartTheme = ReturnType<typeof chartTheme>;

/** Thin ECharts wrapper: SVG renderer, theme-aware, resizes with its container. */
export function Chart({
  build,
  height = 240,
  ariaLabel,
  deps,
  onClick,
}: {
  build: (t: ChartTheme) => EChartsCoreOption;
  height?: number;
  ariaLabel: string;
  deps: unknown[];
  onClick?: (params: any) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const theme = useUi((s) => s.theme);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption({ aria: { enabled: true, label: { description: ariaLabel } }, animationDuration: 300, ...build(chartTheme()) }, true);
    chart.off("click");
    if (onClick) chart.on("click", onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ariaLabel, ...deps]);

  return <div ref={ref} style={{ height }} role="img" aria-label={ariaLabel} className="w-full" />;
}
