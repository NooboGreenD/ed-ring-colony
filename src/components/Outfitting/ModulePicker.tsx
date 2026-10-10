'use client';

/**
 * Окно выбора и инженерии модуля (EDSY-style 3-панельный интерфейс):
 *
 *  - Левая панель: фильтры (поиск, класс, рейтинг, крепление, категории модулей);
 *  - Центральная панель: список модулей, сгруппированный по типам. В строке —
 *    только класс, рейтинг, название и цена, чтобы список оставался списком;
 *    все параметры модуля показывает всплывающая подсказка при наведении —
 *    та же самая, что и на слотах основного окна верфи;
 *  - Правая панель: полный набор параметров выбранного модуля (ничего не
 *    выкинуто) и отдельно — влияние на сборку (масса, прыжок, скорость, щиты, энергия),
 *    а также вкладка инженерии без лишних ползунков со 100% финальным эффектом
 *    и компактными списками необходимых материалов.
 */

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  blueprintsForGroup,
  computeModuleDelta,
  effectiveModule,
  modulesForSlot,
  moduleRef,
} from '@/lib/outfitting/calc';
import { specialsForGroup } from '@/lib/outfitting/specials';
import { isWeapon, weaponMetrics } from '@/lib/outfitting/analysis';
import { moduleSpecValues, specName, type SpecSection, type SpecValue } from '@/lib/outfitting/specs';
import { blueprintLabel, moduleLabel } from '@/lib/outfitting/build';
import { catalogGroupName } from '@/lib/outfitting/i18n';
import { mercBlueprintsForGroup } from '@/lib/outfitting/merccoin';
import {
  ORIGIN_COLORS,
  moduleOrigins,
  originColor,
  originLabelKey,
  type ModuleOrigin,
} from '@/lib/outfitting/origins';
import type {
  BuildSlot,
  OutfittingData,
  OutfittingModule,
  OutfittingShip,
  ShipBuild,
  SlotModification,
} from '@/lib/outfitting/types';
import SpecialEffectCard, { specialName } from './SpecialEffectCard';
import ModuleTooltip from './ModuleTooltip';
import {
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconCoins,
  IconCompass,
  IconCrosshair,
  IconGauge,
  IconGear,
  IconInfo,
  IconLayers,
  IconPlus,
  IconSearch,
  IconShield,
  IconSliders,
  IconStar,
  IconSparkles,
  IconTrash,
  IconWrench,
  IconX,
  IconZap,
} from '@/components/Icons';
import { LABEL, MONO, button, formatters } from './styles';

interface ModulePickerProps {
  data: OutfittingData;
  ship: OutfittingShip;
  build: ShipBuild;
  slot: BuildSlot;
  onPick: (ref: string | null) => void;
  onModify: (modification: SlotModification | null) => void;
  onClose: () => void;
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

function mountLabel(mount?: string): string {
  if (mount === 'F') return 'Fixed';
  if (mount === 'G') return 'Gimbal';
  if (mount === 'T') return 'Turret';
  return '';
}

/**
 * Значки происхождения модуля: жетоны, Стражи, анти-ксено. Показываются и в
 * списке (это и просили — «цвета прямо в основном списке»), и в карточке
 * выбранного модуля, и в подсказке.
 */
function OriginBadges({
  origins,
  t,
  size = 9.5,
}: {
  origins: ModuleOrigin[];
  t: (key: string) => string;
  size?: number;
}) {
  if (origins.length === 0) return null;
  return (
    <>
      {origins.map((origin) => (
        <span
          key={origin}
          title={t(originLabelKey(origin))}
          style={{
            fontFamily: MONO,
            fontSize: size,
            lineHeight: 1.5,
            color: ORIGIN_COLORS[origin],
            background: `${ORIGIN_COLORS[origin]}18`,
            border: `1px solid ${ORIGIN_COLORS[origin]}66`,
            borderRadius: 2,
            padding: '0 4px',
            whiteSpace: 'nowrap',
          }}
        >
          {t(originLabelKey(origin))}
        </span>
      ))}
    </>
  );
}

/** Метка заводской настройки: такие модули нельзя пересобрать у инженера. */
function FactoryBadge({
  module,
  t,
  locale,
  size = 9.5,
}: {
  module: OutfittingModule;
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
  size?: number;
}) {
  const pre = module.preEngineered;
  if (!pre) return null;
  const title = [
    t('outfitting.factory.badge'),
    pre.approx ? t('outfitting.factory.approx') : '',
    (pre.blueprints ?? []).length
      ? `${t('outfitting.factory.blueprints')}: ${(pre.blueprints ?? [])
        .map((id) => `${blueprintLabel(id, locale)} G${pre.grade ?? 1}`)
        .join(' + ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span
      title={title}
      style={{
        fontFamily: MONO,
        fontSize: size,
        lineHeight: 1.5,
        color: '#c9a0ff',
        background: 'rgba(201,160,255,0.12)',
        border: '1px solid rgba(201,160,255,0.5)',
        borderRadius: 2,
        padding: '0 4px',
        whiteSpace: 'nowrap',
      }}
    >
      {pre.approx ? '≈ ' : ''}
      {t('outfitting.factory.badge')}
    </span>
  );
}

/** Порядок разделов параметров — тот же, что во всплывающей подсказке. */
const SECTION_ORDER: SpecSection[] = ['perf', 'mass', 'power', 'price'];

/** Таблица параметров по разделам — правая панель окна выбора. */
function SpecSections({ values, locale, t }: {
  values: SpecValue[];
  locale: string;
  t: (key: string) => string;
}) {
  const grouped = SECTION_ORDER
    .map((section) => ({ section, items: values.filter((value) => value.section === section) }))
    .filter((entry) => entry.items.length > 0);

  if (grouped.length === 0) {
    return <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('outfitting.tip.noData')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {grouped.map((entry) => (
        <div key={entry.section}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 9.5,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              color: 'var(--orange)',
              marginBottom: 3,
            }}
          >
            {t(`outfitting.view.${entry.section}`)}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 4,
              fontSize: 11,
              fontFamily: MONO,
            }}
          >
            {entry.items.map((value) => (
              <div
                key={value.key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 6,
                  background: 'rgba(255,255,255,0.03)',
                  padding: '3px 6px',
                  borderRadius: 2,
                }}
              >
                <span
                  title={specName(locale, value.key)}
                  style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {specName(locale, value.key)}
                </span>
                <span style={{ whiteSpace: 'nowrap' }}>{value.display}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ModulePicker({
  data,
  ship,
  build,
  slot,
  onPick,
  onModify,
  onClose,
}: ModulePickerProps) {
  const { t, locale } = useI18n();
  const { num, credits } = formatters(locale);

  // Состояние фильтров
  const [query, setQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  const [selectedClass, setSelectedClass] = useState<number | 'all'>('all');
  const [selectedRating, setSelectedRating] = useState<string>('all');
  const [selectedMount, setSelectedMount] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'specs' | 'eng'>('specs');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem('edring-outfitting-module-favorites');
      if (raw) setFavorites(JSON.parse(raw));
    } catch { /* приватный режим или повреждённое значение */ }
  }, []);

  const toggleFavorite = (ref: string) => {
    setFavorites((previous) => {
      const next = previous.includes(ref) ? previous.filter((item) => item !== ref) : [...previous, ref];
      try { window.localStorage.setItem('edring-outfitting-module-favorites', JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };

  // Модуль под курсором в списке — для всплывающей подсказки.
  const [hover, setHover] = useState<{ ref: string; x: number; y: number } | null>(null);

  // Доступные для слота модули
  const available = useMemo(() => modulesForSlot(data, ship, slot), [data, ship, slot]);

  // Текущий установленный в слоте модуль
  const current = slot.module;
  const currentRef = current ? moduleRef(current) : null;

  // Выбранный для инспекции модуль (по умолчанию — текущий или первый из списка)
  const [inspectedModule, setInspectedModule] = useState<OutfittingModule | null>(current || available[0] || null);

  // Список доступных категорий / групп для боковой панели
  const groupStats = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of available) {
      map.set(m.grp, (map.get(m.grp) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([grp, count]) => ({
        id: grp,
        name: catalogGroupName(data, locale, grp),
        count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [available, data, locale]);

  // Фильтрация списка модулей
  const filteredModules = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter((module) => {
      if (favoritesOnly && !favorites.includes(moduleRef(module))) return false;
      if (selectedGroup !== 'all' && module.grp !== selectedGroup) return false;
      if (selectedClass !== 'all' && module.class !== selectedClass) return false;
      if (selectedRating !== 'all' && module.rating !== selectedRating) return false;
      if (selectedMount !== 'all' && module.mount !== selectedMount) return false;
      if (q) {
        const label = moduleLabel(data, module, locale).toLowerCase();
        const grp = catalogGroupName(data, locale, module.grp).toLowerCase();
        if (!label.includes(q) && !grp.includes(q)) return false;
      }
      return true;
    });
  }, [available, selectedGroup, selectedClass, selectedRating, selectedMount, query, data, locale, favoritesOnly, favorites]);

  // Группировка списка модулей по типам
  const groupedModules = useMemo(() => {
    const map = new Map<string, { groupNameText: string; modules: OutfittingModule[] }>();
    for (const module of filteredModules) {
      const gName = catalogGroupName(data, locale, module.grp);
      if (!map.has(module.grp)) {
        map.set(module.grp, { groupNameText: gName, modules: [] });
      }
      map.get(module.grp)!.modules.push(module);
    }

    // Сортируем модули внутри группы: класс по убыванию, затем рейтинг (A -> E)
    for (const entry of map.values()) {
      entry.modules.sort((a, b) => {
        if (b.class !== a.class) return b.class - a.class;
        return String(a.rating).localeCompare(String(b.rating));
      });
    }

    return [...map.entries()].map(([grp, val]) => ({
      groupId: grp,
      groupNameText: val.groupNameText,
      modules: val.modules,
    }));
  }, [filteredModules, data, locale]);

  // Расчёт дельты влияния выбранного кандидата
  // Полный список параметров выбранного модуля и его боевая выжимка.
  const inspectedSpecs = useMemo(
    () => (inspectedModule
      ? moduleSpecValues(inspectedModule as unknown as Record<string, unknown>, locale, num)
      : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inspectedModule, locale],
  );
  const hoveredModule = useMemo(
    () => (hover ? available.find((module) => moduleRef(module) === hover.ref) ?? null : null),
    [available, hover],
  );
  const inspectedWeapon = useMemo(
    () => (inspectedModule && isWeapon(data, inspectedModule) ? weaponMetrics(inspectedModule) : null),
    [data, inspectedModule],
  );

  const delta = useMemo(() => {
    if (!inspectedModule) return null;
    return computeModuleDelta(data, build, slot, inspectedModule);
  }, [data, build, slot, inspectedModule]);

  // Инженерия для текущего / выбранного модуля
  const targetForEng = current || inspectedModule;
  const modification = slot.modification ?? {};
  const blueprints = useMemo(
    () => {
      if (!targetForEng) return [];
      const pre = targetForEng.preEngineered as { reengineerable?: boolean; canApplyExperimental?: boolean } | undefined;
      return pre?.reengineerable === false ? [] : blueprintsForGroup(data, targetForEng.grp);
    },
    [data, targetForEng],
  );
  const activeBlueprint = modification.blueprint
    ? blueprints.find((b) => b.id === modification.blueprint)
    : null;
  const specials = useMemo(
    () => {
      if (!targetForEng) return [];
      const pre = targetForEng.preEngineered as { canApplyExperimental?: boolean } | undefined;
      return pre?.canApplyExperimental === false ? [] : specialsForGroup(data, targetForEng.grp);
    },
    [data, targetForEng],
  );

  // Заводская настройка: чертежи производителя и «есть ли что инженерить».
  const factoryPre = targetForEng?.preEngineered ?? null;
  const factoryLocked = factoryPre?.reengineerable === false;
  const showEngTab = blueprints.length > 0 || specials.length > 0;
  const inspectedOrigins = useMemo(() => moduleOrigins(inspectedModule), [inspectedModule]);
  // Рецепты инженера, которые продаются за Merc Coin и подходят этой группе.
  const mercRecipes = useMemo(
    () => mercBlueprintsForGroup(targetForEng?.grp ?? ''),
    [targetForEng],
  );

  const specialOptions = useMemo(
    () =>
      specials
        .map((id) => ({ id, name: specialName(t, data.specials[id]) }))
        .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [specials, data, locale, t],
  );

  const slotKind =
    slot.section === 'standard'
      ? t('outfitting.picker.standard')
      : slot.section === 'hardpoints'
        ? slot.class === 0
          ? t('outfitting.picker.utility')
          : t('outfitting.picker.hardpoint')
        : t('outfitting.picker.internal');

  // Установка модуля
  const handleInstall = (module: OutfittingModule) => {
    onPick(moduleRef(module));
    setInspectedModule(module);
  };

  const handleClearSlot = () => {
    onPick(null);
    setInspectedModule(null);
  };

  // Изменение инженерного чертежа (всегда финальный грейд 100%)
  const handleSelectBlueprint = (bpId: string) => {
    if (!bpId) {
      onModify(null);
      return;
    }
    const bp = blueprints.find((item) => item.id === bpId);
    const maxGrade = bp ? bp.maxGrade : 5;
    const grade = Math.min(modification.grade ?? maxGrade, maxGrade);
    onModify({
      ...modification,
      blueprint: bpId,
      grade,
      quality: 1.0, // Финальный эффект без полоски качества
    });
  };

  const handleSelectGrade = (grade: number) => {
    onModify({
      ...modification,
      grade,
      quality: 1.0, // Всегда 100% максимальный эффект выбранного грейда
    });
  };

  const handleSelectSpecial = (specialId: string) => {
    onModify({
      ...modification,
      special: specialId || undefined,
    });
  };

  const isWeaponSlot = slot.section === 'hardpoints' && slot.class > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4, 6, 9, 0.82)',
        backdropFilter: 'blur(4px)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          width: 'min(1140px, 98vw)',
          height: 'min(820px, 90vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 45px rgba(0,0,0,0.65)',
        }}
      >
        {/* ── ВЕРХНЯЯ ШАПКА ОКНА ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--line)',
            background: 'rgba(15, 23, 42, 0.65)',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--orange)',
                background: 'rgba(230,126,34,0.12)',
                border: '1px solid rgba(230,126,34,0.4)',
                borderRadius: 3,
                padding: '2px 8px',
              }}
            >
              {slotKind} · {t('outfitting.picker.class', { value: slot.class })}
              {slot.special ? ` · ${slot.special === 'Military' ? t('outfitting.picker.military') : slot.special}` : ''}
            </span>

            {current ? (
              <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: MONO, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--muted)' }}>{t('outfitting.picker.installed')}:</span>
                <span style={{ color: ratingColor(current.rating), fontWeight: 700 }}>
                  [{current.class}{current.rating}{current.mount ? `/${current.mount}` : ''}]
                </span>
                <span>{moduleLabel(data, current, locale)}</span>
              </span>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: MONO }}>
                {t('outfitting.emptySlot')}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {current && (
              <button
                type="button"
                onClick={handleClearSlot}
                style={{
                  ...button(false, 'var(--red)'),
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                }}
              >
                <IconTrash size={12} color="var(--red)" />
                {t('outfitting.picker.clear')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: '1px solid var(--line)',
                color: 'var(--muted)',
                borderRadius: 4,
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              title={t('outfitting.picker.close')}
            >
              <IconX size={16} />
            </button>
          </div>
        </div>

        {/* ── ТРЁХКОЛОНОЧНОЕ ТЕЛО ОКНА ── */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* ── 1. ЛЕВАЯ ПАНЕЛЬ: ФИЛЬТРЫ И КАТЕГОРИИ (240px) ── */}
          <div
            style={{
              width: 240,
              minWidth: 200,
              borderRight: '1px solid var(--line)',
              background: 'rgba(10, 15, 24, 0.4)',
              display: 'flex',
              flexDirection: 'column',
              padding: '12px 10px',
              overflowY: 'auto',
              gap: 12,
            }}
          >
            {/* Поисковая строка */}
            <div style={{ position: 'relative' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('outfitting.picker.search')}
                style={{
                  width: '100%',
                  fontSize: 12,
                  fontFamily: MONO,
                  padding: '6px 24px 6px 8px',
                  background: 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid var(--line)',
                  borderRadius: 3,
                  color: 'var(--text)',
                }}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  style={{
                    position: 'absolute',
                    right: 6,
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
              ) : (
                <span
                  style={{
                    position: 'absolute',
                    right: 6,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--muted)',
                    pointerEvents: 'none',
                  }}
                >
                  <IconSearch size={12} />
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => setFavoritesOnly((value) => !value)}
              style={{ ...button(favoritesOnly), justifyContent: 'flex-start', gap: 6, color: favoritesOnly ? '#fbbf24' : 'var(--muted)' }}
            >
              <IconStar size={13} color={favoritesOnly ? '#fbbf24' : 'var(--muted)'} />
              Избранные модули ({favorites.length})
            </button>

            {/* Фильтр по классу */}
            <div>
              <div style={{ ...LABEL, fontSize: 10, marginBottom: 4 }}>
                {t('outfitting.picker.filterClass')}
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={{
                    ...button(selectedClass === 'all'),
                    padding: '2px 6px',
                    fontSize: 10.5,
                  }}
                  onClick={() => setSelectedClass('all')}
                >
                  {t('outfitting.picker.all')}
                </button>
                {Array.from({ length: slot.class }, (_, i) => i + 1).map((c) => (
                  <button
                    key={c}
                    type="button"
                    style={{
                      ...button(selectedClass === c),
                      padding: '2px 6px',
                      fontSize: 10.5,
                    }}
                    onClick={() => setSelectedClass(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Фильтр по рейтингу */}
            <div>
              <div style={{ ...LABEL, fontSize: 10, marginBottom: 4 }}>
                {t('outfitting.picker.filterRating')}
              </div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={{
                    ...button(selectedRating === 'all'),
                    padding: '2px 6px',
                    fontSize: 10.5,
                  }}
                  onClick={() => setSelectedRating('all')}
                >
                  {t('outfitting.picker.all')}
                </button>
                {['A', 'B', 'C', 'D', 'E'].map((r) => (
                  <button
                    key={r}
                    type="button"
                    style={{
                      ...button(selectedRating === r),
                      padding: '2px 6px',
                      fontSize: 10.5,
                      color: selectedRating === r ? 'var(--orange)' : ratingColor(r),
                    }}
                    onClick={() => setSelectedRating(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Фильтр по креплению (для орудий) */}
            {isWeaponSlot && (
              <div>
                <div style={{ ...LABEL, fontSize: 10, marginBottom: 4 }}>
                  {t('outfitting.picker.filterMount')}
                </div>
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={{
                      ...button(selectedMount === 'all'),
                      padding: '2px 6px',
                      fontSize: 10,
                    }}
                    onClick={() => setSelectedMount('all')}
                  >
                    {t('outfitting.picker.all')}
                  </button>
                  <button
                    type="button"
                    style={{
                      ...button(selectedMount === 'F'),
                      padding: '2px 6px',
                      fontSize: 10,
                    }}
                    onClick={() => setSelectedMount('F')}
                  >
                    Fixed
                  </button>
                  <button
                    type="button"
                    style={{
                      ...button(selectedMount === 'G'),
                      padding: '2px 6px',
                      fontSize: 10,
                    }}
                    onClick={() => setSelectedMount('G')}
                  >
                    Gimbal
                  </button>
                  <button
                    type="button"
                    style={{
                      ...button(selectedMount === 'T'),
                      padding: '2px 6px',
                      fontSize: 10,
                    }}
                    onClick={() => setSelectedMount('T')}
                  >
                    Turret
                  </button>
                </div>
              </div>
            )}

            {/* Список групп / категорий модулей */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ ...LABEL, fontSize: 10, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('outfitting.picker.filterCategory')}</span>
                <span style={{ color: 'var(--muted)' }}>{available.length}</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', flex: 1 }}>
                <button
                  type="button"
                  onClick={() => setSelectedGroup('all')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '5px 8px',
                    fontSize: 11,
                    fontFamily: MONO,
                    borderRadius: 3,
                    border: 'none',
                    background: selectedGroup === 'all' ? 'rgba(230,126,34,0.18)' : 'transparent',
                    color: selectedGroup === 'all' ? 'var(--orange)' : 'var(--text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span>{t('outfitting.picker.all')}</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{available.length}</span>
                </button>

                {groupStats.map((item) => {
                  const isCurrentGroup = selectedGroup === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedGroup(item.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '5px 8px',
                        fontSize: 11,
                        fontFamily: MONO,
                        borderRadius: 3,
                        border: 'none',
                        background: isCurrentGroup ? 'rgba(230,126,34,0.18)' : 'transparent',
                        color: isCurrentGroup ? 'var(--orange)' : '#cbd5e1',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.name}
                      </span>
                      <span
                        style={{
                          fontSize: 9.5,
                          color: isCurrentGroup ? 'var(--orange)' : 'var(--muted)',
                          background: 'rgba(255,255,255,0.05)',
                          borderRadius: 2,
                          padding: '1px 4px',
                          marginLeft: 4,
                        }}
                      >
                        {item.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Сброс фильтров */}
            {(selectedGroup !== 'all' || selectedClass !== 'all' || selectedRating !== 'all' || selectedMount !== 'all' || query) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedGroup('all');
                  setSelectedClass('all');
                  setSelectedRating('all');
                  setSelectedMount('all');
                  setQuery('');
                }}
                style={{
                  ...button(false),
                  fontSize: 10.5,
                  padding: '4px 6px',
                  marginTop: 'auto',
                }}
              >
                {t('outfitting.picker.resetFilters')}
              </button>
            )}
          </div>

          {/* ── 2. ЦЕНТРАЛЬНАЯ ПАНЕЛЬ: УПРОЩЁННЫЙ СПИСОК МОДУЛЕЙ (360px) ── */}
          <div
            style={{
              flex: '1 1 360px',
              minWidth: 280,
              borderRight: '1px solid var(--line)',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
              background: 'rgba(8, 12, 19, 0.3)',
            }}
          >
            {groupedModules.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                {t('outfitting.picker.empty')}
              </div>
            )}

            {groupedModules.map((grp) => (
              <div key={grp.groupId} style={{ borderBottom: '1px solid var(--line)' }}>
                {/* Заголовок группы модулей */}
                <div
                  style={{
                    padding: '6px 12px',
                    background: 'rgba(20, 30, 48, 0.45)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    backdropFilter: 'blur(3px)',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--orange)',
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                    }}
                  >
                    {grp.groupNameText}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: MONO }}>
                    {grp.modules.length}
                  </span>
                </div>

                {/* Список модулей в группе: название и цена, параметры — в подсказке */}
                <div>
                  {grp.modules.map((module) => {
                    const isInspected =
                      inspectedModule?.id === module.id && inspectedModule?.grp === module.grp;
                    const isInstalled = current?.id === module.id && current?.grp === module.grp;
                    const rCol = ratingColor(module.rating);
                    const origins = moduleOrigins(module);
                    const oCol = originColor(origins);

                    return (
                      <button
                        key={`${module.grp}:${module.id}`}
                        type="button"
                        onClick={() => setInspectedModule(module)}
                        onDoubleClick={() => handleInstall(module)}
                        onMouseEnter={(e) => setHover({ ref: moduleRef(module), x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => {
                          setHover((previous) => (previous?.ref === moduleRef(module)
                            ? { ref: previous.ref, x: e.clientX, y: e.clientY }
                            : previous));
                        }}
                        onMouseLeave={() => {
                          setHover((previous) => (previous?.ref === moduleRef(module) ? null : previous));
                        }}
                        title={t('outfitting.tip.pick')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          width: '100%',
                          textAlign: 'left',
                          margin: 0,
                          padding: '7px 12px',
                          background: isInspected
                            ? 'rgba(230,126,34,0.14)'
                            : isInstalled
                              ? 'rgba(46,204,113,0.06)'
                              : oCol
                                ? `${oCol}12`
                                : 'transparent',
                          border: 'none',
                          borderBottom: '1px solid rgba(255,255,255,0.04)',
                          borderLeft: `3px solid ${
                            isInspected ? 'var(--orange)' : isInstalled ? 'var(--green)' : oCol ?? 'transparent'
                          }`,
                          cursor: 'pointer',
                          color: 'var(--text)',
                          transition: 'background 0.1s ease',
                          gap: 10,
                        }}
                      >
                        {/* Левая часть: бейдж класса/рейтинга + название */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 11,
                              fontWeight: 700,
                              color: rCol,
                              background: 'rgba(0,0,0,0.3)',
                              border: `1px solid ${rCol}55`,
                              borderRadius: 3,
                              padding: '1px 5px',
                              minWidth: 32,
                              textAlign: 'center',
                            }}
                          >
                            {module.class}{module.rating}
                            {module.mount ? `/${module.mount}` : ''}
                          </span>

                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 12,
                              color: isInspected ? '#fff' : '#e2e8f0',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {moduleLabel(data, module, locale)}
                          </span>
                          <OriginBadges origins={origins} t={t} />
                          <FactoryBadge module={module} t={t} locale={locale} />
                        </div>

                        {/* Правая часть: бейдж установки / цена */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          {isInstalled && (
                            <span
                              style={{
                                color: 'var(--green)',
                                fontSize: 10,
                                fontFamily: MONO,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 2,
                              }}
                            >
                              <IconCheck size={11} color="var(--green)" />
                            </span>
                          )}
                          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: MONO }}>
                            {credits(Number(module.cost ?? 0))}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* ── 3. ПРАВАЯ ПАНЕЛЬ: ПАРАМЕТРЫ, СРАВНЕНИЕ И ИНЖЕНЕРИЯ (380px) ── */}
          <div
            style={{
              flex: '1 1 380px',
              minWidth: 300,
              background: 'rgba(10, 15, 24, 0.65)',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
            }}
          >
            {/* Вкладки: Спецификация/Сравнение vs Инженерия */}
            <div
              style={{
                display: 'flex',
                borderBottom: '1px solid var(--line)',
                background: 'rgba(15, 23, 42, 0.8)',
              }}
            >
              <button
                type="button"
                onClick={() => setActiveTab('specs')}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  background: activeTab === 'specs' ? 'var(--panel)' : 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${activeTab === 'specs' ? 'var(--orange)' : 'transparent'}`,
                  color: activeTab === 'specs' ? 'var(--orange)' : 'var(--muted)',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <IconSliders size={13} />
                {t('outfitting.picker.tab.specs')}
              </button>

              {showEngTab && (
              <button
                type="button"
                onClick={() => setActiveTab('eng')}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  background: activeTab === 'eng' ? 'var(--panel)' : 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${activeTab === 'eng' ? 'var(--orange)' : 'transparent'}`,
                  color: activeTab === 'eng' ? 'var(--orange)' : 'var(--muted)',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {blueprints.length > 0 ? <IconWrench size={13} /> : <IconSparkles size={13} />}
                {blueprints.length > 0 ? t('outfitting.picker.tab.eng') : t('outfitting.eng.special')}
                {modification.blueprint && (
                  <span
                    style={{
                      background: 'var(--green)',
                      color: '#000',
                      fontSize: 9,
                      borderRadius: 2,
                      padding: '0 4px',
                      fontWeight: 800,
                    }}
                  >
                    G{modification.grade ?? 1}
                  </span>
                )}
              </button>
              )}
            </div>

            {/* Содержимое вкладки */}
            <div style={{ padding: 14, flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activeTab === 'specs' && (
                <>
                  {inspectedModule ? (
                    <>
                      {/* Карточка заголовка модуля */}
                      <div
                        style={{
                          background: 'rgba(15, 23, 42, 0.6)',
                          border: `1px solid ${ratingColor(inspectedModule.rating)}40`,
                          borderRadius: 4,
                          padding: '10px 12px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 14,
                              fontWeight: 700,
                              color: ratingColor(inspectedModule.rating),
                            }}
                          >
                            [{inspectedModule.class}{inspectedModule.rating}
                            {inspectedModule.mount ? `/${inspectedModule.mount}` : ''}]
                          </span>
                          <span style={{ fontFamily: MONO, fontSize: 13, color: 'var(--orange)', fontWeight: 700 }}>
                            {credits(Number(inspectedModule.cost ?? 0))}
                          </span>
                        </div>

                        <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc', marginTop: 4 }}>
                          {moduleLabel(data, inspectedModule, locale)}
                        </div>

                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                          {catalogGroupName(data, locale, inspectedModule.grp)}
                          {inspectedModule.mount ? ` · ${mountLabel(inspectedModule.mount)}` : ''}
                          {inspectedModule.pp ? ` · Powerplay: ${inspectedModule.pp}` : ''}
                        </div>

                        {(inspectedOrigins.length > 0 || inspectedModule.preEngineered) && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                            <OriginBadges origins={inspectedOrigins} t={t} size={10} />
                            <FactoryBadge module={inspectedModule} t={t} locale={locale} size={10} />
                          </div>
                        )}

                        {inspectedModule.preEngineered?.description && (
                          <div style={{ fontSize: 10.5, color: '#c9a0ff', marginTop: 5, lineHeight: 1.45 }}>
                            {inspectedModule.preEngineered.description}
                          </div>
                        )}
                        {inspectedModule.preEngineered?.availability && (
                          <div style={{ fontSize: 10.5, color: '#f0b37e', marginTop: 3 }}>
                            {t('outfitting.factory.availability', {
                              value: inspectedModule.preEngineered.availability ?? '',
                            })}
                          </div>
                        )}
                      </div>

                      {/* Все параметры модуля из справочника */}
                      <div>
                        <div style={{ ...LABEL, fontSize: 10.5, marginBottom: 5 }}>
                          {t('outfitting.picker.tab.specs')}
                        </div>

                        {inspectedWeapon && (
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                              gap: 4,
                              fontSize: 11,
                              fontFamily: MONO,
                              marginBottom: 8,
                            }}
                          >
                            {([
                              [t('outfitting.off.dps'), num(inspectedWeapon.dps, 1), '#f43f5e'],
                              [t('outfitting.off.sdps'), num(inspectedWeapon.sdps, 1), undefined],
                              [t('outfitting.off.eps'), num(inspectedWeapon.eps, 2), undefined],
                              [t('outfitting.off.hps'), num(inspectedWeapon.hps, 2), undefined],
                              [t('outfitting.off.dpe'), num(inspectedWeapon.dpe, 1), undefined],
                              [t('outfitting.off.rof'), `${num(inspectedWeapon.rof, 2)}/s`, undefined],
                            ] as [string, string, string | undefined][]).map(([label, value, color]) => (
                              <div
                                key={label}
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  gap: 6,
                                  background: 'rgba(244,63,94,0.07)',
                                  padding: '3px 6px',
                                  borderRadius: 2,
                                }}
                              >
                                <span
                                  title={label}
                                  style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >
                                  {label}
                                </span>
                                <span style={{ whiteSpace: 'nowrap', color: color ?? 'var(--text)', fontWeight: color ? 700 : 400 }}>
                                  {value}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        <SpecSections values={inspectedSpecs} locale={locale} t={t} />
                      </div>

                      {/* ── ВЛИЯНИЕ НА СБОРКУ КОРАБЛЯ (СРАВНЕНИЕ) ── */}
                      {delta && (
                        <div
                          style={{
                            background: 'rgba(15, 23, 42, 0.45)',
                            border: '1px solid var(--line)',
                            borderRadius: 4,
                            padding: '10px 12px',
                          }}
                        >
                          <div
                            style={{
                              ...LABEL,
                              fontSize: 10.5,
                              marginBottom: 6,
                              color: 'var(--orange)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                            }}
                          >
                            <IconSliders size={12} />
                            {t('outfitting.picker.compare')}
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, fontFamily: MONO }}>
                            {/* Масса */}
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.mass')}:</span>
                              <span
                                style={{
                                  color: delta.massDelta < 0 ? 'var(--green)' : delta.massDelta > 0 ? 'var(--orange)' : 'var(--text)',
                                  fontWeight: delta.massDelta !== 0 ? 700 : 400,
                                }}
                              >
                                {delta.massDelta > 0 ? '+' : ''}{delta.massDelta.toFixed(1)} т
                              </span>
                            </div>

                            {/* Прыжок */}
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.jump.full')}:</span>
                              <span
                                style={{
                                  color: delta.jumpRangeDelta > 0 ? 'var(--green)' : delta.jumpRangeDelta < 0 ? 'var(--orange)' : 'var(--text)',
                                  fontWeight: delta.jumpRangeDelta !== 0 ? 700 : 400,
                                }}
                              >
                                {delta.jumpRangeDelta > 0 ? '+' : ''}{delta.jumpRangeDelta.toFixed(2)} св.л
                              </span>
                            </div>

                            {/* Скорость */}
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.speed')}:</span>
                              <span
                                style={{
                                  color: delta.speedDelta > 0 ? 'var(--green)' : delta.speedDelta < 0 ? 'var(--orange)' : 'var(--text)',
                                  fontWeight: delta.speedDelta !== 0 ? 700 : 400,
                                }}
                              >
                                {delta.speedDelta > 0 ? '+' : ''}{delta.speedDelta.toFixed(0)} м/с
                              </span>
                            </div>

                            {/* Щит */}
                            {Math.abs(delta.shieldDelta) > 0.05 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.shield')}:</span>
                                <span
                                  style={{
                                    color: delta.shieldDelta > 0 ? 'var(--green)' : 'var(--orange)',
                                    fontWeight: 700,
                                  }}
                                >
                                  {delta.shieldDelta > 0 ? '+' : ''}{delta.shieldDelta.toFixed(0)} МДж
                                </span>
                              </div>
                            )}

                            {/* Броня */}
                            {Math.abs(delta.armourDelta) > 0.05 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.armour')}:</span>
                                <span
                                  style={{
                                    color: delta.armourDelta > 0 ? 'var(--green)' : 'var(--orange)',
                                    fontWeight: 700,
                                  }}
                                >
                                  {delta.armourDelta > 0 ? '+' : ''}{delta.armourDelta.toFixed(0)}
                                </span>
                              </div>
                            )}

                            {/* Энергия */}
                            {Math.abs(delta.powerDeployedDelta) > 0.01 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.powerDeployed')}:</span>
                                <span
                                  style={{
                                    color: delta.powerDeployedDelta < 0 ? 'var(--green)' : 'var(--orange)',
                                    fontWeight: 700,
                                  }}
                                >
                                  {delta.powerDeployedDelta > 0 ? '+' : ''}{delta.powerDeployedDelta.toFixed(2)} МВт
                                </span>
                              </div>
                            )}

                            {/* Стоимость */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 4, marginTop: 2 }}>
                              <span style={{ color: 'var(--muted)' }}>{t('outfitting.stats.cost')}:</span>
                              <span style={{ color: delta.costDelta > 0 ? 'var(--orange)' : 'var(--green)' }}>
                                {delta.costDelta > 0 ? '+' : ''}{credits(delta.costDelta)}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => toggleFavorite(moduleRef(inspectedModule))}
                        style={{ ...button(false), justifyContent: 'center', gap: 6, color: favorites.includes(moduleRef(inspectedModule)) ? '#fbbf24' : 'var(--muted)' }}
                      >
                        <IconStar size={14} color={favorites.includes(moduleRef(inspectedModule)) ? '#fbbf24' : 'var(--muted)'} />
                        {favorites.includes(moduleRef(inspectedModule)) ? 'В избранном' : 'Добавить в избранное'}
                      </button>

                      {/* Кнопка установки модуля */}
                      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {current?.id === inspectedModule.id && current?.grp === inspectedModule.grp ? (
                          <div
                            style={{
                              background: 'rgba(46,204,113,0.12)',
                              border: '1px solid var(--green)',
                              borderRadius: 4,
                              color: 'var(--green)',
                              fontFamily: MONO,
                              fontSize: 12,
                              fontWeight: 700,
                              padding: '8px 12px',
                              textAlign: 'center',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 6,
                            }}
                          >
                            <IconCheckCircle size={14} color="var(--green)" />
                            {t('outfitting.picker.installed')}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleInstall(inspectedModule)}
                            style={{
                              ...button(true),
                              fontSize: 12.5,
                              fontFamily: MONO,
                              fontWeight: 700,
                              padding: '9px 14px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: 6,
                            }}
                          >
                            <IconCheck size={14} />
                            {t('outfitting.picker.install')}
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>
                      {t('outfitting.picker.empty')}
                    </div>
                  )}
                </>
              )}

              {/* ── ВКЛАДКА ИНЖЕНЕРИИ (БЕЗ ПОЛЗУНКОВ КАЧЕСТВА) ── */}
              {activeTab === 'eng' && showEngTab && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {!targetForEng ? (
                    <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('outfitting.eng.pickFirst')}</p>
                  ) : (
                    <>
                      {/* Что именно поставил производитель. */}
                      {factoryPre && (
                        <div
                          style={{
                            background: 'rgba(201,160,255,0.08)',
                            border: '1px solid rgba(201,160,255,0.35)',
                            borderRadius: 4,
                            padding: '8px 10px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          }}
                        >
                          <div style={{ ...LABEL, fontSize: 10, marginBottom: 0, color: '#c9a0ff' }}>
                            {t('outfitting.factory.badge')}
                            {factoryPre.approx ? ` · ${t('outfitting.factory.approx')}` : ''}
                          </div>
                          {(factoryPre.blueprints ?? []).length > 0 && (
                            <div style={{ fontSize: 11, fontFamily: MONO }}>
                              <span style={{ color: 'var(--muted)' }}>{t('outfitting.factory.blueprints')}: </span>
                              {(factoryPre.blueprints ?? [])
                                .map((id) => `${blueprintLabel(id, locale)} G${factoryPre.grade ?? 1}`)
                                .join(' + ')}
                            </div>
                          )}
                          {(factoryPre.experimentalEffects ?? []).filter(Boolean).length > 0 && (
                            <div style={{ fontSize: 11, fontFamily: MONO, color: '#c9a0ff' }}>
                              {t('outfitting.factory.experimental')}:{' '}
                              {(factoryPre.experimentalEffects ?? [])
                                .filter(Boolean)
                                .map((id) => specialName(t, data.specials[id]) || id)
                                .join(', ')}
                            </div>
                          )}
                          {factoryLocked && (
                            <div style={{ fontSize: 10.5, color: '#f0b37e', lineHeight: 1.4 }}>
                              {t('outfitting.factory.fixed')}
                            </div>
                          )}
                        </div>
                      )}

                      {mercRecipes.length > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            fontSize: 10.5,
                            color: '#fbbf24',
                            lineHeight: 1.45,
                          }}
                        >
                          <IconCoins size={12} color="#fbbf24" />
                          {t('outfitting.merc.recipe')}:{' '}
                          {mercRecipes
                            .map((entry) =>
                              entry.coins
                                ? `${entry.name} (${t('outfitting.merc.coins', { value: entry.coins })})`
                                : entry.name,
                            )
                            .join(', ')}
                        </div>
                      )}

                      {blueprints.length > 0 && (
                      <>
                      {/* Выбор чертежа */}
                      <div>
                        <div style={{ ...LABEL, fontSize: 10.5, marginBottom: 4 }}>
                          {t('outfitting.eng.title')}
                        </div>
                        <select
                          value={modification.blueprint ?? ''}
                          onChange={(e) => handleSelectBlueprint(e.target.value)}
                          style={{
                            width: '100%',
                            fontSize: 12,
                            fontFamily: MONO,
                            margin: 0,
                            background: 'rgba(15, 23, 42, 0.8)',
                            border: '1px solid var(--line)',
                            borderRadius: 3,
                            color: 'var(--text)',
                          }}
                        >
                          <option value="">{t('outfitting.eng.noBlueprint')}</option>
                          {blueprints.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {blueprintLabel(entry.id, locale)} (G1-G{entry.maxGrade})
                            </option>
                          ))}
                        </select>
                      </div>

                      {activeBlueprint && (
                        <>
                          {/* Выбор уровня (G1..G5) */}
                          <div>
                            <div style={{ ...LABEL, fontSize: 10.5, marginBottom: 4 }}>
                              Уровень (Grade)
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {Array.from({ length: activeBlueprint.maxGrade }, (_, i) => i + 1).map((grade) => (
                                <button
                                  key={grade}
                                  type="button"
                                  style={{
                                    ...button(modification.grade === grade),
                                    fontSize: 11,
                                    fontFamily: MONO,
                                    fontWeight: 700,
                                    padding: '4px 10px',
                                  }}
                                  onClick={() => handleSelectGrade(grade)}
                                >
                                  G{grade}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* ФИНАЛЬНЫЙ ЭФФЕКТ ГРЕЙДА (ЧТО ИМЕННО МЕНЯЕТСЯ) */}
                          {(() => {
                            const bpGrade = data.blueprints[activeBlueprint.id]?.grades?.[String(modification.grade ?? 1)];
                            if (!bpGrade) return null;
                            const features = Object.entries(bpGrade.features);

                            return (
                              <div
                                style={{
                                  background: 'rgba(15, 23, 42, 0.5)',
                                  border: '1px solid var(--line)',
                                  borderRadius: 4,
                                  padding: '8px 10px',
                                }}
                              >
                                <div style={{ ...LABEL, fontSize: 10, marginBottom: 4, color: 'var(--orange)' }}>
                                  {t('outfitting.special.changes')} (G{modification.grade ?? 1} Max)
                                </div>
                                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 11, fontFamily: MONO, lineHeight: 1.6 }}>
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

                          {/* Инженеры, предоставляющие этот уровень */}
                          <div>
                            <div style={{ ...LABEL, fontSize: 10, marginBottom: 2 }}>
                              {t('outfitting.eng.engineers')}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.4 }}>
                              {(activeBlueprint.engineers[modification.grade ?? 1] ?? []).map((engineer, index, all) => (
                                <span key={engineer}>
                                  <Link
                                    href={`/engineers?engineer=${encodeURIComponent(engineer)}`}
                                    style={{ color: 'var(--cyan)', textDecoration: 'none' }}
                                  >
                                    {engineer}
                                  </Link>
                                  {index < all.length - 1 ? ', ' : ''}
                                </span>
                              ))}
                              {!(activeBlueprint.engineers[modification.grade ?? 1] ?? []).length && (
                                <span style={{ color: 'var(--muted)' }}>{t('outfitting.eng.noData')}</span>
                              )}
                            </div>
                          </div>

                          {/* Требуемые материалы на чертёж (компактный список чипов) */}
                          <div>
                            <div style={{ ...LABEL, fontSize: 10, marginBottom: 3 }}>
                              {t('outfitting.eng.materials')}
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {Object.entries(
                                data.blueprints[activeBlueprint.id]?.grades?.[String(modification.grade ?? 1)]?.components ?? {},
                              ).map(([name, count]) => (
                                <span
                                  key={name}
                                  style={{
                                    fontSize: 10,
                                    fontFamily: MONO,
                                    color: '#cbd5e1',
                                    background: 'rgba(255,255,255,0.06)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: 3,
                                    padding: '2px 6px',
                                  }}
                                >
                                  {name} <b style={{ color: 'var(--orange)' }}>×{count}</b>
                                </span>
                              ))}
                              {!Object.keys(
                                data.blueprints[activeBlueprint.id]?.grades?.[String(modification.grade ?? 1)]?.components ?? {},
                              ).length && (
                                <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('outfitting.eng.noData')}</span>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                      </>
                      )}

                      {/* Экспериментальный эффект */}
                      {specials.length > 0 && (
                        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 4 }}>
                          <div style={{ ...LABEL, fontSize: 10.5, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <IconSparkles size={12} color="#c9a0ff" />
                            {t('outfitting.eng.special')}
                          </div>
                          <select
                            value={modification.special ?? ''}
                            onChange={(e) => handleSelectSpecial(e.target.value)}
                            style={{
                              width: '100%',
                              fontSize: 12,
                              fontFamily: MONO,
                              margin: '0 0 6px',
                              background: 'rgba(15, 23, 42, 0.8)',
                              border: '1px solid var(--line)',
                              borderRadius: 3,
                              color: 'var(--text)',
                            }}
                          >
                            <option value="">{t('outfitting.eng.specialNone')}</option>
                            {specialOptions.map(({ id, name }) => (
                              <option key={id} value={id}>
                                {name}
                              </option>
                            ))}
                          </select>

                          {modification.special && (
                            <SpecialEffectCard
                              data={data}
                              effect={data.specials[modification.special]}
                              t={t}
                              locale={locale}
                            />
                          )}
                        </div>
                      )}

                      {blueprints.length === 0 && specials.length === 0 && !factoryPre && (
                        <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('outfitting.eng.none')}</p>
                      )}

                      {/* Сброс инженерии */}
                      {(modification.blueprint || modification.special) && (
                        <button
                          type="button"
                          onClick={() => onModify(null)}
                          style={{
                            ...button(false, 'var(--red)'),
                            fontSize: 11,
                            fontFamily: MONO,
                            padding: '5px 8px',
                            marginTop: 6,
                          }}
                        >
                          {t('outfitting.eng.specialNone')} / {t('outfitting.eng.noBlueprint')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Параметры модуля под курсором — та же карточка, что и в основном окне */}
      {hoveredModule && hover && (
        <ModuleTooltip
          data={data}
          module={hoveredModule}
          effective={null}
          modification={null}
          anchor={{ x: hover.x, y: hover.y }}
          hint={t('outfitting.tip.pick')}
        />
      )}
    </div>
  );
}
