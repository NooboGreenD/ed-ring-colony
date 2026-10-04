'use client';

/**
 * Верфь: сборка корабля (EDSY / Coriolis style) с расширенным функционалом:
 *
 *  - Интерактивный кликабельный распределитель питания («Пипки» SYS/ENG/WEP)
 *    вместе с блоком «Управление кораблём»: форсаж, выпуск орудий, загрузка;
 *  - Быстрое снятие модуля правой кнопкой мыши (ПКМ);
 *  - Drag & Drop перетаскивание модулей между подходящими ячейками слотов
 *    и копирование модуля в совместимый слот (кнопка или Alt + перетаскивание);
 *  - Переключатель того, что показывать в строке слота: масса, энергия,
 *    характеристики или цена;
 *  - Подсказка с полным набором параметров модуля при наведении;
 *  - Обмен сборками с coriolis.io, EDSY и игрой (SLEF);
 *  - 3-панельное окно выбора и детальной инженерии модулей с живым сравнением дельты.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import { authFetch } from '@/lib/supabaseClient';
import {
  DEFAULT_PIPS,
  buildSlots,
  computeStats,
  effectiveModule,
} from '@/lib/outfitting/calc';
import {
  blueprintLabel,
  decodeBuild,
  defaultBuild,
  encodeBuild,
  moduleLabel,
  strippedBuild,
} from '@/lib/outfitting/build';
import { useOutfittingData } from '@/lib/outfitting/useOutfittingData';
import { mercEntryFor } from '@/lib/outfitting/merccoin';
import { moduleSpecValues, specName, type SpecSection } from '@/lib/outfitting/specs';
import type {
  BuildSlot,
  OutfittingData,
  OutfittingModule,
  PipState,
  ShipBuild,
  SlotModification,
} from '@/lib/outfitting/types';
import ArmourEngineering from './ArmourEngineering';
import ExchangePanel from './ExchangePanel';
import MercCoinPanel from './MercCoinPanel';
import ModulePicker from './ModulePicker';
import ModuleTooltip from './ModuleTooltip';
import { defaultShipControl, type ShipControlState } from './ShipControl';
import { specialName } from './SpecialEffectCard';
import StatsPanel from './StatsPanel';
import {
  IconCheck,
  IconChevronRight,
  IconCoins,
  IconCopy,
  IconCpu,
  IconCrosshair,
  IconExternalLink,
  IconGrip,
  IconLayers,
  IconLink,
  IconPackage,
  IconPlus,
  IconRefreshCw,
  IconSave,
  IconSearch,
  IconShield,
  IconShieldHalf,
  IconSliders,
  IconSparkles,
  IconTrash,
  IconWrench,
  IconX,
  IconZap,
} from '@/components/Icons';
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

function ratingColor(rating?: string): string {
  switch (rating) {
    case 'A': return '#38bdf8';
    case 'B': return '#fbbf24';
    case 'C': return '#34d399';
    case 'D': return '#f97316';
    case 'E': return '#94a3b8';
    default: return '#cbd5e1';
  }
}

/** Проверка совместимости модуля со слотом */
function isSlotCompatibleWithModule(
  data: OutfittingData,
  targetSlot: BuildSlot,
  candidate: OutfittingModule,
): boolean {
  if (candidate.class > targetSlot.class) return false;

  if (targetSlot.section === 'standard') {
    return targetSlot.group === candidate.grp;
  }

  if (targetSlot.section === 'hardpoints') {
    const isUtility = targetSlot.class === 0;
    const cat = data.groups[candidate.grp]?.category;
    return isUtility ? cat === 'utility' : cat === 'hardpoint';
  }

  if (targetSlot.section === 'internal') {
    if (targetSlot.eligible) {
      if (!targetSlot.eligible[candidate.grp]) return false;
    } else {
      const cat = data.groups[candidate.grp]?.category;
      if (cat !== 'internal' && candidate.grp !== 'ft') return false;
      if (candidate.grp === 'pas') return false;
    }
    return true;
  }

  return false;
}

/** Проверка возможности поменять местами модули в двух слотах */
function canSwapSlots(
  data: OutfittingData,
  sourceSlot: BuildSlot,
  targetSlot: BuildSlot,
): boolean {
  if (sourceSlot.key === targetSlot.key) return false;
  if (!sourceSlot.module) return false;

  if (!isSlotCompatibleWithModule(data, targetSlot, sourceSlot.module)) return false;

  if (targetSlot.module && !isSlotCompatibleWithModule(data, sourceSlot, targetSlot.module)) {
    return false;
  }

  return true;
}

/**
 * Что показывать в строке слота: одно название или ещё и раздел параметров —
 * масса, энергия, характеристики или цена.
 */
type ViewMode = SpecSection | 'name';
const VIEW_MODES: ViewMode[] = ['name', 'mass', 'power', 'perf', 'price'];

/**
 * Строка параметров под названием модуля.
 *
 * Полей у модуля бывает три десятка, поэтому переключатель «показывать»
 * выбирает раздел — но внутри раздела показываем всё, ничего не пряча:
 * строка переносится по словам, а полный набор по всем разделам сразу
 * виден в подсказке при наведении. Режим `name` не показывает ничего:
 * список сборки в одну строку на слот, цифры — в подсказке.
 */
function SlotMetrics({
  module,
  view,
  locale,
  num,
}: {
  module: OutfittingModule;
  view: ViewMode;
  locale: string;
  num: (value: number, digits?: number) => string;
}) {
  if (view === 'name') return null;
  const values = moduleSpecValues(module as unknown as Record<string, unknown>, locale, num, [view]);
  if (values.length === 0) return null;
  return (
    <>
      {values.map((value) => (
        <span key={value.key}>
          <span style={{ opacity: 0.7 }}>{specName(locale, value.key)}</span> {value.display}
        </span>
      ))}
    </>
  );
}

/** Заголовок раздела слотов с HUD-иконкой */
function SectionTitle({
  icon,
  children,
  hint,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '14px 0 6px' }}>
      {icon && <span style={{ color: 'var(--orange)' }}>{icon}</span>}
      <span style={{ ...LABEL, color: 'var(--orange)', marginBottom: 0 }}>{children}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--muted)', marginLeft: 4 }}>{hint}</span>}
    </div>
  );
}

export default function OutfittingWorkspace() {
  const { t, locale } = useI18n();
  const { num, credits, date } = formatters(locale);
  const { data, error } = useOutfittingData();

  const [build, setBuild] = useState<ShipBuild | null>(null);
  const [pips, setPips] = useState<PipState>(DEFAULT_PIPS);
  const [picker, setPicker] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedBuild[]>([]);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');

  // Состояние Drag & Drop
  const [dragSourceKey, setDragSourceKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // Что показывать в строке слота и что сейчас под курсором
  const [view, setView] = useState<ViewMode>('mass');
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);

  // Копирование модуля в другую ячейку и обмен сборками
  const [copySourceKey, setCopySourceKey] = useState<string | null>(null);
  const [exchangeOpen, setExchangeOpen] = useState(false);

  // Состояние полёта: форсаж, выпущенные орудия, груз и остаток топлива
  const [control, setControl] = useState<ShipControlState>({
    boost: false,
    deployed: false,
    cargo: 0,
    fuel: Number.POSITIVE_INFINITY,
  });

  useEffect(() => setSaved(readSaved()), []);

  // Первая загрузка: сборка из ссылки, иначе заводская Sidewinder
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

  // Ссылка всегда описывает то, что на экране
  useEffect(() => {
    if (!build) return;
    const url = new URL(window.location.href);
    url.searchParams.set('b', encodeBuild(build));
    window.history.replaceState(null, '', url.toString());
  }, [build]);

  const ship = data && build ? data.ships[build.ship] : null;
  const slots = useMemo(() => (data && build ? buildSlots(data, build) : []), [data, build]);
  const stats = useMemo(() => (data && build ? computeStats(data, build) : null), [data, build]);

  // Новый корпус — новая загрузка: бак полный, трюм пустой.
  useEffect(() => {
    setControl((previous) => ({ ...previous, cargo: 0, fuel: Number.POSITIVE_INFINITY }));
  }, [build?.ship]);

  // Esc отменяет начатое копирование модуля.
  useEffect(() => {
    if (!copySourceKey) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCopySourceKey(null);
        setNotice(t('outfitting.copy.cancel'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [copySourceKey, t]);

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

  // Перемещение / обмен модулей через Drag & Drop
  const handleSwapSlots = useCallback(
    (sourceKey: string, targetKey: string) => {
      if (!data) return;
      const sourceSlot = slots.find((s) => s.key === sourceKey);
      const targetSlot = slots.find((s) => s.key === targetKey);
      if (!sourceSlot || !targetSlot || !sourceSlot.module) return;
      if (!canSwapSlots(data, sourceSlot, targetSlot)) return;

      setBuild((prev) => {
        if (!prev) return prev;
        const next: ShipBuild = {
          ...prev,
          standard: [...prev.standard],
          hardpoints: [...prev.hardpoints],
          internal: [...prev.internal],
          mods: { ...prev.mods },
        };

        const srcRef = prev[sourceSlot.section][sourceSlot.index];
        const tgtRef = prev[targetSlot.section][targetSlot.index];
        const srcMod = prev.mods[sourceSlot.key];
        const tgtMod = prev.mods[targetSlot.key];

        next[sourceSlot.section][sourceSlot.index] = tgtRef;
        next[targetSlot.section][targetSlot.index] = srcRef;

        if (tgtMod) next.mods[sourceSlot.key] = tgtMod;
        else delete next.mods[sourceSlot.key];

        if (srcMod) next.mods[targetSlot.key] = srcMod;
        else delete next.mods[targetSlot.key];

        return next;
      });

      setNotice(t('outfitting.drag.swapped'));
    },
    [data, slots, t],
  );

  // Копирование модуля в другую совместимую ячейку
  const handleCopySlot = useCallback(
    (sourceKey: string, targetKey: string) => {
      if (!data) return;
      const sourceSlot = slots.find((slot) => slot.key === sourceKey);
      const targetSlot = slots.find((slot) => slot.key === targetKey);
      if (!sourceSlot?.module || !targetSlot || sourceKey === targetKey) return;
      if (!isSlotCompatibleWithModule(data, targetSlot, sourceSlot.module)) return;

      setBuild((previous) => {
        if (!previous) return previous;
        const next: ShipBuild = {
          ...previous,
          standard: [...previous.standard],
          hardpoints: [...previous.hardpoints],
          internal: [...previous.internal],
          mods: { ...previous.mods },
        };
        next[targetSlot.section][targetSlot.index] = previous[sourceSlot.section][sourceSlot.index];
        const sourceMod = previous.mods[sourceSlot.key];
        if (sourceMod) next.mods[targetSlot.key] = { ...sourceMod };
        else delete next.mods[targetSlot.key];
        return next;
      });

      setCopySourceKey(null);
      setNotice(t('outfitting.copy.done'));
    },
    [data, slots, t],
  );

  // Правый клик по слоту: быстрое удаление модуля
  const handleSlotContextMenu = useCallback(
    (e: React.MouseEvent, slot: BuildSlot) => {
      e.preventDefault();
      if (slot.module) {
        setSlotModule(slot, null);
        setNotice(t('outfitting.rightClick.remove'));
      }
    },
    [setSlotModule, t],
  );

  const shipList = useMemo(() => {
    if (!data) return [];
    const text = search.trim().toLowerCase();
    return Object.values(data.ships)
      .filter(
        (entry) =>
          !text ||
          entry.properties.name.toLowerCase().includes(text) ||
          entry.properties.manufacturer.toLowerCase().includes(text),
      )
      .sort((left, right) => left.properties.name.localeCompare(right.properties.name));
  }, [data, search]);

  if (error) {
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
  const hoverSlot = hover ? slots.find((slot) => slot.key === hover.key) ?? null : null;
  const sections: {
    key: string;
    icon: React.ReactNode;
    title: string;
    hint: string;
    items: BuildSlot[];
  }[] = [
    {
      key: 'core',
      icon: <IconCpu size={14} />,
      title: t('outfitting.sec.core'),
      hint: t('outfitting.sec.core.hint'),
      items: slots.filter((slot) => slot.section === 'standard'),
    },
    {
      key: 'hardpoints',
      icon: <IconCrosshair size={14} />,
      title: t('outfitting.sec.hardpoints'),
      hint: t('outfitting.sec.hardpoints.hint'),
      items: slots.filter((slot) => slot.section === 'hardpoints' && slot.class > 0),
    },
    {
      key: 'utility',
      icon: <IconShieldHalf size={14} />,
      title: t('outfitting.sec.utility'),
      hint: t('outfitting.sec.utility.hint'),
      items: slots.filter((slot) => slot.section === 'hardpoints' && slot.class === 0),
    },
    {
      key: 'internal',
      icon: <IconLayers size={14} />,
      title: t('outfitting.sec.internal'),
      hint: t('outfitting.sec.internal.hint'),
      items: slots.filter((slot) => slot.section === 'internal'),
    },
  ];

  const saveBuild = async () => {
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
    const response = await authFetch('/api/outfitting/builds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ship: entry.ship, code: entry.code }),
    });
    if (!response.ok && response.status !== 401) setNotice('Не удалось сохранить сборку в профиль.');
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
      <div style={{ flex: '1 1 620px', minWidth: 320 }}>
        {/* ── Корпус и управление сборкой ─────────────────────────────────── */}
        <div style={PANEL}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={build.ship}
              onChange={(event) => setBuild(defaultBuild(data, event.target.value))}
              style={{ fontSize: 13, fontFamily: MONO, minWidth: 220, margin: 0, fontWeight: 700 }}
            >
              {shipList.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.properties.name} · {entry.properties.manufacturer}
                </option>
              ))}
            </select>

            <div style={{ position: 'relative' }}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('outfitting.shipFilter')}
                style={{ fontSize: 12, fontFamily: MONO, width: 140, margin: 0, paddingRight: 22 }}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  style={{
                    position: 'absolute',
                    right: 4,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <IconX size={12} />
                </button>
              )}
            </div>

            <button
              type="button"
              style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => setBuild(defaultBuild(data, build.ship))}
            >
              <IconRefreshCw size={12} />
              {t('outfitting.btnStock')}
            </button>

            <button
              type="button"
              style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => setBuild(strippedBuild(data, build.ship))}
            >
              <IconTrash size={12} />
              {t('outfitting.btnStripped')}
            </button>

            <button
              type="button"
              style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={copyLink}
            >
              <IconLink size={12} />
              {t('outfitting.btnLink')}
            </button>

            <button
              type="button"
              style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={saveBuild}
            >
              <IconSave size={12} />
              {t('outfitting.btnSave')}
            </button>

            <button
              type="button"
              style={{ ...button(exchangeOpen), display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => setExchangeOpen(true)}
            >
              <IconExternalLink size={12} />
              {t('outfitting.exchange.btn')}
            </button>
          </div>

          {/* Параметры корпуса */}
          <div
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 10,
              fontSize: 11,
              color: 'var(--muted)',
              fontFamily: MONO,
              borderTop: '1px solid var(--line)',
              paddingTop: 8,
            }}
          >
            <span>{t('outfitting.hullMass', { value: num(ship.properties.hullMass, 0) })}</span>
            <span>{t('outfitting.crew', { value: ship.properties.crew })}</span>
            <span>{t('outfitting.baseShield', { value: ship.properties.baseShieldStrength })}</span>
            <span>{t('outfitting.baseArmour', { value: ship.properties.baseArmour })}</span>
            <span>{t('outfitting.hardness', { value: ship.properties.hardness })}</span>
            <span>{t('outfitting.hullCost', { value: credits(ship.properties.hullCost) })}</span>
          </div>

          {/* Переборки корпуса */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
            {ship.bulkheads.map((bulkhead, index) => (
              <button
                key={bulkhead.id}
                type="button"
                style={{
                  ...button(build.bulkhead === index),
                  fontSize: 11,
                  fontFamily: MONO,
                  padding: '3px 8px',
                }}
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

          {/* Инженерия переборок */}
          <ArmourEngineering
            data={data}
            modification={build.mods.BH ?? null}
            onModify={(next) =>
              setBuild((previous) => {
                if (!previous) return previous;
                const mods = { ...previous.mods };
                if (next) mods.BH = next;
                else delete mods.BH;
                return { ...previous, mods };
              })
            }
            t={t}
            locale={locale}
          />

          {notice && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--green)',
                background: 'rgba(46,204,113,0.1)',
                border: '1px solid rgba(46,204,113,0.3)',
                borderRadius: 3,
                padding: '4px 8px',
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice('')}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0 }}
              >
                <IconX size={12} />
              </button>
            </div>
          )}
        </div>

        {/* ── Что показывать в строке слота ─────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            marginTop: 12,
          }}
        >
          <span style={{ ...LABEL, marginBottom: 0 }}>{t('outfitting.view.title')}</span>
          {VIEW_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-pressed={view === mode}
              style={{ ...button(view === mode), padding: '3px 8px', fontSize: 10.5 }}
            >
              {t(`outfitting.view.${mode}`)}
            </button>
          ))}
          {copySourceKey && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10.5,
                color: 'var(--green)',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <IconCopy size={11} color="var(--green)" />
              {t('outfitting.copy.target')}
            </span>
          )}
        </div>

        {/* ── Секции слотов ──────────────────────────────────────────────── */}
        {sections
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <div key={section.key}>
              <SectionTitle icon={section.icon} hint={section.hint}>
                {section.title}
              </SectionTitle>

              <div style={{ ...PANEL, padding: 0, overflow: 'hidden' }}>
                {section.items.map((slot) => {
                  const module = slot.module;
                  const effective = effectiveModule(data, module, slot.modification);
                  const modification = slot.modification;
                  const rCol = module ? ratingColor(module.rating) : 'var(--muted)';

                  const isDraggingThis = dragSourceKey === slot.key;
                  const isDragTarget = dragOverKey === slot.key;
                  const sourceSlot = dragSourceKey ? slots.find((s) => s.key === dragSourceKey) : null;
                  const isValidDrop = sourceSlot ? canSwapSlots(data, sourceSlot, slot) : false;

                  // Режим копирования: подсвечиваем ячейки, куда модуль влезет.
                  const copySlot = copySourceKey ? slots.find((s) => s.key === copySourceKey) : null;
                  const isCopySource = copySourceKey === slot.key;
                  const isCopyTarget = Boolean(
                    copySlot?.module
                    && !isCopySource
                    && isSlotCompatibleWithModule(data, slot, copySlot.module),
                  );
                  const merc = module ? mercEntryFor(module.grp, module.id) : null;

                  const openOrCopy = () => {
                    if (copySourceKey && isCopyTarget) handleCopySlot(copySourceKey, slot.key);
                    else if (copySourceKey) setCopySourceKey(null);
                    else setPicker(slot.key);
                  };

                  return (
                    <div
                      key={slot.key}
                      draggable={Boolean(module)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', slot.key);
                        e.dataTransfer.effectAllowed = 'copyMove';
                        setDragSourceKey(slot.key);
                        setHover(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
                        if (dragOverKey !== slot.key) {
                          setDragOverKey(slot.key);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverKey === slot.key) setDragOverKey(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const sourceKey = e.dataTransfer.getData('text/plain') || dragSourceKey;
                        if (sourceKey) {
                          // Alt при отпускании — копировать, обычное перетаскивание — поменять местами.
                          if (e.altKey) handleCopySlot(sourceKey, slot.key);
                          else handleSwapSlots(sourceKey, slot.key);
                        }
                        setDragSourceKey(null);
                        setDragOverKey(null);
                      }}
                      onDragEnd={() => {
                        setDragSourceKey(null);
                        setDragOverKey(null);
                      }}
                      onMouseEnter={(e) => {
                        if (module && !dragSourceKey) setHover({ key: slot.key, x: e.clientX, y: e.clientY });
                      }}
                      onMouseMove={(e) => {
                        if (module && !dragSourceKey && hover?.key === slot.key) {
                          setHover({ key: slot.key, x: e.clientX, y: e.clientY });
                        }
                      }}
                      onMouseLeave={() => {
                        setHover((previous) => (previous?.key === slot.key ? null : previous));
                      }}
                      onContextMenu={(e) => handleSlotContextMenu(e, slot)}
                      title={t('outfitting.tip.hint')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        borderBottom: '1px solid var(--line)',
                        padding: '6px 10px',
                        cursor: 'pointer',
                        background: isDraggingThis || isCopySource
                          ? 'rgba(230,126,34,0.15)'
                          : isDragTarget
                            ? isValidDrop
                              ? 'rgba(46,204,113,0.15)'
                              : 'rgba(231,76,60,0.15)'
                            : isCopyTarget
                              ? 'rgba(46,204,113,0.08)'
                              : 'transparent',
                        borderLeft: `3px solid ${
                          isDragTarget
                            ? isValidDrop
                              ? 'var(--green)'
                              : 'var(--red)'
                            : isCopyTarget
                              ? 'var(--green)'
                              : module
                                ? rCol
                                : 'transparent'
                        }`,
                        transition: 'background 0.12s ease',
                      }}
                    >
                      {/* Индикатор перетаскивания */}
                      {module && (
                        <span
                          style={{
                            color: 'var(--muted)',
                            cursor: 'grab',
                            display: 'flex',
                            alignItems: 'center',
                            opacity: 0.6,
                          }}
                          title={t('outfitting.drag.hint')}
                        >
                          <IconGrip size={14} />
                        </span>
                      )}

                      {/* Бейдж класса слота */}
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          fontWeight: 700,
                          color: 'var(--orange)',
                          minWidth: 32,
                          background: 'rgba(0,0,0,0.3)',
                          border: '1px solid var(--line)',
                          borderRadius: 3,
                          padding: '2px 4px',
                          textAlign: 'center',
                        }}
                      >
                        {slot.class}
                        {slot.special === 'Military' ? 'M' : ''}
                      </span>

                      {/* Центральная часть: клик открывает ModulePicker */}
                      <div
                        onClick={openOrCopy}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {module && (
                            <span
                              style={{
                                fontFamily: MONO,
                                fontSize: 11,
                                fontWeight: 700,
                                color: rCol,
                              }}
                            >
                              [{module.class}{module.rating}{module.mount ? `/${module.mount}` : ''}]
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: 12.5,
                              fontFamily: MONO,
                              color: module ? '#f8fafc' : 'var(--muted)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {module ? moduleLabel(data, module, locale) : t('outfitting.emptySlot')}
                          </span>
                          {merc && (
                            <span
                              title={
                                merc.coins
                                  ? t('outfitting.merc.coins', { value: merc.coins })
                                  : t('outfitting.merc.unknown')
                              }
                              style={{ display: 'flex', alignItems: 'center', color: '#fbbf24' }}
                            >
                              <IconCoins size={11} color="#fbbf24" />
                            </span>
                          )}
                        </div>

                        {/* Мелкие метрики под модулем */}
                        <div
                          style={{
                            display: 'flex',
                            gap: 10,
                            flexWrap: 'wrap',
                            fontSize: 10.5,
                            color: 'var(--muted)',
                          }}
                        >
                          {effective && (
                            <SlotMetrics module={effective} view={view} locale={locale} num={num} />
                          )}
                          {modification?.blueprint && (
                            <span style={{ color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <IconWrench size={10} color="var(--green)" />
                              {blueprintLabel(modification.blueprint, locale)} G{modification.grade ?? 1}
                            </span>
                          )}
                          {modification?.special && (
                            <span style={{ color: '#c9a0ff', display: 'flex', alignItems: 'center', gap: 3 }}>
                              <IconSparkles size={10} color="#c9a0ff" />
                              {specialName(t, data.specials[modification.special]) || modification.special}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Быстрые действия: очистить слот / открыть */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {module && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCopySourceKey(isCopySource ? null : slot.key);
                              setNotice(isCopySource ? t('outfitting.copy.cancel') : t('outfitting.copy.target'));
                            }}
                            title={t('outfitting.copy.start')}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: isCopySource ? 'var(--green)' : 'var(--muted)',
                              cursor: 'pointer',
                              padding: 4,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: 3,
                            }}
                          >
                            <IconCopy size={13} color={isCopySource ? 'var(--green)' : undefined} />
                          </button>
                        )}
                        {module && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSlotModule(slot, null);
                            }}
                            title={t('outfitting.picker.clear')}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--muted)',
                              cursor: 'pointer',
                              padding: 4,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: 3,
                            }}
                          >
                            <IconX size={14} />
                          </button>
                        )}
                        <span
                          onClick={openOrCopy}
                          style={{ color: 'var(--muted)', fontSize: 13, cursor: 'pointer' }}
                        >
                          <IconChevronRight size={14} />
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

        {/* ── Сохранённые сборки ────────────────────────────────────────── */}
        {saved.length > 0 && (
          <>
            <SectionTitle hint={t('outfitting.saved.hint')}>
              {t('outfitting.saved.title')}
            </SectionTitle>
            <div style={{ ...PANEL, padding: 0 }}>
              {saved.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
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
                  <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: MONO }}>
                    {entry.ship}
                  </span>
                  <button
                    type="button"
                    style={button(false, 'var(--red)')}
                    onClick={() => removeSaved(entry.id)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Что продаётся за Merc Coin ─────────────────────────────────── */}
        <MercCoinPanel data={data} />

        {/* Подвал раздела */}
        <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
          {t('outfitting.source.prefix')}{' '}
          <a href="https://github.com/EDCD/coriolis-data" target="_blank" rel="noopener noreferrer">
            EDCD/coriolis-data
          </a>{' '}
          {t('outfitting.source.middle', { date: date(data.generatedAt) })}{' '}
          <Link href="/engineers">{t('outfitting.source.engineers')}</Link>.
        </p>
      </div>

      {/* ── Правая сводка и распределитель питания ────────────────────── */}
      <div style={{ flex: '0 1 330px', minWidth: 280 }}>
        <StatsPanel
          data={data}
          build={build}
          stats={stats}
          shipName={build.name || ship.properties.name}
          pips={pips}
          onPipsChange={setPips}
          control={{
            ...control,
            cargo: Math.min(control.cargo, stats.cargo),
            fuel: Math.min(control.fuel, stats.fuel),
          }}
          onControlChange={setControl}
        />
      </div>

      {/* ── Подсказка с полными параметрами модуля ───────────────────── */}
      {hoverSlot?.module && (
        <ModuleTooltip
          data={data}
          module={hoverSlot.module}
          effective={effectiveModule(data, hoverSlot.module, hoverSlot.modification)}
          modification={hoverSlot.modification}
          anchor={{ x: hover!.x, y: hover!.y }}
        />
      )}

      {/* ── Обмен сборками с coriolis.io, EDSY и игрой ────────────────── */}
      {exchangeOpen && (
        <ExchangePanel
          data={data}
          build={build}
          onImport={(next) => setBuild(next)}
          onClose={() => setExchangeOpen(false)}
        />
      )}

      {/* ── Окно выбора и инженерии модуля ────────────────────────────── */}
      {activeSlot && (
        <ModulePicker
          data={data}
          ship={ship}
          build={build}
          slot={activeSlot}
          onPick={(ref) => setSlotModule(activeSlot, ref)}
          onModify={(modification) => setSlotMod(activeSlot, modification)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
