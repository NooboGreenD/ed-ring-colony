'use client';

/**
 * Значок состояния PowerPlay для панели, легенды и карточки — те же формы,
 * что рисует шейдер 3D-слоя (`PowerplayPoints.tsx`): звезда — оплот, кольцо с
 * ядром — укреплённая система, точка — эксплуатируемая.
 */

import type { CSSProperties } from 'react';
import { POWERPLAY_STATE_LABEL, type PowerplayState } from '@/lib/powerplay';

export interface PowerplayGlyphProps {
  state: PowerplayState;
  color: string;
  size?: number;
  title?: string;
  style?: CSSProperties;
}

export function PowerplayGlyph({ state, color, size = 12, title, style }: PowerplayGlyphProps) {
  const label = title ?? POWERPLAY_STATE_LABEL[state];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      data-powerplay-glyph={state}
      style={{ flex: '0 0 auto', display: 'inline-block', verticalAlign: 'middle', ...style }}
    >
      <title>{label}</title>
      {state === 'Stronghold' && (
        <path d="M12 1.5 C13 9 15 11 22.5 12 C15 13 13 15 12 22.5 C11 15 9 13 1.5 12 C9 11 11 9 12 1.5 Z" fill={color} />
      )}
      {state === 'Fortified' && (
        <>
          <circle cx="12" cy="12" r="8.6" fill="none" stroke={color} strokeWidth="3.4" />
          <circle cx="12" cy="12" r="2.6" fill={color} />
        </>
      )}
      {state === 'Exploited' && <circle cx="12" cy="12" r="5.5" fill={color} />}
    </svg>
  );
}

/** Квадратик цвета державы для списков. */
export function PowerSwatch({ color, size = 10, style }: { color: string; size?: number; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 2,
        background: color,
        boxShadow: `0 0 6px ${color}66`,
        flex: '0 0 auto',
        ...style,
      }}
    />
  );
}
