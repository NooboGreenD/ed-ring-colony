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
  { id: 'grid', label: 'сетка', hint: 'Плоскость эклиптики и круги дистанций' },
  { id: 'orbits', label: 'орбиты', hint: 'Орбиты планет и звёзд' },
  { id: 'moonOrbits', label: 'орбиты лун', hint: 'Орбиты лун вокруг планет' },
  { id: 'zones', label: 'обитаемая зона', hint: 'Зона обитаемости звёзд' },
  { id: 'rings', label: 'кольца', hint: 'Кольца планет' },
  { id: 'signals', label: 'сигналы', hint: 'Метки сигналов: биология, геология, следы людей, стражи, таргоиды' },
  { id: 'structures', label: 'постройки', hint: 'Стройплощадки, станции и поселения' },
  { id: 'moons', label: 'луны', hint: 'Сами луны' },
];

const VIEW_LABELS: { id: ViewPreset; label: string; hint: string }[] = [
  { id: 'iso', label: '3D', hint: 'Изометрия — обычный вид' },
  { id: 'top', label: 'сверху', hint: 'Вид на плоскость системы' },
  { id: 'side', label: 'сбоку', hint: 'Вид вдоль плоскости системы' },
];

const LABEL_MODES: { id: LabelsMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'по ситуации', hint: 'Подписи у важных тел' },
  { id: 'all', label: 'все', hint: 'Подписи у всех тел' },
  { id: 'focus', label: 'только фокус', hint: 'Подпись только у выбранного тела' },
  { id: 'none', label: 'нет', hint: 'Полностью скрыть подписи' },
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
    background: active ? 'rgba(230,126,34,0.2)' : 'rgba(18,22,31,0.86)',
    border: `1px solid ${active ? '#e67e22' : '#323538'}`,
    color: active ? '#ff9f43' : '#cbd5e1',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 11.5,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
  };
}

const PANEL: React.CSSProperties = {
  background: 'rgba(11,14,20,0.9)',
  border: '1px solid #2b3038',
  borderRadius: 10,
  padding: '8px 10px',
  backdropFilter: 'blur(6px)',
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
    const text = abs >= 365 ? `${(days / 365.25).toFixed(2)} лет` : abs >= 1 ? `${days.toFixed(1)} сут` : `${(days * 24).toFixed(1)} ч`;
    return days >= 0 ? `+${text} от сканов` : `${text} до сканов`;
  }, [state.playing, state.timeDays]);

  return (
    <section style={{ marginBottom: 24 }}>
      <style>{ORRERY_SITE_CSS}</style>
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'stretch',
          flexWrap: 'wrap',
          border: '1px solid #323538',
          borderRadius: 12,
          background: '#14171b',
          padding: 10,
        }}
      >
        <div style={{ flex: '1 1 620px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* ── Верхняя панель: уровни, вид, слои, фильтры ─────────────── */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {ZOOM_LABELS.map((entry) => (
              <button
                key={entry.level}
                type="button"
                title={entry.hint}
                disabled={entry.level > 0 && !focusName}
                onClick={() => viewerRef.current?.setZoom(entry.level)}
                style={{
                  ...buttonStyle(state.zoom === entry.level && Boolean(entry.level === 0 || focusName)),
                  opacity: entry.level > 0 && !focusName ? 0.45 : 1,
                }}
              >
                <span aria-hidden>{entry.icon}</span> {entry.label}
              </button>
            ))}
            <span style={{ width: 1, height: 20, background: '#2b3038' }} />
            {VIEW_LABELS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                title={entry.hint}
                onClick={() => viewerRef.current?.setView(entry.id)}
                style={buttonStyle(state.view === entry.id)}
              >
                {entry.label}
              </button>
            ))}
            <button
              type="button"
              title="Показать всю систему"
              onClick={() => {
                viewerRef.current?.fit();
                onFocusChange?.('');
              }}
              style={buttonStyle(false)}
            >
              ⤢ вся система
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button type="button" onClick={() => setLayersOpen((open) => !open)} style={buttonStyle(layersOpen)} title="Слои сцены">
              ⚙ слои
            </button>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as FilterMode)}
              title="Показать только нужные тела — остальные притухают"
              style={{ ...buttonStyle(filter !== 'all'), paddingRight: 4 }}
            >
              <option value="all">все тела</option>
              <option value="bodies">без звёзд</option>
              <option value="sites">со стройками</option>
              <option value="landable">с посадкой</option>
              <option value="bio">с био</option>
              <option value="signals">с сигналами</option>
              <option value="rings">с кольцами</option>
              <option value="unscanned">без скана</option>
            </select>
            <select
              value={labels}
              onChange={(event) => setLabels(event.target.value as LabelsMode)}
              title="Подписи тел на карте"
              style={{ ...buttonStyle(labels !== 'auto') }}
            >
              {LABEL_MODES.map((entry) => (
                <option key={entry.id} value={entry.id}>{`подписи: ${entry.label}`}</option>
              ))}
            </select>
            <select
              value={scaleMode}
              onChange={(event) => setScaleMode(event.target.value as 'orrery' | 'linear')}
              title="Сжатый масштаб делает систему обозримой, линейный сохраняет пропорции"
              style={{ ...buttonStyle(scaleMode === 'linear') }}
            >
              <option value="orrery">масштаб: сжатый</option>
              <option value="linear">масштаб: линейный</option>
            </select>
            <span style={{ width: 1, height: 20, background: '#2b3038' }} />
            <button
              type="button"
              onClick={() => viewerRef.current?.setMotion(!state.playing)}
              title="Движение тел по орбитам: положение на любую дату"
              style={buttonStyle(state.playing)}
            >
              {state.playing ? '⏸ пауза' : '▶ движение'}
            </button>
            {state.playing && (
              <>
                <select
                  value={state.speed}
                  onChange={(event) => viewerRef.current?.setMotion(true, Number(event.target.value))}
                  title="Сколько суток проходит за секунду"
                  style={buttonStyle(false)}
                >
                  {MOTION_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>{`${speed} сут/с`}</option>
                  ))}
                </select>
                <button type="button" onClick={() => viewerRef.current?.resetTime()} style={buttonStyle(false)} title="Вернуться к дате сканов">
                  ⟲ к сканам
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setRailOpen((open) => !open)}
              style={buttonStyle(railOpen)}
              title="Список тел и построек"
            >
              ☰ список
            </button>
          </div>

          {layersOpen && (
            <div style={{ ...PANEL, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LAYER_LABELS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  title={entry.hint}
                  onClick={() => setViewerLayer(entry.id, !state.layers[entry.id])}
                  style={buttonStyle(state.layers[entry.id])}
                >
                  {state.layers[entry.id] ? '✓' : '○'} {entry.label}
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
              borderRadius: 10,
              border: '1px solid #242a33',
              overflow: 'hidden',
              background: `radial-gradient(120% 90% at 50% 0%, ${SCENE_COLORS.backgroundTop} 0%, ${SCENE_COLORS.background} 62%)`,
            }}
          >
            {!ready && !webglFailed && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7e8794', fontSize: 13 }}>
                Готовим 3D-карту системы…
              </div>
            )}
          </div>

          {/* ── Легенда и подсказка ───────────────────────────────────── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: '#9ca3af' }}>
              <Legend color="#ffd166" label="звезда" />
              <Legend color="#8d99ae" label="планета/луна" />
              <Legend color={STRUCTURE_COLORS.active} label="стройка в работе" />
              <Legend color={STRUCTURE_COLORS.complete} label="постройка готова" />
              <Legend color={SCENE_COLORS.habitableZone} label="обитаемая зона" />
              <Legend color={SCENE_COLORS.player} label="вы здесь" />
            </div>
            <span style={{ fontSize: 10.5, color: '#6b7280' }}>
              колесо — зум · ЛКМ — вращение · ПКМ — панорама · клик по телу — фокус · двойной клик — ближе
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
                <div style={{ fontSize: 12, fontWeight: 700, color: '#eeeeee', marginBottom: 6 }}>
                  {systemName}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, fontSize: 10.5 }}>
                  <Chip>★ {payload.summary.stars}</Chip>
                  <Chip>планет: {payload.summary.planets}</Chip>
                  {payload.summary.moons > 0 && <Chip>лун: {payload.summary.moons}</Chip>}
                  {payload.summary.landable > 0 && <Chip>посадка: {payload.summary.landable}</Chip>}
                  {SIGNAL_KINDS.filter((kind) => payload.summary.signals[kind] > 0).map((kind) => (
                    <Chip key={kind} color={SIGNAL_META[kind].color}>
                      {SIGNAL_META[kind].icon} {SIGNAL_META[kind].short}: {payload.summary.signals[kind]}
                    </Chip>
                  ))}
                  {payload.summary.ringed > 0 && <Chip>кольца: {payload.summary.ringed}</Chip>}
                  {payload.summary.structures > 0 && (
                    <Chip color={STRUCTURE_COLORS.active}>строек: {payload.summary.activeSites || payload.summary.structures}</Chip>
                  )}
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 11, color: '#8b95a3', lineHeight: 1.45 }}>
                  Выберите тело на карте или в списке — здесь появятся его факты, орбита и постройки.
                  {hoveredBody ? ` Сейчас под курсором: ${hoveredBody.shortName}.` : ''}
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
        <div style={{ marginTop: 6, fontSize: 11, color: '#8b95a3' }}>
          Время на карте: {timeLabel} · положение рассчитано по настоящим периодам обращения
        </div>
      )}
      {webglFailed && (
        <p style={{ marginTop: 8, fontSize: 11.5, color: '#f0b37e' }}>
          Похоже, браузер не дал доступ к WebGL: сцена не поднялась. Данные системы ниже — в списках и карточках построек.
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
        color: color ?? '#cbd5e1',
        background: `${color ?? '#8b95a3'}1a`,
        border: `1px solid ${color ?? '#8b95a3'}33`,
        borderRadius: 999,
        padding: '1px 7px',
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
  const structures = payload.structures.filter((structure) => structure.body === body.name);
  const cluster = payload.clusters.find((candidate) => candidate.bodies.includes(body.name) || candidate.star === body.name);
  const rows: [string, string][] = [];
  if (body.cls) rows.push(['Класс', body.cls]);
  if (body.kind !== 'star') rows.push(['Орбита', formatLightSeconds(body.orbitLs)]);
  rows.push(['От входа', formatLightSeconds(body.distanceLs)]);
  if (body.elements.real) rows.push(['Эксцентриситет', body.elements.eccentricity.toFixed(4)]);
  if (body.habitableZoneLs && body.habitableBand) {
    rows.push([
      'Обитаемая зона',
      body.habitableBand === 'habitable' ? 'тело в зоне' : body.habitableBand === 'inner' ? 'ближе зоны' : 'дальше зоны',
    ]);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>{body.name}</span>
        <span style={{ fontSize: 10.5, color: '#8b95a3' }}>
          {body.kind === 'star' ? 'звезда' : body.kind === 'moon' ? 'луна' : 'планета'}
          {cluster && payload.summary.stars > 1 ? ` · ★ ${cluster.star.replace(`${payload.system} `, '')}` : ''}
        </span>
        <button
          type="button"
          onClick={onClear}
          title="Снять фокус"
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#8b95a3', cursor: 'pointer', fontSize: 13 }}
        >
          ✕
        </button>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', margin: '0 0 8px', fontSize: 11.5 }}>
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt style={{ color: '#8b95a3' }}>{key}</dt>
            <dd style={{ margin: 0, color: '#e6eef8' }}>{value}</dd>
          </div>
        ))}
      </dl>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
        {body.landable && <Chip color="#00f3ff">🛬 посадка</Chip>}
        {activeSignalKinds(body.signals).map((kind) => (
          <Chip key={kind} color={SIGNAL_META[kind].color}>
            {SIGNAL_META[kind].icon} {SIGNAL_META[kind].label}: {body.signals[kind]}
          </Chip>
        ))}
        {body.signals.genuses.length > 0 && <Chip color="#22c55e">роды: {body.signals.genuses.slice(0, 3).join(', ')}</Chip>}
        {body.rings.length > 0 && <Chip color="#9fd8ef">💍 колец: {body.rings.length}</Chip>}
        {body.mapped && <Chip color="#ffd166">🗺 нанесено на карту</Chip>}
        {body.firstDiscoveredBy && <Chip>🧭 {body.firstDiscoveredBy}</Chip>}
        {body.firstFootfallBy && <Chip>👣 {body.firstFootfallBy}</Chip>}
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: structures.length ? 8 : 0 }}>
        {ZOOM_LABELS.filter((entry) => entry.level > 0).map((entry) => (
          <button key={entry.level} type="button" onClick={() => onZoom(entry.level)} style={buttonStyle(zoom === entry.level)} title={entry.hint}>
            {entry.icon} {entry.label}
          </button>
        ))}
      </div>

      {structures.map((structure) => (
        <div key={structure.id} style={{ borderTop: '1px solid #262b33', paddingTop: 6, marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: '#e6eef8' }}>
            <span>{structure.name}</span>
            <b style={{ color: structure.complete ? STRUCTURE_COLORS.complete : STRUCTURE_COLORS.active }}>
              {structure.complete ? 'готово' : `${Math.round(structure.progress)}%`}
            </b>
          </div>
          <div style={{ height: 5, background: '#2b2f33', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, structure.progress))}%`,
                height: '100%',
                background: structure.complete ? STRUCTURE_COLORS.complete : STRUCTURE_COLORS.active,
              }}
            />
          </div>
          <div style={{ fontSize: 10.5, color: '#8b95a3', marginTop: 3 }}>
            {structure.requiredTons > 0
              ? `доставлено ${formatTons(structure.providedTons)} из ${formatTons(structure.requiredTons)} · осталось ${formatTons(structure.remainingTons)}`
              : structure.type}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Мини-adaptation: одна колонка на узком экране, легенда переносится. */
const ORRERY_SITE_CSS = `
@media (max-width: 900px) {
  .orrery3d-host { height: 62vh !important; }
}
`;
