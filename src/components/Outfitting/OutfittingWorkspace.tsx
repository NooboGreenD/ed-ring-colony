'use client';

/**
 * Верфь: сборка корабля по образцу coriolis.io, но на наших данных и в стиле сайта.
 *
 * Слева — корпус и слоты (основные, орудия, утилиты, отсеки), справа — живая
 * сводка. Всё считается на клиенте: справочник (`/data/outfitting.json`)
 * скачивается один раз, дальше сборка меняется мгновенно и не ходит в сеть.
 *
 * Сборка живёт в адресной строке (`?b=…`): ссылку можно отправить в
 * эскадрилью, и человек откроет ровно тот же корабль. Локальные сохранения
 * лежат в `localStorage` — аккаунт для этого не нужен.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { buildSlots, computeStats, effectiveModule } from '@/lib/outfitting/calc';
import { blueprintLabel, decodeBuild, defaultBuild, encodeBuild, moduleLabel, strippedBuild } from '@/lib/outfitting/build';
import { useOutfittingData } from '@/lib/outfitting/useOutfittingData';
import type { BuildSlot, ShipBuild, SlotModification } from '@/lib/outfitting/types';
import ModulePicker from './ModulePicker';
import StatsPanel from './StatsPanel';
import { LABEL, MONO, PANEL, button, credits, num } from './styles';

const STORE_KEY = 'ed-ring-colony:outfitting:builds';

interface SavedBuild {
  id: string;
  name: string;
  ship: string;
  code: string;
  savedAt: string;
}

function readSaved(): SavedBuild[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Заголовок раздела слотов. */
function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '14px 0 6px' }}>
      <span style={{ ...LABEL, color: 'var(--orange)' }}>{children}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{hint}</span>}
    </div>
  );
}

export default function OutfittingWorkspace() {
  const { data, error } = useOutfittingData();
  const [build, setBuild] = useState<ShipBuild | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedBuild[]>([]);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => setSaved(readSaved()), []);

  // Первая загрузка: сборка из ссылки, иначе заводская Sidewinder.
  useEffect(() => {
    if (!data || build) return;
    const code = new URLSearchParams(window.location.search).get('b');
    const decoded = code ? decodeBuild(code) : null;
    if (decoded && data.ships[decoded.ship]) {
      setBuild(decoded);
      return;
    }
    const first = data.ships.sidewinder ? 'sidewinder' : Object.keys(data.ships)[0];
    setBuild(defaultBuild(data, first));
  }, [data, build]);

  // Ссылка всегда описывает то, что на экране.
  useEffect(() => {
    if (!build) return;
    const url = new URL(window.location.href);
    url.searchParams.set('b', encodeBuild(build));
    window.history.replaceState(null, '', url.toString());
  }, [build]);

  const ship = data && build ? data.ships[build.ship] : null;
  const slots = useMemo(() => (data && build ? buildSlots(data, build) : []), [data, build]);
  const stats = useMemo(() => (data && build ? computeStats(data, build) : null), [data, build]);

  const setSlotModule = useCallback((slot: BuildSlot, ref: string | null) => {
    setBuild((previous) => {
      if (!previous) return previous;
      const next: ShipBuild = {
        ...previous,
        standard: [...previous.standard],
        hardpoints: [...previous.hardpoints],
        internal: [...previous.internal],
        mods: { ...previous.mods },
      };
      next[slot.section][slot.index] = ref;
      // Сняли модуль — снимаем и его доработку: чертёж от другого модуля
      // применять нельзя.
      if (!ref) delete next.mods[slot.key];
      return next;
    });
  }, []);

  const setSlotMod = useCallback((slot: BuildSlot, modification: SlotModification | null) => {
    setBuild((previous) => {
      if (!previous) return previous;
      const mods = { ...previous.mods };
      if (!modification || (!modification.blueprint && !modification.special)) delete mods[slot.key];
      else mods[slot.key] = modification;
      return { ...previous, mods };
    });
  }, []);

  const shipList = useMemo(() => {
    if (!data) return [];
    const text = search.trim().toLowerCase();
    return Object.values(data.ships)
      .filter((entry) => !text || entry.properties.name.toLowerCase().includes(text) || entry.properties.manufacturer.toLowerCase().includes(text))
      .sort((left, right) => left.properties.name.localeCompare(right.properties.name));
  }, [data, search]);

  if (error) {
    return <p style={{ color: 'var(--red)' }}>{error}</p>;
  }
  if (!data || !build || !ship || !stats) {
    return (
      <p style={{ color: 'var(--orange)', fontFamily: MONO, letterSpacing: 2, fontSize: 13 }}>
        Загрузка справочника верфи…
      </p>
    );
  }

  const activeSlot = picker ? slots.find((slot) => slot.key === picker) ?? null : null;
  const sections: { title: string; hint: string; items: BuildSlot[] }[] = [
    { title: 'основные модули', hint: 'реактор, двигатели, FSD, жизнеобеспечение, распределитель, сенсоры, бак', items: slots.filter((slot) => slot.section === 'standard') },
    { title: 'орудия', hint: 'чем больше класс пилона, тем тяжелее орудие', items: slots.filter((slot) => slot.section === 'hardpoints' && slot.class > 0) },
    { title: 'утилиты', hint: 'усилители щита, теплоотводы, сканеры', items: slots.filter((slot) => slot.section === 'hardpoints' && slot.class === 0) },
    { title: 'внутренние отсеки', hint: 'трюм, щит, топливозаборник, усиления', items: slots.filter((slot) => slot.section === 'internal') },
  ];

  const saveBuild = () => {
    const name = window.prompt('Название сборки', build.name || `${ship.properties.name} — моя сборка`);
    if (!name) return;
    const entry: SavedBuild = {
      id: `${Date.now()}`,
      name,
      ship: ship.properties.name,
      code: encodeBuild({ ...build, name }),
      savedAt: new Date().toISOString(),
    };
    const next = [entry, ...readSaved()].slice(0, 40);
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    setSaved(next);
    setBuild({ ...build, name });
    setNotice('Сборка сохранена в этом браузере.');
  };

  const removeSaved = (id: string) => {
    const next = readSaved().filter((entry) => entry.id !== id);
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    setSaved(next);
  };

  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('b', encodeBuild(build));
    try {
      await navigator.clipboard.writeText(url.toString());
      setNotice('Ссылка на сборку скопирована.');
    } catch {
      setNotice(url.toString());
    }
  };

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 620px', minWidth: 300 }}>
        {/* ── Корпус ──────────────────────────────────────────────────── */}
        <div style={PANEL}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={build.ship}
              onChange={(event) => setBuild(defaultBuild(data, event.target.value))}
              style={{ fontSize: 13, fontFamily: MONO, minWidth: 220, margin: 0 }}
            >
              {shipList.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.properties.name} · {entry.properties.manufacturer}
                </option>
              ))}
            </select>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="фильтр кораблей"
              style={{ fontSize: 12, fontFamily: MONO, width: 150, margin: 0 }}
            />
            <button type="button" style={button(false)} onClick={() => setBuild(defaultBuild(data, build.ship))}>заводская</button>
            <button type="button" style={button(false)} onClick={() => setBuild(strippedBuild(data, build.ship))}>снять всё</button>
            <button type="button" style={button(false)} onClick={copyLink}>ссылка</button>
            <button type="button" style={button(false)} onClick={saveBuild}>сохранить</button>
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 11, color: 'var(--muted)', fontFamily: MONO }}>
            <span>масса корпуса {num(ship.properties.hullMass, 0)} т</span>
            <span>экипаж {ship.properties.crew}</span>
            <span>база щита {ship.properties.baseShieldStrength}</span>
            <span>база брони {ship.properties.baseArmour}</span>
            <span>жёсткость {ship.properties.hardness}</span>
            <span>корпус {credits(ship.properties.hullCost)}</span>
          </div>

          {/* Переборки — это тоже выбор, и он сильно меняет массу. */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
            {ship.bulkheads.map((bulkhead, index) => (
              <button
                key={bulkhead.id}
                type="button"
                style={button(build.bulkhead === index)}
                title={`масса ${bulkhead.mass} т · броня ×${(1 + bulkhead.hullboost).toFixed(2)} · ${credits(bulkhead.cost)}`}
                onClick={() => setBuild({ ...build, bulkhead: index })}
              >
                {bulkhead.name}
              </button>
            ))}
          </div>
          {notice && <p style={{ fontSize: 11, color: 'var(--green)', marginBottom: 0, marginTop: 8 }}>{notice}</p>}
        </div>

        {/* ── Слоты ───────────────────────────────────────────────────── */}
        {sections.filter((section) => section.items.length > 0).map((section) => (
          <div key={section.title}>
            <SectionTitle hint={section.hint}>{section.title}</SectionTitle>
            <div style={{ ...PANEL, padding: 0 }}>
              {section.items.map((slot) => {
                const module = slot.module;
                const effective = effectiveModule(data, module, slot.modification);
                const modification = slot.modification;
                return (
                  <button
                    key={slot.key}
                    type="button"
                    onClick={() => setPicker(slot.key)}
                    style={{
                      display: 'flex', width: '100%', alignItems: 'center', gap: 10, textAlign: 'left',
                      background: 'transparent', border: 'none', borderBottom: '1px solid var(--line)',
                      padding: '8px 10px', cursor: 'pointer', color: 'var(--text)', margin: 0,
                      textTransform: 'none', letterSpacing: 0,
                    }}
                  >
                    <span style={{
                      fontFamily: MONO, fontSize: 11, color: 'var(--orange)', minWidth: 34,
                      border: '1px solid var(--line)', borderRadius: 2, padding: '2px 5px', textAlign: 'center',
                    }}
                    >
                      {slot.class}
                      {slot.special === 'Military' ? 'M' : ''}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontFamily: MONO, color: module ? 'var(--text)' : 'var(--muted)' }}>
                        {module ? moduleLabel(data, module) : '— пусто —'}
                      </span>
                      <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                        {effective && <span>{num(Number(effective.mass ?? 0), 1)} т</span>}
                        {effective && Number(effective.power ?? 0) > 0 && <span>{num(Number(effective.power), 2)} МВт</span>}
                        {module && <span>{credits(Number(module.cost ?? 0))}</span>}
                        {modification?.blueprint && (
                          <span style={{ color: 'var(--green)' }}>
                            ⚙ {blueprintLabel(modification.blueprint)} G{modification.grade ?? 1}
                          </span>
                        )}
                        {modification?.special && (
                          <span style={{ color: '#c9a0ff' }}>✦ {data.specials[modification.special]?.name ?? modification.special}</span>
                        )}
                      </span>
                    </span>
                    <span style={{ color: 'var(--muted)', fontSize: 14 }}>›</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* ── Локальные сохранения ────────────────────────────────────── */}
        {saved.length > 0 && (
          <>
            <SectionTitle hint="хранятся в этом браузере">мои сборки</SectionTitle>
            <div style={{ ...PANEL, padding: 0 }}>
              {saved.map((entry) => (
                <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    onClick={() => {
                      const decoded = decodeBuild(entry.code);
                      if (decoded) setBuild(decoded);
                    }}
                    style={{ ...button(false), flex: 1, textAlign: 'left', border: 'none' }}
                  >
                    {entry.name}
                  </button>
                  <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: MONO }}>{entry.ship}</span>
                  <button type="button" style={button(false, 'var(--red)')} onClick={() => removeSaved(entry.id)}>×</button>
                </div>
              ))}
            </div>
          </>
        )}

        <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
          Цифры модулей и кораблей — из открытого набора{' '}
          <a href="https://github.com/EDCD/coriolis-data" target="_blank" rel="noopener noreferrer">EDCD/coriolis-data</a>
          {' '}(на нём же работает coriolis.io); справочник собран {new Date(data.generatedAt).toLocaleDateString('ru-RU')}.
          Инженерные чертежи и их уровни — оттуда же, инженеры и условия доступа — на странице{' '}
          <Link href="/engineers">инженеров</Link>.
        </p>
      </div>

      <div style={{ flex: '0 1 320px', minWidth: 260 }}>
        <StatsPanel stats={stats} shipName={build.name || ship.properties.name} />
      </div>

      {activeSlot && (
        <ModulePicker
          data={data}
          ship={ship}
          slot={activeSlot}
          onPick={(ref) => setSlotModule(activeSlot, ref)}
          onModify={(modification) => setSlotMod(activeSlot, modification)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
