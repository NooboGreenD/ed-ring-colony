'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { RingBasis3D } from '@/lib/atlasRingGeometry';
import { useAtlasRingPreview } from '@/hooks/useAtlasRingPreview';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { RingGeometryControls } from '@/components/Atlas/RingGeometryControls';
import { RangeNumberField } from '@/components/Atlas/RangeNumberField';
import AtlasDialog from '@/components/Atlas/AtlasDialog';
import { toast } from '@/components/ui/Toaster';
import { IconCopy, IconDownload, IconRefresh, IconSearch, IconSettings, IconX, IconPlus, IconBuilding, IconCheckCircle, IconAlert, IconMapPin } from '@/components/Icons';
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
  projects?: RingProjectOption[];
  onSavedToProject?: (projectId: number, added: number) => void;
}

interface RingPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  source?: string;
  isAnchor?: boolean;
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

interface HubResult {
  anchorName: string;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  hub: {
    systemName: string | null;
    x: number | null;
    y: number | null;
    z: number | null;
    distance: number | null;
    bodyName: string | null;
    bodySubtype: string | null;
    status: 'found' | 'missing' | 'error' | 'searching';
    note?: string;
    source?: string;
  };
}

interface RingResult {
  sessionId?: string;
  start?: string;
  route: RingPoint[];
  center: RingPoint;
  ringCenter?: RingPoint;
  basis3D?: RingBasis3D;
  heightOffset?: number;
  tiltDegrees?: number;
  tiltAxisDegrees?: number;
  ringRadius: number;
  searchRadius: number;
  deviationLimit: number;
  anchors: RingPoint[];
  keySystems: RingPoint[];
  hubs?: HubResult[];
  totals: {
    points: number;
    realPoints: number;
    syntheticPoints: number;
    anchors: number;
    triangulatedAnchors: number;
    discovered: number;
    deviationAvg: number;
    deviationMax: number;
    hubsFound?: number;
    hubsMissing?: number;
  };
  validation?: RingValidation;
  stats: RingStats;
}

const RING_LIMITS = {
  jump: 14.99,
  spacingMin: 480,
  spacingMax: 490,
  spacingLimit: 500,
  deviation: 100,
  deviationPreferred: 50,
} as const;

const DEVIATION_RANGE = { min: 10, max: 400, step: 5 } as const;


interface SessionView {
  session_id: string;
  start_system: string;
  ring_radius: number;
  search_radius: number;
  deviation_limit: number;
  key_systems: RingPoint[];
  center_system?: string | null;
  height_offset?: number;
  tilt_degrees?: number;
  tilt_axis_degrees?: number;
  ring_center?: { x: number; y: number; z: number };
  basis3d?: RingBasis3D;
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
const DEFAULT_DEVIATION = 100;
const DEFAULT_REFINE_RADIUS = 30;

export default function AtlasRingRouteFinder({ onRouteFound, projects = [], onSavedToProject }: Props) {
  const [startSystem, setStartSystem] = useState('Sol');
  const [ringRadius, setRingRadius] = useState(23000);
  const [searchRadius, setSearchRadius] = useState(500);
  const [deviationLimit, setDeviationLimit] = useState(DEFAULT_DEVIATION);
  const [keySystemDraft, setKeySystemDraft] = useState('');
  const [keySystems, setKeySystems] = useState<RingPoint[]>([]);
  // Геометрия некомпланарного кольца:
  const [centerSystem, setCenterSystem] = useState(''); // пусто = Sagittarius A*
  const [heightOffset, setHeightOffset] = useState(0); // св.л от галактической плоскости, -5000..+5000
  const [tiltDegrees, setTiltDegrees] = useState(0); // наклон −180..180°
  const [tiltAxisDegrees, setTiltAxisDegrees] = useState(0); // направление оси 0..359°
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [progress, setProgress] = useState<ProgressView>(EMPTY_PROGRESS);
  const [result, setResult] = useState<RingResult | null>(null);
  const [routeFilter, setRouteFilter] = useState('');
  const [resumable, setResumable] = useState<{ sessionId: string; sectorsDone: number; sectors: number } | null>(null);
  const [saveProjectId, setSaveProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [includeSynthetic, setIncludeSynthetic] = useState(false);
  const [saveSummary, setSaveSummary] = useState('');

  // Modal states
  const [refineModalOpen, setRefineModalOpen] = useState(false);
  const [hubsModalOpen, setHubsModalOpen] = useState(false);
  const [searchingHubs, setSearchingHubs] = useState(false);
  const [hubProgress, setHubProgress] = useState({ done: 0, total: 0, found: 0, missing: 0 });
  const [hubs, setHubs] = useState<HubResult[]>([]);
  const [refineLog, setRefineLog] = useState<string[]>([]);
  // Re-run parameters (в модалке)
  const [refineDeviation, setRefineDeviation] = useState(DEFAULT_DEVIATION);
  const [refineRadius, setRefineRadius] = useState(DEFAULT_REFINE_RADIUS);
  const [refineKeyDraft, setRefineKeyDraft] = useState('');
  const [refineExtraKeys, setRefineExtraKeys] = useState<RingPoint[]>([]);
  const [rerunBeforeSearch, setRerunBeforeSearch] = useState(false);

  const geometryKey = JSON.stringify([startSystem, centerSystem, ringRadius, heightOffset, tiltDegrees, tiltAxisDegrees, searchRadius, deviationLimit]);
  const [searchedGeometry, setSearchedGeometry] = useState<string | null>(null);
  const busy = loading || refining || searchingHubs;
  const previewMessage = useAtlasRingPreview(startSystem, centerSystem, ringRadius, heightOffset, tiltDegrees,
    !busy && geometryKey !== searchedGeometry, tiltAxisDegrees);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  const lastSessionRef = useRef<{ sessionId: string; sectorsDone: number; sectors: number } | null>(null);
  const hubAbortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    hubAbortRef.current?.abort();
    hubAbortRef.current = null;
    setLoading(false);
    setRefining(false);
    setSearchingHubs(false);
    finishAtlasSearchProgress({ message: 'Поиск остановлен пользователем' });
    toast('Поиск остановлен', 'info');
  }, []);

  /** Публикация прогресса на карту. */
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
      keySystems?: RingPoint[];
      hubs?: HubResult[];
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
        ring: {
          cx: (session.ring_center?.x ?? session.center.x),
          cy: (session.ring_center?.y ?? session.center.y),
          cz: (session.ring_center?.z ?? session.center.z),
          radius: session.ring_radius,
          basis: session.basis3d ? {
            ux: session.basis3d.ux, uy: session.basis3d.uy, uz: session.basis3d.uz,
            vx: session.basis3d.vx, vy: session.basis3d.vy, vz: session.basis3d.vz,
          } : undefined,
        },
        beam: patch.beam || null,
        counters: {
          'Сегмент': `${patch.percent > 0 ? session.sectors_done : 0}/${session.sectors}`,
          'Реальных опор': patch.stats?.realAnchors ?? 0,
          'Расчётных опор': patch.stats?.triangulatedAnchors ?? 0,
          'Систем найдено': patch.stats?.systemsFound ?? 0,
          ...(patch.hubs ? { 'Хабов найдено': patch.hubs.filter(h => h?.hub?.status === 'found').length } : {}),
        },
      });
    }
    const points: AtlasSearchPoint[] = [];
    // Ключевые системы — синим.
    for (const ks of patch.keySystems || []) {
      points.push({
        name: ks.name,
        x: ks.x, y: ks.y, z: ks.z,
        kind: 'key-system',
        label: 'Ключевая система маршрута',
      });
    }
    for (const anchor of patch.anchors || []) {
      // Если есть данные по хабам — цвет зависит от статуса.
      const hub = patch.hubs?.find((h) => h?.anchorName === anchor.name && h.hub);
      const kind: AtlasSearchPoint['kind'] = anchor.source === 'triangulated'
        ? 'triangulated'
        : (hub ? (hub.hub.status === 'found' ? 'hub-found' : hub.hub.status === 'missing' ? 'hub-missing' : 'anchor') : 'anchor');
      const label = hub?.hub?.status === 'found'
        ? `Хаб: ${hub.hub.systemName} (${hub.hub.distance} св.л)`
        : hub?.hub?.status === 'missing'
          ? 'Хаб не найден — требуется разведка'
          : `Опорная точка (отклонение ${Number(anchor.deviation || 0).toFixed(1)} св.л.)`;
      points.push({ name: anchor.name, x: anchor.x, y: anchor.y, z: anchor.z, kind, label });
    }
    // Хабы — отдельные зелёные точки.
    for (const h of patch.hubs || []) {
      if (h?.hub?.status === 'found' && h.hub.x != null && h.hub.y != null && h.hub.z != null) {
        points.push({
          name: h.hub.systemName || 'Hub',
          x: h.hub.x, y: h.hub.y, z: h.hub.z,
          kind: 'hub-found',
          label: `Кандидат на хаб: ${h.hub.systemName}`,
        });
      }
    }
    for (const system of patch.found || []) {
      points.push({
        name: system.name,
        x: system.x, y: system.y, z: system.z,
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
    // Перерисовываем хабы и ключевые системы на карте.
    if (payload.hubs || payload.keySystems.length > 0) {
      publishToMap(
        {
          session_id: payload.sessionId || '',
          start_system: payload.start || '',
          ring_radius: payload.ringRadius,
          search_radius: payload.searchRadius,
          deviation_limit: payload.deviationLimit,
          key_systems: payload.keySystems,
          sectors: payload.totals.anchors,
          sectors_done: payload.totals.anchors,
          status: 'completed',
          center: payload.center,
          ring_center: payload.ringCenter ?? payload.center,
          basis3d: payload.basis3D ?? undefined,
        },
        {
          percent: 100, stage: 'done', message: 'Кольцо готово',
          anchors: payload.anchors as RingAnchor[],
          keySystems: payload.keySystems,
          hubs: payload.hubs,
        },
      );
    }
  }, [onRouteFound, publishToMap]);

  /** Запрос шага сессии. */
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
    return data as {
      session: SessionView;
      step?: any;
      completed?: boolean;
      route?: RingPoint[];
    };
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
      if (res.status === 400) break;
    }
    throw new Error(lastMessage);
  }, []);

  const runSearch = useCallback(async (resumeSessionId?: string) => {
    if (!resumeSessionId && !startSystem.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearchedGeometry(geometryKey);
    setLoading(true);
    setResult(null);
    setRouteFilter('');
    setResumable(null);
    setSaveSummary('');
    setHubs([]);
    setHubProgress({ done: 0, total: 0, found: 0, missing: 0 });
    setProgress({ ...EMPTY_PROGRESS, stage: 'coords', message: resumeSessionId ? 'Продолжаем поиск с сохранённого места' : 'Получение координат начальной системы и Sagittarius A*' });
    startAtlasSearchProgress({
      kind: 'ring',
      title: 'ПОИСК ГАЛАКТИЧЕСКОГО КОЛЬЦА',
      stage: 'coords',
      percent: 0,
      message: resumeSessionId ? 'Продолжаем поиск с сохранённого места' : 'Получение координат начальной системы и Sagittarius A*',
      counters: {},
    });
    // Ключевые системы с известными координатами — сразу на карту (те, что ещё
    // не разрешены, сервер подтянет после первого шага).
    const knownKeys = keySystems.filter((ks) => Number.isFinite(ks.x) && (ks.x !== 0 || ks.z !== 0 || ks.y !== 0));
    if (knownKeys.length > 0) {
      publishAtlasSearchPoints(knownKeys.map((ks) => ({
        name: ks.name, x: ks.x, y: ks.y, z: ks.z, kind: 'key-system' as const, label: 'Ключевая система',
      })));
    }

    try {
      let session: SessionView | null = null;
      let step = await postRing({
        session_id: resumeSessionId,
        start_system: resumeSessionId ? undefined : startSystem.trim(),
        ring_radius: ringRadius,
        search_radius: searchRadius,
        deviation_limit: deviationLimit,
        key_systems: resumeSessionId ? undefined : keySystems.map((ks) => ks.name),
        center_system: centerSystem.trim() || null,
        height_offset: heightOffset === 0 ? null : heightOffset,
        tilt_degrees: tiltDegrees === 0 ? null : tiltDegrees,
        tilt_axis_degrees: tiltAxisDegrees === 0 ? null : tiltAxisDegrees,
      }, controller);
      session = step.session;

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
          keySystems: step.session.key_systems || keySystems,
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
          step = await postRing({ session_id: session.session_id }, controller);
        }
      }

      publishAtlasSearchProgress({
        stage: 'route',
        percent: 99,
        message: 'Сегменты пройдены: соединение опорных точек реальными системами',
      });

      const finalized = await postRingFinalize(session!.session_id, controller);
      const ringResult: RingResult = {
        ...finalized.result,
        deviationLimit: session!.deviation_limit || deviationLimit,
        keySystems: session!.key_systems || keySystems,
      };
      applyResult(ringResult);
      const totals = ringResult.totals;
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
      const last = lastSessionRef.current;
      if (last) setResumable({ sessionId: last.sessionId, sectorsDone: last.sectorsDone, sectors: last.sectors });
      finishAtlasSearchProgress({ message: `Поиск прерван: ${message}` });
      toast(message, 'error');
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [applyResult, geometryKey, centerSystem, deviationLimit, heightOffset, keySystems, postRing, postRingFinalize, publishToMap, ringRadius, searchRadius, startSystem, tiltDegrees, tiltAxisDegrees]);

  const search = useCallback(() => {
    sessionRef.current = null;
    void runSearch();
  }, [runSearch]);

  const resume = useCallback(() => {
    const session = resumable?.sessionId || sessionRef.current;
    if (!session) return;
    void runSearch(session);
  }, [resumable, runSearch]);

  /** Добавление ключевой системы (имени достаточно — координаты разрешит сервер при старте). */
  const addKeySystem = useCallback((name: string, target: 'main' | 'refine' = 'main') => {
    const clean = String(name || '').trim();
    if (!clean) return;
    const placeholder: RingPoint = { name: clean, x: 0, y: 0, z: 0, source: 'pending' };
    if (target === 'main') {
      if (keySystems.some((ks) => ks.name.toLowerCase() === clean.toLowerCase())) return;
      setKeySystems((current) => [...current, placeholder]);
      setKeySystemDraft('');
    } else {
      if (refineExtraKeys.some((ks) => ks.name.toLowerCase() === clean.toLowerCase())) return;
      setRefineExtraKeys((current) => [...current, placeholder]);
      setRefineKeyDraft('');
    }
  }, [keySystems, refineExtraKeys]);

  const removeKeySystem = useCallback((name: string) => {
    setKeySystems((current) => current.filter((ks) => ks.name !== name));
  }, []);

  const removeRefineKey = useCallback((name: string) => {
    setRefineExtraKeys((current) => current.filter((ks) => ks.name !== name));
  }, []);

  /** Уточнение маршрута (рефайн через отдельный эндпоинт). */
  const refine = useCallback(async (opts?: { anchors?: boolean; deviation?: number; radius?: number }) => {
    if (!result || refining) return;
    setRefining(true);
    setRefineLog([`[${new Date().toLocaleTimeString()}] Начинаем уточнение…`]);
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
          center: result.center,
          ring_center: result.ringCenter ?? result.center,
          basis3d: result.basis3D ?? undefined,
          ring_radius: result.ringRadius,
          refine_radius: opts?.radius ?? refineRadius,
          deviation_limit: opts?.deviation ?? refineDeviation,
          refine_anchors: opts?.anchors ?? false,
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
      setResult(refined);
      const replacedText = `заменено точек: ${data.replacements}${data.anchor_replacements ? ` (в т.ч. опор: ${data.anchor_replacements})` : ''}`;
      setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString()}] Уточнение завершено: ${replacedText}, осталось расчётных: ${data.synthetic_points}`]);
      publishAtlasSearchProgress({ percent: 100, stage: 'done' });
      finishAtlasSearchProgress({
        message: `Уточнение завершено: ${replacedText}`,
        summary: `Осталось расчётных точек: ${data.synthetic_points}`,
      });
      toast(`Маршрут уточнён: ${replacedText}`, 'success');
    } catch (error) {
      setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString()}] Ошибка: ${error instanceof Error ? error.message : 'неизвестная'}`]);
      finishAtlasSearchProgress({ message: 'Уточнение прервано' });
      toast(error instanceof Error ? error.message : 'Ошибка уточнения маршрута', 'error');
    } finally {
      setRefining(false);
    }
  }, [applyResult, refineDeviation, refineRadius, refining, result]);

  /** Повторный прогон с новыми параметрами (через replan API). */
  const rerun = useCallback(async () => {
    if (!result || loading) return;
    const sessionId = result.sessionId || sessionRef.current;
    if (!sessionId) {
      toast('Нет активной сессии для повтора', 'error');
      return;
    }
    setRefining(true);
    setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString()}] Сброс сессии с новыми параметрами…`]);
    try {
      const res = await fetch('/api/atlas/ring-route/replan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          deviation_limit: refineDeviation,
          search_radius: searchRadius,
          key_systems: refineExtraKeys.map((ks) => ks.name),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось сбросить сессию');
      setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString()}] Сессия сброшена, запускаем перестроение…`]);
      // Добавляем новые ключевые системы в список.
      const addedNames = new Set(keySystems.map((ks) => ks.name.toLowerCase()));
      const newlyAdded = [...keySystems];
      for (const ks of refineExtraKeys) {
        if (!addedNames.has(ks.name.toLowerCase())) { newlyAdded.push(ks); addedNames.add(ks.name.toLowerCase()); }
      }
      setKeySystems(newlyAdded);
      setDeviationLimit(refineDeviation);
      setRefineExtraKeys([]);
      setRefineModalOpen(false);
      setRefining(false);
      setLoading(false); // runSearch сам выставит loading, но сначала снимем refining
      // Запускаем поиск заново (сессия уже сброшена, sessionId тот же).
      void runSearch(sessionId);
    } catch (error) {
      setRefining(false);
      toast(error instanceof Error ? error.message : 'Ошибка повтора', 'error');
    }
  }, [keySystems, loading, refineDeviation, refineExtraKeys, result, runSearch, searchRadius]);

  /** Поиск хабов по опорным точкам (SSE-поток). */
  const searchHubs = useCallback(async () => {
    if (!result || searchingHubs) return;
    const anchors = result.anchors.filter((a) => a.name);
    if (anchors.length === 0) {
      toast('Нет опорных точек для поиска хабов', 'info');
      return;
    }
    hubAbortRef.current?.abort();
    const controller = new AbortController();
    hubAbortRef.current = controller;
    setSearchingHubs(true);
    setHubsModalOpen(true);
    setHubs(anchors.map((a) => ({ anchorName: a.name, anchorX: a.x, anchorY: a.y, anchorZ: a.z, hub: { systemName: null, x: null, y: null, z: null, distance: null, bodyName: null, bodySubtype: null, status: 'searching' } })));
    setHubProgress({ done: 0, total: anchors.length, found: 0, missing: 0 });

    try {
      const res = await fetch('/api/atlas/ring-route/hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchors: anchors.map((a) => ({ name: a.name, x: a.x, y: a.y, z: a.z })), spansh_budget: 8 }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('Не удалось начать поиск хабов');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const accum: HubResult[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.type === 'hub') {
              accum[msg.index] = msg.hub;
              // Чтобы React не падал на undefined-слотах при .map, держим массив плотным:
              // для ещё не обработанных ячеек оставляем статус searching.
              for (let i = 0; i < anchors.length; i++) {
                if (!accum[i]) {
                  accum[i] = {
                    anchorName: anchors[i].name,
                    anchorX: anchors[i].x,
                    anchorY: anchors[i].y,
                    anchorZ: anchors[i].z,
                    hub: { systemName: null, x: null, y: null, z: null, distance: null, bodyName: null, bodySubtype: null, status: 'searching' },
                  };
                }
              }
              setHubs([...accum]);
            } else if (msg.type === 'progress') {
              const found = accum.filter((h) => h?.hub?.status === 'found').length;
              const missing = accum.filter((h) => h?.hub?.status === 'missing').length;
              setHubProgress({ done: msg.done, total: msg.total, found, missing });
            } else if (msg.type === 'done') {
              const finalResults: HubResult[] = Array.isArray(msg.results)
                ? msg.results.map((r: HubResult) => r && r.hub ? r : null).filter(Boolean) as HubResult[]
                : [];
              setHubs(finalResults);
              const foundCount = Number.isFinite(msg.found) ? msg.found : finalResults.filter(r => r.hub.status === 'found').length;
              const missingCount = Number.isFinite(msg.missing) ? msg.missing : finalResults.filter(r => r.hub.status === 'missing').length;
              setHubProgress({ done: finalResults.length, total: msg.total ?? anchors.length, found: foundCount, missing: missingCount });
              // Обновляем результат и карту.
              const updated: RingResult = {
                ...result,
                hubs: finalResults,
                totals: { ...result.totals, hubsFound: foundCount, hubsMissing: missingCount },
              };
              setResult(updated);
              publishToMap(
                {
                  session_id: result.sessionId || '',
                  start_system: result.start || '',
                  ring_radius: result.ringRadius,
                  search_radius: result.searchRadius,
                  deviation_limit: result.deviationLimit,
                  key_systems: result.keySystems,
                  sectors: result.totals.anchors,
                  sectors_done: result.totals.anchors,
                  status: 'completed',
                  center: result.center,
                },
                {
                  percent: 100, stage: 'done', message: 'Хабы просканированы',
                  anchors: result.anchors as RingAnchor[],
                  keySystems: result.keySystems,
                  hubs: msg.results,
                },
              );
              toast(`Хабы: найдено ${foundCount}, не найдено ${missingCount}`, missingCount > 0 ? 'info' : 'success');
            } else if (msg.type === 'error') {
              toast(msg.message || 'Ошибка поиска хабов', 'error');
            }
          } catch {/* ignore parse */}
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast(error instanceof Error ? error.message : 'Ошибка поиска хабов', 'error');
    } finally {
      hubAbortRef.current = null;
      setSearchingHubs(false);
    }
  }, [publishToMap, result, searchingHubs]);

  const stopHubSearch = useCallback(() => {
    hubAbortRef.current?.abort();
    hubAbortRef.current = null;
    setSearchingHubs(false);
  }, []);

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
              name: point.name, x: point.x, y: point.y, z: point.z, source: point.source,
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

  const syntheticShare = result && result.totals.points > 0
    ? Math.round((result.totals.syntheticPoints / result.totals.points) * 100)
    : 0;
  const hubsFoundCount = result?.totals.hubsFound ?? 0;
  const hubsMissingCount = result?.totals.hubsMissing ?? 0;

  // Подготавливаем параметры уточнения при открытии модалки.
  const openRefineModal = () => {
    setRefineDeviation(result?.deviationLimit ?? deviationLimit);
    setRefineRadius(DEFAULT_REFINE_RADIUS);
    setRefineExtraKeys([]);
    setRefineKeyDraft('');
    setRefineLog([]);
    setRefineModalOpen(true);
  };

  return (
    <div className="atlas-route-finder atlas-ring-finder">
      <div className="atlas-search-panel">
        <h3>Галактическое кольцо колонизации</h3>
        <p className="atlas-route-desc">
          Настройте окружность на карте, затем запустите поиск систем вдоль кольца.
        </p>
        <details className="atlas-details atlas-ring-help">
          <summary>Как строится маршрут</summary>
          <p className="atlas-muted">Замкнутый маршрут вокруг выбранного центра. Прыжок ≤14,99 св.л.;
            опоры через 480–490 св.л.; отклонение от окружности — в пределах выбранного допуска.
            Ключевые системы обязательны для маршрута. После поиска можно уточнить расчётные точки и найти строительные хабы.</p>
        </details>
        <div className="atlas-ring-section">
          <h4 className="atlas-ring-section-title">Область поиска</h4>

          <SystemSearchInput
            label="Начальная система"
            value={startSystem}
            disabled={busy}
            onChange={setStartSystem}
            onSubmit={() => { if (startSystem.trim() && !busy) search(); }}
            placeholder="Sol"
          />

          {previewMessage && <p className="atlas-ring-preview-status" role="status"><IconMapPin size={14} /><span>{previewMessage}</span></p>}

          <RangeNumberField
            id="ring-radius"
            label="Удаление от центра"
            min={RING_RADIUS_RANGE.min}
            max={RING_RADIUS_RANGE.max}
            step={RING_RADIUS_RANGE.step}
            value={ringRadius}
            onChange={setRingRadius}
            disabled={busy}
            hint="Радиус окружности кольца от центра расчёта."
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
            hint="Окно поиска опорной системы вокруг точки кольца."
          />

          <RangeNumberField
            id="ring-deviation"
            label="Допуск отклонения от окружности"
            min={DEVIATION_RANGE.min}
            max={DEVIATION_RANGE.max}
            step={DEVIATION_RANGE.step}
            value={deviationLimit}
            onChange={setDeviationLimit}
            disabled={busy}
            hint="Максимальное отклонение от идеальной окружности (по умолчанию 100 св.л.). Увеличение допускает больше реальных систем, уменьшение — ведёт к более правильной форме кольца."
          />

        </div>

        <RingGeometryControls
          centerSystem={centerSystem} onCenterChange={setCenterSystem}
          heightOffset={heightOffset} onHeightChange={setHeightOffset}
          tiltDegrees={tiltDegrees} onTiltChange={setTiltDegrees}
          tiltAxisDegrees={tiltAxisDegrees} onAxisChange={setTiltAxisDegrees}
          disabled={busy}
        />

        {/* Ключевые системы — обязательные точки маршрута */}
        <div className="atlas-search-field atlas-ring-section">
          <label>Ключевые системы (через них пройдёт маршрут)</label>
          <div className="atlas-key-systems">
            {keySystems.map((ks) => (
              <span key={ks.name} className="atlas-key-chip">
                <IconMapPin size={10} /> {ks.name}
                <button type="button" onClick={() => removeKeySystem(ks.name)} aria-label="Удалить">×</button>
              </span>
            ))}
          </div>
          <div className="atlas-key-chip-row">
            <SystemSearchInput
              label=""
              value={keySystemDraft}
              disabled={busy}
              onChange={setKeySystemDraft}
              onSubmit={() => { if (keySystemDraft.trim()) void addKeySystem(keySystemDraft, 'main'); }}
              placeholder="Имя системы…"
              compact
            />
            <button
              type="button"
              className="atlas-secondary-btn"
              onClick={() => { if (keySystemDraft.trim()) void addKeySystem(keySystemDraft, 'main'); }}
              disabled={busy || !keySystemDraft.trim()}
              title="Добавить ключевую систему"
            >
              <IconPlus size={12} /> Добавить
            </button>
          </div>
        </div>

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
              Ход поиска виден на 3D-карте: кольцо, луч текущего сегмента и найденные системы.
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

          {/* Инфографика уточнения */}
          <div className="atlas-refine-infograph">
            <div className={`atlas-infograph-cell ${hubsFoundCount > 0 ? 'ok' : ''}`}>
              <div className="num">{hubsFoundCount}</div>
              <div className="lbl">Хабов найдено</div>
            </div>
            <div className={`atlas-infograph-cell ${hubsMissingCount > 0 ? 'warn' : ''}`}>
              <div className="num">{hubsMissingCount}</div>
              <div className="lbl">Хабов не найдено</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{result.totals.triangulatedAnchors}</div>
              <div className="lbl">Триангулированных опор</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{result.totals.deviationMax}</div>
              <div className="lbl">Макс. отклонение, св.л</div>
            </div>
          </div>

          <div className="atlas-details-box">
            <div className="atlas-stat-grid">
              <div>Расчётных опор</div><div>{result.totals.triangulatedAnchors} из {result.totals.anchors}</div>
              <div>Сегментов с расчётом</div><div>{result.stats.triangulatedSegments ?? '—'}</div>
              <div>Среднее отклонение</div><div>{result.totals.deviationAvg} св.л.</div>
              <div>Допуск отклонения</div><div>{result.deviationLimit} св.л.</div>
              <div>Ключевых систем</div><div>{result.keySystems.length}</div>
              <div>Систем из каталога Spansh</div><div>{result.stats.catalogHits.toLocaleString('ru-RU')}</div>
              <div>Систем из кэша Atlas</div><div>{result.stats.cacheHits.toLocaleString('ru-RU')}</div>
              <div>Запросов к EDSM</div><div>{result.stats.edsmRequests.toLocaleString('ru-RU')}</div>
              <div>Запросов к Spansh</div><div>{result.stats.spanshRequests.toLocaleString('ru-RU')}</div>
              <div>Сохранено в кэш проекта</div><div>{result.stats.systemsSaved.toLocaleString('ru-RU')}</div>
            </div>
          </div>

          {result.validation && <RingValidationPanel validation={result.validation} />}

          <div className="atlas-button-row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="atlas-secondary-btn" onClick={() => void refine()} disabled={busy || result.totals.syntheticPoints === 0}>
              {refining ? 'Уточнение…' : 'Заменить расчётные точки реальными системами'}
            </button>
            <button type="button" className="atlas-secondary-btn" onClick={openRefineModal} disabled={busy}>
              <IconSettings size={12} /> Уточнить с параметрами / Повторный прогон
            </button>
            <button type="button" className="atlas-secondary-btn" onClick={() => void searchHubs()} disabled={busy || searchingHubs}>
              <IconBuilding size={12} /> {searchingHubs ? 'Поиск хабов…' : 'Найти строительные хабы'}
            </button>
          </div>

          {/* Сохранение */}
          <div className="atlas-details-box atlas-save-box">
            <h4>Сохранить найденное кольцо</h4>
            <p className="atlas-muted">
              Кольцо остаётся на 3D-карте, пока вы его не уберёте. Ниже — сохранение в проект и выгрузка файлом.
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
              <button type="button" className="atlas-scan-btn" onClick={() => void saveToProject()} disabled={saving || !saveProjectId}>
                {saving ? 'Сохраняем…' : 'Сохранить в проект'}
              </button>
              <button type="button" className="atlas-secondary-btn" onClick={exportRingCsv}>
                <IconDownload size={12} /> Скачать CSV
              </button>
              <button type="button" className="atlas-secondary-btn" onClick={() => void copyRoute()}>
                <IconCopy size={12} /> Копировать
              </button>
              <button type="button" className="atlas-link-btn" onClick={() => clearAtlasSearchResult()}>
                Убрать с карты
              </button>
            </div>

            {saveSummary && <p className="atlas-save-summary">{saveSummary}</p>}
          </div>

          {/* Список точек */}
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
            {filteredRoute.slice(0, 300).map((point, index) => {
              const hub = result.hubs?.find((h) => h.anchorName === point.name);
              return (
                <div key={`${point.name}-${index}`} className="route-row">
                  <span className="route-idx">{index + 1}</span>
                  <span className="route-name">
                    {point.name}
                    {point.isAnchor && <span className="atlas-tag orange">опора</span>}
                    {point.source === 'triangulated' && <span className="atlas-tag">расчётная</span>}
                    {hub?.hub.status === 'found' && <span className="atlas-tag atlas-hub-ok">хаб: {hub.hub.systemName}</span>}
                    {hub?.hub.status === 'missing' && <span className="atlas-tag atlas-hub-bad">хаб не найден</span>}
                  </span>
                  <span className="route-coords">{formatCoordinates(point)}</span>
                </div>
              );
            })}
            {filteredRoute.length > 300 && <p className="atlas-muted">Показаны первые 300 точек — полный список в CSV.</p>}
          </div>
        </div>
      )}

      {/* ── Модалка повторного прогона / уточнения ── */}
      {refineModalOpen && (
        <AtlasDialog
          eyebrow="Уточнение и повторный прогон"
          title="Параметры перестроения кольца"
          onClose={() => { if (!refining) setRefineModalOpen(false); }}
          busy={refining}
          wide
        >
          <p>
            Здесь можно изменить допуск отклонения, радиус уточнения, добавить
            ключевые точки и перезапустить построение. Триангулированные участки
            перестроятся с учётом новых параметров.
          </p>

          <RangeNumberField
            id="refine-deviation"
            label="Новый допуск отклонения, св.л."
            min={DEVIATION_RANGE.min}
            max={DEVIATION_RANGE.max}
            step={DEVIATION_RANGE.step}
            value={refineDeviation}
            onChange={setRefineDeviation}
            disabled={refining}
            hint="Больше допуск — больше реальных систем попадает в опоры; меньше — кольцо ближе к идеальной окружности."
          />

          <RangeNumberField
            id="refine-radius"
            label="Радиус замены расчётных точек, св.л."
            min={10}
            max={120}
            step={5}
            value={refineRadius}
            onChange={setRefineRadius}
            disabled={refining}
            hint="На каком расстоянии искать реальную систему взамен триангулированной."
          />

          <div className="atlas-search-field">
            <label>Дополнительные ключевые системы</label>
            <div className="atlas-key-systems">
              {refineExtraKeys.map((ks) => (
                <span key={ks.name} className="atlas-key-chip">
                  <IconMapPin size={10} /> {ks.name}
                  <button type="button" onClick={() => removeRefineKey(ks.name)}>×</button>
                </span>
              ))}
            </div>
            <div className="atlas-key-chip-row">
              <SystemSearchInput
                label=""
                value={refineKeyDraft}
                onChange={setRefineKeyDraft}
                onSubmit={() => { if (refineKeyDraft.trim()) void addKeySystem(refineKeyDraft, 'refine'); }}
                placeholder="Имя системы…"
                compact
              />
              <button
                type="button"
                className="atlas-secondary-btn"
                onClick={() => { if (refineKeyDraft.trim()) void addKeySystem(refineKeyDraft, 'refine'); }}
                disabled={refining || !refineKeyDraft.trim()}
              >
                <IconPlus size={12} /> Добавить
              </button>
            </div>
          </div>

          <div className="atlas-refine-infograph">
            <div className="atlas-infograph-cell"><div className="num">{result?.totals.syntheticPoints ?? 0}</div><div className="lbl">Расчётных точек сейчас</div></div>
            <div className="atlas-infograph-cell"><div className="num">{result?.totals.triangulatedAnchors ?? 0}</div><div className="lbl">Триангулированных опор</div></div>
            <div className="atlas-infograph-cell"><div className="num">{refineDeviation}</div><div className="lbl">Новый допуск</div></div>
            <div className="atlas-infograph-cell"><div className="num">{refineExtraKeys.length}</div><div className="lbl">Добавлено ключей</div></div>
          </div>

          {refineLog.length > 0 && (
            <div className="atlas-refine-log">
              {refineLog.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}

          <div className="atlas-modal-footer">
            <button type="button" className="atlas-link-btn" onClick={() => setRefineModalOpen(false)} disabled={refining}>
              Закрыть
            </button>
            <button type="button" className="atlas-secondary-btn" onClick={() => void refine({ anchors: true, deviation: refineDeviation, radius: refineRadius })} disabled={refining}>
              <IconRefresh size={12} /> Уточнить точки (без перезапуска)
            </button>
            <button type="button" className="atlas-scan-btn" onClick={() => void rerun()} disabled={refining}>
              <IconRefresh size={12} /> Перестроить кольцо
            </button>
          </div>
        </AtlasDialog>
      )}

      {/* ── Модалка поиска хабов ── */}
      {hubsModalOpen && result && (
        <AtlasDialog
          eyebrow="Строительные хабы"
          title="Поиск кандидатов на хабы (радиус 14.99 св.л)"
          onClose={() => { if (!searchingHubs) { stopHubSearch(); setHubsModalOpen(false); } }}
          busy={searchingHubs}
          wide
        >
          <p>
            Поиск каменистых тел с возможностью посадки в радиусе 14.99 св.л от каждой
            опорной точки. Зелёная метка — кандидат найден; красная — в известных
            системах подходящего тела нет (требуется разведка региона).
            Источники: кэш Atlas, БД проекта, Spansh, EDSM.
          </p>

          <div className="atlas-refine-infograph">
            <div className="atlas-infograph-cell ok">
              <div className="num">
                <IconCheckCircle size={14} /> {hubProgress.found}
              </div>
              <div className="lbl">Хабов найдено</div>
            </div>
            <div className="atlas-infograph-cell warn">
              <div className="num">
                <IconAlert size={14} /> {hubProgress.missing}
              </div>
              <div className="lbl">Хабов не найдено</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{hubProgress.done}/{hubProgress.total}</div>
              <div className="lbl">Опор обработано</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{searchingHubs ? '…' : Math.round((hubProgress.done / Math.max(1, hubProgress.total)) * 100) + '%'}</div>
              <div className="lbl">Прогресс</div>
            </div>
          </div>

          {searchingHubs && (
            <div className="atlas-progress-bar-mini">
              <div style={{ width: `${Math.round((hubProgress.done / Math.max(1, hubProgress.total)) * 100)}%` }} />
            </div>
          )}

          <div className="atlas-hubs-list">
            {hubs.map((h, i) => {
              if (!h || !h.hub) return null;
              return (
              <div key={`${h.anchorName}-${i}`} className="atlas-hub-row">
                <span className={`atlas-hub-dot ${h.hub.status === 'found' ? 'found' : h.hub.status === 'missing' ? 'missing' : 'searching'}`} />
                <span className="atlas-hub-name">{h.anchorName}</span>
                <span className="atlas-hub-meta">
                  {h.hub.status === 'found' && <>→ <strong className="atlas-hub-ok">{h.hub.systemName}</strong> ({h.hub.distance} св.л; {h.hub.bodySubtype || h.hub.bodyName})</>}
                  {h.hub.status === 'missing' && <span className="atlas-hub-bad">хаб не найден{h.hub.note ? `: ${h.hub.note}` : ''}</span>}
                  {h.hub.status === 'searching' && 'поиск…'}
                  {h.hub.status === 'error' && 'ошибка'}
                </span>
              </div>
              );
            })}
          </div>

          <div className="atlas-modal-footer">
            {searchingHubs && (
              <button type="button" className="atlas-link-btn" onClick={stopHubSearch}>Остановить</button>
            )}
            <button type="button" className="atlas-scan-btn" onClick={() => setHubsModalOpen(false)} disabled={searchingHubs}>
              Закрыть
            </button>
          </div>
        </AtlasDialog>
      )}
    </div>
  );
}

/** Панель проверки требований. */
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
          + `точки маршрута: макс. ${v.routeDeviationMax}`,
      )}
      {v.startOffset > RING_LIMITS.deviation && (
        <p className="atlas-muted">
          Стартовая система на {v.startOffset.toLocaleString('ru-RU')} св.л. от окружности кольца:
          подход к ней и возврат идут отдельным участком.
        </p>
      )}
    </div>
  );
}
