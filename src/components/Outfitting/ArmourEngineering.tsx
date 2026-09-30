'use client';

/**
 * Инженерия переборок (брони):
 *
 * Выбор чертежа, уровня (G1..G5 со 100% максимальным эффектом без лишних
 * полосок качества) и экспериментального эффекта с материалами.
 */

import React, { useMemo } from 'react';
import Link from 'next/link';
import { blueprintsForGroup } from '@/lib/outfitting/calc';
import { specialsForGroup } from '@/lib/outfitting/specials';
import { blueprintLabel } from '@/lib/outfitting/build';
import type { OutfittingData, SlotModification } from '@/lib/outfitting/types';
import SpecialEffectCard, { specialName } from './SpecialEffectCard';
import { IconSparkles, IconWrench } from '@/components/Icons';
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
  const activeBlueprint = current.blueprint
    ? blueprints.find((entry) => entry.id === current.blueprint)
    : null;
  const specials = useMemo(
    () =>
      specialsForGroup(data, 'bh')
        .map((id) => ({ id, name: specialName(t, data.specials[id]) }))
        .sort((left, right) => left.name.localeCompare(right.name, locale)),
    [data, locale, t],
  );

  if (!blueprints.length) return null;

  const update = (next: SlotModification) => {
    onModify(next.blueprint || next.special ? next : null);
  };

  const handleBlueprintChange = (value: string) => {
    if (!value) {
      update({ ...current, blueprint: undefined, grade: undefined });
    } else {
      const maxGrade = blueprints.find((item) => item.id === value)?.maxGrade ?? 5;
      update({
        ...current,
        blueprint: value,
        grade: Math.min(current.grade ?? maxGrade, maxGrade),
        quality: 1.0, // Всегда 100% финальный эффект
      });
    }
  };

  const handleGradeChange = (grade: number) => {
    update({
      ...current,
      grade,
      quality: 1.0, // Всегда 100% финальный эффект
    });
  };

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <IconWrench size={13} color="var(--orange)" />
        <span style={{ ...LABEL, color: 'var(--orange)', marginBottom: 0 }}>
          {t('outfitting.eng.title')} брони
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={current.blueprint ?? ''}
          onChange={(e) => handleBlueprintChange(e.target.value)}
          style={{ flex: '1 1 180px', minWidth: 160, fontSize: 12, fontFamily: MONO, margin: 0 }}
        >
          <option value="">{t('outfitting.eng.noBlueprint')}</option>
          {blueprints.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {blueprintLabel(entry.id, locale)} (G1-G{entry.maxGrade})
            </option>
          ))}
        </select>

        <select
          value={current.special ?? ''}
          onChange={(event) => update({ ...current, special: event.target.value || undefined })}
          style={{ flex: '1 1 180px', minWidth: 160, fontSize: 12, fontFamily: MONO, margin: 0 }}
        >
          <option value="">{t('outfitting.eng.specialNone')}</option>
          {specials.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </div>

      {activeBlueprint && (
        <div style={{ marginTop: 8 }}>
          {/* Кнопки грейда G1..G5 */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {Array.from({ length: activeBlueprint.maxGrade }, (_, index) => index + 1).map((grade) => (
              <button
                key={grade}
                type="button"
                style={{
                  ...button(current.grade === grade),
                  fontSize: 11,
                  fontFamily: MONO,
                  fontWeight: 700,
                  padding: '3px 8px',
                }}
                onClick={() => handleGradeChange(grade)}
              >
                G{grade}
              </button>
            ))}
          </div>

          {/* Финальный эффект грейда */}
          {(() => {
            const bpGrade = data.blueprints[activeBlueprint.id]?.grades?.[String(current.grade ?? 1)];
            if (!bpGrade) return null;
            const features = Object.entries(bpGrade.features);

            return (
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.45)',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  padding: '6px 8px',
                  marginBottom: 6,
                  maxWidth: 480,
                }}
              >
                <div style={{ ...LABEL, fontSize: 10, marginBottom: 3, color: 'var(--orange)' }}>
                  {t('outfitting.special.changes')} (G{current.grade ?? 1} Max)
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 10.5, fontFamily: MONO, lineHeight: 1.5 }}>
                  {features.map(([prop, range]) => {
                    const maxVal = range[1];
                    const isPositive = maxVal > 0;
                    const rule = data.modifications[prop];
                    const higherBetter = rule?.higherbetter ?? true;
                    const isGood = higherBetter ? isPositive : !isPositive;
                    const displayVal = (maxVal * 100).toFixed(1);

                    return (
                      <li key={prop} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ color: 'var(--muted)' }}>
                          {t(`outfitting.mod.${prop}`) || prop}
                        </span>
                        <span style={{ color: isGood ? 'var(--green)' : 'var(--orange)', fontWeight: 700 }}>
                          {isPositive ? '+' : ''}{displayVal}%
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })()}

          {/* Материалы на прогон */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ ...LABEL, fontSize: 10, marginBottom: 2 }}>
              {t('outfitting.eng.materials')}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {Object.entries(
                data.blueprints[activeBlueprint.id]?.grades?.[String(current.grade ?? 1)]?.components ?? {},
              ).map(([name, count]) => (
                <span
                  key={name}
                  style={{
                    fontSize: 9.5,
                    fontFamily: MONO,
                    color: '#cbd5e1',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 3,
                    padding: '2px 5px',
                  }}
                >
                  {name} <b style={{ color: 'var(--orange)' }}>×{count}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {current.special && (
        <div style={{ maxWidth: 520, marginTop: 6 }}>
          <SpecialEffectCard data={data} effect={data.specials[current.special]} t={t} locale={locale} />
        </div>
      )}
    </div>
  );
}
