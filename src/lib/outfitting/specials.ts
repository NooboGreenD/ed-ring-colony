/**
 * Экспериментальные эффекты для интерфейса верфи.
 *
 * Данные (`public/data/outfitting.json`) хранят поправки в «машинном» виде —
 * долях от базового значения в соглашении Coriolis. Показывать их как есть
 * нельзя: `rof: -0.029` на экране должно читаться как «+3 % скорострельности»,
 * сопротивления складываются по остатку, а `damagedist` — вообще не число.
 * Здесь это приводится к человеческому виду, но без единой строки текста:
 * подписи берёт интерфейс по ключам перевода.
 */

import { RESISTANCES, ruleFor } from './calc';
import type { OutfittingData, SpecialEffect } from './types';

/** Одна строка в списке «что меняет эффект». */
export interface SpecialFeature {
  /** Свойство модуля: ключ перевода `outfitting.mod.<property>`. */
  property: string;
  /** Как показывать значение. */
  kind: 'percent' | 'resistance' | 'value' | 'damagedist';
  /** Значение для показа: доля (percent/resistance) или абсолютное число. */
  value: number;
  /** Доли по типам урона — только для `kind: 'damagedist'`. */
  distribution?: { type: string; share: number }[];
  /** Изменение к лучшему (зелёное) или к худшему (красное). */
  better: boolean;
}

/** Порядок строк: сначала польза, потом цена — как в игре. */
const ORDER = [
  'damage', 'damagedist', 'rof', 'breachdmg', 'shotspeed', 'jitter', 'ammo', 'clip', 'reload',
  'hullboost', 'hullreinforcement', 'shieldboost', 'shieldreinforcement', 'optmul', 'regen', 'brokenregen',
  'kinres', 'thermres', 'explres', 'causres',
  'pgen', 'maxfuel', 'optmass', 'duration', 'spinup',
  'syscap', 'engcap', 'wepcap', 'sysrate', 'engrate', 'weprate',
  'integrity', 'mass', 'power', 'distdraw', 'eff', 'thermload',
];

/** Типы урона в порядке показа. */
const DAMAGE_TYPES = ['A', 'E', 'K', 'T'];

/**
 * Скорострельность хранится как поправка к интервалу между выстрелами:
 * интервал −2,9 % — это +3 % выстрелов в секунду. Показываем второе.
 */
function invertInterval(value: number): number {
  return 1 / (1 + value) - 1;
}

/** Строки «что меняет эффект» в порядке показа. */
export function specialFeatures(data: OutfittingData, effect: SpecialEffect | null | undefined): SpecialFeature[] {
  if (!effect) return [];
  const rows: SpecialFeature[] = [];
  for (const [property, raw] of Object.entries(effect.features ?? {})) {
    if (property === 'damagedist') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const distribution = Object.entries(raw)
        .filter(([, share]) => Number(share) > 0)
        .map(([type, share]) => ({ type, share: Number(share) }))
        .sort((left, right) => DAMAGE_TYPES.indexOf(left.type) - DAMAGE_TYPES.indexOf(right.type));
      if (distribution.length) rows.push({ property, kind: 'damagedist', value: 0, distribution, better: true });
      continue;
    }
    const value = Array.isArray(raw) ? raw[1] : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;

    if (RESISTANCES.has(property)) {
      rows.push({ property, kind: 'resistance', value, better: value > 0 });
      continue;
    }
    if (property === 'rof') {
      const shown = invertInterval(value);
      rows.push({ property, kind: 'percent', value: shown, better: shown > 0 });
      continue;
    }
    const rule = ruleFor(data, property);
    const kind = rule.type === 'numeric' ? 'value' : 'percent';
    rows.push({ property, kind, value, better: (value > 0) === rule.higherbetter });
  }
  return rows.sort((left, right) => {
    const leftAt = ORDER.indexOf(left.property);
    const rightAt = ORDER.indexOf(right.property);
    return (leftAt < 0 ? ORDER.length : leftAt) - (rightAt < 0 ? ORDER.length : rightAt);
  });
}

/** Эффекты, доступные группе модулей (id в порядке названий из данных). */
export function specialsForGroup(data: OutfittingData, group: string | undefined): string[] {
  if (!group) return [];
  const ids = data.moduleBlueprints[group]?.specials ?? [];
  return [...ids].filter((id) => data.specials[id]);
}
