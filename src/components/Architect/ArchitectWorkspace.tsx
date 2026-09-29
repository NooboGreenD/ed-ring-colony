'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataQualityPanel from '@/components/Architect/DataQualityPanel';
import ExistingPanel, { structureKey } from '@/components/Architect/ExistingPanel';
import InstallationPicker from '@/components/Architect/InstallationPicker';
import PlanInsights from '@/components/Architect/PlanInsights';
import PlanSummary from '@/components/Architect/PlanSummary';
import ProgressPanel from '@/components/Architect/ProgressPanel';
import SharePanel from '@/components/Architect/SharePanel';
import SiteEditor from '@/components/Architect/SiteEditor';
import SiteTable from '@/components/Architect/SiteTable';
import SourcingPanel from '@/components/Architect/SourcingPanel';
import SyncPanel from '@/components/Architect/SyncPanel';
import { CATALOGUE_VERSION, ECONOMY_LABELS_RU } from '@/lib/architect/catalogue';
import { bodyBoostedEconomies, economyBodyFit } from '@/lib/architect/economy';
import { SIGNAL_META, activeSignalKinds } from '@/lib/bodySignals';
import { buildBodyIndex, resolveBodyName } from '@/lib/architect/bodyNames';
import { parseSyncReport, type SyncSourceState, type SystemSyncReport } from '@/lib/architect/bodySync';
import { auditBodyRows, auditPlanData } from '@/lib/architect/dataQuality';
import { adoptExisting, type ExistingStructure } from '@/lib/architect/existing';
import {
  matchProgress,
  parseActualSites,
  type ActualSite,
  type ProgressReport,
  type SiteProgress,
} from '@/lib/architect/progress';
import type { PlanView } from '@/lib/architect/store';
import type { SitePatch } from '@/lib/architect/planner';
import {
  ORBITAL_SLOT_LIMIT,
  PLAN_FORMAT_VERSION,
  addSite,
  canBePrimary,
  createPlan,
  evaluatePlan,
  formatTons,
  fromScanRecords,
  getInstallation,
  orbitalLimit,
  parsePlan,
  placementCheck,
  planToStructures,
  predictSurfaceSlots,
  removeSite,
  serializePlan,
  setOrbitalSlots,
  setSitePrimary,
  setSiteStatus,
  siteCargo,
  summarizePlan,
  surfaceSlotReason,
  updateSite,
} from '@/lib/architect/planner';
import type { ArchitectBody, ArchitectPlan, PlannedSite, PlannedSiteStatus } from '@/lib/architect/types';

const SystemOrrery3D = dynamic(() => import('@/components/SystemMap/SystemOrrery3D'), { ssr: false });

const PLAN_PREFIX = 'ed-architect:plan:';
const RECENT_KEY = 'ed-architect:recent';
const STATUS_ORDER: PlannedSiteStatus[] = ['plan', 'building', 'complete'];
const STATUS_LABELS: Record<PlannedSiteStatus, string> = { plan: 'план', building: 'строится', complete: 'готово' };
const STATUS_TONES: Record<PlannedSiteStatus, string> = { plan: 'var(--muted)', building: 'var(--cyan)', complete: 'var(--green)' };
const KIND_LABELS: Record<ArchitectBody['kind'], string> = { star: 'звезда', planet: 'планета', moon: 'луна' };

type BodySort = 'distance' | 'slots' | 'structures';
type BodyFilter = 'all' | 'planned' | 'slots' | 'issues';
type PickerLocation = 'any' | 'surface' | 'orbital';
/** Как смотреть на план: карточки тел, плоская таблица или инфографика. */
type WorkspaceView = 'bodies' | 'table' | 'insights';

const BODY_SORT_LABELS: Record<BodySort, string> = { distance: 'по расстоянию', slots: 'по свободным слотам', structures: 'по постройкам' };
const BODY_FILTER_LABELS: Record<BodyFilter, string> = { all: 'все', planned: 'с постройками', slots: 'есть слоты', issues: 'с ошибками' };
const VIEW_LABELS: Record<WorkspaceView, string> = { bodies: 'Тела', table: 'Таблица', insights: 'Аналитика' };

function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * Человеко-читаемое описание того, откуда взяты тела: при сверке (`compare`)
 * показывает разбивку база/EDSM/уточнено, иначе — старую короткую подпись.
 */
function describeSourceStats(
  source: string,
  stats: { database: number; edsm: number; spansh?: number; merged: number; total: number } | null,
): string {
  if (!stats || stats.total === 0) return source || '—';
  const parts: string[] = [];
  if (stats.database > 0) parts.push(`база: ${stats.database}`);
  if (stats.edsm > 0) parts.push(`EDSM: ${stats.edsm}`);
  if ((stats.spansh ?? 0) > 0) parts.push(`Spansh: ${stats.spansh}`);
  if (stats.merged > 0) parts.push(`уточнено: ${stats.merged}`);
  return `сверка источников (${parts.join(', ')})`;
}

function writeRecent(system: string) {
  if (typeof window === 'undefined') return;
  const next = [system, ...readRecent().filter((item) => item.toLowerCase() !== system.toLowerCase())].slice(0, 8);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

export default function ArchitectWorkspace() {
  const [systemInput, setSystemInput] = useState('');
  const [systemName, setSystemName] = useState('');
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [source, setSource] = useState('');
  /** Сколько тел взято из базы проекта / EDSM / уточнено сверкой обоих источников. */
  const [sourceStats, setSourceStats] = useState<{ database: number; edsm: number; spansh?: number; merged: number; total: number } | null>(null);
  /** Состояние сторонних источников тел — показывает панель «Источники данных». */
  const [syncReport, setSyncReport] = useState<SystemSyncReport | null>(null);
  /** Состояние источников фактической застройки (Raven, EDSM) от `ExistingPanel`. */
  const [existingSources, setExistingSources] = useState<SyncSourceState[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [plan, setPlan] = useState<ArchitectPlan | null>(null);
  const [pickerBody, setPickerBody] = useState<string>('');
  const [pickerLocation, setPickerLocation] = useState<PickerLocation>('any');
  const [showMap, setShowMap] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // Серверная копия плана: null — план пока только черновик в браузере.
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [actualSites, setActualSites] = useState<ActualSite[]>([]);
  const [progressFetched, setProgressFetched] = useState(false);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState('');
  const [progressSource, setProgressSource] = useState('');
  const [progressTelemetry, setProgressTelemetry] = useState<{ available: boolean; snapshots: number; latestAt: string | null } | null>(null);
  const [bodyQuery, setBodyQuery] = useState('');
  const [bodySort, setBodySort] = useState<BodySort>('distance');
  const [bodyFilter, setBodyFilter] = useState<BodyFilter>('all');
  const [collapsedBodies, setCollapsedBodies] = useState<string[]>([]);
  /** Редактируемая запись плана: null — модальное окно закрыто. */
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  /** Вид рабочей области: карточки тел, таблица плана или инфографика. */
  const [view, setView] = useState<WorkspaceView>('bodies');
  /** Записи, которых только что коснулся перенос факта, — подсвечиваются. */
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const bodies = useMemo<ArchitectBody[]>(() => fromScanRecords(rawRows, systemName), [rawRows, systemName]);
  const bodiesByName = useMemo(() => new Map(bodies.map((body) => [body.name, body])), [bodies]);
  /** Индекс имён тел: по нему постройки плана привязываются к карточкам. */
  const bodyIndex = useMemo(() => buildBodyIndex(bodies, systemName), [bodies, systemName]);
  const knownBodyNames = useMemo(() => new Set(bodies.map((body) => body.name)), [bodies]);

  /**
   * Постройки плана, разложенные по телам каталога.
   *
   * Раньше карточка тела фильтровала план строкой `site.bodyName === body.name`,
   * и запись с именем из стороннего источника («A 1» вместо «Sol A 1») нигде
   * не показывалась — перенос факта выглядел как «ничего не произошло».
   * Теперь имя приводится индексом, а всё, что не привязалось, честно
   * попадает в отдельную карточку «вне каталога тел».
   */
  const { sitesByBody, unassignedSites } = useMemo(() => {
    const map = new Map<string, PlannedSite[]>();
    const unassigned: PlannedSite[] = [];
    for (const site of plan?.sites ?? []) {
      const match = bodies.length > 0 ? resolveBodyName(site.bodyName, bodyIndex) : null;
      const target = match?.name || (bodies.length === 0 ? site.bodyName : '');
      if (!target) {
        unassigned.push(site);
        continue;
      }
      const list = map.get(target);
      if (list) list.push(site);
      else map.set(target, [site]);
    }
    return { sitesByBody: map, unassignedSites: unassigned };
  }, [plan, bodies, bodyIndex]);
  const evaluation = useMemo(
    () => (plan ? evaluatePlan(plan, bodies) : null),
    [plan, bodies],
  );
  const structures = useMemo(() => (plan ? planToStructures(plan) : []), [plan]);
  const editingSite = useMemo(
    () => plan?.sites.find((site) => site.id === editingSiteId) ?? null,
    [plan, editingSiteId],
  );

  /** Занятые наземные слоты по телам — для фильтра и сортировки списка. */
  const surfaceUsedByBody = useMemo(() => {
    const map = new Map<string, number>();
    for (const [bodyName, sites] of sitesByBody) {
      const used = sites.filter((site) => getInstallation(site.installationId)?.location === 'surface').length;
      if (used > 0) map.set(bodyName, used);
    }
    return map;
  }, [sitesByBody]);

  const orbitalUsedByBody = useMemo(() => {
    const map = new Map<string, number>();
    for (const [bodyName, sites] of sitesByBody) {
      const used = sites.filter((site) => getInstallation(site.installationId)?.location === 'orbital').length;
      if (used > 0) map.set(bodyName, used);
    }
    return map;
  }, [sitesByBody]);

  const sitesCountByBody = useMemo(() => {
    const map = new Map<string, number>();
    for (const [bodyName, sites] of sitesByBody) map.set(bodyName, sites.length);
    return map;
  }, [sitesByBody]);

  const issuesByBody = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of evaluation?.issues ?? []) {
      if (!issue.bodyName) continue;
      // Замечание приходит с именем из записи плана — приводим его к каталогу,
      // иначе счётчик проблем не попадал бы на карточку тела.
      const name = bodies.length > 0 ? (resolveBodyName(issue.bodyName, bodyIndex).name || issue.bodyName) : issue.bodyName;
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return map;
  }, [evaluation, bodies, bodyIndex]);

  /**
   * Состояние источника фактического прогресса — в той же панели источников,
   * что и тела: пользователю важно одним взглядом понять, какие данные живые.
   */
  const progressSourceState = useMemo<SyncSourceState[]>(() => {
    if (!systemName) return [];
    const label = progressSource === 'raven' ? 'Стройплощадки: Raven'
      : progressSource ? `Стройплощадки: ${progressSource}` : 'Стройплощадки';
    if (progressError) {
      return [{ id: 'progress', label, status: 'unavailable', count: 0, updatedAt: null, note: progressError }];
    }
    if (!progressFetched) {
      return [{ id: 'progress', label, status: 'skipped', count: 0, updatedAt: null, note: 'не запрошено' }];
    }
    return [{
      id: 'progress',
      label,
      status: actualSites.length > 0 ? 'ok' : 'empty',
      count: actualSites.length,
      updatedAt: progressTelemetry?.latestAt ?? null,
      note: progressTelemetry?.available === false ? 'снимков Uploader нет' : null,
    }];
  }, [systemName, progressSource, progressError, progressFetched, actualSites, progressTelemetry]);

  /** Аудит загруженных данных: дубли, пустые поля, невозможные значения. */
  const dataReport = useMemo(() => auditBodyRows(rawRows, { system: systemName }), [rawRows, systemName]);
  const planReport = useMemo(
    () => auditPlanData(plan ?? createPlan(systemName || 'Без системы'), bodies),
    [plan, bodies, systemName],
  );

  const visibleBodies = useMemo(() => {
    const query = bodyQuery.trim().toLocaleLowerCase();
    let list = bodies;
    if (query) list = list.filter((body) => `${body.name} ${body.subType}`.toLocaleLowerCase().includes(query));
    if (bodyFilter === 'planned') list = list.filter((body) => (sitesCountByBody.get(body.name) ?? 0) > 0);
    if (bodyFilter === 'slots') {
      list = list.filter((body) => {
        const surfaceFree = predictSurfaceSlots(body) - (surfaceUsedByBody.get(body.name) ?? 0);
        const orbitalSlots = plan ? orbitalLimit(body, plan) : 0;
        const orbitalFree = orbitalSlots === null ? 1 : orbitalSlots - (orbitalUsedByBody.get(body.name) ?? 0);
        return surfaceFree > 0 || orbitalFree > 0;
      });
    }
    if (bodyFilter === 'issues') list = list.filter((body) => (issuesByBody.get(body.name) ?? 0) > 0);
    if (bodySort === 'slots' || bodySort === 'structures') {
      const weight = (body: ArchitectBody) => bodySort === 'slots'
        ? predictSurfaceSlots(body) - (surfaceUsedByBody.get(body.name) ?? 0)
          + (() => {
            const limit = plan ? orbitalLimit(body, plan) : 0;
            return limit === null ? 1 : Math.max(0, limit - (orbitalUsedByBody.get(body.name) ?? 0));
          })()
        : (sitesCountByBody.get(body.name) ?? 0);
      list = [...list].sort((left, right) => weight(right) - weight(left) || left.distanceLs - right.distanceLs);
    }
    return list;
  }, [bodies, bodyQuery, bodyFilter, bodySort, surfaceUsedByBody, orbitalUsedByBody, sitesCountByBody, issuesByBody, plan]);

  /** Отчёт пересчитывается при любой правке плана — площадки при этом не перезапрашиваются. */
  const progress = useMemo<ProgressReport | null>(
    () => (plan && progressFetched ? matchProgress(plan, actualSites) : null),
    [plan, progressFetched, actualSites],
  );
  const progressBySite = useMemo(
    () => new Map<string, SiteProgress>((progress?.sites ?? []).map((entry) => [entry.siteId, entry])),
    [progress],
  );

  /**
   * Фактические стройплощадки системы. Источник — тот же, что у остального
   * сайта (`/api/systems/progress`); при недоступности панель честно пишет,
   * что данных нет, а планировщик продолжает работать.
   */
  const loadProgress = useCallback(async (name: string) => {
    const target = name.trim();
    if (!target) return;
    setProgressLoading(true);
    setProgressError('');
    try {
      const response = await fetch(`/api/systems/progress?name=${encodeURIComponent(target)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setActualSites([]);
        setProgressFetched(false);
        setProgressSource('');
        setProgressTelemetry(null);
        setProgressError(String(data?.error || `Прогресс недоступен (HTTP ${response.status})`));
        return;
      }
      setActualSites(parseActualSites(data));
      setProgressSource(String(data?.source || 'raven'));
      setProgressTelemetry(data?.telemetry && typeof data.telemetry === 'object' ? data.telemetry : null);
      setProgressFetched(true);
    } catch (error) {
      setActualSites([]);
      setProgressFetched(false);
      setProgressSource('');
      setProgressTelemetry(null);
      setProgressError(error instanceof Error ? error.message : 'Не удалось получить прогресс');
    } finally {
      setProgressLoading(false);
    }
  }, []);

  const loadSystem = useCallback(async (name: string, overridePlan: ArchitectPlan | null = null) => {
    const target = name.trim();
    if (!target) return;
    setLoading(true);
    setLoadError('');
    setNotice('');
    // Прогресс относится к прежней системе — сбрасываем, чтобы не показывать чужой.
    setActualSites([]);
    setProgressFetched(false);
    setProgressError('');
    setProgressSource('');
    setProgressTelemetry(null);
    setSourceStats(null);
    setSyncReport(null);
    setExistingSources([]);
    setFlashIds([]);
    setCollapsedBodies([]);
    setEditingSiteId(null);
    setPickerBody('');
    try {
      // Сверка на загрузке: сравниваются данные базы проекта и EDSM, для
      // каждого тела остаётся более точный/свежий источник (см. ARCHITECT.md,
      // раздел «Сверка тел с EDSM»), а не «база, если она не пустая».
      const response = await fetch(`/api/atlas/system-bodies?system=${encodeURIComponent(target)}&compare=1`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const rows = Array.isArray(data?.bodies) ? data.bodies : [];
      const stats = data?.sources && typeof data.sources === 'object' ? data.sources : null;
      setSyncReport(parseSyncReport(data));
      if (rows.length === 0) {
        setRawRows([]);
        setSystemName(target);
        setSource('');
        setSourceStats(stats);
        setLoadError('Тел в системе не найдено: проверьте название или загрузите сканы через Colonial Helper.');
        setPlan(overridePlan ?? createPlan(target));
        void loadProgress(target);
        return;
      }
      setRawRows(rows);
      setSystemName(target);
      setSource(String(data?.source || 'edsm'));
      setSourceStats(stats);
      setSystemInput(target);
      writeRecent(target);
      setRecent(readRecent());

      let restored: ArchitectPlan | null = overridePlan;
      if (!restored) {
        try {
          const saved = window.localStorage.getItem(PLAN_PREFIX + target.toLowerCase());
          if (saved) {
            const parsed = parsePlan(saved);
            if (parsed.plan) {
              restored = parsed.plan;
              if (parsed.warning) setNotice(parsed.warning);
            }
          }
        } catch {
          restored = null;
        }
      }
      setPlan(restored ?? createPlan(target));
      void loadProgress(target);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить систему');
    } finally {
      setLoading(false);
    }
  }, [loadProgress]);

  /** Открыть план по ссылке `/architect?plan=<id>` или из списка системы. */
  const openPlanById = useCallback(async (id: string) => {
    setLoading(true);
    setLoadError('');
    setNotice('');
    try {
      const response = await fetch(`/api/architect/plans/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(String(data?.error || `HTTP ${response.status}`));
      const view = data?.plan as PlanView | undefined;
      if (!view || typeof view.system !== 'string') throw new Error('Сервер не вернул описание плана');
      const parsed = parsePlan(data?.draft);
      if (!parsed.plan) throw new Error(parsed.error || 'Сохранённый план повреждён');
      setRemoteId(view.id);
      setSystemInput(view.system);
      await loadSystem(view.system, parsed.plan);
      const opened = `Открыт план «${view.title || 'без названия'}» автора ${view.authorName}`;
      setNotice(parsed.warning ? `${parsed.warning}. ${opened}` : opened);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Не удалось открыть план по ссылке');
    } finally {
      setLoading(false);
    }
  }, [loadSystem]);

  useEffect(() => {
    setRecent(readRecent());
    const params = new URLSearchParams(window.location.search);
    const planId = params.get('plan');
    const requested = params.get('system');
    if (planId) {
      void openPlanById(planId);
    } else if (requested) {
      setSystemInput(requested);
      void loadSystem(requested);
    }
    // Загрузка при первом открытии страницы по ссылке /architect?system=… или ?plan=…
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Черновик живёт в localStorage: тестовый режим не требует таблиц в базе.
  useEffect(() => {
    if (!plan || !systemName) return;
    try {
      window.localStorage.setItem(PLAN_PREFIX + systemName.toLowerCase(), serializePlan(plan));
    } catch {
      /* место кончилось — черновик просто не сохранится */
    }
  }, [plan, systemName]);

  const openPicker = useCallback((bodyName: string, location: PickerLocation = 'any') => {
    setPickerBody(bodyName);
    setPickerLocation(location);
  }, []);

  const pickInstallation = useCallback((installationId: string) => {
    if (!plan) return;
    const body = bodiesByName.get(pickerBody);
    const check = placementCheck(body, installationId, plan);
    if (!check.ok) {
      setNotice(check.errors.join('; '));
      return;
    }
    setPlan(addSite(plan, pickerBody, installationId));
    // Тело получило постройку — раскрываем его карточку, чтобы результат был виден.
    setCollapsedBodies((list) => list.filter((name) => name !== pickerBody));
    setPickerBody('');
    setNotice('');
  }, [plan, pickerBody, bodiesByName]);

  /** Ключи «тело + постройка» из плана: по ним панель факта помечает дубли. */
  const plannedKeys = useMemo(
    () => new Set((plan?.sites ?? []).map((site) => structureKey(site.bodyName, site.installationId))),
    [plan],
  );

  /**
   * Перенос реальной застройки в план.
   *
   * Ничего не удаляет и не создаёт дублей: уже имеющимся записям только
   * подтягивает статус к факту (см. `adoptExisting`).
   */
  const applyExisting = useCallback((structures: ExistingStructure[]) => {
    if (!plan) return;
    // Каталог тел передаётся внутрь: имена из источников приводятся к нему,
    // иначе перенесённые записи не попадали бы на карточки тел и выглядели
    // бы как «ничего не изменилось».
    const result = adoptExisting(plan, structures, { bodies, index: bodyIndex, system: systemName });
    setPlan(result.plan);

    // Раскрываем карточки затронутых тел и подсвечиваем изменённые записи —
    // результат переноса должен быть виден без прокрутки вслепую.
    setCollapsedBodies((list) => list.filter((name) => !result.touchedBodies.includes(name)));
    setFlashIds(result.touchedSiteIds);
    if (result.touchedSiteIds.length > 0) {
      window.setTimeout(() => setFlashIds([]), 2600);
      // Если пользователь смотрит аналитику, возвращаем его к телам: правки плана там не видны.
      setView((current) => (current === 'insights' ? 'bodies' : current));
    }

    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`добавлено ${result.added.length}`);
    if (result.updated.length > 0) parts.push(`обновлён статус у ${result.updated.length}`);
    if (result.unmatchedBodies.length > 0) {
      const names = result.unmatchedBodies
        .map((item) => item.rawBodyName || item.name)
        .slice(0, 3)
        .join(', ');
      parts.push(`тело не опознано у ${result.unmatchedBodies.length} (${names}) — записи в конце списка`);
    }
    if (result.unknown.length > 0) parts.push(`тип не опознан у ${result.unknown.length}`);
    setNotice(parts.length > 0 ? `Факт применён к плану: ${parts.join(', ')}.` : 'Переносить нечего: всё уже в плане.');
  }, [plan, bodies, bodyIndex, systemName]);

  const exportPlan = useCallback(() => {
    if (!plan) return;
    const blob = new Blob([serializePlan(plan)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${plan.system.replace(/[^\w-]+/g, '_') || 'plan'}-architect.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [plan]);

  const importPlan = useCallback(async (file: File) => {
    const text = await file.text();
    const parsed = parsePlan(text);
    if (!parsed.plan) {
      setNotice(parsed.error || 'Не удалось прочитать файл');
      return;
    }
    setPlan(parsed.plan);
    setSystemName(parsed.plan.system);
    setSystemInput(parsed.plan.system);
    setNotice(parsed.warning ? parsed.warning : `Импортирован план: ${parsed.plan.sites.length} построек`);
  }, []);

  const copySummary = useCallback(async () => {
    if (!plan || !evaluation) return;
    try {
      await navigator.clipboard.writeText(summarizePlan(plan, evaluation));
      setNotice('Сводка скопирована в буфер обмена');
    } catch {
      setNotice('Браузер не дал доступ к буферу обмена — используйте экспорт файла');
    }
  }, [plan, evaluation]);

  const saveSiteEdits = useCallback((siteId: string, patch: SitePatch) => {
    if (!plan) return;
    setPlan(updateSite(plan, siteId, patch));
    setCollapsedBodies((list) => (patch.bodyName ? list.filter((name) => name !== patch.bodyName) : list));
    setEditingSiteId(null);
    setNotice('Постройка обновлена');
  }, [plan]);

  const togglePrimary = useCallback((siteId: string) => {
    if (!plan) return;
    const site = plan.sites.find((entry) => entry.id === siteId);
    if (!site) return;
    setPlan(setSitePrimary(plan, siteId, !site.primary));
  }, [plan]);

  const primarySite = useMemo(() => plan?.sites.find((site) => site.primary) ?? null, [plan]);
  const primaryName = useMemo(() => {
    if (!primarySite) return null;
    return getInstallation(primarySite.installationId)?.nameRu.split(' (')[0] ?? null;
  }, [primarySite]);

  return (
    <main style={{ maxWidth: 1440, margin: '24px auto', padding: '0 16px' }}>
      <header style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, color: 'var(--text)' }}>Архитектор системы</h1>
            <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, maxWidth: 860 }}>
              Планировщик застройки под колонизацию: выберите систему, распределите постройки по телам —
              инструмент посчитает наземные слоты, очки системы (T2/T3), порядок стройки, товары и тоннаж,
              которые надо привезти. Наземные и орбитальные постройки — в отдельных разделах у каждого тела,
              любую запись можно отредактировать, а порт — назначить основным.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <span style={betaBadge}>тестовый режим · v{PLAN_FORMAT_VERSION}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
              каталог построек v{CATALOGUE_VERSION} · черновик в браузере, планы сохраняются на сервере
            </span>
          </div>
        </div>

        <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            value={systemInput}
            onChange={(event) => setSystemInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void loadSystem(systemInput);
            }}
            placeholder="Название системы, например HIP 90297"
            style={{ ...inputStyle, flex: '1 1 260px' }}
          />
          <button type="button" onClick={() => void loadSystem(systemInput)} disabled={loading} style={primaryButton}>
            {loading ? 'Загрузка…' : 'Загрузить систему'}
          </button>
          {systemName && (
            <>
              <Link href={`/system/${encodeURIComponent(systemName)}`} style={ghostButton}>
                Страница системы
              </Link>
              <button type="button" onClick={() => setShowMap((value) => !value)} style={ghostButton}>
                {showMap ? 'Скрыть карту' : 'Показать на карте'}
              </button>
            </>
          )}
        </div>

        {recent.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Недавние:</span>
            {recent.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => void loadSystem(item)}
                style={{ ...chipStyle, ...(item === systemName ? chipActive : {}) }}
              >
                {item}
              </button>
            ))}
          </div>
        )}

        {loadError && <div style={{ marginTop: 10, color: 'var(--red)', fontSize: 13 }}>{loadError}</div>}
        {notice && <div style={{ marginTop: 10, color: 'var(--orange)', fontSize: 13 }}>{notice}</div>}
        {!loadError && systemName && (
          <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12 }}>
            Тел: {bodies.length} · источник: {describeSourceStats(source, sourceStats)}
            {plan && plan.sites.length > 0 ? ` · в плане: ${plan.sites.length}` : ''}
            {primaryName ? ` · основной порт: ${primaryName}` : ''}
          </div>
        )}
      </header>

      {showMap && systemName && (
        <section style={{ ...cardStyle, marginBottom: 12, padding: 8 }}>
          <SystemOrrery3D systemName={systemName} bodies={rawRows} structures={structures} height={520} />
        </section>
      )}

      {!systemName && (
        <section style={{ ...cardStyle, color: 'var(--muted)', fontSize: 13 }}>
          <p style={{ marginTop: 0 }}>
            Как это работает:
          </p>
          <ol style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Загрузите систему — тела возьмутся из каталога проекта, а при их отсутствии из EDSM.</li>
            <li>Нажмите «+ постройка» у тела: список сразу покажет, что на это тело поставить нельзя и почему.</li>
            <li>Наземные и орбитальные постройки лежат в отдельных разделах карточки тела, а занятые слоты видны на полосе.</li>
            <li>Любую постройку в плане можно отредактировать: тип, тело, статус, заметка и роль основного порта.</li>
            <li>Отметьте основной порт: он строится с колониального корабля, не тратит очки системы, но везёт больше материалов.</li>
            <li>Следите за очками системы: основной порт бесплатный, а каждый следующий порт дороже.</li>
            <li>Экспортируйте план в JSON или скопируйте сводку — её можно отдать эскадрилье и перевозчикам.</li>
            <li>Сохраните план на сервере и опубликуйте: получите ссылку, по которой его откроют другие.</li>
            <li>Сверьте план со стройплощадками и посчитайте «где купить» по рынкам EDDN.</li>
          </ol>
          <p style={{ marginBottom: 0 }}>
            Это тестовый режим: черновик живёт в вашем браузере, а сохранённые планы и ссылки — уже на сервере.
            Совместное редактирование появится позже.
          </p>
        </section>
      )}

      {systemName && plan && evaluation && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(320px, 0.65fr)', gap: 12 }} className="architect-grid">
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" onClick={exportPlan} style={ghostButton}>Экспорт JSON</button>
              <button type="button" onClick={() => fileInput.current?.click()} style={ghostButton}>Импорт JSON</button>
              <button type="button" onClick={() => void copySummary()} style={ghostButton}>Копировать сводку</button>
              <button
                type="button"
                style={{ ...ghostButton, color: 'var(--red)' }}
                onClick={() => {
                  if (window.confirm('Очистить план системы?')) setPlan(createPlan(systemName, plan.architect));
                }}
              >
                Очистить план
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importPlan(file);
                  event.target.value = '';
                }}
              />
            </div>

            {bodies.length > 0 && (
              <>
                <div className="architect-kpi-grid">
                  <Kpi label="Тел в каталоге" value={bodies.length} tone="var(--cyan)" />
                  <Kpi
                    label="Построек в плане"
                    value={plan.sites.length}
                    tone="var(--orange)"
                    active={bodyFilter === 'planned'}
                    onClick={() => setBodyFilter(bodyFilter === 'planned' ? 'all' : 'planned')}
                  />
                  <Kpi label="Тоннаж" value={formatTons(evaluation.haulTons)} tone="var(--green)" />
                  <Kpi
                    label="Основной порт"
                    value={primaryName ?? '—'}
                    tone={primaryName ? 'var(--orange)' : 'var(--muted)'}
                    clickable={Boolean(primarySite)}
                    onClick={primarySite ? () => setEditingSiteId(primarySite.id) : undefined}
                  />
                  <Kpi
                    label="Оценка системы"
                    value={evaluation.score}
                    tone="var(--orange)"
                    active={bodyFilter === 'issues'}
                    onClick={() => setBodyFilter(bodyFilter === 'issues' ? 'all' : 'issues')}
                  />
                  {/*
                    Очки тиров — главный ограничитель плана, поэтому они в шапке,
                    а не только в сводке: отрицательное значение сразу красное.
                  */}
                  <Kpi
                    label="Очки T2"
                    value={evaluation.tierPoints.tier2}
                    tone={evaluation.tierPoints.tier2 < 0 ? 'var(--red)' : 'var(--cyan)'}
                    hint={`потрачено ${evaluation.tierSpent.tier2} из ${evaluation.tierGiven.tier2}`}
                  />
                  <Kpi
                    label="Очки T3"
                    value={evaluation.tierPoints.tier3}
                    tone={evaluation.tierPoints.tier3 < 0 ? 'var(--red)' : 'var(--cyan)'}
                    hint={`потрачено ${evaluation.tierSpent.tier3} из ${evaluation.tierGiven.tier3}`}
                  />
                  <Kpi
                    label="Качество данных"
                    value={dataReport.score}
                    tone={dataReport.score >= 80 ? 'var(--green)' : dataReport.score >= 50 ? 'var(--orange)' : 'var(--red)'}
                    hint={dataReport.issues.length > 0 ? `замечаний: ${dataReport.issues.length}` : 'замечаний нет'}
                  />
                </div>
                {/* Переключатель вида: карточки тел ↔ таблица плана ↔ инфографика. */}
                <div style={{ ...cardStyle, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Вид</span>
                  {(Object.keys(VIEW_LABELS) as WorkspaceView[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setView(value)}
                      aria-pressed={view === value}
                      style={{ ...chipStyle, ...(view === value ? chipActive : {}) }}
                    >
                      {VIEW_LABELS[value]}
                    </button>
                  ))}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>
                    {view === 'bodies' ? 'постройки по телам системы'
                      : view === 'table' ? 'весь план одним списком'
                        : 'очки, тоннаж, экономики и эффекты'}
                  </span>
                </div>

                {view === 'bodies' && (
                <div style={{ ...cardStyle, padding: '9px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Фильтр тел</span>
                  <input
                    value={bodyQuery}
                    onChange={(event) => setBodyQuery(event.target.value)}
                    placeholder="Название или класс тела"
                    aria-label="Фильтр тел"
                    style={{ ...inputStyle, flex: '1 1 220px', margin: 0 }}
                  />
                  {(Object.keys(BODY_FILTER_LABELS) as BodyFilter[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setBodyFilter(value)}
                      style={{ ...chipStyle, ...(bodyFilter === value ? chipActive : {}) }}
                    >
                      {BODY_FILTER_LABELS[value]}
                    </button>
                  ))}
                  <span style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginLeft: 6 }}>Сортировка</span>
                  {(Object.keys(BODY_SORT_LABELS) as BodySort[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setBodySort(value)}
                      style={{ ...chipStyle, ...(bodySort === value ? chipActive : {}) }}
                    >
                      {BODY_SORT_LABELS[value]}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCollapsedBodies(bodies.filter((body) => (sitesCountByBody.get(body.name) ?? 0) === 0).map((body) => body.name))}
                    style={ghostButton}
                  >
                    Свернуть пустые
                  </button>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>{visibleBodies.length} из {bodies.length}</span>
                </div>
                )}
              </>
            )}

            {bodies.length === 0 && (
              <div style={{ ...cardStyle, color: 'var(--muted)', fontSize: 13 }}>
                Тела не загружены — планировать можно только по названию тела, проверка слотов будет недоступна.
              </div>
            )}

            {view === 'bodies' && (
              <>
                {visibleBodies.length === 0 && bodies.length > 0 && (
                  <div style={{ ...cardStyle, color: 'var(--muted)', fontSize: 13 }}>
                    Под фильтр не подошло ни одного тела.
                  </div>
                )}

                {visibleBodies.map((body) => (
                  <BodyCard
                    key={body.name}
                    body={body}
                    sites={sitesByBody.get(body.name) ?? []}
                    progressBySite={progressBySite}
                    flashIds={flashIds}
                    collapsed={collapsedBodies.includes(body.name)}
                    errorCount={issuesByBody.get(body.name) ?? 0}
                    orbitalSlots={orbitalLimit(body, plan)}
                    orbitalSlotsCustom={Object.keys(plan.orbitalSlots).some((name) => resolveBodyName(name, bodyIndex).name === body.name)}
                    onSetOrbitalSlots={(slots) => setPlan(setOrbitalSlots(plan, body.name, slots))}
                    onToggleCollapse={() => setCollapsedBodies((list) => (
                      list.includes(body.name) ? list.filter((name) => name !== body.name) : [...list, body.name]
                    ))}
                    onAdd={(location) => openPicker(body.name, location)}
                    onRemove={(siteId) => setPlan(removeSite(plan, siteId))}
                    onCycle={(siteId, status) => setPlan(setSiteStatus(plan, siteId, status))}
                    onEdit={(siteId) => setEditingSiteId(siteId)}
                    onTogglePrimary={togglePrimary}
                  />
                ))}

                {/*
                  Постройки, тело которых не нашлось в каталоге: раньше такие
                  записи просто исчезали из интерфейса — план менялся, а на
                  экране ничего не происходило. Теперь они видны и их можно
                  привязать к телу вручную.
                */}
                {unassignedSites.length > 0 && (
                  <div className="architect-body" style={{ ...cardStyle, borderColor: 'var(--orange)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 16, color: 'var(--orange)' }}>Постройки вне каталога тел</div>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {unassignedSites.length} шт. · тело не найдено в данных системы
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      Такое бывает, когда источник называет тело иначе, чем каталог, или данных о теле нет вовсе.
                      Откройте запись и выберите тело — проверка слотов и экономик заработает.
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {unassignedSites.map((site) => (
                        <SiteRow
                          key={site.id}
                          site={site}
                          body={null}
                          progressBySite={progressBySite}
                          flash={flashIds.includes(site.id)}
                          onRemove={(siteId) => setPlan(removeSite(plan, siteId))}
                          onCycle={(siteId, status) => setPlan(setSiteStatus(plan, siteId, status))}
                          onEdit={(siteId) => setEditingSiteId(siteId)}
                          onTogglePrimary={togglePrimary}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {view === 'table' && (
              <SiteTable
                plan={plan}
                evaluation={evaluation}
                progressBySite={progressBySite}
                knownBodyNames={knownBodyNames}
                flashIds={flashIds}
                onEdit={(siteId) => setEditingSiteId(siteId)}
                onRemove={(siteId) => setPlan(removeSite(plan, siteId))}
                onCycle={(siteId, status) => setPlan(setSiteStatus(plan, siteId, status))}
                onTogglePrimary={togglePrimary}
              />
            )}

            {view === 'insights' && (
              <PlanInsights
                plan={plan}
                evaluation={evaluation}
                bodies={bodies}
                onSelectSite={(siteId) => setEditingSiteId(siteId)}
              />
            )}

            <SharePanel
              plan={plan}
              systemName={systemName}
              remoteId={remoteId}
              onSaved={(view) => setRemoteId(view.id)}
              onOpen={(planId) => void openPlanById(planId)}
              onDeleted={() => setRemoteId(null)}
              onNotice={setNotice}
            />
          </section>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PlanSummary
              plan={plan}
              evaluation={evaluation}
              onMarkPrimary={(siteId) => togglePrimary(siteId)}
            />
            <ExistingPanel
              systemName={systemName}
              bodies={bodies}
              plannedKeys={plannedKeys}
              onApply={applyExisting}
              onSources={setExistingSources}
            />
            <DataQualityPanel
              report={dataReport}
              planReport={planReport}
              onShowUnknownBodies={() => {
                setView('bodies');
                setBodyFilter('all');
                setBodyQuery('');
              }}
            />
            <SyncPanel
              system={systemName}
              report={syncReport}
              extra={[...existingSources, ...progressSourceState]}
              loading={loading}
              onRefresh={() => void loadSystem(systemName)}
            />
            <ProgressPanel
              systemName={systemName}
              report={progress}
              telemetry={progressTelemetry}
              loading={progressLoading}
              error={progressError}
              source={progressSource}
              onRefresh={() => void loadProgress(systemName)}
            />
            <SourcingPanel systemName={systemName} cargo={evaluation.cargo} />
          </div>
        </div>
      )}

      {pickerBody && plan && bodiesByName.get(pickerBody) && (
        <InstallationPicker
          body={bodiesByName.get(pickerBody)!}
          plan={plan}
          onPick={pickInstallation}
          onClose={() => setPickerBody('')}
          initialLocation={pickerLocation}
        />
      )}

      {editingSite && plan && (
        <SiteEditor
          site={editingSite}
          plan={plan}
          bodies={bodies}
          onSave={saveSiteEdits}
          onClose={() => setEditingSiteId(null)}
          onDelete={(siteId) => {
            setPlan(removeSite(plan, siteId));
            setEditingSiteId(null);
          }}
        />
      )}

      <style>{`
        .architect-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
        .architect-kpi { transition: border-color .15s ease, transform .15s ease; }
        .architect-kpi:hover { transform: translateY(-1px); }
        button.architect-kpi { cursor: pointer; text-align: left; }
        .architect-kpi-active { box-shadow: inset 0 -2px 0 var(--orange); }
        .architect-body { transition: border-color .15s ease; }
        .architect-body:hover { border-color: var(--cyan); }
        .architect-body-header { cursor: pointer; user-select: none; }
        .architect-chevron { display: inline-block; transition: transform .15s ease; color: var(--muted); width: 14px; text-align: center; }
        .architect-chevron-collapsed { transform: rotate(-90deg); }
        .architect-site { animation: architect-fade-in .18s ease; transition: background .12s ease, border-color .12s ease; }
        .architect-site:hover { background: var(--panel); }
        .architect-site-primary { border-color: var(--orange) !important; }
        @keyframes architect-fade-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
        /* Подсветка записей, которых коснулся перенос фактической застройки. */
        .architect-flash { animation: architect-flash 2.4s ease-out; }
        @keyframes architect-flash {
          0% { background: rgba(0, 229, 255, .22); border-color: var(--cyan); }
          60% { background: rgba(0, 229, 255, .10); }
          100% { background: var(--bg); }
        }
        .architect-chart-col { cursor: pointer; }
        .architect-chart-col:hover .architect-chart-bar { filter: brightness(1.35); }
        .architect-chart-col:focus-visible { outline: 1px solid var(--cyan); outline-offset: 2px; }
        .architect-slotbar { height: 5px; background: var(--bg); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; margin-top: 8px; }
        .architect-slotbar-fill { height: 100%; transition: width .25s ease; }
        .architect-sitegroup { margin-top: 10px; }
        @media (max-width: 640px) {
          .architect-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 980px) {
          .architect-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </main>
  );
}

function Kpi({
  label,
  value,
  tone,
  hint,
  active,
  clickable,
  onClick,
}: {
  label: string;
  value: string | number;
  tone: string;
  /** Пояснение мелким шрифтом под числом: из чего оно сложилось. */
  hint?: string;
  active?: boolean;
  clickable?: boolean;
  onClick?: () => void;
}) {
  const clickableStyle = onClick ? { cursor: 'pointer', textAlign: 'left' as const } : {};
  return (
    <div
      className={`architect-kpi${onClick ? ' architect-kpi-clickable' : ''}${active ? ' architect-kpi-active' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        background: 'var(--panel)', border: '1px solid var(--line)', borderTop: `2px solid ${tone}`,
        borderRadius: 4, padding: '10px 12px', minWidth: 0, ...clickableStyle,
      }}
    >
      <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ color: tone, fontFamily: 'ui-monospace, monospace', fontSize: 19, fontWeight: 700, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {hint && (
        <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function BodyCard({
  body,
  sites,
  progressBySite,
  flashIds,
  collapsed,
  errorCount,
  orbitalSlots,
  orbitalSlotsCustom,
  onSetOrbitalSlots,
  onToggleCollapse,
  onAdd,
  onRemove,
  onCycle,
  onEdit,
  onTogglePrimary,
}: {
  body: ArchitectBody;
  /**
   * Постройки этого тела. Список приходит сверху: там имена из плана
   * приводятся к каталогу индексом имён, поэтому запись с именем из чужого
   * источника («A 1» вместо «Sol A 1») больше не теряется.
   */
  sites: PlannedSite[];
  progressBySite: Map<string, SiteProgress>;
  flashIds: string[];
  collapsed: boolean;
  errorCount: number;
  orbitalSlots: number | null;
  orbitalSlotsCustom: boolean;
  onSetOrbitalSlots: (slots: number) => void;
  onToggleCollapse: () => void;
  onAdd: (location: PickerLocation) => void;
  onRemove: (siteId: string) => void;
  onCycle: (siteId: string, status: PlannedSiteStatus) => void;
  onEdit: (siteId: string) => void;
  onTogglePrimary: (siteId: string) => void;
}) {
  const surfaceLimit = predictSurfaceSlots(body);
  const surfaceSites = sites.filter((site) => getInstallation(site.installationId)?.location === 'surface');
  const orbitalSites = sites.filter((site) => getInstallation(site.installationId)?.location !== 'surface');
  const surfaceUsed = surfaceSites.length;
  const orbitalUsed = orbitalSites.length;
  const blocked = body.kind !== 'star' ? surfaceSlotReason(body) : '';
  const slotTone = surfaceLimit <= 0
    ? 'var(--red)'
    : surfaceUsed >= surfaceLimit ? 'var(--red)' : surfaceUsed / surfaceLimit > 0.7 ? 'var(--orange)' : 'var(--green)';
  const orbitalTone = orbitalSlots === 0 || (orbitalSlots !== null && orbitalUsed >= orbitalSlots)
    ? 'var(--red)'
    : orbitalSlots !== null && orbitalUsed / orbitalSlots > 0.7 ? 'var(--orange)' : 'var(--green)';
  const allowSurface = body.kind === 'planet' || body.kind === 'moon';
  const allowOrbital = orbitalSlots === null || orbitalSlots > 0;
  const boostedEconomies = body.kind !== 'star' ? bodyBoostedEconomies(body) : [];
  // Разделы «наземные/орбитальные» показываем у тел с постройками и у тех,
  // где соответствующее размещение вообще возможно.
  const showSurfaceGroup = allowSurface && (sites.length > 0 || surfaceUsed > 0);
  const showOrbitalGroup = allowOrbital || orbitalUsed > 0;

  return (
    <div className="architect-body" style={{ ...cardStyle, borderColor: errorCount > 0 ? 'var(--red)' : undefined }}>
      <div
        className="architect-body-header"
        onClick={onToggleCollapse}
        title={collapsed ? 'Развернуть карточку тела' : 'Свернуть карточку тела'}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, color: 'var(--text)' }}>
              <span className={`architect-chevron${collapsed ? ' architect-chevron-collapsed' : ''}`}>▾</span>
              {' '}{body.name}
              {sites.length > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--orange)' }}>
                  построек: {sites.length}
                </span>
              )}
              {errorCount > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 3, padding: '0 5px' }}>
                  проблем: {errorCount}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {/*
                Числа форматируются одинаково (русский разделитель разрядов и
                не больше двух знаков после запятой): раньше расстояние шло с
                запятой, а гравитация — с точкой, и таблица выглядела так,
                будто данные из разных мест.
              */}
              {body.subType && body.subType !== 'Неизвестно'
                ? body.subType
                : <span style={{ color: 'var(--orange)' }}>класс тела неизвестен</span>}
              {' · '}{KIND_LABELS[body.kind]} · {formatNumber(body.distanceLs)} св. с
              {body.radiusKm > 0 ? ` · R ${formatNumber(body.radiusKm)} км` : ''}
              {body.tempK > 0 ? ` · ${formatNumber(body.tempK)} K` : ''}
              {body.gravity > 0 ? ` · ${formatNumber(body.gravity)} g` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: surfaceLimit > 0 || allowOrbital ? 'var(--muted)' : 'var(--red)' }}>
              {body.kind !== 'star' && (surfaceLimit > 0
                ? `наземных: ${surfaceUsed} из ${surfaceLimit}`
                : blocked)}
              {body.kind !== 'star' && ' · '}
              орбитальных: {orbitalUsed}{orbitalSlots === null ? '' : ` из ${orbitalSlots}`}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onAdd('any');
              }}
              style={primaryButton}
            >
              + постройка
            </button>
          </div>
        </div>
        {body.kind !== 'star' && surfaceLimit > 0 && (
          <div className="architect-slotbar" title={`Занято наземных слотов: ${surfaceUsed} из ${surfaceLimit}`}>
            <div className="architect-slotbar-fill" style={{ width: `${Math.min(100, (surfaceUsed / surfaceLimit) * 100)}%`, background: slotTone }} />
          </div>
        )}
        {orbitalSlots !== null && orbitalSlots > 0 && (
          <div className="architect-slotbar" title={`Занято орбитальных слотов: ${orbitalUsed} из ${orbitalSlots}`} style={{ marginTop: 3 }}>
            <div className="architect-slotbar-fill" style={{ width: `${Math.min(100, (orbitalUsed / orbitalSlots) * 100)}%`, background: orbitalTone }} />
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Tag tone={body.landable ? 'var(--green)' : 'var(--muted)'} label={body.landable ? 'есть посадка' : 'нет посадки'} />
            {body.terraformable && <Tag tone="var(--cyan)" label="терраформируемое" />}
            {body.hasAtmosphere && <Tag tone="var(--cyan)" label="атмосфера" />}
            {body.volcanism && <Tag tone="var(--cyan)" label="вулканизм" />}
            {body.hasRings && <Tag tone="var(--cyan)" label="кольца / пояс" />}
            {/*
              Сигналы тела: биология и всё остальное, что нашёл сканер. Для
              застройки это важные подсказки — биология рядом со стройкой
              пропадёт, геология даёт материалы, человеческие сигналы говорят
              о чужом присутствии.
            */}
            {activeSignalKinds(body.signals).map((kind) => (
              <Tag
                key={kind}
                tone={SIGNAL_META[kind].color}
                label={`${SIGNAL_META[kind].icon} ${SIGNAL_META[kind].label}: ${body.signals[kind]}`}
              />
            ))}
          </div>

          {body.kind !== 'star' && orbitalSlots !== null && (
            <div
              className="architect-orbital-slots"
              style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 12 }}
            >
              <span style={{ color: 'var(--muted)' }}>Орбитальные слоты:</span>
              <button
                type="button"
                aria-label="Уменьшить число орбитальных слотов"
                onClick={() => onSetOrbitalSlots(Math.max(0, orbitalSlots - 1))}
                disabled={orbitalSlots <= 0}
                style={linkButton}
              >−</button>
              <input
                aria-label={`Орбитальные слоты тела ${body.name}`}
                type="number"
                min={0}
                max={ORBITAL_SLOT_LIMIT}
                value={orbitalSlots}
                onChange={(event) => onSetOrbitalSlots(Number(event.target.value))}
                style={{ width: 52, padding: '3px 5px', textAlign: 'center', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 3 }}
              />
              <button
                type="button"
                aria-label="Увеличить число орбитальных слотов"
                onClick={() => onSetOrbitalSlots(orbitalSlots + 1)}
                disabled={orbitalSlots >= ORBITAL_SLOT_LIMIT}
                style={linkButton}
              >+</button>
              <span style={{ color: orbitalSlotsCustom ? 'var(--cyan)' : 'var(--muted)', fontSize: 11 }}>
                {orbitalSlotsCustom ? 'задано вручную' : 'не подтверждено — сверьте с картой системы'}
              </span>
            </div>
          )}

          {boostedEconomies.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
              🏭 усиливает экономики:{' '}
              <span style={{ color: 'var(--green)' }}>
                {boostedEconomies.map((economy) => ECONOMY_LABELS_RU[economy]).join(', ')}
              </span>
            </div>
          )}

          {body.signals.genuses.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
              роды биологии: {body.signals.genuses.join(', ')}
            </div>
          )}
          {body.signals.bio > 0 && body.landable && (
            <div style={{ marginTop: 6, fontSize: 11, color: SIGNAL_META.bio.color }}>
              На теле есть биология — соберите образцы до начала стройки: поселение уничтожает находки рядом с собой.
            </div>
          )}

          {showSurfaceGroup && (
            <SiteGroup
              title="Наземные постройки"
              counter={` ${surfaceUsed} из ${surfaceLimit}`}
              body={body}
              onAdd={() => onAdd('surface')}
              sites={surfaceSites}
              progressBySite={progressBySite}
              flashIds={flashIds}
              onRemove={onRemove}
              onCycle={onCycle}
              onEdit={onEdit}
              onTogglePrimary={onTogglePrimary}
            />
          )}
          {showOrbitalGroup && (
            <SiteGroup
              title="Орбитальные постройки"
              counter={orbitalSlots === null ? ` ${orbitalUsed}` : ` ${orbitalUsed} из ${orbitalSlots}`}
              body={body}
              canAdd={allowOrbital && (orbitalSlots === null || orbitalUsed < orbitalSlots)}
              onAdd={() => onAdd('orbital')}
              sites={orbitalSites}
              progressBySite={progressBySite}
              flashIds={flashIds}
              onRemove={onRemove}
              onCycle={onCycle}
              onEdit={onEdit}
              onTogglePrimary={onTogglePrimary}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Раздел построек одного размещения: наземные или орбитальные. */
function SiteGroup({
  title,
  counter,
  body,
  sites,
  progressBySite,
  flashIds,
  canAdd = true,
  onAdd,
  onRemove,
  onCycle,
  onEdit,
  onTogglePrimary,
}: {
  title: string;
  counter: string;
  body: ArchitectBody;
  sites: PlannedSite[];
  progressBySite: Map<string, SiteProgress>;
  flashIds: string[];
  canAdd?: boolean;
  onAdd: () => void;
  onRemove: (siteId: string) => void;
  onCycle: (siteId: string, status: PlannedSiteStatus) => void;
  onEdit: (siteId: string) => void;
  onTogglePrimary: (siteId: string) => void;
}) {
  return (
    <div className="architect-sitegroup">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
          {title}
          <span style={{ color: 'var(--text)' }}>{counter}</span>
        </span>
        <button type="button" onClick={onAdd} disabled={!canAdd} style={{ ...linkButton, margin: 0, opacity: canAdd ? 1 : 0.45 }}>+ добавить</button>
      </div>
      {sites.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 3, padding: '6px 8px' }}>
          Пока ничего не запланировано.
        </div>
      )}
      {sites.map((site) => (
        <SiteRow
          key={site.id}
          site={site}
          body={body}
          progressBySite={progressBySite}
          flash={flashIds.includes(site.id)}
          onRemove={onRemove}
          onCycle={onCycle}
          onEdit={onEdit}
          onTogglePrimary={onTogglePrimary}
        />
      ))}
    </div>
  );
}

function SiteRow({
  site,
  body,
  progressBySite,
  flash = false,
  onRemove,
  onCycle,
  onEdit,
  onTogglePrimary,
}: {
  site: PlannedSite;
  /** null — запись показывается в карточке «вне каталога тел». */
  body: ArchitectBody | null;
  progressBySite: Map<string, SiteProgress>;
  /** Подсветить запись: её только что затронул перенос факта. */
  flash?: boolean;
  onRemove: (siteId: string) => void;
  onCycle: (siteId: string, status: PlannedSiteStatus) => void;
  onEdit: (siteId: string) => void;
  onTogglePrimary: (siteId: string) => void;
}) {
  const installation = getInstallation(site.installationId);
  if (!installation) {
    return (
      <div key={site.id} style={{ color: 'var(--red)', fontSize: 12, margin: '4px 0' }}>
        Неизвестная постройка «{site.installationId}»{' '}
        <button type="button" style={linkButton} onClick={() => onRemove(site.id)}>удалить</button>
      </div>
    );
  }
  const nextStatus = STATUS_ORDER[(STATUS_ORDER.indexOf(site.status) + 1) % STATUS_ORDER.length];
  const siteProgress = progressBySite.get(site.id);
  const actual = siteProgress?.actual ?? null;
  const cargo = siteCargo(site);
  const tons = cargo?.haulTons ?? installation.haulTons;
  const isPrimary = Boolean(site.primary);
  // Соответствие экономики постройки телу (звёзды не учитываем).
  const economyFit = installation.influence !== 'none' && body && body.kind !== 'star'
    ? economyBodyFit(installation.influence, body)
    : null;

  return (
    <div
      className={`architect-site${isPrimary ? ' architect-site-primary' : ''}${flash ? ' architect-flash' : ''}`}
      style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between',
        border: '1px solid var(--line)', borderLeft: `3px solid ${isPrimary ? 'var(--orange)' : STATUS_TONES[site.status]}`,
        borderRadius: 3, padding: '6px 8px', background: 'var(--bg)', margin: '4px 0',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>
          {isPrimary && <span style={{ color: 'var(--orange)' }} title="Основной порт системы">★ </span>}
          {installation.nameRu}
          <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {installation.id}</span>
        </div>
        {!body && (
          <div style={{ fontSize: 11, color: 'var(--orange)' }}>
            {site.bodyName
              ? `тело: ${site.bodyName} — не найдено в каталоге системы`
              : 'тело не указано источником — выберите его в редакторе записи'}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {installation.location === 'surface' ? 'поверхность' : 'орбита'} · T{installation.tier}
          {' · '}
          {formatTons(tons)}
          {isPrimary ? ' (основной порт)' : ''}
          {installation.needs.count > 0 ? ` · нужно ${installation.needs.count} очк. T${installation.needs.tier}` : ''}
          {installation.gives.count > 0 ? ` · даёт ${installation.gives.count} очк. T${installation.gives.tier}` : ''}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          экономика: {ECONOMY_LABELS_RU[installation.influence]}
          {economyFit && economyFit.level !== 'neutral' && (
            <span
              style={{ marginLeft: 6, color: economyFit.level === 'boost' ? 'var(--green)' : 'var(--orange)' }}
              title={economyFit.reason}
            >
              {economyFit.level === 'boost' ? '▲ усилена телом' : '▽ слабо на этом теле'}
            </span>
          )}
        </div>
        {site.note && (
          <div style={{ fontSize: 11, color: 'var(--cyan)', marginTop: 2 }}>📝 {site.note}</div>
        )}
        {actual && (
          <div style={{ fontSize: 11, marginTop: 2, color: actual.complete ? 'var(--green)' : 'var(--cyan)' }}>
            площадка: {Math.round(actual.progress)} %
            {siteProgress?.deliveredTons != null && siteProgress?.requiredTons != null
              ? ` · ${formatTons(siteProgress.deliveredTons)} из ${formatTons(siteProgress.requiredTons)}`
              : ''}
            {siteProgress?.matchKind === 'type' ? ' · совпало по типу' : ''}
            {siteProgress?.matchKind === 'body' ? ' · совпало по телу' : ''}
          </div>
        )}
        {siteProgress?.mismatch && (
          <div style={{ fontSize: 11, marginTop: 2, color: 'var(--orange)' }}>{siteProgress.mismatch}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canBePrimary(site.installationId) && (
          <button
            type="button"
            onClick={() => onTogglePrimary(site.id)}
            title={isPrimary
              ? 'Снять пометку основного порта'
              : 'Назначить основным портом: строится с колониального корабля, очков не тратит, материалов больше'}
            style={{
              ...ghostButton,
              ...(isPrimary ? { borderColor: 'var(--orange)', color: 'var(--orange)' } : {}),
              padding: '6px 8px',
            }}
          >
            {isPrimary ? '★ основной' : '☆ основной'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onCycle(site.id, nextStatus)}
          style={{ ...ghostButton, color: STATUS_TONES[site.status], borderColor: STATUS_TONES[site.status] }}
        >
          {STATUS_LABELS[site.status]}
        </button>
        <button type="button" style={ghostButton} onClick={() => onEdit(site.id)}>
          изменить
        </button>
        <button type="button" style={{ ...ghostButton, color: 'var(--red)' }} onClick={() => onRemove(site.id)}>
          удалить
        </button>
      </div>
    </div>
  );
}

/** Число в русском формате: разделитель разрядов, не больше двух знаков дроби. */
function formatNumber(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function Tag({ label, tone }: { label: string; tone: string }) {
  return (
    <span style={{ fontSize: 11, color: tone, border: `1px solid ${tone}`, borderRadius: 3, padding: '1px 6px' }}>
      {label}
    </span>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: 14,
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  color: 'var(--text)',
  padding: '8px 10px',
  borderRadius: 3,
  fontSize: 13,
};

const primaryButton: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--orange)',
  color: 'var(--orange)',
  padding: '7px 14px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: 'ui-monospace, monospace',
};

const ghostButton: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line)',
  color: 'var(--muted)',
  padding: '6px 12px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
};

// Граница разбита на составляющие: рядом с `borderColor` из активного состояния
// шортхенд `border` вызывал предупреждение React о смешении свойств.
const chipStyle: React.CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--muted)',
  padding: '3px 9px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
};

const chipActive: React.CSSProperties = {
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
};

const linkButton: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--cyan)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
};

const betaBadge: React.CSSProperties = {
  border: '1px solid var(--orange)',
  color: 'var(--orange)',
  fontSize: 11,
  letterSpacing: 1,
  textTransform: 'uppercase',
  padding: '3px 8px',
  borderRadius: 3,
  fontFamily: 'ui-monospace, monospace',
};
