'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
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
  const { t, locale } = useI18n();
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
    finishAtlasSearchProgress({ message: t('atlas.ui.ringStoppedByUser') });
    toast(t('atlas.ui.ringStopped'), 'info');
  }, [t]);

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
        title: t('atlas.ui.ringOverlaySearch'),
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
          [t('atlas.ui.counterSegment')]: `${patch.percent > 0 ? session.sectors_done : 0}/${session.sectors}`,
          [t('atlas.ui.counterRealAnchors')]: patch.stats?.realAnchors ?? 0,
          [t('atlas.ui.counterTriAnchors')]: patch.stats?.triangulatedAnchors ?? 0,
          [t('atlas.ui.counterSystemsFound')]: patch.stats?.systemsFound ?? 0,
          ...(patch.hubs ? { [t('atlas.ui.counterHubsFound')]: patch.hubs.filter(h => h?.hub?.status === 'found').length } : {}),
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
        label: t('atlas.ui.ringKeySystemLabel'),
      });
    }
    for (const anchor of patch.anchors || []) {
      // Если есть данные по хабам — цвет зависит от статуса.
      const hub = patch.hubs?.find((h) => h?.anchorName === anchor.name && h.hub);
      const kind: AtlasSearchPoint['kind'] = anchor.source === 'triangulated'
        ? 'triangulated'
        : (hub ? (hub.hub.status === 'found' ? 'hub-found' : hub.hub.status === 'missing' ? 'hub-missing' : 'anchor') : 'anchor');
      const label = hub?.hub?.status === 'found'
        ? t('atlas.ui.ringHubPointLabel', { system: hub.hub.systemName ?? '', distance: hub.hub.distance ?? '' })
        : hub?.hub?.status === 'missing'
          ? t('atlas.ui.ringHubMissingPoint')
          : t('atlas.ui.ringAnchorPointLabel', { value: Number(anchor.deviation || 0).toFixed(1) });
      points.push({ name: anchor.name, x: anchor.x, y: anchor.y, z: anchor.z, kind, label });
    }
    // Хабы — отдельные зелёные точки.
    for (const h of patch.hubs || []) {
      if (h?.hub?.status === 'found' && h.hub.x != null && h.hub.y != null && h.hub.z != null) {
        points.push({
          name: h.hub.systemName || 'Hub',
          x: h.hub.x, y: h.hub.y, z: h.hub.z,
          kind: 'hub-found',
          label: t('atlas.ui.ringHubCandidateLabel', { system: h.hub.systemName ?? '' }),
        });
      }
    }
    for (const system of patch.found || []) {
      points.push({
        name: system.name,
        x: system.x, y: system.y, z: system.z,
        kind: 'system',
        label: t('atlas.ui.ringSourceLabel', { source: system.source || t('atlas.ui.ringSourceCatalog') }),
      });
    }
    if (points.length > 0) publishAtlasSearchPoints(points);
  }, [t]);

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
          percent: 100, stage: 'done', message: t('atlas.ui.ringDone'),
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
        throw new Error(t('atlas.ui.ringErrTimeout', { status: res.status }));
      }
      throw new Error(data.error || t('atlas.ui.ringErrStep', { status: res.status }));
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
  }, [t]);

  const postRingFinalize = useCallback(async (sessionId: string, controller: AbortController) => {
    let lastMessage = t('atlas.ui.ringFinalizeFailed');
    for (let attempt = 1; attempt <= FINALIZE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        publishAtlasSearchProgress({
          stage: 'route',
          percent: 99,
          message: t('atlas.ui.ringFinalizeRetry', { attempt, total: FINALIZE_ATTEMPTS }),
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
        lastMessage = t('atlas.ui.ringFinalizeNetwork');
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.result?.route) && data.result.route.length > 1) {
        return data as { result: RingResult };
      }
      const statusHint = res.status ? `HTTP ${res.status}` : t('atlas.ui.ringNoResponse');
      lastMessage = data.error
        || t('atlas.ui.ringFinalizeHttp', { hint: statusHint });
      if (res.status === 400) break;
    }
    throw new Error(lastMessage);
  }, [t]);

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
    setProgress({ ...EMPTY_PROGRESS, stage: 'coords', message: resumeSessionId ? t('atlas.ui.ringResumeMessage') : t('atlas.ui.ringCoordsMessage') });
    startAtlasSearchProgress({
      kind: 'ring',
      title: t('atlas.ui.ringOverlaySearch'),
      stage: 'coords',
      percent: 0,
      message: resumeSessionId ? t('atlas.ui.ringResumeMessage') : t('atlas.ui.ringCoordsMessage'),
      counters: {},
    });
    // Ключевые системы с известными координатами — сразу на карту (те, что ещё
    // не разрешены, сервер подтянет после первого шага).
    const knownKeys = keySystems.filter((ks) => Number.isFinite(ks.x) && (ks.x !== 0 || ks.z !== 0 || ks.y !== 0));
    if (knownKeys.length > 0) {
      publishAtlasSearchPoints(knownKeys.map((ks) => ({
        name: ks.name, x: ks.x, y: ks.y, z: ks.z, kind: 'key-system' as const, label: t('atlas.ui.ringKeySystem'),
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
          message: step.step?.progress?.message || t('atlas.ui.ringScanningSegments'),
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
          message: step.step?.progress?.message || t('atlas.ui.ringScanningSegments'),
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
        message: t('atlas.ui.ringSegmentsDone'),
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
        message: t('atlas.ui.ringAssembled', { points: totals.points, synthetic: totals.syntheticPoints }),
      }));
      finishAtlasSearchProgress({
        stage: 'done',
        percent: 100,
        message: t('atlas.ui.ringAssembledShort', { points: totals.points }),
        summary: t('atlas.ui.ringSummary', { real: totals.realPoints.toLocaleString(locale), synthetic: totals.syntheticPoints.toLocaleString(locale), saved: finalized.result.stats.systemsSaved.toLocaleString(locale) }),
        counters: {
          [t('atlas.ui.counterRoutePoints')]: totals.points,
          [t('atlas.ui.counterSyntheticPoints')]: totals.syntheticPoints,
          [t('atlas.ui.counterAnchorSystems')]: totals.anchors,
        },
      });
      toast(
        t('atlas.ui.ringBuiltToast', { points: totals.points, synthetic: totals.syntheticPoints }),
        'success',
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : t('atlas.ui.ringSearchError');
      const last = lastSessionRef.current;
      if (last) setResumable({ sessionId: last.sessionId, sectorsDone: last.sectorsDone, sectors: last.sectors });
      finishAtlasSearchProgress({ message: t('atlas.ui.ringInterrupted', { message }) });
      toast(message, 'error');
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [applyResult, geometryKey, centerSystem, deviationLimit, heightOffset, keySystems, locale, postRing, postRingFinalize, publishToMap, ringRadius, searchRadius, startSystem, t, tiltDegrees, tiltAxisDegrees]);

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
    setRefineLog([`[${new Date().toLocaleTimeString(locale)}] ${t('atlas.ui.refineStartLog')}`]);
    publishAtlasSearchProgress({
      active: true,
      kind: 'ring',
      title: t('atlas.ui.ringRefineOverlay'),
      stage: 'refine',
      percent: 5,
      message: t('atlas.ui.refineMessage'),
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
      if (!res.ok) throw new Error(data.error || t('atlas.ui.refineFailed'));
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
      const replacedText = t('atlas.ui.refineReplaced', { count: data.replacements }) + (data.anchor_replacements ? t('atlas.ui.refineReplacedAnchors', { count: data.anchor_replacements }) : '');
      setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString(locale)}] ${t('atlas.ui.refineDoneLog', { text: replacedText, left: data.synthetic_points })}`]);
      publishAtlasSearchProgress({ percent: 100, stage: 'done' });
      finishAtlasSearchProgress({
        message: t('atlas.ui.refineDoneMessage', { text: replacedText }),
        summary: t('atlas.ui.refineLeft', { count: data.synthetic_points }),
      });
      toast(t('atlas.ui.refineToast', { text: replacedText }), 'success');
    } catch (error) {
      setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString(locale)}] ${t('atlas.ui.logError', { message: error instanceof Error ? error.message : t('atlas.ui.unknownError') })}`]);
      finishAtlasSearchProgress({ message: t('atlas.ui.refineAborted') });
      toast(error instanceof Error ? error.message : t('atlas.ui.refineRunError'), 'error');
    } finally {
      setRefining(false);
    }
  }, [applyResult, locale, refineDeviation, refineRadius, refining, result, t]);

  /** Повторный прогон с новыми параметрами (через replan API). */
  const rerun = useCallback(async () => {
    if (!result || loading) return;
    const sessionId = result.sessionId || sessionRef.current;
    if (!sessionId) {
      toast(t('atlas.ui.noActiveSession'), 'error');
      return;
    }
    setRefining(true);
    setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString(locale)}] ${t('atlas.ui.sessionResetLog')}`]);
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
      if (!res.ok) throw new Error(data.error || t('atlas.ui.sessionResetFailed'));
      setRefineLog((log) => [...log, `[${new Date().toLocaleTimeString(locale)}] ${t('atlas.ui.sessionResetDone')}`]);
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
      toast(error instanceof Error ? error.message : t('atlas.ui.retryError'), 'error');
    }
  }, [keySystems, loading, refineDeviation, refineExtraKeys, result, runSearch, searchRadius, t]);

  /** Поиск хабов по опорным точкам (SSE-поток). */
  const searchHubs = useCallback(async () => {
    if (!result || searchingHubs) return;
    const anchors = result.anchors.filter((a) => a.name);
    if (anchors.length === 0) {
      toast(t('atlas.ui.noAnchors'), 'info');
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
      if (!res.ok || !res.body) throw new Error(t('atlas.ui.hubsStartFailed'));
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
                  percent: 100, stage: 'done', message: t('atlas.ui.hubsScanned'),
                  anchors: result.anchors as RingAnchor[],
                  keySystems: result.keySystems,
                  hubs: msg.results,
                },
              );
              toast(t('atlas.ui.hubsToast', { found: foundCount, missing: missingCount }), missingCount > 0 ? 'info' : 'success');
            } else if (msg.type === 'error') {
              toast(msg.message || t('atlas.ui.hubsError'), 'error');
            }
          } catch {/* ignore parse */}
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast(error instanceof Error ? error.message : t('atlas.ui.hubsError'), 'error');
    } finally {
      hubAbortRef.current = null;
      setSearchingHubs(false);
    }
  }, [publishToMap, result, searchingHubs, t]);

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
    toast(t('atlas.ui.ringCsvSaved'), 'success');
  };

  const saveToProject = useCallback(async () => {
    if (!result || saving) return;
    const projectId = Number(saveProjectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      toast(t('atlas.ui.pickProjectToSave'), 'info');
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
      if (!response.ok) throw new Error(data.error || t('atlas.ui.saveRingFailed'));
      const summary = t('atlas.ui.saveRingAdded', { count: data.added.toLocaleString(locale) })
        + (data.skipped_duplicate ? t('atlas.ui.saveRingExisting', { count: data.skipped_duplicate.toLocaleString(locale) }) : '')
        + (data.skipped_synthetic ? t('atlas.ui.saveRingSynthetic', { count: data.skipped_synthetic.toLocaleString(locale) }) : '');
      setSaveSummary(summary);
      toast(summary, 'success');
      onSavedToProject?.(projectId, Number(data.added) || 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('atlas.ui.saveRingError');
      setSaveSummary('');
      toast(message, 'error');
    } finally {
      setSaving(false);
    }
  }, [includeSynthetic, locale, onSavedToProject, result, saveProjectId, saving, t]);

  const copyRoute = async () => {
    if (!result) return;
    const text = result.route.map((point, index) => `${index + 1}. ${point.name} (${formatCoordinates(point, 2)})`).join('\n');
    const ok = await copyText(text);
    toast(ok ? t('atlas.ui.ringCopied') : t('atlas.ui.clipboardUnavailable'), ok ? 'success' : 'error');
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
        <h3>{t('atlas.ui.ringTitle')}</h3>
        <p className="atlas-route-desc">
          {t('atlas.ui.ringIntro')}
        </p>
        <details className="atlas-details atlas-ring-help">
          <summary>{t('atlas.ui.ringHelpTitle')}</summary>
          <p className="atlas-muted">{t('atlas.ui.ringHelpBody')}</p>
        </details>
        <div className="atlas-ring-section">
          <h4 className="atlas-ring-section-title">{t('atlas.ui.ringArea')}</h4>

          <SystemSearchInput
            label={t('atlas.ui.ringStartLabel')}
            value={startSystem}
            disabled={busy}
            onChange={setStartSystem}
            onSubmit={() => { if (startSystem.trim() && !busy) search(); }}
            placeholder="Sol"
          />

          {previewMessage && <p className="atlas-ring-preview-status" role="status"><IconMapPin size={14} /><span>{previewMessage}</span></p>}

          <RangeNumberField
            id="ring-radius"
            label={t('atlas.ui.ringRadiusField')}
            min={RING_RADIUS_RANGE.min}
            max={RING_RADIUS_RANGE.max}
            step={RING_RADIUS_RANGE.step}
            value={ringRadius}
            onChange={setRingRadius}
            disabled={busy}
            hint={t('atlas.ui.ringRadiusHint')}
          />

          <RangeNumberField
            id="ring-search-radius"
            label={t('atlas.ui.ringSearchRadiusField')}
            min={SEARCH_RADIUS_RANGE.min}
            max={SEARCH_RADIUS_RANGE.max}
            step={SEARCH_RADIUS_RANGE.step}
            value={searchRadius}
            onChange={setSearchRadius}
            disabled={busy}
            hint={t('atlas.ui.ringSearchRadiusHint')}
          />

          <RangeNumberField
            id="ring-deviation"
            label={t('atlas.ui.ringDeviationField')}
            min={DEVIATION_RANGE.min}
            max={DEVIATION_RANGE.max}
            step={DEVIATION_RANGE.step}
            value={deviationLimit}
            onChange={setDeviationLimit}
            disabled={busy}
            hint={t('atlas.ui.ringDeviationHint')}
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
          <label>{t('atlas.ui.ringKeySystems')}</label>
          <div className="atlas-key-systems">
            {keySystems.map((ks) => (
              <span key={ks.name} className="atlas-key-chip">
                <IconMapPin size={10} /> {ks.name}
                <button type="button" onClick={() => removeKeySystem(ks.name)} aria-label={t('atlas.ui.delete')}>×</button>
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
              placeholder={t('atlas.ui.ringSystemPlaceholder')}
              compact
            />
            <button
              type="button"
              className="atlas-secondary-btn"
              onClick={() => { if (keySystemDraft.trim()) void addKeySystem(keySystemDraft, 'main'); }}
              disabled={busy || !keySystemDraft.trim()}
              title={t('atlas.ui.ringAddKeyTitle')}
            >
              <IconPlus size={12} /> {t('atlas.ui.add')}
            </button>
          </div>
        </div>

        <div className="atlas-button-row">
          <button type="button" className="atlas-scan-btn" onClick={search} disabled={busy || !startSystem.trim()}>
            {loading ? t('atlas.ui.ringSearchingSystems') : t('atlas.ui.ringBuild')}
          </button>
          {busy && (
            <button type="button" className="atlas-stop-btn" onClick={stop}>{t('atlas.ui.stop')}</button>
          )}
        </div>

        {loading && (
          <div className="atlas-progress" aria-live="polite">
            <div className="atlas-progress-head">
              <span>{progress.message || t('atlas.ui.ringPreparing')}</span>
              <strong>{Math.round(progress.percent)}%</strong>
            </div>
            <div className="atlas-progress-bar">
              <div style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
            </div>
            <div className="atlas-progress-meta">
              {t('atlas.ui.ringProgressMeta', { done: progress.sectorsDone, total: progress.sectors, real: progress.realAnchors, tri: progress.triangulatedAnchors, found: progress.systemsFound })}
            </div>
            <p className="atlas-muted">
              {t('atlas.ui.ringProgressHint')}
            </p>
          </div>
        )}

        {resumable && !busy && (
          <div className="atlas-resume-box">
            <p>
              {t('atlas.ui.ringResumeText', { done: resumable.sectorsDone, total: resumable.sectors })}
            </p>
            <div className="atlas-button-row">
              <button type="button" className="atlas-secondary-btn" onClick={resume}>{t('atlas.ui.ringResumeBtn')}</button>
              <button type="button" className="atlas-link-btn" onClick={search}>{t('atlas.ui.ringRestartBtn')}</button>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="atlas-section">
          <div className="atlas-section-head">
            <h4>{t('atlas.ui.ringResultTitle')}</h4>
            <div className="atlas-section-actions">
              <button type="button" className="atlas-icon-btn" title={t('atlas.ui.ringCopyTitle')} onClick={() => void copyRoute()}>
                <IconCopy size={12} />
              </button>
              <button type="button" className="atlas-icon-btn" title={t('atlas.ui.downloadCsv')} onClick={exportRingCsv}>
                <IconDownload size={12} />
              </button>
            </div>
          </div>

          <div className="atlas-route-summary">
            <div className="stat-box"><div className="num">{result.totals.points.toLocaleString(locale)}</div><div className="lbl">{t('atlas.ui.counterRoutePoints')}</div></div>
            <div className="stat-box"><div className="num">{result.totals.anchors}</div><div className="lbl">{t('atlas.ui.counterAnchorSystems')}</div></div>
            <div className="stat-box"><div className="num">{result.totals.realPoints.toLocaleString(locale)}</div><div className="lbl">{t('atlas.ui.ringRealPoints')}</div></div>
            <div className="stat-box"><div className="num">{result.totals.syntheticPoints.toLocaleString(locale)}</div><div className="lbl">{t('atlas.ui.ringSyntheticShare', { value: syntheticShare })}</div></div>
          </div>

          {/* Инфографика уточнения */}
          <div className="atlas-refine-infograph">
            <div className={`atlas-infograph-cell ${hubsFoundCount > 0 ? 'ok' : ''}`}>
              <div className="num">{hubsFoundCount}</div>
              <div className="lbl">{t('atlas.ui.counterHubsFound')}</div>
            </div>
            <div className={`atlas-infograph-cell ${hubsMissingCount > 0 ? 'warn' : ''}`}>
              <div className="num">{hubsMissingCount}</div>
              <div className="lbl">{t('atlas.ui.ringHubsMissing')}</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{result.totals.triangulatedAnchors}</div>
              <div className="lbl">{t('atlas.ui.ringTriAnchors')}</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{result.totals.deviationMax}</div>
              <div className="lbl">{t('atlas.ui.ringDeviationMax')}</div>
            </div>
          </div>

          <div className="atlas-details-box">
            <div className="atlas-stat-grid">
              <div>{t('atlas.ui.ringTriAnchorsShort')}</div><div>{t('atlas.ui.ringOfTotal', { value: result.totals.triangulatedAnchors, total: result.totals.anchors })}</div>
              <div>{t('atlas.ui.ringTriSegments')}</div><div>{result.stats.triangulatedSegments ?? '—'}</div>
              <div>{t('atlas.ui.ringDeviationAvg')}</div><div>{t('atlas.ui.lightYears', { value: result.totals.deviationAvg })}</div>
              <div>{t('atlas.ui.ringDeviationLimit')}</div><div>{t('atlas.ui.lightYears', { value: result.deviationLimit })}</div>
              <div>{t('atlas.ui.ringKeySystemsCount')}</div><div>{result.keySystems.length}</div>
              <div>{t('atlas.ui.ringCatalogHits')}</div><div>{result.stats.catalogHits.toLocaleString(locale)}</div>
              <div>{t('atlas.ui.ringCacheHits')}</div><div>{result.stats.cacheHits.toLocaleString(locale)}</div>
              <div>{t('atlas.ui.ringEdsmRequests')}</div><div>{result.stats.edsmRequests.toLocaleString(locale)}</div>
              <div>{t('atlas.ui.ringSpanshRequests')}</div><div>{result.stats.spanshRequests.toLocaleString(locale)}</div>
              <div>{t('atlas.ui.ringSystemsSaved')}</div><div>{result.stats.systemsSaved.toLocaleString(locale)}</div>
            </div>
          </div>

          {result.validation && <RingValidationPanel validation={result.validation} />}

          <div className="atlas-button-row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="atlas-secondary-btn" onClick={() => void refine()} disabled={busy || result.totals.syntheticPoints === 0}>
              {refining ? t('atlas.ui.ringRefining') : t('atlas.ui.ringRefineBtn')}
            </button>
            <button type="button" className="atlas-secondary-btn" onClick={openRefineModal} disabled={busy}>
              <IconSettings size={12} /> {t('atlas.ui.ringRefineWithParams')}
            </button>
            <button type="button" className="atlas-secondary-btn" onClick={() => void searchHubs()} disabled={busy || searchingHubs}>
              <IconBuilding size={12} /> {searchingHubs ? t('atlas.ui.ringHubsSearching') : t('atlas.ui.ringFindHubs')}
            </button>
          </div>

          {/* Сохранение */}
          <div className="atlas-details-box atlas-save-box">
            <h4>{t('atlas.ui.ringSaveTitle')}</h4>
            <p className="atlas-muted">{t('atlas.ui.ringSaveHint')}</p>

            <div className="atlas-project-select">
              <label htmlFor="ring-save-project">{t('atlas.ui.ringProjectLabel')}</label>
              <select
                id="ring-save-project"
                value={saveProjectId}
                onChange={(event) => setSaveProjectId(event.target.value)}
                disabled={saving}
              >
                <option value="">{projects.length > 0 ? t('atlas.pickProject') : t('atlas.ui.noProjects')}</option>
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
              {t('atlas.ui.ringIncludeSynthetic', { count: result.totals.syntheticPoints.toLocaleString(locale) })}
            </label>

            <div className="atlas-button-row">
              <button type="button" className="atlas-scan-btn" onClick={() => void saveToProject()} disabled={saving || !saveProjectId}>
                {saving ? t('atlas.ui.ringSaving') : t('atlas.ui.saveToProject')}
              </button>
              <button type="button" className="atlas-secondary-btn" onClick={exportRingCsv}>
                <IconDownload size={12} /> {t('atlas.ui.downloadCsv')}
              </button>
              <button type="button" className="atlas-secondary-btn" onClick={() => void copyRoute()}>
                <IconCopy size={12} /> {t('atlas.ui.ringCopyText')}
              </button>
              <button type="button" className="atlas-link-btn" onClick={() => clearAtlasSearchResult()}>
                {t('atlas.ui.ringClearMap')}
              </button>
            </div>

            {saveSummary && <p className="atlas-save-summary">{saveSummary}</p>}
          </div>

          {/* Список точек */}
          <div className="atlas-section-head">
            <h4>{t('atlas.ui.ringPointsTitle')}</h4>
            <div className="atlas-inline-search compact">
              <IconSearch size={12} />
              <input
                type="search"
                value={routeFilter}
                onChange={(event) => setRouteFilter(event.target.value)}
                placeholder={t('atlas.ui.ringFindPoint')}
                aria-label={t('atlas.ui.ringPointsFilterAria')}
              />
              {routeFilter && (
                <button type="button" onClick={() => setRouteFilter('')} aria-label={t('atlas.clearFilter')}>
                  <IconX size={11} />
                </button>
              )}
            </div>
          </div>
          <p className="atlas-list-counter">{t('atlas.shownOf', { shown: Math.min(300, filteredRoute.length), total: filteredRoute.length })}</p>
          <div className="atlas-route-list">
            {filteredRoute.length === 0 && <p className="atlas-muted">{t('atlas.ui.ringNoPoints')}</p>}
            {filteredRoute.slice(0, 300).map((point, index) => {
              const hub = result.hubs?.find((h) => h.anchorName === point.name);
              return (
                <div key={`${point.name}-${index}`} className="route-row">
                  <span className="route-idx">{index + 1}</span>
                  <span className="route-name">
                    {point.name}
                    {point.isAnchor && <span className="atlas-tag orange">{t('atlas.ui.ringTagAnchor')}</span>}
                    {point.source === 'triangulated' && <span className="atlas-tag">{t('atlas.ui.ringTagSynthetic')}</span>}
                    {hub?.hub.status === 'found' && <span className="atlas-tag atlas-hub-ok">{t('atlas.ui.ringTagHub', { system: hub.hub.systemName ?? '' })}</span>}
                    {hub?.hub.status === 'missing' && <span className="atlas-tag atlas-hub-bad">{t('atlas.ui.ringTagHubMissing')}</span>}
                  </span>
                  <span className="route-coords">{formatCoordinates(point)}</span>
                </div>
              );
            })}
            {filteredRoute.length > 300 && <p className="atlas-muted">{t('atlas.ui.ringPointsLimit')}</p>}
          </div>
        </div>
      )}

      {/* ── Модалка повторного прогона / уточнения ── */}
      {refineModalOpen && (
        <AtlasDialog
          eyebrow={t('atlas.ui.ringRefineEyebrow')}
          title={t('atlas.ui.ringRefineTitle')}
          onClose={() => { if (!refining) setRefineModalOpen(false); }}
          busy={refining}
          wide
        >
          <p>{t('atlas.ui.ringRefineIntro')}</p>

          <RangeNumberField
            id="refine-deviation"
            label={t('atlas.ui.ringNewDeviation')}
            min={DEVIATION_RANGE.min}
            max={DEVIATION_RANGE.max}
            step={DEVIATION_RANGE.step}
            value={refineDeviation}
            onChange={setRefineDeviation}
            disabled={refining}
            hint={t('atlas.ui.ringNewDeviationHint')}
          />

          <RangeNumberField
            id="refine-radius"
            label={t('atlas.ui.ringRefineRadius')}
            min={10}
            max={120}
            step={5}
            value={refineRadius}
            onChange={setRefineRadius}
            disabled={refining}
            hint={t('atlas.ui.ringRefineRadiusHint')}
          />

          <div className="atlas-search-field">
            <label>{t('atlas.ui.ringExtraKeys')}</label>
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
                placeholder={t('atlas.ui.ringSystemPlaceholder')}
                compact
              />
              <button
                type="button"
                className="atlas-secondary-btn"
                onClick={() => { if (refineKeyDraft.trim()) void addKeySystem(refineKeyDraft, 'refine'); }}
                disabled={refining || !refineKeyDraft.trim()}
              >
                <IconPlus size={12} /> {t('atlas.ui.add')}
              </button>
            </div>
          </div>

          <div className="atlas-refine-infograph">
            <div className="atlas-infograph-cell"><div className="num">{result?.totals.syntheticPoints ?? 0}</div><div className="lbl">{t('atlas.ui.ringSyntheticNow')}</div></div>
            <div className="atlas-infograph-cell"><div className="num">{result?.totals.triangulatedAnchors ?? 0}</div><div className="lbl">{t('atlas.ui.ringTriAnchors')}</div></div>
            <div className="atlas-infograph-cell"><div className="num">{refineDeviation}</div><div className="lbl">{t('atlas.ui.ringNewTolerance')}</div></div>
            <div className="atlas-infograph-cell"><div className="num">{refineExtraKeys.length}</div><div className="lbl">{t('atlas.ui.ringKeysAdded')}</div></div>
          </div>

          {refineLog.length > 0 && (
            <div className="atlas-refine-log">
              {refineLog.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}

          <div className="atlas-modal-footer">
            <button type="button" className="atlas-link-btn" onClick={() => setRefineModalOpen(false)} disabled={refining}>
              {t('atlas.ui.close')}
            </button>
            <button type="button" className="atlas-secondary-btn" onClick={() => void refine({ anchors: true, deviation: refineDeviation, radius: refineRadius })} disabled={refining}>
              <IconRefresh size={12} /> {t('atlas.ui.ringRefinePoints')}
            </button>
            <button type="button" className="atlas-scan-btn" onClick={() => void rerun()} disabled={refining}>
              <IconRefresh size={12} /> {t('atlas.ui.ringRebuild')}
            </button>
          </div>
        </AtlasDialog>
      )}

      {/* ── Модалка поиска хабов ── */}
      {hubsModalOpen && result && (
        <AtlasDialog
          eyebrow={t('atlas.ui.ringHubsEyebrow')}
          title={t('atlas.ui.ringHubsTitle')}
          onClose={() => { if (!searchingHubs) { stopHubSearch(); setHubsModalOpen(false); } }}
          busy={searchingHubs}
          wide
        >
          <p>{t('atlas.ui.ringHubsIntro')}</p>

          <div className="atlas-refine-infograph">
            <div className="atlas-infograph-cell ok">
              <div className="num">
                <IconCheckCircle size={14} /> {hubProgress.found}
              </div>
              <div className="lbl">{t('atlas.ui.counterHubsFound')}</div>
            </div>
            <div className="atlas-infograph-cell warn">
              <div className="num">
                <IconAlert size={14} /> {hubProgress.missing}
              </div>
              <div className="lbl">{t('atlas.ui.ringHubsMissing')}</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{hubProgress.done}/{hubProgress.total}</div>
              <div className="lbl">{t('atlas.ui.ringAnchorsProcessed')}</div>
            </div>
            <div className="atlas-infograph-cell">
              <div className="num">{searchingHubs ? '…' : Math.round((hubProgress.done / Math.max(1, hubProgress.total)) * 100) + '%'}</div>
              <div className="lbl">{t('atlas.ui.ringProgressLbl')}</div>
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
                  {h.hub.status === 'found' && <>→ <strong className="atlas-hub-ok">{h.hub.systemName}</strong> ({t('atlas.ui.ringHubFoundLine', { distance: h.hub.distance ?? '', body: h.hub.bodySubtype || h.hub.bodyName || '' })})</>}
                  {h.hub.status === 'missing' && <span className="atlas-hub-bad">{t('atlas.ui.ringTagHubMissing')}{h.hub.note ? `: ${h.hub.note}` : ''}</span>}
                  {h.hub.status === 'searching' && t('atlas.ui.ringHubSearching')}
                  {h.hub.status === 'error' && t('atlas.ui.ringHubError')}
                </span>
              </div>
              );
            })}
          </div>

          <div className="atlas-modal-footer">
            {searchingHubs && (
              <button type="button" className="atlas-link-btn" onClick={stopHubSearch}>{t('atlas.ui.ringHubStop')}</button>
            )}
            <button type="button" className="atlas-scan-btn" onClick={() => setHubsModalOpen(false)} disabled={searchingHubs}>
              {t('atlas.ui.close')}
            </button>
          </div>
        </AtlasDialog>
      )}
    </div>
  );
}

/** Панель проверки требований. */
function RingValidationPanel({ validation: v }: { validation: RingValidation }) {
  const { t, locale } = useI18n();
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
    <div className="atlas-details-box atlas-validation" aria-label={t('atlas.ui.ringValidationAria')}>
      <h4>{t('atlas.ui.ringValidationTitle')}</h4>
      {row(
        v.jumpViolations === 0,
        t('atlas.ui.ringValJump', { value: RING_LIMITS.jump }),
        t('atlas.ui.ringValJumpDetail', { value: v.maxJump.toFixed(2) }) + (v.jumpViolations ? t('atlas.ui.ringValJumpViolations', { count: v.jumpViolations }) : ''),
      )}
      {row(
        spacingOk,
        t('atlas.ui.ringValSpacing', { min: RING_LIMITS.spacingMin, max: RING_LIMITS.spacingMax, limit: RING_LIMITS.spacingLimit }),
        t('atlas.ui.ringValSpacingDetail', { min: v.anchorSpacingMin, max: v.anchorSpacingMax, avg: v.anchorSpacingAvg })
          + (v.anchorSpacingOutside ? t('atlas.ui.ringValSpacingOutside', { min: RING_LIMITS.spacingMin, max: RING_LIMITS.spacingMax, count: v.anchorSpacingOutside }) : ''),
      )}
      {row(
        v.anchorDeviationMax <= RING_LIMITS.deviation && v.deviationViolations === 0,
        t('atlas.ui.ringValDeviation', { value: RING_LIMITS.deviation }),
        t('atlas.ui.ringValDeviationDetail', { max: v.anchorDeviationMax, avg: v.anchorDeviationAvg, route: v.routeDeviationMax }),
      )}
      {v.startOffset > RING_LIMITS.deviation && (
        <p className="atlas-muted">{t('atlas.ui.ringValStartOffset', { value: v.startOffset.toLocaleString(locale) })}</p>
      )}
    </div>
  );
}
