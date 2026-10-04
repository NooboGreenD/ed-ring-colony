'use client';

/**
 * Всплывающая карточка модуля при наведении.
 *
 * Показывает всё, что про модуль знает справочник: массу, энергию, цену и
 * все числовые характеристики — уже с учётом инженерии, если она выставлена.
 * Значения берутся из `moduleSpecValues`, поэтому подсказка и переключатель
 * «что показывать» в списке слотов говорят об одном и том же наборе полей.
 *
 * Позиционирование фиксированное (`position: fixed`) и привязано к курсору,
 * чтобы карточка не обрезалась внутри прокручиваемых панелей.
 */

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { groupName, mountName } from '@/lib/outfitting/i18n';
import { moduleSpecValues, specName, type SpecSection } from '@/lib/outfitting/specs';
import { mercEntryFor } from '@/lib/outfitting/merccoin';
import { blueprintLabel } from '@/lib/outfitting/build';
import type { OutfittingData, OutfittingModule, SlotModification } from '@/lib/outfitting/types';
import { IconCoins, IconSparkles, IconWrench } from '@/components/Icons';
import { specialName } from './SpecialEffectCard';
import { MONO, formatters } from './styles';

const SECTION_ORDER: SpecSection[] = ['perf', 'mass', 'power', 'price'];

interface ModuleTooltipProps {
  data: OutfittingData;
  /** Модуль как он есть в справочнике — для названия и группы. */
  module: OutfittingModule;
  /** Модуль с применённой инженерией — из него берутся числа. */
  effective: OutfittingModule | null;
  modification: SlotModification | null;
  /** Координаты курсора в окне. */
  anchor: { x: number; y: number };
}

export default function ModuleTooltip({
  data,
  module,
  effective,
  modification,
  anchor,
}: ModuleTooltipProps) {
  const { t, locale } = useI18n();
  const { num } = formatters(locale);

  const source = (effective ?? module) as unknown as Record<string, unknown>;
  const values = moduleSpecValues(source, locale, num);
  const base = module as unknown as Record<string, unknown>;
  const merc = mercEntryFor(module.grp, module.id);

  const grouped = SECTION_ORDER
    .map((section) => ({ section, items: values.filter((value) => value.section === section) }))
    .filter((entry) => entry.items.length > 0);

  // Карточка всегда остаётся в окне: вправо/вниз, если места хватает.
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const width = 290;
  const left = anchor.x + width + 24 > viewportWidth ? Math.max(8, anchor.x - width - 16) : anchor.x + 16;
  const top = Math.min(Math.max(8, anchor.y - 40), Math.max(8, viewportHeight - 360));

  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left,
        top,
        width,
        maxHeight: 340,
        overflowY: 'auto',
        zIndex: 70,
        background: 'rgba(8,12,18,0.97)',
        border: '1px solid var(--orange)',
        borderRadius: 3,
        padding: '8px 10px',
        boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f8fafc', lineHeight: 1.3 }}>
        {module.name || groupName(locale, module.grp)}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: MONO, marginTop: 1 }}>
        {module.class}
        {module.rating}
        {module.mount ? ` · ${mountName(locale, module.mount)}` : ''}
        {' · '}
        {groupName(locale, module.grp)}
      </div>

      {(modification?.blueprint || modification?.special) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
          {modification.blueprint && (
            <span style={{ fontSize: 10.5, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 3 }}>
              <IconWrench size={10} color="var(--green)" />
              {blueprintLabel(modification.blueprint, locale)} G{modification.grade ?? 1}
            </span>
          )}
          {modification.special && (
            <span style={{ fontSize: 10.5, color: '#c9a0ff', display: 'flex', alignItems: 'center', gap: 3 }}>
              <IconSparkles size={10} color="#c9a0ff" />
              {specialName(t, data.specials[modification.special]) || modification.special}
            </span>
          )}
        </div>
      )}

      {merc && (
        <div
          style={{
            marginTop: 5,
            fontSize: 10.5,
            color: '#fbbf24',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <IconCoins size={11} color="#fbbf24" />
          {merc.coins ? t('outfitting.merc.coins', { value: merc.coins }) : t('outfitting.merc.unknown')}
        </div>
      )}

      {grouped.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{t('outfitting.tip.noData')}</div>
      ) : (
        grouped.map((entry) => (
          <div key={entry.section} style={{ marginTop: 6 }}>
            <div
              style={{
                fontSize: 9.5,
                letterSpacing: 1.5,
                textTransform: 'uppercase',
                color: 'var(--orange)',
                fontFamily: MONO,
                marginBottom: 2,
              }}
            >
              {t(`outfitting.view.${entry.section}`)}
            </div>
            {entry.items.map((value) => {
              const original = base[value.key];
              const changed = typeof original === 'number' && Math.abs(original - value.raw) > 1e-9;
              const better = changed && (value.raw > (original as number)) === value.higherBetter;
              return (
                <div
                  key={value.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 11,
                    padding: '1px 0',
                  }}
                >
                  <span style={{ color: 'var(--muted)' }}>{specName(locale, value.key)}</span>
                  <span
                    style={{
                      fontFamily: MONO,
                      color: changed ? (better ? 'var(--green)' : '#f0b37e') : 'var(--text)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {value.display}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}

      <div style={{ marginTop: 6, fontSize: 9.5, color: 'var(--muted)', lineHeight: 1.4 }}>
        {t('outfitting.tip.hint')}
      </div>
    </div>
  );
}
