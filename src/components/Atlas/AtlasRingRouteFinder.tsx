'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { RangeNumberField } from '@/components/Atlas/RangeNumberField';
import { toast } from '@/components/ui/Toaster';
import { IconCopy, IconDownload, IconSearch, IconX } from '@/components/Icons';
import { copyText, downloadCsv, formatCoordinates, routeToCsvRows } from '@/lib/atlas';
import {
  clearAtlasSearchResult,
  finishAtlasSearchProgress,
  publishAtlasSearchProgress,
  publishAtlasSearchPoints,
  startAtlasSearchProgress,
  type AtlasSearchPoint,
} from '@/lib/atlasSearchProgress';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';

/** Проект эскадрильи, в который можно сохранить кольцо. */
export interface RingProjectOption {
  id: number;
  name: string;
  squadron_name?: string;
}

interface Props {
  onRouteFound: (route: RoutePoint[]) => void;
  /** Проекты для сохранения маршрута: приходят со страницы Atlas. */
  projects?: RingProjectOption[];
  /** Вызывается после сохранения: страница может показать маршрут проекта. */
  onSavedToProject?: (projectId: number, added: number) => void;
}

interface RingPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  source?: string;
}

interface RingAnchor extends RingPoint {
  deviation?: number;
  found?: number;
  usedRadius?: number;
}

interface RingStats {
  realAnchors: number;
  triangulatedAnchors: number;
  systemsFound: number;
  systemsSaved: number;
  catalogHits: number;
  cacheHits: number;
  edsmRequests: number;
  spanshRequests: number;
  reusedFromNeighbours: number;
  triangulatedSegments?: number;
}

interface RingValidation {
  maxJump: number;
  jumpViolations: number;
  anchorSpacingMin: number;
  anchorSpacingMax: number;
  anchorSpacingAvg: number;
  anchorSpacingViolations: number;
  anchorSpacingOutside: number;
  anchorDeviationMax: number;
  anchorDeviationAvg: number;
  routeDeviationMax: number;
  deviationViolations: number;
  startOffset: number;
  withinSpec: boolean;
}

interface RingResult {
  sessionId?: string;
  start?: string;
  route: RingPoint[];
  center: RingPoint;
  ringRadius: number;
  searchRadius: number;
  anchors: RingPoint[];
  totals: {
    points: number;
    realPoints: number;
    syntheticPoints: number;
    anchors: number;
    triangulatedAnchors: number;
    discovered: number;
    deviationAvg: number;
    deviationMax: number;
  };
  validation?: RingValidation;
  stats: RingStats;
}

/** Требования к кольцу — те же числа, что в atlasRingSearch.ts. */
const RING_LIMITS = {
  jump: 14.99,
  spacingMin: 480,
  spacingMax: 490,
  spacingLimit: 500,
  deviation: 100,
  deviationPreferred: 50,
} as const;

interface SessionView {
  session_id: string;
  start_system: string;
  ring_radius: number;
  search_radius: number;
  sectors: number;
  sectors_done: number;
  status: string;
  center: { x: number; y: number; z: number };
}

interface ProgressView {
  percent: number;
  stage: string;
  message: string;
  sectors: number;
  sectorsDone: number;
  realAnchors: number;
  triangulatedAnchors: number;
  systemsFound: number;
  systemsSaved: number;
}

const EMPTY_PROGRESS: ProgressView = {
  percent: 0,
  stage: 'idle',
  message: '',
  sectors: 0,
  sectorsDone: 0,
  realAnchors: 0,
  triangulatedAnchors: 0,
  systemsFound: 0,
  systemsSaved: 0,
};

const MAX_STEP_RETRIES = 4;
const FINALIZE_ATTEMPTS = 3;
const ROUTE_SAMPLE_LIMIT = 3000;
const RING_RADIUS_RANGE = { min: 100, max: 45000, step: 100 } as const;
const SEARCH_RADIUS_RANGE = { min: 50, max: 3000, step: 50 } as const;

export default function AtlasRingRouteFinder({ onRouteFound, projects = [], onSavedToProject }: Props) {
  const [startSystem, setStartSystem] = useState('Sol');
  const [ringRadius, setRingRadius] = useState(23000);
  const [searchRadius, setSearchRadius] = useState(500);
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [progress, setProgress] = useState<ProgressView>(EMPTY_PROGRESS);
  const [result, setResult] = useState<RingResult | null>(null);
  const [routeFilter, setRouteFilter] = useState('');
  const [resumable, setResumable] = useState<{ sessionId: string; sectorsDone: number; sectors: number } | null>(null);
  // Сохранение результата: проект эскадрильи, состояние запроса и итог.
  const [saveProjectId, setSaveProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [includeSynthetic, setIncludeSynthetic] = useState(false);
  const [saveSummary, setSaveSummary] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  const lastSessionRef = useRef<{ sessionId: string; sectorsDone: number; sectors: number } | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setRefining(false);
    finishAtlasSearchProgress({ message: 'Поиск остановлен пользователем' });
    toast('Поиск остановлен', 'info');
  }, []);

  /** Публикация прогресса на карту: контур кольца, луч, опоры и найденные системы. */
  const publishToMap = useCallback((
    session: SessionView | null,
    patch: {
      percent: number;
      stage: string;
      message: string;
      anchors?: RingAnchor[];
      found?: RingPoint[];
      beam?: { x: number; y: number; z: number } | null;
      stats?: RingStats;
    },
  ) => {
    if (session) {
      publishAtlasSearchProgress({
        active: true,
        kind: 'ring',
        title: 'ПОИСК ГАЛАКТИЧЕСКОГО КОЛЬЦА',
        stage: patch.stage,
        percent: patch.percent,
        message: patch.message,
        ring: { cx: session.center.x, cy: session.center.y, cz: session.center.z, radius: session.ring_radius },
        beam: patch.beam || null,
        counters: {
          'Сегмент': `${patch.percent > 0 ? session.sectors_done : 0}/${session.sectors}`,
          'Реальных опор': patch.stats?.realAnchors ?? 0,
          'Расчётных опор': patch.stats?.triangulatedAnchors ?? 0,
          'Систем найдено': patch.stats?.systemsFound ?? 0,
        },
      });
    }
    const points: AtlasSearchPoint[] = [];
    for (const anchor of patch.anchors || []) {
      points.push({
        name: anchor.name,
        x: anchor.x,
        y: anchor.y,
        z: anchor.z,
        kind: anchor.source === 'triangulated' ? 'triangulated' : 'anchor',
        label: `Опорная точка (отклонение ${Number(anchor.deviation || 0).toFixed(1)} св.л.)`,
      });
    }
    for (const system of patch.found || []) {
      points.push({
        name: system.name,
        x: system.x,
        y: system.y,
        z: system.z,
        kind: 'system',
        label: `Источник: ${system.source || 'каталог'}`,
      });
    }
    if (points.length > 0) publishAtlasSearchPoints(points);
  }, []);

  const applyResult = useCallback((payload: RingResult) => {
    setResult(payload);
    const mapped: RoutePoint[] = payload.route.map((point, index) => ({
      id: -(index + 1),
      system_name: point.name,
      x: point.x,
      y: point.y,
      z: point.z,
      sort_order: index,
      status: 'planned',
      isHub: false,
    }));
    onRouteFound(mapped);

    // Маршрут на карте: прореживаем линию и отдельно показываем расчётные точки.
    const stride = Math.max(1, Math.ceil(payload.route.length / ROUTE_SAMPLE_LIMIT));
    const path = payload.route
      .filter((_, index) => index % stride === 0)
      .map((point) => ({ name: point.name, x: point.x, y: point.y, z: point.z, kind: 'system' as const }));
    const synthetic = payload.route
      .filter((point) => point.source === 'triangulated')
      .slice(0, 1500)
      .map((point) => ({ name: point.name, x: point.x, y: point.y, z: point.z, kind: 'triangulated' as const }));
    publishAtlasSearchProgress({ path, beam: null });
    if (synthetic.length > 0) publishAtlasSearchPoints(synthetic);
  }, [onRouteFound]);

  /** Запрос шага сессии + запоминание идентификатора для возобновления. */
  const postRing = useCallback(async (body: Record<string, unknown>, controller: AbortController) => {
    const res = await fetch('/api/atlas/ring-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 504 || res.status === 502 || res.status === 503) {
        throw new Error(`Сервер не ответил вовремя (HTTP ${res.status}). Шаг будет повторён`);
      }
      throw new Error(data.error || `Сервер не смог обработать шаг поиска (HTTP ${res.status})`);
    }
    if (data.session?.session_id) {
      sessionRef.current = data.session.session_id;
      lastSessionRef.current = {
        sessionId: data.session.session_id,
        sectorsDone: Number(data.session.sectors_done) || 0,
        sectors: Number(data.session.sectors) || 0,
      };
    }
    return data as { session: SessionView; step?: any; completed?: boolean; route?: RingPoint[] };
  }, []);

  const postRingFinalize = useCallback(async (sessionId: string, controller: AbortController) => {
    let lastMessage = 'Не удалось собрать маршрут кольца';
    for (let attempt = 1; attempt <= FINALIZE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        publishAtlasSearchProgress({
          stage: 'route',
          percent: 99,
          message: `Сборка маршрута не успела, повторяем (${attempt} из ${FINALIZE_ATTEMPTS})`,
        });
        await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
      }
      let res: Response;
      try {
        res = await fetch('/api/atlas/ring-route/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
          signal: controller.signal,
        });
      } catch (error: any) {
        if (controller.signal.aborted) throw error;
        lastMessage = 'Не удалось собрать маршрут кольца: связь оборвалась. Сегменты сохранены — можно продолжить с этого места.';
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.result?.route) && data.result.route.length > 1) {
        return data as { result: RingResult };
      }
      const statusHint = res.status ? `HTTP ${res.status}` : 'нет ответа';
      lastMessage = data.error
        || `Не удалось собрать маршрут кольца (${statusHint}). Сегменты сохранены — можно продолжить с этого места.`;
      // 400 — ошибка запроса, повтор её не исправит. Таймаут и 5xx — да.
      if (res.status === 400) break;
    }
    throw new Error(lastMessage);
  }, []);

  const runSearch = useCallback(async (resumeSessionId?: string) => {
    if (!resumeSessionId && !startSystem.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setResult(null);
    setRouteFilter('');
    setResumable(null);
    setSaveSummary('');
    setProgress({ ...EMPTY_PROGRESS, stage: 'coords', message: resumeSessionId ? 'Продолжаем поиск с сохранённого места' : 'Получение координат начальной системы и Sagittarius A*' });
    startAtlasSearchProgress({
      kind: 'ring',
      title: 'ПОИСК ГАЛАКТИЧЕСКОГО КОЛЬЦА',
      stage: 'coords',
      percent: 0,
      message: resumeSessionId ? 'Продолжаем поиск с сохранённого места' : 'Получение координат начальной системы и Sagittarius A*',
      counters: {},
    });

    try {
      let session: SessionView | null = null;
      let step = await postRing({
        session_id: resumeSessionId,
        start_system: resumeSessionId ? undefined : startSystem.trim(),
        ring_radius: ringRadius,
        search_radius: searchRadius,
      }, controller);
      session = step.session;

      // Шаги идут один за другим: каждый запрос короткий, поэтому соединение не
      // рвётся даже на кольце радиусом 45 000 св.л. Если шаг не прошёл из-за
      // сети — повторяем его, а не начинаем всё заново.
      let retries = 0;
      while (true) {
        const anchors = (step.step?.anchors || []) as RingAnchor[];
        const found = (step.step?.found || []) as RingPoint[];
        const stats = step.step?.stats as RingStats | undefined;
        session = step.session;

        setProgress({
          percent: step.step?.progress?.percent ?? 0,
          stage: step.step?.progress?.stage || 'scan',
          message: step.step?.progress?.message || 'Перебор сегментов кольца',
          sectors: step.session.sectors,
          sectorsDone: step.session.sectors_done,
          realAnchors: stats?.realAnchors ?? 0,
          triangulatedAnchors: stats?.triangulatedAnchors ?? 0,
          systemsFound: stats?.systemsFound ?? 0,
          systemsSaved: stats?.systemsSaved ?? 0,
        });

        publishToMap(step.session, {
          percent: step.step?.progress?.percent ?? 0,
          stage: step.step?.progress?.stage || 'scan',
          message: step.step?.progress?.message || 'Перебор сегментов кольца',
          anchors,
          found,
          beam: step.step?.beam || null,
          stats,
        });

        if (step.completed || step.step?.done) break;

        try {
          step = await postRing({ session_id: session.session_id }, controller);
          retries = 0;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          retries++;
          if (retries > MAX_STEP_RETRIES) throw error;
          await new Promise((resolve) => setTimeout(resolve, 400 * retries));
          // Повторяем тот же шаг: сессия уже сохранена на сервере.
          step = await postRing({ session_id: session.session_id }, controller);
        }
      }

      publishAtlasSearchProgress({
        stage: 'route',
        percent: 99,
        message: 'Сегменты пройдены: соединение опорных точек реальными системами',
      });

      const finalized = await postRingFinalize(session!.session_id, controller);
      applyResult(finalized.result);
      const totals = finalized.result.totals;
      setProgress((current) => ({
        ...current,
        percent: 100,
        stage: 'done',
        message: `Кольцо собрано: ${totals.points} точек, расчётных ${totals.syntheticPoints}`,
      }));
      finishAtlasSearchProgress({
        stage: 'done',
        percent: 100,
        message: `Кольцо собрано: ${totals.points} точек`,
        summary: `Реальных точек ${totals.realPoints.toLocaleString('ru-RU')} · расчётных ${totals.syntheticPoints.toLocaleString('ru-RU')} · в кэш сохранено ${finalized.result.stats.systemsSaved.toLocaleString('ru-RU')} систем`,
        counters: {
          'Точек маршрута': totals.points,
          'Расчётных точек': totals.syntheticPoints,
          'Опорных систем': totals.anchors,
        },
      });
      toast(
        `Кольцо построено: ${totals.points} точек, расчётных ${totals.syntheticPoints}`,
        'success',
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : 'Ошибка поиска кольца';
      // Сессия остаётся на сервере: пользователь продолжит поиск одной кнопкой.
      const last = lastSessionRef.current;
      if (last) setResumable({ sessionId: last.sessionId, sectorsDone: last.sectorsDone, sectors: last.sectors });
      finishAtlasSearchProgress({ message: `Поиск прерван: ${message}` });
      toast(message, 'error');
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [applyResult, postRing, postRingFinalize, publishToMap, ringRadius, searchRadius, startSystem]);

  const search = useCallback(() => {
    sessionRef.current = null;
    void runSearch();
  }, [runSearch]);

  const resume = useCallback(() => {
    const session = resumable?.sessionId || sessionRef.current;
    if (!session) return;
    void runSearch(session);
  }, [resumable, runSearch]);

  const refine = useCallback(async () => {
    if (!result || refining) return;
    setRefining(true);
    publishAtlasSearchProgress({
      active: true,
      kind: 'ring',
      title: 'УТОЧНЕНИЕ КОЛЬЦА',
      stage: 'refine',
      percent: 5,
      message: 'Ищем реальные системы для расчётных точек',
    });
    try {
      const res = await fetch('/api/atlas/ring-route/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          route: result.route,
          center: result.center || { x: 25.21875, y: -20.90625, z: 25899.96875 },
          ring_radius: result.ringRadius,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось уточнить маршрут');
      const refined: RingResult = {
        ...result,
        route: data.route,
        totals: {
          ...result.totals,
          points: data.route.length,
          realPoints: data.real_points,
          syntheticPoints: data.synthetic_points,
        },
      };
      applyResult(refined);
      publishAtlasSearchProgress({ percent: 100, stage: 'done' });
      finishAtlasSearchProgress({
        message: `Уточнение завершено: заменено ${data.replacements} точек`,
        summary: `Осталось расчётных точек: ${data.synthetic_points}`,
      });
      toast(`Маршрут уточнён: заменено ${data.replacements} точек`, 'success');
    } catch (error) {
      finishAtlasSearchProgress({ message: 'Уточнение прервано' });
      toast(error instanceof Error ? error.message : 'Ошибка уточнения маршрута', 'error');
    } finally {
      setRefining(false);
    }
  }, [applyResult, refining, result]);

  const exportRingCsv = () => {
    if (!result) return;
    downloadCsv(
      `galactic-ring-${result.start || startSystem}`,
      routeToCsvRows(result.route.map((point) => ({
        ...point,
        source: point.source === 'triangulated' ? 'triangulated' : point.source || 'catalog',
      }))),
    );
    toast('CSV кольца сохранён в загрузки', 'success');
  };

  /** Сохранение кольца в проект эскадрильи (системы уходят с координатами). */
  const saveToProject = useCallback(async () => {
    if (!result || saving) return;
    const projectId = Number(saveProjectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      toast('Выберите проект для сохранения кольца', 'info');
      return;
    }
    setSaving(true);
    setSaveSummary('');
    try {
      // Сервер берёт маршрут из сессии, если она есть: тело запроса остаётся
      // маленьким даже на кольце из десяти тысяч точек.
      const response = await fetch('/api/atlas/ring-route/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          session_id: result.sessionId,
          ring_radius: result.ringRadius,
          include_synthetic: includeSynthetic,
          route: result.sessionId
            ? undefined
            : result.route.map((point) => ({
              name: point.name,
              x: point.x,
              y: point.y,
              z: point.z,
              source: point.source,
            })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить кольцо в проект');
      const summary = `В проект добавлено систем: ${data.added.toLocaleString('ru-RU')}`
        + (data.skipped_duplicate ? `, уже было: ${data.skipped_duplicate.toLocaleString('ru-RU')}` : '')
        + (data.skipped_synthetic ? `, расчётных точек пропущено: ${data.skipped_synthetic.toLocaleString('ru-RU')}` : '');
      setSaveSummary(summary);
      toast(summary, 'success');
      onSavedToProject?.(projectId, Number(data.added) || 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка сохранения кольца';
      setSaveSummary('');
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  }, [includeSynthetic, onSavedToProject, result, saveProjectId, saving]);

  const copyRoute = async () => {
    if (!result) return;
    const text = result.route.map((point, index) => `${index + 1}. ${point.name} (${formatCoordinates(point, 2)})`).join('\n');
    const ok = await copyText(text);
    toast(ok ? 'Кольцо скопировано в буфер' : 'Буфер обмена недоступен', ok ? 'success' : 'error');
  };

  const filteredRoute = useMemo(() => {
    if (!result) return [];
    const query = routeFilter.trim().toLowerCase();
    if (!query) return result.route;
    return result.route.filter((point) => point.name.toLowerCase().includes(query));
  }, [result, routeFilter]);

  const busy = loading || refining;
  const syntheticShare = result && result.totals.points > 0
    ? Math.round((result.totals.syntheticPoints / result.totals.points) * 100)
    : 0;

  return (
    <div className="atlas-route-finder">
      <div className="atlas-search-panel">
        <h3>Галактическое кольцо колонизации</h3>
        <p className="atlas-route-desc">
          Замкнутый маршрут вокруг Sagittarius A*. Требования к результату: прыжок между соседними
          системами не больше 14,99 св.л.; опорные точки через 480–490 св.л. (не больше 500);
          отклонение от оси кольца до 50 св.л. (допуск 100). Опоры берутся из каталога Spansh в базе
          проекта и кэша Atlas; разрывы закрываются реальными системами, расчётные точки остаются,
          лишь если рядом систем нет. Поиск идёт шагами и продолжается после обрыва связи.
        </p>

        <SystemSearchInput
          label="Начальная система"
          value={startSystem}
          onChange={setStartSystem}
          onSubmit={() => { if (startSystem.trim() && !busy) search(); }}
          placeholder="Sol"
        />

        <RangeNumberField
          id="ring-radius"
          label="Удаление от центра"
          min={RING_RADIUS_RANGE.min}
          max={RING_RADIUS_RANGE.max}
          step={RING_RADIUS_RANGE.step}
          value={ringRadius}
          onChange={setRingRadius}
          disabled={busy}
          hint="Радиус окружности кольца от Sagittarius A*. Число опорных точек считается от длины окружности."
        />

        <RangeNumberField
          id="ring-search-radius"
          label="Радиус поиска известных систем"
          min={SEARCH_RADIUS_RANGE.min}
          max={SEARCH_RADIUS_RANGE.max}
          step={SEARCH_RADIUS_RANGE.step}
          value={searchRadius}
          onChange={setSearchRadius}
          disabled={busy}
          hint="Окно, в котором ищется опорная система вокруг каждой точки кольца. Больше окно — больше вариантов, но медленнее шаг."
        />

        <div className="atlas-button-row">
          <button type="button" className="atlas-scan-btn" onClick={search} disabled={busy || !startSystem.trim()}>
            {loading ? 'Поиск систем кольца…' : 'Построить галактическое кольцо'}
          </button>
          {busy && (
            <button type="button" className="atlas-stop-btn" onClick={stop}>Стоп</button>
          )}
        </div>

        {loading && (
          <div className="atlas-progress" aria-live="polite">
            <div className="atlas-progress-head">
              <span>{progress.message || 'Подготовка поиска…'}</span>
              <strong>{Math.round(progress.percent)}%</strong>
            </div>
            <div className="atlas-progress-bar">
              <div style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
            </div>
            <div className="atlas-progress-meta">
              Сегмент {progress.sectorsDone} из {progress.sectors} · реальных опор: {progress.realAnchors} ·
              {' '}расчётных: {progress.triangulatedAnchors} · найдено систем: {progress.systemsFound}
            </div>
            <p className="atlas-muted">
              Ход поиска виден на 3D-карте: кольцо, луч текущего сегмента и найденные системы. Найденное
              сразу сохраняется в базу проекта — повторный поиск в этом районе пойдёт быстрее.
            </p>
          </div>
        )}

        {resumable && !busy && (
          <div className="atlas-resume-box">
            <p>
              Поиск прерван на сегменте {resumable.sectorsDone} из {resumable.sectors}.
              Прогресс сохранён на сервере.
            </p>
            <div className="atlas-button-row">
              <button type="button" className="atlas-secondary-btn" onClick={resume}>Продолжить с этого места</button>
              <button type="button" className="atlas-link-btn" onClick={search}>Начать заново</button>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="atlas-section">
          <div className="atlas-section-head">
            <h4>Результат кольцевого маршрута</h4>
            <div className="atlas-section-actions">
              <button type="button" className="atlas-icon-btn" title="Скопировать кольцо текстом" onClick={() => void copyRoute()}>
                <IconCopy size={12} />
              </button>
              <button type="button" className="atlas-icon-btn" title="Скачать CSV" onClick={exportRingCsv}>
                <IconDownload size={12} />
              </button>
            </div>
          </div>

          <div className="atlas-route-summary">
            <div className="stat-box"><div className="num">{result.totals.points.toLocaleString('ru-RU')}</div><div className="lbl">Точек маршрута</div></div>
            <div className="stat-box"><div className="num">{result.totals.anchors}</div><div className="lbl">Опорных систем</div></div>
            <div className="stat-box"><div className="num">{result.totals.realPoints.toLocaleString('ru-RU')}</div><div className="lbl">Реальных точек</div></div>
            <div className="stat-box"><div className="num">{result.totals.syntheticPoints.toLocaleString('ru-RU')}</div><div className="lbl">Расчётных ({syntheticShare}%)</div></div>
          </div>

          <div className="atlas-details-box">
            <div className="atlas-stat-grid">
              <div>Расчётных опор</div><div>{result.totals.triangulatedAnchors} из {result.totals.anchors}</div>
              <div>Сегментов с расчётом</div><div>{result.stats.triangulatedSegments ?? '—'}</div>
              <div>Среднее отклонение</div><div>{result.totals.deviationAvg} св.л.</div>
              <div>Максимальное отклонение</div><div>{result.totals.deviationMax} св.л.</div>
              <div>Систем из каталога Spansh</div><div>{result.stats.catalogHits.toLocaleString('ru-RU')}</div>
              <div>Систем из кэша Atlas</div><div>{result.stats.cacheHits.toLocaleString('ru-RU')}</div>
              <div>Запросов к EDSM</div><div>{result.stats.edsmRequests.toLocaleString('ru-RU')}</div>
              <div>Запросов к Spansh</div><div>{result.stats.spanshRequests.toLocaleString('ru-RU')}</div>
              <div>Сохранено в кэш проекта</div><div>{result.stats.systemsSaved.toLocaleString('ru-RU')}</div>
            </div>
          </div>

          {result.validation && <RingValidationPanel validation={result.validation} />}

          <button type="button" className="atlas-secondary-btn" onClick={() => void refine()} disabled={busy || result.totals.syntheticPoints === 0}>
            {refining
              ? `Уточнение маршрута: ${Math.round(progress.percent)}%`
              : result.totals.syntheticPoints === 0
                ? 'Расчётных точек нет — уточнять нечего'
                : 'Заменить расчётные точки реальными системами'}
          </button>

          {/* Сохранение и экспорт: маршрут кольца — это тысячи систем, поэтому
              его нужно уметь либо передать эскадрилье, либо выгрузить файлом. */}
          <div className="atlas-details-box atlas-save-box">
            <h4>Сохранить найденное кольцо</h4>
            <p className="atlas-muted">
              Кольцо остаётся на 3D-карте, пока вы его не уберёте (кнопка «✕» в рамке результата
              слева сверху). Ниже — сохранение в проект эскадрильи и выгрузка файлом.
            </p>

            <div className="atlas-project-select">
              <label htmlFor="ring-save-project">Проект:</label>
              <select
                id="ring-save-project"
                value={saveProjectId}
                onChange={(event) => setSaveProjectId(event.target.value)}
                disabled={saving}
              >
                <option value="">{projects.length > 0 ? 'Выберите проект' : 'Проектов нет'}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.squadron_name ? `[${project.squadron_name}] ` : ''}
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="atlas-checkbox-row">
              <input
                type="checkbox"
                checked={includeSynthetic}
                onChange={(event) => setIncludeSynthetic(event.target.checked)}
                disabled={saving}
              />
              Сохранять и расчётные точки (их {result.totals.syntheticPoints.toLocaleString('ru-RU')})
            </label>

            <div className="atlas-button-row">
              <button
                type="button"
                className="atlas-scan-btn"
                onClick={() => void saveToProject()}
                disabled={saving || !saveProjectId}
              >
                {saving ? 'Сохраняем…' : 'Сохранить в проект'}
              </button>
              <button type="button" className="atlas-secondary-btn" onClick={exportRingCsv}>
                <IconDownload size={12} /> Скачать CSV
              </button>
              <button type="button" className="atlas-secondary-btn" onClick={() => void copyRoute()}>
                <IconCopy size={12} /> Копировать текстом
              </button>
              <button type="button" className="atlas-link-btn" onClick={() => clearAtlasSearchResult()}>
                Убрать с карты
              </button>
            </div>

            {saveSummary && <p className="atlas-save-summary">{saveSummary}</p>}
            <p className="atlas-muted">
              В проект системы уходят вместе с координатами и порядком облёта; расчётные точки
              по умолчанию пропускаются — это вычисленные координаты, а не системы.
              {projects.length === 0 && ' Список проектов пуст: создайте проект на странице «Проекты».'}
            </p>
          </div>

          <div className="atlas-section-head">
            <h4>Точки кольца</h4>
            <div className="atlas-inline-search compact">
              <IconSearch size={12} />
              <input
                type="search"
                value={routeFilter}
                onChange={(event) => setRouteFilter(event.target.value)}
                placeholder="Найти точку"
                aria-label="Фильтр точек кольца"
              />
              {routeFilter && (
                <button type="button" onClick={() => setRouteFilter('')} aria-label="Очистить фильтр">
                  <IconX size={11} />
                </button>
              )}
            </div>
          </div>
          <p className="atlas-list-counter">Показано {Math.min(300, filteredRoute.length)} из {filteredRoute.length}</p>
          <div className="atlas-route-list">
            {filteredRoute.length === 0 && <p className="atlas-muted">Точек по фильтру нет.</p>}
            {filteredRoute.slice(0, 300).map((point, index) => (
              <div key={`${point.name}-${index}`} className="route-row">
                <span className="route-idx">{index + 1}</span>
                <span className="route-name">
                  {point.name}
                  {point.source === 'triangulated' && <span className="atlas-tag">расчётная</span>}
                </span>
                <span className="route-coords">{formatCoordinates(point)}</span>
              </div>
            ))}
            {filteredRoute.length > 300 && <p className="atlas-muted">Показаны первые 300 точек — полный список в CSV.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Проверка результата по требованиям кольца: что выполнено и что вышло за пределы. */
function RingValidationPanel({ validation: v }: { validation: RingValidation }) {
  const row = (ok: boolean, title: string, detail: string) => (
    <div className={`atlas-check-row ${ok ? 'ok' : 'fail'}`}>
      <span aria-hidden>{ok ? '✓' : '✗'}</span>
      <span>
        <strong>{title}</strong> — {detail}
      </span>
    </div>
  );
  const spacingOk = v.anchorSpacingViolations === 0;
  return (
    <div className="atlas-details-box atlas-validation" aria-label="Проверка требований кольца">
      <h4>Проверка требований</h4>
      {row(
        v.jumpViolations === 0,
        `Прыжок не больше ${RING_LIMITS.jump} св.л.`,
        `максимальный ${v.maxJump.toFixed(2)} св.л.${v.jumpViolations ? `, нарушений: ${v.jumpViolations}` : ''}`,
      )}
      {row(
        spacingOk,
        `Опоры через ${RING_LIMITS.spacingMin}–${RING_LIMITS.spacingMax} св.л. (не больше ${RING_LIMITS.spacingLimit})`,
        `от ${v.anchorSpacingMin} до ${v.anchorSpacingMax} св.л., среднее ${v.anchorSpacingAvg}`
          + (v.anchorSpacingOutside ? `; вне ${RING_LIMITS.spacingMin}–${RING_LIMITS.spacingMax}: ${v.anchorSpacingOutside}` : ''),
      )}
      {row(
        v.anchorDeviationMax <= RING_LIMITS.deviation && v.deviationViolations === 0,
        `Отклонение от оси до ${RING_LIMITS.deviation} св.л.`,
        `опоры: макс. ${v.anchorDeviationMax}, среднее ${v.anchorDeviationAvg}; `
          + `точки маршрута: макс. ${v.routeDeviationMax}`
          + (v.anchorDeviationMax <= RING_LIMITS.deviationPreferred ? '' : `; опоры выше ${RING_LIMITS.deviationPreferred} св.л. — допуск`),
      )}
      {v.startOffset > RING_LIMITS.deviation && (
        <p className="atlas-muted">
          Стартовая система на {v.startOffset.toLocaleString('ru-RU')} св.л. от окружности кольца:
          подход к ней и возврат идут отдельным участком и в проверку отклонения не входят.
        </p>
      )}
    </div>
  );
}
