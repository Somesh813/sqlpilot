import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
} from '@angular/core';
import * as echarts from 'echarts';
import { isNumeric, VisualizationType, type QueryResult } from '@sqlpilot/shared';
import { ThemeService } from '../core/services/theme.service';

@Component({
  selector: 'sp-chart',
  standalone: true,
  template: `<div #host class="h-full min-h-[240px] w-full"></div>`,
})
export class ChartComponent implements AfterViewInit, OnDestroy {
  readonly result = input.required<QueryResult>();
  readonly type = input<VisualizationType>(VisualizationType.BAR);
  readonly xField = input<string | null>(null);
  readonly yField = input<string | null>(null);

  @ViewChild('host') host!: ElementRef<HTMLDivElement>;
  private chart: echarts.ECharts | null = null;
  private readonly theme = inject(ThemeService);

  constructor() {
    effect(() => {
      // re-render on theme or data change
      this.theme.mode();
      this.result();
      this.type();
      queueMicrotask(() => this.render());
    });
  }

  ngAfterViewInit(): void {
    this.render();
    window.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.chart?.dispose();
  }

  private onResize = (): void => this.chart?.resize();

  private render(): void {
    if (!this.host) return;
    const dark = this.theme.mode() === 'dark';
    this.chart?.dispose();
    this.chart = echarts.init(this.host.nativeElement, undefined, { renderer: 'canvas' });

    const r = this.result();
    const cols = r.columns.map((c) => c.name);
    const numeric = cols.filter((c) => r.rows.every((row) => isNumeric(row[c])));
    const category = cols.filter((c) => !numeric.includes(c));
    const x = this.xField() ?? category[0] ?? cols[0];
    const y = this.yField() ?? numeric[0] ?? cols[1] ?? cols[0];

    const axisColor = dark ? '#9aa3b2' : '#6b7280';
    const grid = { left: 48, right: 24, top: 32, bottom: 48 };
    const base: echarts.EChartsOption = {
      grid,
      textStyle: { color: axisColor, fontFamily: 'Inter, sans-serif' },
      tooltip: { trigger: 'item' },
      color: ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7'],
    };

    const labels = r.rows.map((row) => String(row[x] ?? ''));
    const values = r.rows.map((row) => Number(row[y] ?? 0));

    let option: echarts.EChartsOption;
    switch (this.type()) {
      case VisualizationType.PIE:
        option = {
          ...base,
          tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
          series: [
            {
              type: 'pie',
              radius: ['40%', '68%'],
              data: r.rows.map((row) => ({ name: String(row[x]), value: Number(row[y]) })),
            },
          ],
        };
        break;
      case VisualizationType.SCATTER:
        option = {
          ...base,
          xAxis: { type: 'value', name: x, axisLine: { lineStyle: { color: axisColor } } },
          yAxis: { type: 'value', name: y, axisLine: { lineStyle: { color: axisColor } } },
          series: [{ type: 'scatter', data: r.rows.map((row) => [Number(row[x]), Number(row[y])]) }],
        };
        break;
      case VisualizationType.LINE:
      case VisualizationType.AREA:
        option = {
          ...base,
          xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: axisColor } } },
          yAxis: { type: 'value', axisLine: { lineStyle: { color: axisColor } } },
          series: [
            {
              type: 'line',
              smooth: true,
              areaStyle: this.type() === VisualizationType.AREA ? {} : undefined,
              data: values,
            },
          ],
        };
        break;
      default:
        option = {
          ...base,
          xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: labels.length > 8 ? 35 : 0 } },
          yAxis: { type: 'value', axisLine: { lineStyle: { color: axisColor } } },
          series: [{ type: 'bar', data: values, itemStyle: { borderRadius: [4, 4, 0, 0] } }],
        };
    }

    this.chart.setOption(option);
  }
}
