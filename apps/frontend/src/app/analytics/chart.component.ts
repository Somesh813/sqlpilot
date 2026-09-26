import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import * as echarts from 'echarts';
import { isNumeric, VisualizationType, type QueryResult } from '@sqlpilot/shared';
import { ThemeService } from '../core/services/theme.service';
import { humanizeHeader } from '../shared/format-value';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#84cc16'];

/**
 * Draws the rows it is given — never mock data. Axes/series come from the inputs when
 * provided (the backend's analysis), otherwise they are inferred from the column types.
 * If ECharts throws, the failure is contained here and reported via `failed`.
 */
@Component({
  selector: 'sp-chart',
  standalone: true,
  template: `
    @if (failed()) {
      <div class="grid h-full min-h-[8rem] place-items-center text-xs text-content-muted">
        This data couldn't be drawn as a chart. The table above has all the values.
      </div>
    } @else {
      <div #host class="h-full w-full"></div>
    }
  `,
  styles: [':host { display: block; width: 100%; height: 100%; min-height: 16rem; }'],
})
export class ChartComponent implements AfterViewInit, OnDestroy {
  readonly result = input.required<QueryResult>();
  readonly type = input<VisualizationType>(VisualizationType.BAR);
  readonly xField = input<string | null>(null);
  readonly yFields = input<string[]>([]);

  readonly failed = signal(false);

  @ViewChild('host') host?: ElementRef<HTMLDivElement>;
  private chart: echarts.ECharts | null = null;
  private observer: ResizeObserver | null = null;
  private ready = false;
  private readonly theme = inject(ThemeService);

  constructor() {
    effect(() => {
      // re-render whenever any input, or the theme, changes
      this.theme.mode();
      this.result();
      this.type();
      this.xField();
      this.yFields();
      if (this.ready) queueMicrotask(() => this.render());
    });
  }

  ngAfterViewInit(): void {
    this.ready = true;
    this.render();
    if (this.host && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.chart?.resize());
      this.observer.observe(this.host.nativeElement);
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.chart?.dispose();
  }

  private render(): void {
    if (!this.host) return;
    try {
      this.chart?.dispose();
      this.chart = echarts.init(this.host.nativeElement, undefined, { renderer: 'canvas' });
      this.chart.setOption(this.buildOption());
      this.failed.set(false);
    } catch (error) {
      console.error('[sp-chart] could not render chart', error);
      this.failed.set(true);
    }
  }

  private buildOption(): echarts.EChartsOption {
    const dark = this.theme.mode() === 'dark';
    const text = dark ? '#c7cdd8' : '#4b5563';
    const line = dark ? '#2a303c' : '#e5e7eb';
    const r = this.result();
    const cols = r.columns.map((c) => c.name);
    const numeric = cols.filter((c) => r.rows.every((row) => row[c] === null || isNumeric(row[c])));
    const dimensions = cols.filter((c) => !numeric.includes(c));

    const x = this.xField() ?? dimensions[0] ?? cols[0];
    const ys = this.yFields().length ? this.yFields() : [numeric.find((c) => c !== x) ?? cols[1] ?? cols[0]];
    const labels = r.rows.map((row) => String(row[x] ?? ''));
    const series = (y: string) => r.rows.map((row) => Number(row[y] ?? 0));
    const type = this.type();

    const base: echarts.EChartsOption = {
      color: PALETTE,
      backgroundColor: 'transparent',
      textStyle: { color: text, fontFamily: 'Inter, system-ui, sans-serif' },
      tooltip: {
        confine: true,
        backgroundColor: dark ? '#111419' : '#ffffff',
        borderColor: line,
        textStyle: { color: dark ? '#f3f4f6' : '#111827' },
      },
      legend: ys.length > 1 ? { top: 0, textStyle: { color: text } } : undefined,
    };

    if (type === VisualizationType.PIE) {
      const y = ys[0];
      return {
        ...base,
        tooltip: { ...base.tooltip, trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { type: 'scroll', bottom: 0, textStyle: { color: text } },
        series: [
          {
            type: 'pie',
            radius: ['42%', '70%'],
            center: ['50%', '45%'],
            itemStyle: { borderColor: dark ? '#0a0c10' : '#fff', borderWidth: 2, borderRadius: 4 },
            label: { color: text },
            data: r.rows.map((row) => ({ name: String(row[x] ?? ''), value: Number(row[y] ?? 0) })),
          },
        ],
      };
    }

    if (type === VisualizationType.SCATTER) {
      const sx = this.xField() ?? numeric[0];
      const sy = ys[0] ?? numeric[1];
      return {
        ...base,
        tooltip: { ...base.tooltip, trigger: 'item' },
        grid: { left: 56, right: 24, top: 24, bottom: 48 },
        xAxis: { type: 'value', name: humanizeHeader(sx), nameTextStyle: { color: text }, splitLine: { lineStyle: { color: line } } },
        yAxis: { type: 'value', name: humanizeHeader(sy), nameTextStyle: { color: text }, splitLine: { lineStyle: { color: line } } },
        series: [{ type: 'scatter', symbolSize: 9, data: r.rows.map((row) => [Number(row[sx]), Number(row[sy])]) }],
      };
    }

    const isLine = type === VisualizationType.LINE || type === VisualizationType.AREA;
    const manyLabels = labels.length > 8;
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: 'axis', axisPointer: { type: isLine ? 'line' : 'shadow' } },
      grid: { left: 56, right: 24, top: ys.length > 1 ? 36 : 24, bottom: manyLabels ? 72 : 40, containLabel: false },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: !isLine,
        axisLine: { lineStyle: { color: line } },
        axisLabel: { color: text, rotate: manyLabels ? 40 : 0, interval: labels.length > 24 ? 'auto' : 0, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: text },
        splitLine: { lineStyle: { color: line, opacity: 0.7 } },
      },
      series: ys.map((y) => ({
        name: humanizeHeader(y),
        type: isLine ? ('line' as const) : ('bar' as const),
        smooth: isLine,
        showSymbol: labels.length <= 40,
        areaStyle: type === VisualizationType.AREA ? { opacity: 0.25 } : undefined,
        itemStyle: isLine ? undefined : { borderRadius: [4, 4, 0, 0] },
        data: series(y),
      })),
    };
  }
}
