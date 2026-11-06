'use client';

/**
 * 3D-карта системы на three.js — замена Plotly-сцене (`SystemPlotlyMap`).
 *
 * Plotly остаётся библиотекой графиков: у неё нет ни удобного управления
 * камерой, ни подписей, которые не слипаются, ни теней от звёзд, а каждая
 * перерисовка собирала заново всю фигуру. Здесь сцену строит общий движок
 * `@/lib/orrery3d` — тот же, что Colonial Helper вкладывает в автономный HTML,
 * поэтому сайт и десктоп показывают одну и ту же карту.
 *
 * React отвечает только за обвязку: панели, фильтры, ссылки. Сама сцена живёт
 * в императивном вьюере, и её состояние (`focus`, `zoom`, слои) синхронизируется
 * через события — без перерисовки сцены на каждое движение мыши.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildOrreryLayout, type OrreryLayout, type OrreryStructure } from '@/lib/systemOrrery';
import { SIGNAL_KINDS, SIGNAL_META, activeSignalKinds } from '@/lib/bodySignals';
import { buildOrreryView } from '@/lib/orrery3d/payload';
import { ZOOM_LABELS, type ViewPreset, type ZoomLevel } from '@/lib/orrery3d/camera';
import { MOTION_SPEEDS } from '@/lib/orrery3d/motion';
import { SCENE_COLORS, STRUCTURE_COLORS, formatLightSeconds, formatTons } from '@/lib/orrery3d/palette';
import type { LayerName } from '@/lib/orrery3d/scene';
import type { FilterMode, LabelsMode, OrreryViewer, OrreryViewerState } from '@/lib/orrery3d/viewer';
import { useI18n } from '@/lib/i18n/I18nContext';
import { discoveredByLabel } from '@/lib/i18n/orreryTips';
import type { OrreryViewBody, OrreryViewPayload } from '@/lib/orrery3d/types';
import SystemBodyRail from './SystemBodyRail';

export interface SystemOrrery3DProps {
  systemName: string;
  /** Записи тел из API/журнала; раскладка считается здесь же. */
  bodies?: any[];
  /** Готовая раскладка (если страница посчитала её раньше). */
  layout?: OrreryLayout;
  structures?: OrreryStructure[];
  /** Куда поставить камеру при открытии (тело или звезда). */
  focusTarget?: string;
  onFocusChange?: (target: string) => void;
  player?: OrreryViewPayload['player'];
  height?: number | string;
}

const LAYER_LABELS: { id: LayerName; label: string; hint: string }[] = [
  { id: 'grid', label: 'orrery.layerGrid', hint: 'orrery.layerGridHint' },
  { id: 'orbits', label: 'orrery.layerOrbits', hint: 'orrery.layerOrbitsHint' },
  { id: 'moonOrbits', label: 'orrery.layerMoonOrbits', hint: 'orrery.layerMoonOrbitsHint' },
  { id: 'zones', label: 'orrery.layerZones', hint: 'orrery.layerZonesHint' },
  { id: 'rings', label: 'orrery.layerRings', hint: 'orrery.layerRingsHint' },
  { id: 'signals', label: 'orrery.layerSignals', hint: 'orrery.layerSignalsHint' },
  { id: 'structures', label: 'orrery.layerStructures', hint: 'orrery.layerStructuresHint' },
  { id: 'moons', label: 'orrery.layerMoons', hint: 'orrery.layerMoonsHint' },
];

const VIEW_LABELS: { id: ViewPreset; label: string; hint: string }[] = [
  { id: 'iso', label: 'orrery.viewIso', hint: 'orrery.viewIsoHint' },
  { id: 'top', label: 'orrery.viewTop', hint: 'orrery.viewTopHint' },
  { id: 'side', label: 'orrery.viewSide', hint: 'orrery.viewSideHint' },
];

const LABEL_MODES: { id: LabelsMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'orrery.labelsAuto', hint: 'orrery.labelsAutoHint' },
  { id: 'all', label: 'orrery.labelsAll', hint: 'orrery.labelsAllHint' },
  { id: 'focus', label: 'orrery.labelsFocus', hint: 'orrery.labelsFocusHint' },
  { id: 'none', label: 'orrery.labelsNone', hint: 'orrery.labelsNoneHint' },
];

/**
 * Пустые значения по умолчанию — общие на все рендеры.
 *
 * `structures = []` в параметрах создавал НОВЫЙ массив на каждый рендер:
 * от него зависел useMemo пакета данных, пакет уезжал во вьюер, вьюер
 * пересобирал сцену и ставил камеру в исходное положение — а заодно слал
 * событие состояния, вызывая следующий рендер. Камеру в такой петле было
 * невозможно увести с места.
 */
const NO_STRUCTURES: OrreryStructure[] = [];

/** Поверхностное сравнение состояния вьюера: без него каждый кадр — ре-рендер. */
function sameViewerState(a: OrreryViewerState, b: OrreryViewerState): boolean {
  if (a === b) return true;
  if (a.focus !== b.focus || a.zoom !== b.zoom || a.view !== b.view) return false;
  if (a.filter !== b.filter || a.labels !== b.labels) return false;
  if (a.playing !== b.playing || a.speed !== b.speed) return false;
  // Время идёт непрерывно: подпись показывает десятые доли, поэтому мелкие
  // шаги не должны дёргать React.
  if (Math.abs(a.timeDays - b.timeDays) > 0.02) return false;
  const layers = Object.keys(a.layers) as LayerName[];
  return layers.every((layer) => a.layers[layer] === b.layers[layer]);
}

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'rgba(230,126,34,0.12)' : 'transparent',
    border: `1px solid ${active ? 'var(--orange)' : 'var(--line)'}`,
    color: active ? 'var(--orange)' : 'var(--muted)',
    borderRadius: 2,
    padding: '6px 9px',
    fontSize: 11,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    letterSpacing: 1,
    textTransform: 'uppercase',
  };
}

const PANEL: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '10px 12px',
};

export default function SystemOrrery3D({
  systemName,
  bodies,
  layout: layoutProp,
  structures = NO_STRUCTURES,
  focusTarget,
  onFocusChange,
  player = null,
  height = 620,
}: SystemOrrery3DProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OrreryViewer | null>(null);
  const [ready, setReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [scaleMode, setScaleMode] = useState<'orrery' | 'linear'>('orrery');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [labels, setLabels] = useState<LabelsMode>('auto');
  const [railOpen, setRailOpen] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [hovered, setHovered] = useState<string>('');
  const [state, setState] = useState<OrreryViewerState>({
    focus: focusTarget ?? '',
    zoom: focusTarget ? 2 : 0,
    view: 'iso',
    filter: 'all',
    labels: 'auto',
    layers: {
      grid: true, orbits: true, moonOrbits: true, zones: true, rings: true,
      structures: true, moons: true, signals: true, player: true,
    },
    playing: false,
    speed: 1,
    timeDays: 0,
  });

  // Входные данные приходят от страниц, которые пересоздают массивы на
  // каждый свой рендер. Считаем по содержимому, а не по ссылке: иначе пакет
  // данных, а с ним и вся сцена, собирались бы заново от каждого движения
  // мыши (наведение меняет состояние компонента).
  const bodiesKey = useMemo(() => JSON.stringify(bodies ?? null), [bodies]);
  const structuresKey = useMemo(() => JSON.stringify(structures), [structures]);
  const playerKey = useMemo(() => JSON.stringify(player ?? null), [player]);
  const stableBodies = useMemo(() => bodies ?? [], [bodiesKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  const stableStructures = useMemo(() => structures, [structuresKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  const stablePlayer = useMemo(() => player ?? null, [playerKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(
    () => layoutProp ?? buildOrreryLayout(stableBodies, systemName),
    [layoutProp, stableBodies, systemName],
  );

  const payload = useMemo(
    () => buildOrreryView(layout, stableStructures, {
      systemName,
      scaleMode,
      player: stablePlayer,
    }),
    [layout, stableStructures, systemName, scaleMode, stablePlayer],
  );

  // Вьюер поднимается один раз на систему: дальше обновляется пакет данных.
  useEffect(() => {
    let disposed = false;
    let viewer: OrreryViewer | null = null;
    const container = containerRef.current;
    if (!container) return undefined;

    (async () => {
      try {
        const module = await import('@/lib/orrery3d/viewer');
        if (disposed) return;
        viewer = module.createOrreryViewer(container, payload, {
          focus: focusTarget ?? '',
          zoom: focusTarget ? 2 : 0,
          tooltips: true,
          // Подсказки вьюера (`orrery.tip*`) собираются вне React: переводчик
          // передаём функцией, иначе на других языках они оставались русскими.
          translate: t,
          onSelect: (pick) => {
            const name = pick ? (pick.kind === 'body' ? pick.name : pick.body ?? '') : '';
            setState((previous) => ({ ...previous, focus: name, zoom: name ? (previous.zoom || 2) : 0 }));
            onFocusChange?.(name);
          },
          onHover: (pick) => setHovered(pick ? (pick.kind === 'body' ? pick.name : pick.body ?? '') : ''),
          // Вьюер сообщает состояние на каждом кадре проигрывания орбит.
          // Пропускаем одинаковые снимки: иначе React перерисовывался 60 раз
          // в секунду, пересобирал пакет данных и вьюер возвращал камеру.
          onState: (next) => setState((previous) => (sameViewerState(previous, next) ? previous : next)),
        });
        viewerRef.current = viewer;
        if (!viewer.getScene()) setWebglFailed(true);
        setReady(true);
      } catch {
        if (!disposed) setWebglFailed(true);
      }
    })();

    return () => {
      disposed = true;
      viewerRef.current = null;
      viewer?.dispose();
    };
    // Пересоздаём вьюер только при смене системы: остальное — setPayload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemName]);

  // Язык переключили — вьюер получает новый переводчик. Пересоздавать его
  // нельзя: потеряются камера, время и выбранное тело.
  useEffect(() => {
    viewerRef.current?.setTranslate(t);
  }, [t]);

  // Данные обновились (новые сканы, изменившиеся постройки) — сцена
  // пересобирается, но камера остаётся там, куда её поставил пользователь.
  // Переключение масштаба вьюер распознаёт сам и кадрирует заново.
  useEffect(() => {
    if (!ready) return;
    viewerRef.current?.setPayload(payload, { keepFocus: true });
  }, [payload, ready]);

  useEffect(() => {
    if (!ready) return;
    viewerRef.current?.setFilter(filter);
  }, [filter, ready]);

  useEffect(() => {
    if (!ready) return;
    viewerRef.current?.setLabels(labels);
  }, [labels, ready]);

  useEffect(() => {
    if (!ready || !focusTarget) return;
    const current = viewerRef.current?.getState();
    if (current?.focus === focusTarget) return;
    viewerRef.current?.focus(focusTarget, current?.focus ? current.zoom : 2);
  }, [focusTarget, ready]);

  const focusName = state.focus;
  const focusBody: OrreryViewBody | undefined = useMemo(
    () => payload.bodies.find((body) => body.name === focusName),
    [payload.bodies, focusName],
  );
  const focusStructures = useMemo(
    () => payload.structures.filter((structure) => structure.body === focusName),
    [payload.structures, focusName],
  );
  const hoveredBody = payload.bodies.find((body) => body.name === hovered);

  const handleFocus = useCallback((name: string) => {
    viewerRef.current?.focus(name);
    onFocusChange?.(name);
  }, [onFocusChange]);

  const setViewerLayer = useCallback((layer: LayerName, value: boolean) => {
    viewerRef.current?.setLayer(layer, value);
  }, []);

  const timeLabel = useMemo(() => {
    if (!state.playing && state.timeDays === 0) return '';
    const days = state.timeDays;
    const abs = Math.abs(days);
    const text = abs >= 365
      ? t('orrery.timeYears', { value: (days / 365.25).toFixed(2) })
      : abs >= 1 ? t('orrery.timeDays', { value: days.toFixed(1) }) : t('orrery.timeHours', { value: (days * 24).toFixed(1) });
    return days >= 0 ? t('orrery.timeFromScans', { value: text }) : t('orrery.timeToScans', { value: text });
  }, [state.playing, state.timeDays]);

  return (
    <section className="orrery3d-shell" style={{ marginBottom: 24 }}>
      <style>{ORRERY_SITE_CSS}</style>
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'stretch',
          flexWrap: 'wrap',
          border: '1px solid var(--line)',
          borderRadius: 4,
          background: 'var(--panel)',
          padding: 12,
        }}
      >
        <div style={{ flex: '1 1 620px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* ── Верхняя панель: уровни, вид, слои, фильтры ─────────────── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {ZOOM_LABELS.map((entry) => (
              <button
                key={entry.level}
                type="button"
                title={t(entry.hint)}
                disabled={entry.level > 0 && !focusName}
                onClick={() => viewerRef.current?.setZoom(entry.level)}
                style={{
                  ...buttonStyle(state.zoom === entry.level && Boolean(entry.level === 0 || focusName)),
                  opacity: entry.level > 0 && !focusName ? 0.45 : 1,
                }}
              >
                <span aria-hidden>{entry.icon}</span> {t(entry.label)}
              </button>
            ))}
            <span style={{ width: 1, height: 20, background: 'var(--line)' }} />
            {VIEW_LABELS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                title={t(entry.hint)}
                onClick={() => viewerRef.current?.setView(entry.id)}
                style={buttonStyle(state.view === entry.id)}
              >
                {t(entry.label)}
              </button>
            ))}
            <button
              type="button"
              title={t('orrery.fitAllTitle')}
              onClick={() => {
                viewerRef.current?.fit();
                onFocusChange?.('');
              }}
              style={buttonStyle(false)}
            >
              {t('orrery.fitAll')}
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button type="button" onClick={() => setLayersOpen((open) => !open)} style={buttonStyle(layersOpen)} title={t('orrery.layersTitle')}>
              {t('orrery.layers')}
            </button>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as FilterMode)}
              title={t('orrery.filterTitle')}
              style={{ ...buttonStyle(filter !== 'all'), paddingRight: 4 }}
            >
              <option value="all">{t('orrery.filterAll')}</option>
              <option value="bodies">{t('orrery.filterNoStars')}</option>
              <option value="sites">{t('orrery.filterSites')}</option>
              <option value="landable">{t('orrery.filterLandable')}</option>
              <option value="bio">{t('orrery.filterBio')}</option>
              <option value="signals">{t('orrery.filterSignals')}</option>
              <option value="rings">{t('orrery.filterRings')}</option>
              <option value="unscanned">{t('orrery.filterUnscanned')}</option>
            </select>
            <select
              value={labels}
              onChange={(event) => setLabels(event.target.value as LabelsMode)}
              title={t('orrery.labelsTitle')}
              style={{ ...buttonStyle(labels !== 'auto') }}
            >
              {LABEL_MODES.map((entry) => (
                <option key={entry.id} value={entry.id}>{`${t('orrery.labelsPrefix')} ${t(entry.label)}`}</option>
              ))}
            </select>
            <select
              value={scaleMode}
              onChange={(event) => setScaleMode(event.target.value as 'orrery' | 'linear')}
              title={t('orrery.scaleTitle')}
              style={{ ...buttonStyle(scaleMode === 'linear') }}
            >
              <option value="orrery">{t('orrery.scaleCompressed')}</option>
              <option value="linear">{t('orrery.scaleLinear')}</option>
            </select>
            <span style={{ width: 1, height: 20, background: 'var(--line)' }} />
            <button
              type="button"
              onClick={() => viewerRef.current?.setMotion(!state.playing)}
              title={t('orrery.motionTitle')}
              style={buttonStyle(state.playing)}
            >
              {state.playing ? t('orrery.motionPause') : t('orrery.motionPlay')}
            </button>
            {state.playing && (
              <>
                <select
                  value={state.speed}
                  onChange={(event) => viewerRef.current?.setMotion(true, Number(event.target.value))}
                  title={t('orrery.speedTitle')}
                  style={buttonStyle(false)}
                >
                  {MOTION_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>{t('orrery.daysPerSecond', { value: speed })}</option>
                  ))}
                </select>
                <button type="button" onClick={() => viewerRef.current?.resetTime()} style={buttonStyle(false)} title={t('orrery.backToScansTitle')}>
                  {t('orrery.backToScans')}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setRailOpen((open) => !open)}
              style={buttonStyle(railOpen)}
              title={t('orrery.listTitle')}
            >
              {t('orrery.list')}
            </button>
          </div>

          {layersOpen && (
            <div style={{ ...PANEL, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LAYER_LABELS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  title={t(entry.hint)}
                  onClick={() => setViewerLayer(entry.id, !state.layers[entry.id])}
                  style={buttonStyle(state.layers[entry.id])}
                >
                  {state.layers[entry.id] ? '✓' : '○'} {t(entry.label)}
                </button>
              ))}
            </div>
          )}

          {/* ── Сцена ─────────────────────────────────────────────────── */}
          <div
            ref={containerRef}
            className="orrery3d-host"
            style={{
              position: 'relative',
              height,
              minHeight: 320,
              width: '100%',
              borderRadius: 2,
              border: '1px solid var(--line)',
              overflow: 'hidden',
              background: SCENE_COLORS.background,
            }}
          >
            {!ready && !webglFailed && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
                {t('orrery.preparing')}
              </div>
            )}
          </div>

          {/* ── Легенда и подсказка ───────────────────────────────────── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--muted)' }}>
              <Legend color="#ffd166" label={t('orrery.legendStar')} />
              <Legend color="#8d99ae" label={t('orrery.legendPlanet')} />
              <Legend color={STRUCTURE_COLORS.active} label={t('orrery.legendSiteActive')} />
              <Legend color={STRUCTURE_COLORS.complete} label={t('orrery.legendSiteDone')} />
              <Legend color={SCENE_COLORS.habitableZone} label={t('orrery.legendHabitable')} />
              <Legend color={SCENE_COLORS.player} label={t('orrery.legendPlayer')} />
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
              {t('orrery.controlsHint')}
            </span>
          </div>
        </div>

        {/* ── Правая колонка: карточка фокуса и список тел ─────────────── */}
        <div style={{ flex: '0 1 340px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <div style={{ ...PANEL, maxHeight: 260, overflowY: 'auto' }}>
            {focusBody ? (
              <FocusCard
                body={focusBody}
                payload={payload}
                zoom={state.zoom}
                onZoom={(level) => viewerRef.current?.setZoom(level)}
                onClear={() => {
                  viewerRef.current?.fit();
                  onFocusChange?.('');
                }}
              />
            ) : (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
                  {systemName}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, fontSize: 10.5 }}>
                  <Chip>★ {payload.summary.stars}</Chip>
                  <Chip>{t('orrery.chipPlanets', { count: payload.summary.planets })}</Chip>
                  {payload.summary.moons > 0 && <Chip>{t('orrery.chipMoons', { count: payload.summary.moons })}</Chip>}
                  {payload.summary.landable > 0 && <Chip>{t('orrery.chipLandable', { count: payload.summary.landable })}</Chip>}
                  {SIGNAL_KINDS.filter((kind) => payload.summary.signals[kind] > 0).map((kind) => (
                    <Chip key={kind} color={SIGNAL_META[kind].color}>
                      {SIGNAL_META[kind].icon} {SIGNAL_META[kind].short}: {payload.summary.signals[kind]}
                    </Chip>
                  ))}
                  {payload.summary.ringed > 0 && <Chip>{t('orrery.chipRings', { count: payload.summary.ringed })}</Chip>}
                  {payload.summary.structures > 0 && (
                    <Chip color={STRUCTURE_COLORS.active}>{t('orrery.chipSites', { count: payload.summary.activeSites || payload.summary.structures })}</Chip>
                  )}
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
                  {t('orrery.pickBody')}
                  {hoveredBody ? t('orrery.hoverNow', { name: hoveredBody.shortName }) : ''}
                </p>
              </>
            )}
          </div>

          {railOpen && (
            <div style={{ ...PANEL, flex: 1, minHeight: 220, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <SystemBodyRail
                payload={payload}
                focus={focusName}
                onFocus={handleFocus}
                filter={filter}
                onFilterChange={setFilter}
                onClose={() => setRailOpen(false)}
              />
            </div>
          )}
        </div>
      </div>

      {timeLabel && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
          {t('orrery.timeOnMap', { label: timeLabel })}
        </div>
      )}
      {webglFailed && (
        <p style={{ marginTop: 8, fontSize: 11.5, color: '#f0b37e' }}>
          {t('orrery.webglFailed')}
        </p>
      )}
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        color: color ?? 'var(--text)',
        background: `${color ?? '#8b95a3'}1a`,
        border: `1px solid ${color ?? '#8b95a3'}33`,
        borderRadius: 2,
        padding: '2px 7px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      {children}
    </span>
  );
}

/** Карточка выбранного тела: факты, орбита, кольца и постройки. */
function FocusCard({
  body,
  payload,
  zoom,
  onZoom,
  onClear,
}: {
  body: OrreryViewBody;
  payload: OrreryViewPayload;
  zoom: ZoomLevel;
  onZoom: (level: ZoomLevel) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const structures = payload.structures.filter((structure) => structure.body === body.name);
  const cluster = payload.clusters.find((candidate) => candidate.bodies.includes(body.name) || candidate.star === body.name);
  const rows: [string, string][] = [];
  if (body.cls) rows.push([t('orrery.rowClass'), body.cls]);
  if (body.kind !== 'star') rows.push([t('orrery.rowOrbit'), formatLightSeconds(body.orbitLs)]);
  rows.push([t('orrery.rowFromEntry'), formatLightSeconds(body.distanceLs)]);
  if (body.elements.real) rows.push([t('orrery.rowEccentricity'), body.elements.eccentricity.toFixed(4)]);
  if (body.habitableZoneLs && body.habitableBand) {
    rows.push([
      t('orrery.rowHabitable'),
      body.habitableBand === 'habitable' ? t('orrery.bandInside') : body.habitableBand === 'inner' ? t('orrery.bandInner') : t('orrery.bandOuter'),
    ]);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{body.name}</span>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
          {body.kind === 'star' ? t('orrery.kindStar') : body.kind === 'moon' ? t('orrery.kindMoon') : t('orrery.kindPlanet')}
          {cluster && payload.summary.stars > 1 ? ` · ★ ${cluster.star.replace(`${payload.system} `, '')}` : ''}
        </span>
        <button
          type="button"
          onClick={onClear}
          title={t('orrery.clearFocus')}
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 }}
        >
          ✕
        </button>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', margin: '0 0 8px', fontSize: 11.5 }}>
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--muted)' }}>{key}</dt>
            <dd style={{ margin: 0, color: 'var(--text)' }}>{value}</dd>
          </div>
        ))}
      </dl>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
        {body.landable && <Chip color="#00f3ff">{t('orrery.chipLandableShort')}</Chip>}
        {activeSignalKinds(body.signals).map((kind) => (
          <Chip key={kind} color={SIGNAL_META[kind].color}>
            {SIGNAL_META[kind].icon} {SIGNAL_META[kind].label}: {body.signals[kind]}
          </Chip>
        ))}
        {body.signals.genuses.length > 0 && <Chip color="#22c55e">{t('orrery.chipGenuses', { list: body.signals.genuses.slice(0, 3).join(', ') })}</Chip>}
        {body.rings.length > 0 && <Chip color="#9fd8ef">{t('orrery.chipRingsShort', { count: body.rings.length })}</Chip>}
        {body.mapped && <Chip color="#ffd166">{t('orrery.chipMapped')}</Chip>}
        {body.firstDiscoveredBy && <Chip>🧭 {discoveredByLabel(body.firstDiscoveredBy, t)}</Chip>}
        {body.firstFootfallBy && <Chip>👣 {discoveredByLabel(body.firstFootfallBy, t)}</Chip>}
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: structures.length ? 8 : 0 }}>
        {ZOOM_LABELS.filter((entry) => entry.level > 0).map((entry) => (
          <button key={entry.level} type="button" onClick={() => onZoom(entry.level)} style={buttonStyle(zoom === entry.level)} title={t(entry.hint)}>
            {entry.icon} {t(entry.label)}
          </button>
        ))}
      </div>

      {structures.map((structure) => (
        <div key={structure.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: 'var(--text)' }}>
            <span>{structure.name}</span>
            <b style={{ color: structure.complete ? STRUCTURE_COLORS.complete : STRUCTURE_COLORS.active }}>
              {structure.complete ? t('orrery.structureDone') : `${Math.round(structure.progress)}%`}
            </b>
          </div>
          <div style={{ height: 5, background: 'var(--line)', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, structure.progress))}%`,
                height: '100%',
                background: structure.complete ? STRUCTURE_COLORS.complete : STRUCTURE_COLORS.active,
              }}
            />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
            {structure.requiredTons > 0
              ? t('orrery.structureTons', { provided: formatTons(structure.providedTons), required: formatTons(structure.requiredTons), remaining: formatTons(structure.remainingTons) })
              : structure.type}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Мини-adaptation: одна колонка на узком экране, легенда переносится. */
const ORRERY_SITE_CSS = `
.orrery3d-shell { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.orrery3d-shell button, .orrery3d-shell select, .orrery3d-shell input { font-family: inherit; }
.orrery3d-shell button:not(:disabled):hover { border-color: var(--orange) !important; color: var(--text) !important; background: rgba(230,126,34,0.06) !important; }
.orrery3d-shell button:focus-visible, .orrery3d-shell select:focus-visible, .orrery3d-shell input:focus-visible { outline: 1px solid var(--orange); outline-offset: 2px; }
@media (max-width: 900px) {
  .orrery3d-host { height: 62vh !important; }
}
`;
