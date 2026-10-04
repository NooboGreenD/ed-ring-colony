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
 *
 * Прокрутки внутри карточки нет сознательно: курсор на подсказку не наводится
 * (`pointer-events: none`), прокрутить её нечем, поэтому текст должен
 * помещаться целиком. Если параметров столько, что в окно по высоте они не
 * лезут, карточка раскладывается в несколько колонок, а не обрезается.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
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

/** Ширина одной колонки параметров. */
const COLUMN_WIDTH = 290;
const COLUMN_GAP = 14;
/** Отступ от края окна. */
const EDGE = 8;

interface Placement {
  left: number;
  top: number;
}

/**
 * Куда поставить карточку: вправо-вниз от курсора, а если не влезает —
 * влево и/или выше, но всегда целиком в окне.
 */
function place(
  anchor: { x: number; y: number },
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): Placement {
  const left = anchor.x + width + 24 > viewportWidth
    ? Math.max(EDGE, anchor.x - width - 16)
    : anchor.x + 16;
  const top = Math.max(EDGE, Math.min(anchor.y - 40, viewportHeight - height - EDGE));
  return { left, top };
}

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

  // Сколько колонок нужно, чтобы карточка влезла в окно по высоте.
  // Оценка с запасом: лучше разложить в две колонки чуть раньше, чем
  // обнаружить нехватку места уже после отрисовки.
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const estimatedHeight = 90 + grouped.length * 18 + values.length * 16 + 30;
  const available = Math.max(200, viewportHeight - 2 * EDGE);
  const columns = Math.min(3, Math.max(1, Math.ceil(estimatedHeight / available)));
  const width = COLUMN_WIDTH * columns + COLUMN_GAP * (columns - 1);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement>(() =>
    place(anchor, width, estimatedHeight, viewportWidth, viewportHeight));

  // Оценка нужна только для первого кадра: дальше считаем по факту.
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || typeof window === 'undefined') return;
    const next = place(anchor, node.offsetWidth, node.offsetHeight, window.innerWidth, window.innerHeight);
    setPlacement((previous) => (previous.left === next.left && previous.top === next.top ? previous : next));
  }, [anchor.x, anchor.y, anchor, width, module.id, module.grp, values.length]);

  return (
    <div
      ref={cardRef}
      role="tooltip"
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width,
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
        <div style={{ columnCount: columns, columnGap: COLUMN_GAP }}>
          {grouped.map((entry) => (
          <div key={entry.section} style={{ marginTop: 6, breakInside: 'avoid' }}>
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
          ))}
        </div>
      )}

      <div style={{ marginTop: 6, fontSize: 9.5, color: 'var(--muted)', lineHeight: 1.4 }}>
        {t('outfitting.tip.hint')}
      </div>
    </div>
  );
}
