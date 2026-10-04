'use client';

/**
 * Простые графики для верфи — рисуем SVG руками.
 *
 * Библиотеку графиков в проект не тянем: нужны ровно две формы — ломаная
 * (дальность от загрузки, скорость от пипок) и горизонтальные полосы
 * (стоимость и потребление по разделам). Обе занимают меньше места, чем
 * зависимость, и рисуются теми же цветами, что и остальной HUD.
 */

import React from 'react';
import { LABEL, MONO } from './styles';

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: ChartPoint[];
}

interface LineChartProps {
  series: ChartSeries[];
  height?: number;
  /** Подпись оси X — единицы, не название величины. */
  xUnit?: string;
  yUnit?: string;
  formatX?: (value: number) => string;
  formatY?: (value: number) => string;
  /** Отметить точку текущего состояния сборки. */
  marker?: { x: number; label?: string };
}

const PAD_LEFT = 44;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 26;

/** Ломаная по набору точек: оси, сетка из трёх линий, подписи по краям. */
export function LineChart({
  series,
  height = 150,
  xUnit,
  yUnit,
  formatX = (value) => String(Math.round(value)),
  formatY = (value) => value.toFixed(1),
  marker,
}: LineChartProps) {
  const width = 300;
  const points = series.flatMap((entry) => entry.points);
  if (points.length < 2) return null;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, Math.min(...ys));
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const plotWidth = width - PAD_LEFT - PAD_RIGHT;
  const plotHeight = height - PAD_TOP - PAD_BOTTOM;
  const toX = (value: number) => PAD_LEFT + ((value - minX) / spanX) * plotWidth;
  const toY = (value: number) => PAD_TOP + plotHeight - ((value - minY) / spanY) * plotHeight;

  const gridY = [0, 0.5, 1].map((fraction) => minY + fraction * spanY);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      style={{ display: 'block', overflow: 'visible' }}
    >
      {gridY.map((value) => (
        <g key={value}>
          <line
            x1={PAD_LEFT}
            x2={width - PAD_RIGHT}
            y1={toY(value)}
            y2={toY(value)}
            stroke="var(--line)"
            strokeWidth={1}
          />
          <text
            x={PAD_LEFT - 5}
            y={toY(value) + 3}
            textAnchor="end"
            fontSize={8.5}
            fill="var(--muted)"
            fontFamily={MONO}
          >
            {formatY(value)}
          </text>
        </g>
      ))}

      {marker && marker.x >= minX && marker.x <= maxX && (
        <line
          x1={toX(marker.x)}
          x2={toX(marker.x)}
          y1={PAD_TOP}
          y2={PAD_TOP + plotHeight}
          stroke="var(--orange)"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.7}
        />
      )}

      {series.map((entry) => (
        <polyline
          key={entry.key}
          fill="none"
          stroke={entry.color}
          strokeWidth={1.6}
          strokeLinejoin="round"
          points={entry.points.map((point) => `${toX(point.x)},${toY(point.y)}`).join(' ')}
        />
      ))}

      <text x={PAD_LEFT} y={height - 4} fontSize={8.5} fill="var(--muted)" fontFamily={MONO}>
        {formatX(minX)}
      </text>
      <text
        x={width - PAD_RIGHT}
        y={height - 4}
        textAnchor="end"
        fontSize={8.5}
        fill="var(--muted)"
        fontFamily={MONO}
      >
        {formatX(maxX)}
        {xUnit ? ` ${xUnit}` : ''}
      </text>
      {yUnit && (
        <text x={2} y={PAD_TOP + 2} fontSize={8.5} fill="var(--muted)" fontFamily={MONO}>
          {yUnit}
        </text>
      )}
    </svg>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Горизонтальные полосы с подписью и долей от суммы. */
export function BarChart({
  items,
  format,
}: {
  items: BarItem[];
  format: (value: number) => string;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return null;
  const max = Math.max(...items.map((item) => item.value));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {items.map((item) => (
        <div key={item.key}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 10.5,
              color: 'var(--muted)',
              marginBottom: 2,
            }}
          >
            <span>{item.label}</span>
            <span style={{ fontFamily: MONO, color: 'var(--text)' }}>
              {format(item.value)}
              <span style={{ color: 'var(--muted)' }}> · {Math.round((item.value / total) * 100)} %</span>
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--line)', borderRadius: 2, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(2, (item.value / max) * 100)}%`,
                height: '100%',
                background: item.color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Заголовок графика с подписью оси — чтобы блоки выглядели одинаково. */
export function ChartBlock({
  title,
  legend,
  children,
}: {
  title: string;
  legend?: { label: string; color: string }[];
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 8 }}>
      <div style={{ ...LABEL, color: 'var(--orange)', marginBottom: 6 }}>{title}</div>
      {legend && legend.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          {legend.map((entry) => (
            <span
              key={entry.label}
              style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <span style={{ width: 10, height: 2, background: entry.color, display: 'inline-block' }} />
              {entry.label}
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}
