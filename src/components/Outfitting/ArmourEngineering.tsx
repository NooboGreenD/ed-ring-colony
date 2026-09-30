'use client';

/**
 * Инженерия переборок (брони).
 *
 * Броня — единственный «модуль», который выбирается не в слоте, а кнопками у
 * корпуса, поэтому и её доработка живёт отдельно от `ModulePicker`. Набор тот
 * же: чертёж, уровень, качество прогона и экспериментальный эффект. Без этого
 * блока четыре эффекта брони (угловое, слоистое, отражающее и толстое
 * бронирование) были бы недоступны, хотя в игре они есть.
 *
 * Доработка хранится в сборке под ключом `BH` — так же, как слоты хранят свои
 * под `S0`, `H1`, `I4`.
 */

import { useMemo } from 'react';
import { blueprintsForGroup } from '@/lib/outfitting/calc';
import { specialsForGroup } from '@/lib/outfitting/specials';
import { blueprintLabel } from '@/lib/outfitting/build';
import type { OutfittingData, SlotModification } from '@/lib/outfitting/types';
import SpecialEffectCard, { specialName } from './SpecialEffectCard';
import { LABEL, MONO, button } from './styles';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export default function ArmourEngineering({
  data,
  modification,
  onModify,
  t,
  locale,
}: {
  data: OutfittingData;
  modification: SlotModification | null;
  onModify: (next: SlotModification | null) => void;
  t: Translate;
  locale: string;
}) {
  const current = modification ?? {};
  const blueprints = useMemo(() => blueprintsForGroup(data, 'bh'), [data]);
  const activeBlueprint = current.blueprint ? blueprints.find((entry) => entry.id === current.blueprint) : null;
  const specials = useMemo(
    () => specialsForGroup(data, 'bh')
      .map((id) => ({ id, name: specialName(t, data.specials[id]) }))
      .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [data, locale, t],
  );

  if (!blueprints.length) return null;

  const update = (next: SlotModification) => {
    onModify(next.blueprint || next.special ? next : null);
  };

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div style={{ ...LABEL, marginBottom: 5 }}>{t('outfitting.eng.title')}</div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={current.blueprint ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) update({ ...current, blueprint: undefined, grade: undefined });
            else {
              const maxGrade = blueprints.find((item) => item.id === value)?.maxGrade ?? 5;
              update({ ...current, blueprint: value, grade: Math.min(current.grade ?? 5, maxGrade), quality: current.quality ?? 1 });
            }
          }}
          style={{ flex: '1 1 180px', minWidth: 160, fontSize: 12, fontFamily: MONO, margin: 0 }}
        >
          <option value="">{t('outfitting.eng.noBlueprint')}</option>
          {blueprints.map((entry) => (
            <option key={entry.id} value={entry.id}>{blueprintLabel(entry.id, locale)}</option>
          ))}
        </select>

        <select
          value={current.special ?? ''}
          onChange={(event) => update({ ...current, special: event.target.value || undefined })}
          style={{ flex: '1 1 180px', minWidth: 160, fontSize: 12, fontFamily: MONO, margin: 0 }}
        >
          <option value="">{t('outfitting.eng.specialNone')}</option>
          {specials.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name}</option>
          ))}
        </select>
      </div>

      {activeBlueprint && (
        <>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '8px 0 6px' }}>
            {Array.from({ length: activeBlueprint.maxGrade }, (_, index) => index + 1).map((grade) => (
              <button
                key={grade}
                type="button"
                style={button(current.grade === grade)}
                onClick={() => update({ ...current, grade, quality: current.quality ?? 1 })}
              >
                G{grade}
              </button>
            ))}
          </div>
          <label style={{ ...LABEL, display: 'block', marginBottom: 2 }}>
            {t('outfitting.eng.quality', { value: Math.round((current.quality ?? 1) * 100) })}
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((current.quality ?? 1) * 100)}
            onChange={(event) => update({ ...current, quality: Number(event.target.value) / 100 })}
            style={{ width: '100%', maxWidth: 320, margin: '0 0 6px' }}
          />
        </>
      )}

      {current.special && (
        <div style={{ maxWidth: 520, marginTop: 6 }}>
          <SpecialEffectCard data={data} effect={data.specials[current.special]} t={t} locale={locale} />
        </div>
      )}
    </div>
  );
}
