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
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { blueprintsForGroup, effectiveModule, modulesForSlot, moduleRef } from '@/lib/outfitting/calc';
import { blueprintLabel, moduleLabel } from '@/lib/outfitting/build';
import type { BuildSlot, OutfittingData, OutfittingModule, OutfittingShip, SlotModification } from '@/lib/outfitting/types';
import { LABEL, MONO, button, credits, num } from './styles';

/** Ключевая цифра группы — по ней и выбирают модуль. */
function highlightOf(module: OutfittingModule): string {
  if (module.cargo) return `${module.cargo} т трюма`;
  if (module.fuel) return `${module.fuel} т топлива`;
  if (module.pgen) return `${num(Number(module.pgen), 2)} МВт`;
  if (module.optmass && module.grp === 'fsd') return `опт. масса ${num(Number(module.optmass), 0)} т · ${num(Number(module.maxfuel ?? 0), 2)} т/прыжок`;
  if (module.optmass && module.grp === 't') return `опт. масса ${num(Number(module.optmass), 0)} т`;
  if (module.optmass) return `опт. масса ${num(Number(module.optmass), 0)} т · ×${num(Number(module.optmul ?? 1), 2)}`;
  if (module.wepcap) return `WEP ${num(Number(module.wepcap), 1)} · ENG ${num(Number(module.engcap ?? 0), 1)}`;
  if (module.range && module.grp === 's') return `${num(Number(module.range), 0)} км обзора`;
  if (module.hullreinforcement) return `+${module.hullreinforcement} брони`;
  if (module.shieldaddition) return `+${module.shieldaddition} MJ щита`;
  if (module.shieldboost) return `+${num(Number(module.shieldboost) * 100, 0)}% щита`;
  if (module.shieldreinforcement) return `+${module.shieldreinforcement} MJ восстановления`;
  if (module.passengers) return `${module.passengers} мест`;
  if (module.rate) return `${num(Number(module.rate), 0)} кг/с`;
  if (module.damage) return `урон ${num(Number(module.damage), 1)}`;
  if (module.jumpboost) return `+${module.jumpboost} св. лет к прыжку`;
  if (module.bays) return `${module.bays} отсек(а)`;
  if (module.time) return `${num(Number(module.time) / 60, 0)} мин запаса`;
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
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');

  const available = useMemo(() => modulesForSlot(data, ship, slot), [data, ship, slot]);
  const groups = useMemo(() => {
    const set = new Map<string, number>();
    for (const module of available) set.set(module.grp, (set.get(module.grp) ?? 0) + 1);
    return [...set.keys()].sort((left, right) => (data.groups[left]?.name ?? left).localeCompare(data.groups[right]?.name ?? right));
  }, [available, data]);

  const list = useMemo(() => {
    const text = query.trim().toLowerCase();
    return available
      .filter((module) => (group === 'all' || module.grp === group))
      .filter((module) => !text || moduleLabel(data, module).toLowerCase().includes(text))
      .sort((left, right) => (right.class - left.class)
        || String(left.rating).localeCompare(String(right.rating))
        || (data.groups[left.grp]?.name ?? '').localeCompare(data.groups[right.grp]?.name ?? ''));
  }, [available, group, query, data]);

  const current = slot.module;
  const modification = slot.modification ?? {};
  const blueprints = current ? blueprintsForGroup(data, current.grp) : [];
  const activeBlueprint = modification.blueprint ? blueprints.find((entry) => entry.id === modification.blueprint) : null;
  const specials = current ? data.moduleBlueprints[current.grp]?.specials ?? [] : [];
  const preview = effectiveModule(data, current, slot.modification);

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
            {slot.section === 'standard' ? 'Основной слот' : slot.section === 'hardpoints' ? (slot.class === 0 ? 'Утилита' : 'Орудийный пилон') : 'Внутренний отсек'}
            {' · '}класс {slot.class}
            {slot.special ? ` · ${slot.special === 'Military' ? 'военный' : slot.special}` : ''}
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="поиск модуля"
            style={{ flex: '1 1 160px', minWidth: 140, fontSize: 12, fontFamily: MONO }}
          />
          <button type="button" style={button(false)} onClick={() => onPick(null)}>очистить слот</button>
          <button type="button" style={button(false)} onClick={onClose}>закрыть</button>
        </div>

        {groups.length > 1 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <button type="button" style={button(group === 'all')} onClick={() => setGroup('all')}>все</button>
            {groups.map((id) => (
              <button key={id} type="button" style={button(group === id)} onClick={() => setGroup(id)}>
                {data.groups[id]?.name ?? id}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 0, minHeight: 0, flex: 1, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px', minWidth: 280, overflowY: 'auto', maxHeight: '58vh' }}>
            {list.length === 0 && (
              <p style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>В этот слот ничего не подходит.</p>
            )}
            {list.map((module) => {
              const active = current?.id === module.id && current?.grp === module.grp;
              const highlight = highlightOf(module);
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
                    <span style={{ fontFamily: MONO, color: active ? 'var(--orange)' : 'var(--text)' }}>{moduleLabel(data, module)}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11, fontFamily: MONO }}>{credits(Number(module.cost ?? 0))}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                    <span>{num(Number(module.mass ?? 0), 1)} т</span>
                    <span>{num(Number(module.power ?? 0), 2)} МВт</span>
                    {highlight && <span style={{ color: '#9fd8ef' }}>{highlight}</span>}
                    {module.pp && <span style={{ color: '#c9a0ff' }}>Powerplay: {String(module.pp)}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ flex: '1 1 300px', minWidth: 260, borderLeft: '1px solid var(--line)', padding: 12, overflowY: 'auto', maxHeight: '58vh' }}>
            <div style={{ ...LABEL, marginBottom: 6 }}>инженерия</div>
            {!current && <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>Сначала выберите модуль в слот.</p>}
            {current && blueprints.length === 0 && (
              <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>Этот модуль инженерам не подчиняется.</p>
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
                  <option value="">без доработки</option>
                  {blueprints.map((entry) => (
                    <option key={entry.id} value={entry.id}>{blueprintLabel(entry.id)}</option>
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
                      качество прогона: {Math.round((modification.quality ?? 1) * 100)}%
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((modification.quality ?? 1) * 100)}
                      onChange={(event) => onModify({ ...modification, quality: Number(event.target.value) / 100 })}
                      style={{ width: '100%', margin: '0 0 8px' }}
                    />

                    <div style={{ ...LABEL, marginBottom: 3 }}>инженеры до этого уровня</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>
                      {(activeBlueprint.engineers[modification.grade ?? 1] ?? []).map((engineer, index, all) => (
                        <span key={engineer}>
                          <Link href={`/engineers?engineer=${encodeURIComponent(engineer)}`} style={{ color: 'var(--cyan)' }}>{engineer}</Link>
                          {index < all.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                      {!(activeBlueprint.engineers[modification.grade ?? 1] ?? []).length && (
                        <span style={{ color: 'var(--muted)' }}>нет данных</span>
                      )}
                    </div>

                    <div style={{ ...LABEL, marginBottom: 3 }}>материалы на прогон</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 8 }}>
                      {Object.entries(data.blueprints[activeBlueprint.id]?.grades?.[String(modification.grade ?? 1)]?.components ?? {})
                        .map(([name, count]) => `${name} ×${count}`).join(' · ') || 'нет данных'}
                    </div>
                  </>
                )}

                {specials.length > 0 && (
                  <>
                    <div style={{ ...LABEL, marginBottom: 3 }}>экспериментальный эффект</div>
                    <select
                      value={modification.special ?? ''}
                      onChange={(event) => onModify({ ...modification, special: event.target.value || undefined })}
                      style={{ width: '100%', fontSize: 12, fontFamily: MONO, margin: '0 0 6px' }}
                    >
                      <option value="">нет</option>
                      {specials.map((id) => (
                        <option key={id} value={id}>{data.specials[id]?.name ?? id}</option>
                      ))}
                    </select>
                    {modification.special && (
                      <p style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 8px' }}>
                        {data.specials[modification.special]?.description || 'Описание недоступно.'}
                        <br />
                        <i>В открытых данных у эффектов нет числовых модификаторов — в сводке они не учитываются.</i>
                      </p>
                    )}
                  </>
                )}

                {preview && current && (
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 4 }}>
                    <div style={{ ...LABEL, marginBottom: 3 }}>после доработки</div>
                    <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: MONO, lineHeight: 1.6 }}>
                      масса {num(Number(preview.mass ?? 0), 2)} т
                      {' · '}энергия {num(Number(preview.power ?? 0), 2)} МВт
                      {preview.optmass ? ` · опт. масса ${num(Number(preview.optmass), 0)} т` : ''}
                      {preview.integrity ? ` · прочность ${num(Number(preview.integrity), 0)}` : ''}
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
