'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InstallationPicker from '@/components/Architect/InstallationPicker';
import PlanSummary from '@/components/Architect/PlanSummary';
import ProgressPanel from '@/components/Architect/ProgressPanel';
import SharePanel from '@/components/Architect/SharePanel';
import SourcingPanel from '@/components/Architect/SourcingPanel';
import { CATALOGUE_VERSION } from '@/lib/architect/catalogue';
import {
  matchProgress,
  parseActualSites,
  type ActualSite,
  type ProgressReport,
  type SiteProgress,
} from '@/lib/architect/progress';
import type { PlanView } from '@/lib/architect/store';
import {
  PLAN_FORMAT_VERSION,
  addSite,
  createPlan,
  evaluatePlan,
  formatTons,
  fromScanRecords,
  getInstallation,
  parsePlan,
  placementCheck,
  planToStructures,
  predictSurfaceSlots,
  removeSite,
  serializePlan,
  setSiteStatus,
  summarizePlan,
  surfaceSlotReason,
} from '@/lib/architect/planner';
import type { ArchitectBody, ArchitectPlan, PlannedSiteStatus } from '@/lib/architect/types';

const SystemOrrery3D = dynamic(() => import('@/components/SystemMap/SystemOrrery3D'), { ssr: false });

const PLAN_PREFIX = 'ed-architect:plan:';
const RECENT_KEY = 'ed-architect:recent';
const STATUS_ORDER: PlannedSiteStatus[] = ['plan', 'building', 'complete'];
const STATUS_LABELS: Record<PlannedSiteStatus, string> = { plan: 'план', building: 'строится', complete: 'готово' };
const KIND_LABELS: Record<ArchitectBody['kind'], string> = { star: 'звезда', planet: 'планета', moon: 'луна' };

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
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [plan, setPlan] = useState<ArchitectPlan | null>(null);
  const [pickerBody, setPickerBody] = useState<string>('');
  const [showMap, setShowMap] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // Серверная копия плана: null — план пока только черновик в браузере.
  const [remoteId, setRemoteId] = useState<string | null>(null);
  const [actualSites, setActualSites] = useState<ActualSite[]>([]);
  const [progressFetched, setProgressFetched] = useState(false);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState('');
  const [progressSource, setProgressSource] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const bodies = useMemo<ArchitectBody[]>(() => fromScanRecords(rawRows, systemName), [rawRows, systemName]);
  const bodiesByName = useMemo(() => new Map(bodies.map((body) => [body.name, body])), [bodies]);
  const evaluation = useMemo(
    () => (plan ? evaluatePlan(plan, bodies) : null),
    [plan, bodies],
  );
  const structures = useMemo(() => (plan ? planToStructures(plan) : []), [plan]);
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
        setProgressError(String(data?.error || `Прогресс недоступен (HTTP ${response.status})`));
        return;
      }
      setActualSites(parseActualSites(data));
      setProgressSource(String(data?.source || 'raven'));
      setProgressFetched(true);
    } catch (error) {
      setActualSites([]);
      setProgressFetched(false);
      setProgressSource('');
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
    try {
      const response = await fetch(`/api/atlas/system-bodies?system=${encodeURIComponent(target)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const rows = Array.isArray(data?.bodies) ? data.bodies : [];
      if (rows.length === 0) {
        setRawRows([]);
        setSystemName(target);
        setSource('');
        setLoadError('Тел в системе не найдено: проверьте название или загрузите сканы через Colonial Helper.');
        setPlan(overridePlan ?? createPlan(target));
        void loadProgress(target);
        return;
      }
      setRawRows(rows);
      setSystemName(target);
      setSource(String(data?.source || 'edsm'));
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
      setNotice(parsed.warning || `Открыт план «${view.title || 'без названия'}» автора ${view.authorName}`);
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

  const pickInstallation = useCallback((installationId: string) => {
    if (!plan) return;
    const body = bodiesByName.get(pickerBody);
    const check = placementCheck(body, installationId, plan);
    if (!check.ok) {
      setNotice(check.errors.join('; '));
      return;
    }
    setPlan(addSite(plan, pickerBody, installationId));
    setPickerBody('');
    setNotice('');
  }, [plan, pickerBody, bodiesByName]);

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

  return (
    <main style={{ maxWidth: 1440, margin: '24px auto', padding: '0 16px' }}>
      <header style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, color: 'var(--text)' }}>Архитектор системы</h1>
            <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, maxWidth: 860 }}>
              Планировщик застройки под колонизацию: выберите систему, распределите постройки по телам —
              инструмент посчитает наземные слоты, очки системы (T2/T3), порядок стройки, товары и тоннаж,
              которые надо привезти.
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
            Тел: {bodies.length} · источник: {source || '—'}
            {plan && plan.sites.length > 0 ? ` · в плане: ${plan.sites.length}` : ''}
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
            <li>Следите за очками системы: первый порт бесплатный, а каждый следующий порт дороже.</li>
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

            {bodies.length === 0 && (
              <div style={{ ...cardStyle, color: 'var(--muted)', fontSize: 13 }}>
                Тела не загружены — планировать можно только по названию тела, проверка слотов будет недоступна.
              </div>
            )}

            {bodies.map((body) => (
              <BodyCard
                key={body.name}
                body={body}
                plan={plan}
                progressBySite={progressBySite}
                onAdd={() => setPickerBody(body.name)}
                onRemove={(siteId) => setPlan(removeSite(plan, siteId))}
                onCycle={(siteId, status) => setPlan(setSiteStatus(plan, siteId, status))}
              />
            ))}

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
            <PlanSummary plan={plan} evaluation={evaluation} />
            <ProgressPanel
              systemName={systemName}
              report={progress}
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
        />
      )}

      <style>{`
        @media (max-width: 980px) {
          .architect-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </main>
  );
}

function BodyCard({
  body,
  plan,
  progressBySite,
  onAdd,
  onRemove,
  onCycle,
}: {
  body: ArchitectBody;
  plan: ArchitectPlan;
  progressBySite: Map<string, SiteProgress>;
  onAdd: () => void;
  onRemove: (siteId: string) => void;
  onCycle: (siteId: string, status: PlannedSiteStatus) => void;
}) {
  const sites = plan.sites.filter((site) => site.bodyName === body.name);
  const surfaceLimit = predictSurfaceSlots(body);
  const surfaceUsed = sites.filter((site) => getInstallation(site.installationId)?.location === 'surface').length;
  const orbitalUsed = sites.length - surfaceUsed;
  const blocked = body.kind !== 'star' ? surfaceSlotReason(body) : '';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 16, color: 'var(--text)' }}>{body.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {body.subType} · {KIND_LABELS[body.kind]} · {body.distanceLs.toLocaleString('ru-RU')} св. с
            {body.radiusKm > 0 ? ` · R ${body.radiusKm.toLocaleString('ru-RU')} км` : ''}
            {body.tempK > 0 ? ` · ${body.tempK} K` : ''}
            {body.gravity > 0 ? ` · ${body.gravity} g` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: surfaceLimit > 0 ? 'var(--muted)' : 'var(--red)' }}>
            {body.kind === 'star'
              ? `орбитальных: ${orbitalUsed}`
              : surfaceLimit > 0
                ? `наземных слотов: ${surfaceUsed} из ${surfaceLimit} · орбитальных: ${orbitalUsed}`
                : blocked}
          </span>
          <button type="button" onClick={onAdd} style={primaryButton}>+ постройка</button>
        </div>
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Tag tone={body.landable ? 'var(--green)' : 'var(--muted)'} label={body.landable ? 'есть посадка' : 'нет посадки'} />
        {body.terraformable && <Tag tone="var(--cyan)" label="терраформируемое" />}
        {body.hasAtmosphere && <Tag tone="var(--cyan)" label="атмосфера" />}
        {body.volcanism && <Tag tone="var(--cyan)" label="вулканизм" />}
        {body.hasRings && <Tag tone="var(--cyan)" label="кольца / пояс" />}
      </div>

      {sites.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sites.map((site) => {
            const installation = getInstallation(site.installationId);
            if (!installation) {
              return (
                <div key={site.id} style={{ color: 'var(--red)', fontSize: 12 }}>
                  Неизвестная постройка «{site.installationId}»{' '}
                  <button type="button" style={linkButton} onClick={() => onRemove(site.id)}>удалить</button>
                </div>
              );
            }
            const nextStatus = STATUS_ORDER[(STATUS_ORDER.indexOf(site.status) + 1) % STATUS_ORDER.length];
            const siteProgress = progressBySite.get(site.id);
            const actual = siteProgress?.actual ?? null;
            return (
              <div
                key={site.id}
                style={{
                  display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between',
                  border: '1px solid var(--line)', borderRadius: 3, padding: '6px 8px', background: 'var(--bg)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)' }}>
                    {installation.nameRu}
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {installation.id}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {installation.location === 'surface' ? 'поверхность' : 'орбита'} · T{installation.tier}
                    {' · '}
                    {formatTons(installation.haulTons)}
                    {installation.needs.count > 0 ? ` · нужно ${installation.needs.count} очк. T${installation.needs.tier}` : ''}
                    {installation.gives.count > 0 ? ` · даёт ${installation.gives.count} очк. T${installation.gives.tier}` : ''}
                  </div>
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
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" style={ghostButton} onClick={() => onCycle(site.id, nextStatus)}>
                    {STATUS_LABELS[site.status]}
                  </button>
                  <button type="button" style={{ ...ghostButton, color: 'var(--red)' }} onClick={() => onRemove(site.id)}>
                    удалить
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
