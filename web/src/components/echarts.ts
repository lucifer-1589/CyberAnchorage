/** ECharts, tree-shaken to what the app draws (bar + line, SVG renderer). Imported lazily by Chart.tsx
 *  so routes render their shell before the chart library arrives. */
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer]);

export { echarts };
