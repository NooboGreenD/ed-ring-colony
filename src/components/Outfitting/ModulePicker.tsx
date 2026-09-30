'use client';

/**
 * Выбор модуля в слот и его инженерная доработка.
 *
 * Список — только то, что физически влезает в слот (класс и назначение),
 * с ключевой цифрой группы (ёмкость трюма, дальность FSD, мощность реактора):
 * без неё выбор превращается в перебор одинаковых строк.
 *
 * Инженерия: чертёж, уровень и «качество прогона». Числа берутся из того же
 * набора, что и у coriolis.io, поэтому сводка меняется ровно так, как в игре.
 * Экспериментальные эффекты показаны справочно — в открытых данных у них есть
 * материалы и описание, но нет числовых модификаторов, и выдумывать их тут
 * нельзя.
 *
 * Все подписи идут через словарь (`outfitting.*`), названия групп и чертежей —
 * через `src/lib/outfitting/i18n.ts`. Собственные имена модулей из Coriolis
 * («Advanced Docking Computer») остаются как есть: это имена из игры.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import { blueprintsForGroup, effectiveModule, modulesForSlot, moduleRef } from '@/lib/outfitting/calc';
import { blueprintLabel, moduleLabel } from '@/lib/outfitting/build';
import { groupName } from '@/lib/outfitting/i18n';
import type { BuildSlot, OutfittingData, OutfittingModule, OutfittingShip, SlotModification } from '@/lib/outfitting/types';
import { LABEL, MONO, button, formatters } from './styles';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Ключевая цифра группы — по ней и выбирают модуль. */
function highlightOf(module: OutfittingModule, t: Translate, num: (value: number, digits?: number) => string): string {
  if (module.cargo) return t('outfitting.hl.cargo', { value: String(module.cargo) });
  if (module.fuel) return t('outfitting.hl.fuel', { value: String(module.fuel) });
  if (module.pgen) return t('outfitting.hl.pgen', { value: num(Number(module.pgen), 2) });
  if (module.optmass && module.grp === 'fsd') {
    return t('outfitting.hl.fsd', { mass: num(Number(module.optmass), 0), fuel: num(Number(module.maxfuel ?? 0), 2) });
  }
  if (module.optmass && module.grp === 't') return t('outfitting.hl.optmass', { mass: num(Number(module.optmass), 0) });
  if (module.optmass) return t('outfitting.hl.optmassMul', { mass: num(Number(module.optmass), 0), mul: num(Number(module.optmul ?? 1), 2) });
  if (module.wepcap) return t('outfitting.hl.distributor', { wep: num(Number(module.wepcap), 1), eng: num(Number(module.engcap ?? 0), 1) });
  if (module.range && module.grp === 's') return t('outfitting.hl.sensors', { value: num(Number(module.range), 0) });
  if (module.hullreinforcement) return t('outfitting.hl.hullReinforcement', { value: String(module.hullreinforcement) });
  if (module.shieldaddition) return t('outfitting.hl.shieldAddition', { value: String(module.shieldaddition) });
  if (module.shieldboost) return t('outfitting.hl.shieldBoost', { value: num(Number(module.shieldboost) * 100, 0) });
  if (module.shieldreinforcement) return t('outfitting.hl.shieldReinforcement', { value: String(module.shieldreinforcement) });
  if (module.passengers) return t('outfitting.hl.passengers', { value: String(module.passengers) });
  if (module.rate) return t('outfitting.hl.rate', { value: num(Number(module.rate), 0) });
  if (module.damage) return t('outfitting.hl.damage', { value: num(Number(module.damage), 1) });
  if (module.jumpboost) return t('outfitting.hl.jumpBoost', { value: String(module.jumpboost) });
  if (module.bays) return t('outfitting.hl.bays', { value: String(module.bays) });
  if (module.time) return t('outfitting.hl.time', { value: num(Number(module.time) / 60, 0) });
  return '';
}

export default function ModulePicker({
  data,
  ship,
  slot,
  onPick,
  onModify,
  onClose,
}: {
  data: OutfittingData;
  ship: OutfittingShip;
  slot: BuildSlot;
  onPick: (ref: string | null) => void;
  onModify: (modification: SlotModification | null) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { num, credits } = formatters(locale);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');

  const label = (id: string) => groupName(locale, id, data.groups[id]?.name);

  const available = useMemo(() => modulesForSlot(data, ship, slot), [data, ship, slot]);
  const groups = useMemo(() => {
    const set = new Map<string, number>();
    for (const module of available) set.set(module.grp, (set.get(module.grp) ?? 0) + 1);
    return [...set.keys()].sort((left, right) => groupName(locale, left, data.groups[left]?.name)
      .localeCompare(groupName(locale, right, data.groups[right]?.name)));
  }, [available, data, locale]);

  const list = useMemo(() => {
    const text = query.trim().toLowerCase();
    return available
      .filter((module) => (group === 'all' || module.grp === group))
      .filter((module) => !text || moduleLabel(data, module, locale).toLowerCase().includes(text))
      .sort((left, right) => (right.class - left.class)
        || String(left.rating).localeCompare(String(right.rating))
        || groupName(locale, left.grp, data.groups[left.grp]?.name)
          .localeCompare(groupName(locale, right.grp, data.groups[right.grp]?.name)));
  }, [available, group, query, data, locale]);

  const current = slot.module;
  const modification = slot.modification ?? {};
  const blueprints = current ? blueprintsForGroup(data, current.grp) : [];
  const activeBlueprint = modification.blueprint ? blueprints.find((entry) => entry.id === modification.blueprint) : null;
  const specials = current ? data.moduleBlueprints[current.grp]?.specials ?? [] : [];
  const preview = effectiveModule(data, current, slot.modification);

  const slotKind = slot.section === 'standard'
    ? t('outfitting.picker.standard')
    : slot.section === 'hardpoints'
      ? (slot.class === 0 ? t('outfitting.picker.utility') : t('outfitting.picker.hardpoint'))
      : t('outfitting.picker.internal');

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(8,10,12,0.72)', zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 4,
          width: 'min(980px, 100%)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1 }}>
            {slotKind}
            {' · '}{t('outfitting.picker.class', { value: slot.class })}
            {slot.special ? ` · ${slot.special === 'Military' ? t('outfitting.picker.military') : slot.special}` : ''}
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('outfitting.picker.search')}
            style={{ flex: '1 1 160px', minWidth: 140, fontSize: 12, fontFamily: MONO }}
          />
          <button type="button" style={button(false)} onClick={() => onPick(null)}>{t('outfitting.picker.clear')}</button>
          <button type="button" style={button(false)} onClick={onClose}>{t('outfitting.picker.close')}</button>
        </div>

        {groups.length > 1 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <button type="button" style={button(group === 'all')} onClick={() => setGroup('all')}>{t('outfitting.picker.all')}</button>
            {groups.map((id) => (
              <button key={id} type="button" style={button(group === id)} onClick={() => setGroup(id)}>
                {label(id)}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 0, minHeight: 0, flex: 1, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px', minWidth: 280, overflowY: 'auto', maxHeight: '58vh' }}>
            {list.length === 0 && (
              <p style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>{t('outfitting.picker.empty')}</p>
            )}
            {list.map((module) => {
              const active = current?.id === module.id && current?.grp === module.grp;
              const highlight = highlightOf(module, t, num);
              return (
                <button
                  key={`${module.grp}:${module.id}`}
                  type="button"
                  onClick={() => onPick(moduleRef(module))}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', margin: 0,
                    background: active ? 'rgba(230,126,34,0.10)' : 'transparent',
                    border: 'none', borderBottom: '1px solid var(--line)', borderLeft: `2px solid ${active ? 'var(--orange)' : 'transparent'}`,
                    padding: '7px 12px', cursor: 'pointer', color: 'var(--text)', textTransform: 'none', letterSpacing: 0,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                    <span style={{ fontFamily: MONO, color: active ? 'var(--orange)' : 'var(--text)' }}>{moduleLabel(data, module, locale)}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11, fontFamily: MONO }}>{credits(Number(module.cost ?? 0))}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                    <span>{t('outfitting.unit.t', { value: num(Number(module.mass ?? 0), 1) })}</span>
                    <span>{t('outfitting.unit.mw', { value: num(Number(module.power ?? 0), 2) })}</span>
                    {highlight && <span style={{ color: '#9fd8ef' }}>{highlight}</span>}
                    {module.pp && <span style={{ color: '#c9a0ff' }}>Powerplay: {String(module.pp)}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ flex: '1 1 300px', minWidth: 260, borderLeft: '1px solid var(--line)', padding: 12, overflowY: 'auto', maxHeight: '58vh' }}>
            <div style={{ ...LABEL, marginBottom: 6 }}>{t('outfitting.eng.title')}</div>
            {!current && <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('outfitting.eng.pickFirst')}</p>}
            {current && blueprints.length === 0 && (
              <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('outfitting.eng.none')}</p>
            )}

            {current && blueprints.length > 0 && (
              <>
                <select
                  value={modification.blueprint ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) onModify(null);
                    else onModify({ ...modification, blueprint: value, grade: Math.min(modification.grade ?? 5, blueprints.find((item) => item.id === value)?.maxGrade ?? 5), quality: modification.quality ?? 1 });
                  }}
                  style={{ width: '100%', fontSize: 12, fontFamily: MONO, margin: '0 0 8px' }}
                >
                  <option value="">{t('outfitting.eng.noBlueprint')}</option>
                  {blueprints.map((entry) => (
                    <option key={entry.id} value={entry.id}>{blueprintLabel(entry.id, locale)}</option>
                  ))}
                </select>

                {activeBlueprint && (
                  <>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                      {Array.from({ length: activeBlueprint.maxGrade }, (_, index) => index + 1).map((grade) => (
                        <button
                          key={grade}
                          type="button"
                          style={button(modification.grade === grade)}
                          onClick={() => onModify({ ...modification, grade, quality: modification.quality ?? 1 })}
                        >
                          G{grade}
                        </button>
                      ))}
                    </div>

                    <label style={{ ...LABEL, display: 'block', marginBottom: 2 }}>
                      {t('outfitting.eng.quality', { value: Math.round((modification.quality ?? 1) * 100) })}
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((modification.quality ?? 1) * 100)}
                      onChange={(event) => onModify({ ...modification, quality: Number(event.target.value) / 100 })}
                      style={{ width: '100%', margin: '0 0 8px' }}
                    />

                    <div style={{ ...LABEL, marginBottom: 3 }}>{t('outfitting.eng.engineers')}</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>
                      {(activeBlueprint.engineers[modification.grade ?? 1] ?? []).map((engineer, index, all) => (
                        <span key={engineer}>
                          <Link href={`/engineers?engineer=${encodeURIComponent(engineer)}`} style={{ color: 'var(--cyan)' }}>{engineer}</Link>
                          {index < all.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                      {!(activeBlueprint.engineers[modification.grade ?? 1] ?? []).length && (
                        <span style={{ color: 'var(--muted)' }}>{t('outfitting.eng.noData')}</span>
                      )}
                    </div>

                    <div style={{ ...LABEL, marginBottom: 3 }}>{t('outfitting.eng.materials')}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 8 }}>
                      {Object.entries(data.blueprints[activeBlueprint.id]?.grades?.[String(modification.grade ?? 1)]?.components ?? {})
                        .map(([name, count]) => `${name} ×${count}`).join(' · ') || t('outfitting.eng.noData')}
                    </div>
                  </>
                )}

                {specials.length > 0 && (
                  <>
                    <div style={{ ...LABEL, marginBottom: 3 }}>{t('outfitting.eng.special')}</div>
                    <select
                      value={modification.special ?? ''}
                      onChange={(event) => onModify({ ...modification, special: event.target.value || undefined })}
                      style={{ width: '100%', fontSize: 12, fontFamily: MONO, margin: '0 0 6px' }}
                    >
                      <option value="">{t('outfitting.eng.specialNone')}</option>
                      {specials.map((id) => (
                        <option key={id} value={id}>{data.specials[id]?.name ?? id}</option>
                      ))}
                    </select>
                    {modification.special && (
                      <p style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 8px' }}>
                        {data.specials[modification.special]?.description || t('outfitting.eng.specialNoDesc')}
                        <br />
                        <i>{t('outfitting.eng.specialNote')}</i>
                      </p>
                    )}
                  </>
                )}

                {preview && current && (
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 4 }}>
                    <div style={{ ...LABEL, marginBottom: 3 }}>{t('outfitting.eng.preview')}</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: MONO, lineHeight: 1.6 }}>
                      {t('outfitting.preview.mass', { value: num(Number(preview.mass ?? 0), 2) })}
                      {' · '}{t('outfitting.preview.power', { value: num(Number(preview.power ?? 0), 2) })}
                      {preview.optmass ? ` · ${t('outfitting.preview.optmass', { value: num(Number(preview.optmass), 0) })}` : ''}
                      {preview.integrity ? ` · ${t('outfitting.preview.integrity', { value: num(Number(preview.integrity), 0) })}` : ''}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
