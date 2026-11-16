import { useEffect, useRef, useState } from "react";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { useUi } from "@/store/ui";
import { motionOK } from "@/lib/perf";
import { Skeleton } from "@/components/ui/primitives";

/** Read a CSS custom property so charts follow the active theme. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The "royal" chart theme, built from the same tokens as the UI (src/styles/globals.css). */
export function chartTheme() {
  const fg = `rgb(${cssVar("--fg")})`;
  const muted = cssVar("--chart-axis");
  return {
    fg,
    muted,
    grid: cssVar("--chart-grid"),
    s1: cssVar("--chart-1"),
    s2: cssVar("--chart-2"),
    series: [1, 2, 3, 4, 5, 6].map((i) => cssVar(`--chart-${i}`)),
    ord: [cssVar("--chart-ord-1"), cssVar("--chart-ord-2"), cssVar("--chart-ord-3"), cssVar("--chart-ord-4")],
    /** brand gradient for the one hero series (vertical/horizontal stops for ECharts LinearGradient) */
    brand: (horizontal = true) => ({
      type: "linear",
      x: 0,
      y: 0,
      x2: horizontal ? 1 : 0,
      y2: horizontal ? 0 : 1,
      colorStops: [
        { offset: 0, color: `rgb(${cssVar("--grad-1")})` },
        { offset: 0.55, color: `rgb(${cssVar("--grad-2")})` },
        { offset: 1, color: `rgb(${cssVar("--grad-3")})` },
      ],
    }),
    font: '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif',
    tooltip: {
      backgroundColor: `rgb(${cssVar("--glass-solid")})`,
      borderColor: `rgb(${cssVar("--control-border")})`,
      textStyle: { color: fg, fontFamily: '"Instrument Sans Variable", system-ui, sans-serif', fontSize: 12 },
      extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgb(0 0 0 / .25);",
    },
  };
}

export type ChartTheme = ReturnType<typeof chartTheme>;

type EchartsModule = typeof import("@/components/echarts");
let loader: Promise<EchartsModule> | null = null;
const loadEcharts = () => (loader ??= import("@/components/echarts"));

/** Thin ECharts wrapper: lazy-loaded library, SVG renderer, theme-aware, resizes with its container.
 *  Series draw in once per mount (500 ms); later data updates animate in 200 ms. */
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
  const chartRef = useRef<ECharts | null>(null);
  const drawn = useRef(false);
  const [ready, setReady] = useState(false);
  const theme = useUi((s) => s.theme);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    loadEcharts().then(({ echarts }) => {
      if (disposed || !ref.current) return;
      const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
      chartRef.current = chart;
      ro = new ResizeObserver(() => chart.resize());
      ro.observe(ref.current);
      setReady(true);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const t = chartTheme();
    const animate = motionOK();
    chart.setOption(
      {
        aria: { enabled: true, label: { description: ariaLabel } },
        textStyle: { fontFamily: t.font },
        animation: animate,
        animationDuration: drawn.current ? 200 : 500,
        animationDurationUpdate: 200,
        animationEasing: "cubicOut",
        ...build(t),
      },
      true,
    );
    drawn.current = true;
    chart.off("click");
    if (onClick) chart.on("click", onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, theme, ariaLabel, ...deps]);

  return (
    <div className="relative w-full" style={{ height }}>
      {!ready && <Skeleton className="absolute inset-2" />}
      <div ref={ref} style={{ height }} role="img" aria-label={ariaLabel} className="w-full" />
    </div>
  );
}
