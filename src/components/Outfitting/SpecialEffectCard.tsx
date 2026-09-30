'use client';

/**
 * Карточка экспериментального эффекта:
 *
 *  - Название и краткое тактическое действие;
 *  - Список конкретных изменений характеристик (бонусы и штрафы);
 *  - Компактно сгруппированный список требуемых материалов на прогон.
 */

import React from 'react';
import { specialFeatures } from '@/lib/outfitting/specials';
import type { OutfittingData, SpecialEffect } from '@/lib/outfitting/types';
import { LABEL, MONO, num } from './styles';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function specialName(t: Translate, effect: SpecialEffect | null | undefined): string {
  if (!effect) return '';
  const key = `outfitting.special.name.${effect.kind}`;
  const translated = t(key);
  return translated === key ? effect.name : translated;
}

export function specialDescription(t: Translate, effect: SpecialEffect | null | undefined): string {
  if (!effect) return '';
  const key = `outfitting.special.desc.${effect.kind}`;
  const translated = t(key);
  return translated === key ? '' : translated;
}

function signed(value: number, digits: number, locale: string): string {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${num(Math.abs(rounded), digits, locale)}`;
}

export default function SpecialEffectCard({
  data,
  effect,
  t,
  locale,
  compact = false,
}: {
  data: OutfittingData;
  effect: SpecialEffect | null | undefined;
  t: Translate;
  locale: string;
  compact?: boolean;
}) {
  if (!effect) return null;
  const rows = specialFeatures(data, effect);
  const description = specialDescription(t, effect);

  return (
    <div
      style={{
        background: 'rgba(15, 23, 42, 0.45)',
        border: '1px solid rgba(201, 160, 255, 0.3)',
        borderRadius: 4,
        padding: '8px 10px',
        margin: '6px 0',
      }}
    >
      {/* Описание / Тактический эффект */}
      {description && (
        <p style={{ fontSize: 11, color: '#e2e8f0', lineHeight: 1.45, margin: '0 0 6px' }}>
          {description}
        </p>
      )}

      {effect.tag && (
        <p style={{ fontSize: 10.5, color: '#9fd8ef', lineHeight: 1.4, margin: '0 0 6px' }}>
          <span style={{ ...LABEL, color: 'var(--muted)', marginRight: 5 }}>
            {t('outfitting.special.tactical')}:
          </span>
          {t(`outfitting.special.tag.${effect.tag}`)}
        </p>
      )}

      {/* Что именно изменится */}
      {rows.length > 0 && (
        <div style={{ margin: '4px 0 6px' }}>
          <div style={{ ...LABEL, fontSize: 10, marginBottom: 3, color: '#c9a0ff' }}>
            {t('outfitting.special.changes')}
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              fontFamily: MONO,
              fontSize: 11,
              lineHeight: 1.6,
            }}
          >
            {rows.map((row) => (
              <li key={row.property} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: 'var(--muted)' }}>{t(`outfitting.mod.${row.property}`)}</span>
                <span style={{ color: row.better ? 'var(--green)' : 'var(--orange)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {row.kind === 'damagedist' &&
                    (row.distribution ?? [])
                      .map((part) => `${t(`outfitting.dmg.${part.type}`)} ${num(part.share * 100, 0, locale)}%`)
                      .join(' / ')}
                  {row.kind === 'percent' && `${signed(row.value * 100, 1, locale)} %`}
                  {row.kind === 'resistance' && `${signed(row.value * 100, 1, locale)} %`}
                  {row.kind === 'value' && signed(row.value, 1, locale)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Маленький список требуемых ресурсов на прогон */}
      {!compact && Object.keys(effect.components ?? {}).length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 5, marginTop: 4 }}>
          <div style={{ ...LABEL, fontSize: 10, marginBottom: 3 }}>
            {t('outfitting.special.materials')}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {Object.entries(effect.components).map(([name, count]) => (
              <span
                key={name}
                style={{
                  fontSize: 10,
                  fontFamily: MONO,
                  color: '#cbd5e1',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(201, 160, 255, 0.25)',
                  borderRadius: 3,
                  padding: '2px 5px',
                }}
              >
                {name} <b style={{ color: '#c9a0ff' }}>×{count}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
