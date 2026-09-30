'use client';

/**
 * Карточка экспериментального эффекта: название, описание, список изменений.
 *
 * Эффект — это вторая половина инженерии: чертёж поднимает основные цифры, а
 * эффект добавляет к ним свой набор поправок. Поправки реальные, они уже
 * учтены в сводке сборки (`effectiveModule` в `calc.ts`), поэтому здесь важно
 * показать их ровно в том виде, в каком их понимает игрок:
 *
 *  * проценты — со знаком и с цветом «лучше/хуже»;
 *  * сопротивления — с пометкой «от остатка», потому что +8 % к 50 % дают 54 %;
 *  * распределение урона — списком долей по типам;
 *  * эффекты без чисел (сбить захват, перезапустить двигатели) — отдельной
 *    строкой, чтобы не выглядело, будто эффект «ничего не делает».
 */

import { specialFeatures } from '@/lib/outfitting/specials';
import type { OutfittingData, SpecialEffect } from '@/lib/outfitting/types';
import { LABEL, MONO, num } from './styles';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Локализованное название эффекта (английское из данных — как запасное). */
export function specialName(t: Translate, effect: SpecialEffect | null | undefined): string {
  if (!effect) return '';
  const key = `outfitting.special.name.${effect.kind}`;
  const translated = t(key);
  return translated === key ? effect.name : translated;
}

/** Локализованное описание эффекта. */
export function specialDescription(t: Translate, effect: SpecialEffect | null | undefined): string {
  if (!effect) return '';
  const key = `outfitting.special.desc.${effect.kind}`;
  const translated = t(key);
  return translated === key ? '' : translated;
}

/** Знак у процента ставим сами: у отрицательных нулей вид неопрятный. */
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
    <div style={{ margin: '0 0 8px' }}>
      {description && (
        <p style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.55, margin: '0 0 6px' }}>{description}</p>
      )}

      {effect.tag && (
        <p style={{ fontSize: 11, color: '#9fd8ef', lineHeight: 1.5, margin: '0 0 6px' }}>
          <span style={{ ...LABEL, color: 'var(--muted)', marginRight: 6 }}>{t('outfitting.special.tactical')}</span>
          {t(`outfitting.special.tag.${effect.tag}`)}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div style={{ ...LABEL, marginBottom: 3 }}>{t('outfitting.special.changes')}</div>
          <ul style={{ listStyle: 'none', margin: '0 0 6px', padding: 0, fontFamily: MONO, fontSize: 11, lineHeight: 1.7 }}>
            {rows.map((row) => (
              <li key={row.property} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ color: 'var(--muted)' }}>{t(`outfitting.mod.${row.property}`)}</span>
                <span style={{ color: row.better ? 'var(--green)' : 'var(--orange)', whiteSpace: 'nowrap' }}>
                  {row.kind === 'damagedist' && (row.distribution ?? [])
                    .map((part) => `${t(`outfitting.dmg.${part.type}`)} ${num(part.share * 100, 0, locale)}%`)
                    .join(' / ')}
                  {row.kind === 'percent' && `${signed(row.value * 100, 1, locale)} %`}
                  {row.kind === 'resistance' && `${signed(row.value * 100, 1, locale)} %`}
                  {row.kind === 'value' && signed(row.value, 1, locale)}
                </span>
              </li>
            ))}
          </ul>
          {rows.some((row) => row.kind === 'resistance') && (
            <p style={{ fontSize: 10, color: 'var(--muted)', margin: '0 0 6px' }}>
              {t('outfitting.mod.kinres')}, {t('outfitting.mod.thermres')}, {t('outfitting.mod.explres')} —{' '}
              {t('outfitting.special.resHint')}
            </p>
          )}
        </>
      )}

      {rows.length === 0 && (
        <p style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 6px' }}>
          {t('outfitting.special.noNumbers')}
        </p>
      )}

      {!compact && Object.keys(effect.components ?? {}).length > 0 && (
        <>
          <div style={{ ...LABEL, marginBottom: 3 }}>{t('outfitting.special.materials')}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 6 }}>
            {Object.entries(effect.components).map(([name, count]) => `${name} ×${count}`).join(' · ')}
          </div>
        </>
      )}

      {rows.length > 0 && (
        <p style={{ fontSize: 10, color: 'var(--muted)', margin: 0 }}>
          <i>{t('outfitting.special.applied')}</i>
        </p>
      )}
    </div>
  );
}
