'use client';

/**
 * Значок авианосца — как на навигационной панели и картах игры: контур
 * корпуса (узкий верх, широкие «плечи», две опоры с вырезом между ними) и
 * круг ангара с горизонтальным «окном». Свой носитель жёлтый, носители
 * эскадрильи зелёные, остальные оранжевые, списываемый — серый и перечёркнут.
 *
 * Эскадренный Javelin отличается заполненным кругом: в игре у него тот же
 * силуэт, а на сайте классы нужно различать с первого взгляда.
 *
 * Одна геометрия (сетка 64×64) рисуется двумя способами: SVG — в панели слоёв
 * и карточках, canvas — в текстуре спрайта на 3D-карте.
 */

import type { CSSProperties } from 'react';
import { CARRIER_TONE_COLOR, type CarrierTone } from '@/lib/carrierMap';

export type CarrierGlyphKind = 'drake' | 'javelin';

export const CARRIER_GLYPH_GRID = 64;
export const CARRIER_HULL_PATH = 'M27 4H37L59 44L50 59H40L36 52H28L24 59H14L5 44Z';
export const CARRIER_CORE = { cx: 32, cy: 33, r: 11 } as const;
export const CARRIER_SLOT = { x: 25.5, y: 31.25, width: 13, height: 3.5 } as const;
export const CARRIER_SLASH_PATH = 'M9 57L55 9';
const HULL_STROKE = 4;
const CORE_STROKE = 3.5;
const HULL_FILL = 'rgba(8, 10, 12, 0.55)';
const DARK = '#0d0f11';

export interface CarrierGlyphProps {
  glyph?: CarrierGlyphKind;
  tone?: CarrierTone;
  /** Явный цвет вместо цвета тона. */
  color?: string;
  size?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function CarrierGlyph({ glyph = 'drake', tone = 'other', color, size = 16, title, className, style }: CarrierGlyphProps) {
  const stroke = color ?? CARRIER_TONE_COLOR[tone];
  const javelin = glyph === 'javelin';
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${CARRIER_GLYPH_GRID} ${CARRIER_GLYPH_GRID}`}
      fill="none"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={className}
      data-carrier-glyph={glyph}
      data-carrier-tone={tone}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    >
      {title ? <title>{title}</title> : null}
      <path d={CARRIER_HULL_PATH} fill={HULL_FILL} stroke={stroke} strokeWidth={HULL_STROKE} strokeLinejoin="round" />
      {javelin ? (
        <>
          <circle cx={CARRIER_CORE.cx} cy={CARRIER_CORE.cy} r={CARRIER_CORE.r + CORE_STROKE / 2} fill={stroke} />
          <rect {...CARRIER_SLOT} fill={DARK} />
        </>
      ) : (
        <>
          <circle cx={CARRIER_CORE.cx} cy={CARRIER_CORE.cy} r={CARRIER_CORE.r} stroke={stroke} strokeWidth={CORE_STROKE} />
          <rect {...CARRIER_SLOT} fill={stroke} />
        </>
      )}
      {tone === 'decommission' ? (
        <path d={CARRIER_SLASH_PATH} stroke={stroke} strokeWidth={HULL_STROKE} strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/**
 * Тот же значок на canvas: `x, y` — левый верхний угол, `size` — сторона
 * квадрата в пикселях. Тёмная подложка под контуром держит значок читаемым
 * на ярком ядре галактики.
 */
export function drawCarrierGlyph(
  ctx: CanvasRenderingContext2D,
  options: { glyph: CarrierGlyphKind; color: string; size: number; x: number; y: number; decommission?: boolean },
): void {
  const scale = options.size / CARRIER_GLYPH_GRID;
  const hull = new Path2D(CARRIER_HULL_PATH);
  const core = new Path2D();
  core.arc(CARRIER_CORE.cx, CARRIER_CORE.cy, CARRIER_CORE.r, 0, Math.PI * 2);

  ctx.save();
  ctx.translate(options.x, options.y);
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(4, 6, 8, 0.9)';
  ctx.lineWidth = HULL_STROKE + 4;
  ctx.stroke(hull);
  ctx.fillStyle = HULL_FILL;
  ctx.fill(hull);

  ctx.strokeStyle = options.color;
  ctx.lineWidth = HULL_STROKE;
  ctx.stroke(hull);

  if (options.glyph === 'javelin') {
    const disc = new Path2D();
    disc.arc(CARRIER_CORE.cx, CARRIER_CORE.cy, CARRIER_CORE.r + CORE_STROKE / 2, 0, Math.PI * 2);
    ctx.fillStyle = options.color;
    ctx.fill(disc);
    ctx.fillStyle = DARK;
    ctx.fillRect(CARRIER_SLOT.x, CARRIER_SLOT.y, CARRIER_SLOT.width, CARRIER_SLOT.height);
  } else {
    ctx.lineWidth = CORE_STROKE;
    ctx.stroke(core);
    ctx.fillStyle = options.color;
    ctx.fillRect(CARRIER_SLOT.x, CARRIER_SLOT.y, CARRIER_SLOT.width, CARRIER_SLOT.height);
  }

  if (options.decommission) {
    const slash = new Path2D(CARRIER_SLASH_PATH);
    ctx.strokeStyle = 'rgba(4, 6, 8, 0.9)';
    ctx.lineWidth = HULL_STROKE + 4;
    ctx.stroke(slash);
    ctx.strokeStyle = options.color;
    ctx.lineWidth = HULL_STROKE;
    ctx.stroke(slash);
  }
  ctx.restore();
}
