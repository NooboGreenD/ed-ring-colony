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
import { useI18n } from '@/lib/i18n/I18nContext';
import { buildSlots, computeStats, effectiveModule } from '@/lib/outfitting/calc';
import { blueprintLabel, decodeBuild, defaultBuild, encodeBuild, moduleLabel, strippedBuild } from '@/lib/outfitting/build';
import { useOutfittingData } from '@/lib/outfitting/useOutfittingData';
import type { BuildSlot, ShipBuild, SlotModification } from '@/lib/outfitting/types';
import ModulePicker from './ModulePicker';
import StatsPanel from './StatsPanel';
import { LABEL, MONO, PANEL, button, formatters } from './styles';

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
  const { t, locale } = useI18n();
  const { num, credits, date } = formatters(locale);
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
    // Текст ошибки из загрузчика технический и русский — показываем свой.
    return <p style={{ color: 'var(--red)' }}>{t('outfitting.loadFailed')}</p>;
  }
  if (!data || !build || !ship || !stats) {
    return (
      <p style={{ color: 'var(--orange)', fontFamily: MONO, letterSpacing: 2, fontSize: 13 }}>
        {t('outfitting.loading')}
      </p>
    );
  }

  const activeSlot = picker ? slots.find((slot) => slot.key === picker) ?? null : null;
  const sections: { key: string; title: string; hint: string; items: BuildSlot[] }[] = [
    { key: 'core', title: t('outfitting.sec.core'), hint: t('outfitting.sec.core.hint'), items: slots.filter((slot) => slot.section === 'standard') },
    { key: 'hardpoints', title: t('outfitting.sec.hardpoints'), hint: t('outfitting.sec.hardpoints.hint'), items: slots.filter((slot) => slot.section === 'hardpoints' && slot.class > 0) },
    { key: 'utility', title: t('outfitting.sec.utility'), hint: t('outfitting.sec.utility.hint'), items: slots.filter((slot) => slot.section === 'hardpoints' && slot.class === 0) },
    { key: 'internal', title: t('outfitting.sec.internal'), hint: t('outfitting.sec.internal.hint'), items: slots.filter((slot) => slot.section === 'internal') },
  ];

  const saveBuild = () => {
    const name = window.prompt(
      t('outfitting.prompt.name'),
      build.name || t('outfitting.defaultName', { ship: ship.properties.name }),
    );
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
    setNotice(t('outfitting.notice.saved'));
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
      setNotice(t('outfitting.notice.link'));
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
              placeholder={t('outfitting.shipFilter')}
              style={{ fontSize: 12, fontFamily: MONO, width: 150, margin: 0 }}
            />
            <button type="button" style={button(false)} onClick={() => setBuild(defaultBuild(data, build.ship))}>{t('outfitting.btnStock')}</button>
            <button type="button" style={button(false)} onClick={() => setBuild(strippedBuild(data, build.ship))}>{t('outfitting.btnStripped')}</button>
            <button type="button" style={button(false)} onClick={copyLink}>{t('outfitting.btnLink')}</button>
            <button type="button" style={button(false)} onClick={saveBuild}>{t('outfitting.btnSave')}</button>
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 11, color: 'var(--muted)', fontFamily: MONO }}>
            <span>{t('outfitting.hullMass', { value: num(ship.properties.hullMass, 0) })}</span>
            <span>{t('outfitting.crew', { value: ship.properties.crew })}</span>
            <span>{t('outfitting.baseShield', { value: ship.properties.baseShieldStrength })}</span>
            <span>{t('outfitting.baseArmour', { value: ship.properties.baseArmour })}</span>
            <span>{t('outfitting.hardness', { value: ship.properties.hardness })}</span>
            <span>{t('outfitting.hullCost', { value: credits(ship.properties.hullCost) })}</span>
          </div>

          {/* Переборки — это тоже выбор, и он сильно меняет массу. */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
            {ship.bulkheads.map((bulkhead, index) => (
              <button
                key={bulkhead.id}
                type="button"
                style={button(build.bulkhead === index)}
                title={t('outfitting.bulkheadTitle', {
                  mass: bulkhead.mass,
                  boost: (1 + bulkhead.hullboost).toFixed(2),
                  cost: credits(bulkhead.cost),
                })}
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
          <div key={section.key}>
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
                        {module ? moduleLabel(data, module, locale) : t('outfitting.emptySlot')}
                      </span>
                      <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                        {effective && <span>{t('outfitting.unit.t', { value: num(Number(effective.mass ?? 0), 1) })}</span>}
                        {effective && Number(effective.power ?? 0) > 0 && (
                          <span>{t('outfitting.unit.mw', { value: num(Number(effective.power), 2) })}</span>
                        )}
                        {module && <span>{credits(Number(module.cost ?? 0))}</span>}
                        {modification?.blueprint && (
                          <span style={{ color: 'var(--green)' }}>
                            ⚙ {blueprintLabel(modification.blueprint, locale)} G{modification.grade ?? 1}
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
            <SectionTitle hint={t('outfitting.saved.hint')}>{t('outfitting.saved.title')}</SectionTitle>
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
          {t('outfitting.source.prefix')}{' '}
          <a href="https://github.com/EDCD/coriolis-data" target="_blank" rel="noopener noreferrer">EDCD/coriolis-data</a>
          {' '}{t('outfitting.source.middle', { date: date(data.generatedAt) })}{' '}
          <Link href="/engineers">{t('outfitting.source.engineers')}</Link>.
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
