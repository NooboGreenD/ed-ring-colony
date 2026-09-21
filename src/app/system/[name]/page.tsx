'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  IconXCircle,
  IconGlobe,
  IconPlane,
  IconExternalLink,
  IconChart,
  IconCheckCircle,
  IconConstruction,
  IconPackage,
  IconCheck,
} from '@/components/Icons';

import { buildOrreryLayout, summarizeLayout, toStructures } from '@/lib/systemOrrery';
import { STAR_CLASS_LABELS, type StarClass } from '@/lib/galaxySystems';

const SystemPlotlyMap = dynamic(() => import('@/components/SystemPlotlyMap'), {
  ssr: false,
});

interface ResourceData {
  name: string;
  key: string;
  required?: number | null;
  provided?: number | null;
  remaining: number;
  /** true only for a source with RequiredAmount and ProvidedAmount per item */
  exact?: boolean;
}

interface ProjectData {
  buildId: string;
  buildName: string;
  buildType: string | null;
  complete: boolean;
  progress: number;
  bodyName: string | null;
  totalRequired?: number | null;
  totalProvided?: number | null;
  totalRemaining?: number;
  resources: ResourceData[];
}

interface SystemData {
  system_name: string;
  progress: number | null;
  status: string;
  found: boolean;
  siteName: string | null;
  architectName: string | null;
  projects: ProjectData[];
  resources: ResourceData[];
  totalRequired?: number | null;
  totalProvided?: number | null;
  totalRemaining?: number;
  bodies?: any[];
  updated_at?: string;
  error?: string;
}

function hasExactAmounts(resource: ResourceData): resource is ResourceData & { required: number; provided: number } {
  return resource.exact === true
    && typeof resource.required === 'number'
    && typeof resource.provided === 'number';
}

function formatCargo(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('ru-RU')
    : '—';
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    : '—';
}

/** Стабильный пустой массив: `?? []` на каждом рендере ломал бы зависимости useMemo. */
const NO_ROWS: any[] = [];

export default function SystemPage() {
  const { name } = useParams();
  const systemName = decodeURIComponent(name as string);
  const [system, setSystem] = useState<SystemData | null>(null);
  const [galaxy, setGalaxy] = useState<{
    id64: string;
    name: string;
    x: number;
    y: number;
    z: number;
    main_star: string | null;
    star_type: StarClass;
    star_giant_class: string | null;
    needs_permit: boolean | null;
    distance_from_sols: number | null;
    distance_from_sgra: number | null;
  } | null>(null);
  const [bodies, setBodies] = useState<any[]>([]);
  const [mapFocus, setMapFocus] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/systems/progress?name=${encodeURIComponent(systemName)}`, { cache: 'no-store' })
        .then((response) => response.json())
        .catch(() => null),
      fetch(`/api/atlas/system-bodies?system=${encodeURIComponent(systemName)}`, { cache: 'no-store' })
        .then((response) => response.json())
        .then((data) => (Array.isArray(data?.bodies) ? data.bodies : []))
        .catch(() => []),
      fetch(`/api/galaxy/systems/by-name?name=${encodeURIComponent(systemName)}`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ])
      .then(([progress, scanBodies, catalog]) => {
        if (cancelled) return;
        setSystem(progress);
        setBodies(scanBodies);
        setGalaxy(catalog?.name ? catalog : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [systemName]);

  // ВСЕ хуки — до ранних return'ов. Если `useMemo` стоит после `if (loading)
  // return`, то на первом рендере их меньше, чем на втором: React видит другое
  // число хуков, кидает "Rendered more hooks than during the previous render"
  // и страница падает с «Application error: a client-side exception».
  // Поэтому расчёт оверрея идёт здесь, а `system` на этом этапе ещё может быть
  // null — отсюда NO_ROWS и необязательные поля.
  const orreryStructures = useMemo(() => toStructures(system?.projects ?? NO_ROWS), [system]);

  // Та же геометрия, что и у 3D-карты: карточки тел обязаны называть те же
  // классы/дистанции и те же постройки, что и оверей на карте.
  const orreryLayout = useMemo(
    () => buildOrreryLayout(bodies.length ? bodies : system?.bodies ?? NO_ROWS, systemName, {}),
    [bodies, system, systemName],
  );
  const orrerySummary = useMemo(() => summarizeLayout(orreryLayout, orreryStructures), [orreryLayout, orreryStructures]);
  const structureByBody = useMemo(() => {
    const map: Record<string, typeof orreryStructures> = {};
    for (const structure of orreryStructures) {
      const key = orreryLayout.bodies.find((body) => body.name.toLowerCase() === (structure.bodyName || '').toLowerCase())?.name ?? structure.bodyName;
      if (!key) continue;
      (map[key] ??= []).push(structure);
    }
    return map;
  }, [orreryStructures, orreryLayout]);

  if (loading) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40, textAlign: 'center' }}>
        <div style={{ color: '#e67e22', fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 2 }}>
          Загрузка системы...
        </div>
      </main>
    );
  }

  if ((!system || !system.found) && galaxy) {
    const starLabel = STAR_CLASS_LABELS[galaxy.star_type] || galaxy.star_type;
    return (
      <main className="card" style={{ maxWidth: 1280, margin: '24px auto', padding: 28, borderRadius: 4 }}>
        <div style={{ marginBottom: 20 }}>
          <Link href="/map" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>← Назад к карте</Link>
        </div>
        <h1 style={{ fontSize: 28, color: '#eeeeee', marginBottom: 8 }}>{galaxy.name}</h1>
        <p style={{ color: '#9ca3af', marginTop: 0 }}>
          Система есть в каталоге Spansh. Стройки на маршруте колонии здесь нет — это не статус «запланировано».
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' }}>Главная звезда</div>
            <div style={{ color: '#eeeeee' }}>{starLabel}</div>
            {galaxy.main_star && <div style={{ fontSize: 12, color: '#9ca3af' }}>{galaxy.main_star}</div>}
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' }}>Координаты</div>
            <div style={{ color: '#eeeeee', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
              {galaxy.x.toFixed(2)}, {galaxy.y.toFixed(2)}, {galaxy.z.toFixed(2)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' }}>До Sol / Sgr A*</div>
            <div style={{ color: '#eeeeee' }}>
              {galaxy.distance_from_sols != null ? `${Number(galaxy.distance_from_sols).toFixed(1)} св.лет` : '—'}
              {' · '}
              {galaxy.distance_from_sgra != null ? `${Number(galaxy.distance_from_sgra).toFixed(1)} св.лет` : '—'}
            </div>
          </div>
          {galaxy.needs_permit && (
            <div style={{ color: '#f87171' }}>Нужен permit</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(galaxy.name)}`} target="_blank" rel="noopener noreferrer" style={{ padding: '8px 16px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#3b82f6', borderRadius: 3, textDecoration: 'none', fontSize: 13 }}>EDSM <IconExternalLink size={10} /></a>
          <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(galaxy.name)}`} target="_blank" rel="noopener noreferrer" style={{ padding: '8px 16px', background: 'rgba(230,126,34,0.15)', border: '1px solid rgba(230,126,34,0.4)', color: '#e67e22', borderRadius: 3, textDecoration: 'none', fontSize: 13 }}>Raven <IconExternalLink size={10} /></a>
          <a href={`https://spansh.co.uk/system/${encodeURIComponent(galaxy.id64)}`} target="_blank" rel="noopener noreferrer" style={{ padding: '8px 16px', background: 'rgba(255,209,102,0.12)', border: '1px solid rgba(255,209,102,0.35)', color: '#ffd166', borderRadius: 3, textDecoration: 'none', fontSize: 13 }}>Spansh <IconExternalLink size={10} /></a>
        </div>
        {bodies.length > 0 && (
          <SystemPlotlyMap systemName={galaxy.name} projects={[]} initialBodies={bodies} focusTarget={mapFocus} onFocusChange={setMapFocus} />
        )}
        {orreryLayout.bodies.length > 0 && (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>В локальных сканах {orreryLayout.bodies.length} тел.</p>
        )}
      </main>
    );
  }

  if (!system || !system.found) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40 }}>
        <h1 style={{ color: '#e74c3c' }}><IconXCircle size={20} color="#e74c3c" /> Система не найдена</h1>
        <p style={{ color: '#9ca3af' }}>{system?.error || 'Не удалось загрузить данные системы'}</p>
        <Link href="/map" style={{ color: '#3b82f6', textDecoration: 'none' }}>← Вернуться к карте</Link>
      </main>
    );
  }

  const hasSystemCargoTotals = typeof system.totalRequired === 'number'
    && typeof system.totalProvided === 'number';
  const resourceRowsAreApproximate = system.resources.some((resource) => !hasExactAmounts(resource));
  const importedCargo = system.resources.reduce((total, resource) => (
    total + (hasExactAmounts(resource) ? resource.provided : 0)
  ), 0);
  const hasImportedCargo = hasSystemCargoTotals || importedCargo > 0;
  return (
    <main className="card" style={{ maxWidth: 1280, margin: '24px auto', padding: 28, borderRadius: 4 }}>
      <div style={{ marginBottom: 20 }}>
        <Link href="/map" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>← Назад к карте</Link>
      </div>

      <h1 style={{ fontSize: 28, color: '#eeeeee', marginBottom: 8, letterSpacing: -0.5 }}>{systemName}</h1>

      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        <a
          href={`https://ravencolonial.com/#sys=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px',
            background: 'rgba(230,126,34,0.15)',
            border: '1px solid rgba(230,126,34,0.4)',
            color: '#e67e22',
            borderRadius: 3,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <IconPlane size={12} /> RavenColonial <IconExternalLink size={10} />
        </a>
        <Link
          href={`/atlas?tab=market&system=${encodeURIComponent(systemName)}`}
          style={{
            padding: '8px 16px', background: 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e',
            borderRadius: 3, textDecoration: 'none', fontSize: 13,
            fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <IconPackage size={12} /> Рынки рядом в Atlas
        </Link>
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px',
            background: 'rgba(59,130,246,0.15)',
            border: '1px solid rgba(59,130,246,0.4)',
            color: '#3b82f6',
            borderRadius: 3,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <IconGlobe size={12} /> EDSM <IconExternalLink size={10} />
        </a>
      </div>

      {system.error && (
        <div style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 6, color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', fontSize: 12 }}>
          {system.error}
        </div>
      )}

      {/* Статус строительства */}
      <div style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 4, padding: 20, marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}><IconChart size={18} /> Статус строительства</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Прогресс</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: system.progress === 100 ? '#22c55e' : '#e67e22' }}>
              {system.progress == null ? '—' : `${formatPercent(system.progress)}%`}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Статус</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: system.status === 'done' ? '#22c55e' : system.status === 'building' ? '#e67e22' : '#3b82f6' }}>
              {system.status === 'done' ? <><IconCheckCircle size={16} /> Завершён</> : system.status === 'building' ? <><IconConstruction size={16} /> Строительство</> : <><IconCheck size={16} /> Запланирован</>}
            </div>
          </div>
          {hasImportedCargo && (
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Груз доставлен</div>
              <div style={{ fontSize: 16, color: '#eeeeee', fontWeight: 600 }}>
                {formatCargo(hasSystemCargoTotals ? system.totalProvided : importedCargo)} / {formatCargo(system.totalRequired)} т
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                Осталось: {formatCargo(system.totalRemaining)} т
              </div>
            </div>
          )}
          {system.siteName && (
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Сайт</div>
              <div style={{ fontSize: 16, color: '#eeeeee' }}>{system.siteName}</div>
            </div>
          )}
          {system.architectName && (
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Архитектор</div>
              <div style={{ fontSize: 16, color: '#eeeeee' }}>{system.architectName}</div>
            </div>
          )}
          {system.updated_at && (
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Обновлено</div>
              <div style={{ fontSize: 14, color: '#9ca3af' }}>{new Date(system.updated_at).toLocaleString('ru-RU')}</div>
            </div>
          )}
        </div>
      </div>

      {/* Интерактивная 3D-карта системы Plotly */}
      <SystemPlotlyMap
        systemName={systemName}
        projects={system.projects}
        initialBodies={bodies}
        focusTarget={mapFocus}
        onFocusChange={setMapFocus}
      />

      {/* Проекты / Постройки */}
      {system.projects.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}><IconConstruction size={18} /> Постройки ({system.projects.length})</h2>
          <div style={{ display: 'grid', gap: 12 }}>
            {system.projects.map((project) => {
              const hasProjectCargoTotals = typeof project.totalRequired === 'number'
                && typeof project.totalProvided === 'number';
              const hasApproximateRows = project.resources.some((resource) => !hasExactAmounts(resource));

              return (
                <div key={project.buildId} style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 10, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: '#eeeeee' }}>{project.buildName}</span>
                    <span style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: project.complete ? '#22c55e' : '#e67e22',
                      padding: '4px 10px',
                      background: project.complete ? 'rgba(34,197,94,0.1)' : 'rgba(230,126,34,0.1)',
                      borderRadius: 4,
                    }}>
                      {project.complete ? <><IconCheckCircle size={16} /> Завершён</> : `${formatPercent(project.progress)}%`}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
                    {project.buildType && (
                      <div style={{ fontSize: 13, color: '#9ca3af' }}>
                        <span style={{ color: '#eeeeee' }}>Тип:</span> {project.buildType}
                      </div>
                    )}
                    {project.bodyName && (
                      <div style={{ fontSize: 13, color: '#9ca3af' }}>
                        <span style={{ color: '#eeeeee' }}>Тело:</span> {project.bodyName}
                      </div>
                    )}
                    {project.buildId && (
                      <div style={{ fontSize: 13, color: '#9ca3af' }}>
                        <span style={{ color: '#eeeeee' }}>ID:</span> {project.buildId}
                      </div>
                    )}
                    {project.bodyName && (
                      <div style={{ fontSize: 13 }}>
                        <button
                          onClick={() => setMapFocus(project.bodyName ?? '')}
                          style={{ background: 'rgba(0,243,255,0.08)', border: '1px solid rgba(0,243,255,0.35)', color: '#00f3ff', borderRadius: 4, fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                        >
                          🎯 показать на карте
                        </button>
                      </div>
                    )}
                  </div>

                  {hasProjectCargoTotals && (
                    <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 6, background: 'rgba(59,130,246,0.09)', color: '#d1d5db', fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <IconPackage size={13} color="#60a5fa" />
                      <span>Доставлено:</span>
                      <strong style={{ color: '#eeeeee' }}>{formatCargo(project.totalProvided)} / {formatCargo(project.totalRequired)} т</strong>
                      <span style={{ color: '#9ca3af' }}>· Осталось: {formatCargo(project.totalRemaining)} т</span>
                    </div>
                  )}

                  {project.resources.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 8, fontWeight: 600 }}><IconPackage size={11} /> Ресурсы проекта</div>
                      <div style={{ display: 'grid', gap: 6 }}>
                        {project.resources.map((resource) => {
                          const exact = hasExactAmounts(resource);
                          const percent = exact && resource.required > 0
                            ? Math.min(100, (resource.provided / resource.required) * 100)
                            : 0;

                          return (
                            <div key={resource.key} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#323538', borderRadius: 6, padding: '8px 12px' }}>
                              <span style={{ color: '#eeeeee', fontSize: 13, minWidth: 140 }}>{resource.name}</span>
                              {exact ? (
                                <div style={{ flex: 1, background: '#3a3d40', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                                  <div style={{
                                    width: `${percent}%`,
                                    background: resource.remaining === 0 ? '#22c55e' : '#3b82f6',
                                    height: '100%',
                                    borderRadius: 4,
                                  }} />
                                </div>
                              ) : (
                                <span style={{ flex: 1, color: '#7a7d80', fontSize: 11 }}>Нет точных данных о доставке</span>
                              )}
                              <span style={{ color: '#9ca3af', fontSize: 12, minWidth: 130, textAlign: 'right' }}>
                                {exact
                                  ? `${formatCargo(resource.provided)} / ${formatCargo(resource.required)} т`
                                  : `Осталось: ${formatCargo(resource.remaining)} т`}
                              </span>
                              {resource.remaining === 0 && <span style={{ color: '#22c55e', fontSize: 11, fontWeight: 600 }}><IconCheck size={12} color="#22c55e" /></span>}
                            </div>
                          );
                        })}
                      </div>
                      {hasApproximateRows && (
                        <div style={{ marginTop: 8, color: '#9ca3af', fontSize: 11 }}>
                          RavenColonial передаёт по этим позициям текущий остаток. Общий доставленный объём выше рассчитан по исходной и оставшейся потребности.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Общие ресурсы системы */}
      {system.resources.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}><IconPackage size={18} /> Общие ресурсы системы</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
            {system.resources.map((resource) => {
              const exact = hasExactAmounts(resource);
              return (
                <div key={resource.key} style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: '#eeeeee', fontSize: 14 }}>{resource.name}</span>
                  <span style={{ color: resource.remaining === 0 ? '#22c55e' : '#e67e22', fontSize: 13, fontWeight: 600, textAlign: 'right' }}>
                    {exact
                      ? `${formatCargo(resource.provided)} / ${formatCargo(resource.required)} т`
                      : `Осталось: ${formatCargo(resource.remaining)} т`}
                  </span>
                </div>
              );
            })}
          </div>
          {resourceRowsAreApproximate && (
            <p style={{ color: '#9ca3af', fontSize: 11, marginTop: 10, marginBottom: 0 }}>
              Для общего списка RavenColonial публикует остаток по товару, а не историческое распределение доставок по каждой позиции.
            </p>
          )}
        </div>
      )}

      {/* Тела системы карточками — тот же оверей-движок, что и у 3D-карты */}
      {orreryLayout.bodies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ fontSize: 18, color: '#eeeeee', margin: 0 }}>
              <IconGlobe size={16} color="#9ca3af" /> Тела системы ({orreryLayout.bodies.length})
            </h2>
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              ★ {orrerySummary.stars} · планет {orrerySummary.planets} · лун {orrerySummary.moons} · с посадкой {orrerySummary.landable}
            </span>
          </div>
          {orreryLayout.clusters.map((cluster) => (
            <div key={cluster.starName || 'system'} style={{ marginBottom: 14 }}>
              {orreryLayout.clusters.length > 1 && (
                <button
                  onClick={() => setMapFocus(cluster.starName)}
                  style={{ background: 'transparent', border: 'none', color: '#e67e22', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '2px 0', marginBottom: 6 }}
                >
                  ★ {cluster.starName.replace(`${systemName} `, '')} · тел {cluster.bodies.length} → фокус на карте
                </button>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
                {cluster.bodies.map((body) => {
                  const bodyStructures = structureByBody[body.name] ?? [];
                  return (
                    <button
                      key={body.name}
                      onClick={() => setMapFocus(body.name)}
                      title="Показать тело на 3D-карте"
                      style={{ textAlign: 'left', background: '#25282b', border: '1px solid #323538', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', color: '#eeeeee' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{body.name.replace(`${systemName} `, '')}</span>
                        <span style={{ fontSize: 10, color: '#9ca3af' }}>{body.kind === 'moon' ? 'луна' : 'планета'}</span>
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                        {body.subType || 'тело'}
                        {body.distanceLs > 0 ? ` · ${Math.round(body.distanceLs)} св. с` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>
                        {body.radiusM > 0 ? `${Math.round(body.radiusM / 1000).toLocaleString('ru-RU')} км` : ''}
                        {body.gravity > 0 ? ` · ${(body.gravity / 9.80665).toFixed(2)} g` : ''}
                        {body.tempK > 0 ? ` · ${Math.round(body.tempK)} K` : ''}
                      </div>
                      {(body.landable || body.bioSignals > 0 || body.rings.length > 0 || bodyStructures.length > 0) && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5, fontSize: 10 }}>
                          {body.landable && <span style={{ color: '#00f3ff', background: 'rgba(0,243,255,0.1)', padding: '1px 6px', borderRadius: 4 }}>🛬 посадка</span>}
                          {body.bioSignals > 0 && <span style={{ color: '#22c55e', background: 'rgba(34,197,94,0.12)', padding: '1px 6px', borderRadius: 4 }}>🌿 {body.bioSignals}</span>}
                          {body.rings.length > 0 && <span style={{ color: '#9fd8ef', background: 'rgba(159,216,239,0.12)', padding: '1px 6px', borderRadius: 4 }}>💍 {body.rings.length}</span>}
                          {bodyStructures.length > 0 && <span style={{ color: '#ff9f43', background: 'rgba(230,126,34,0.14)', padding: '1px 6px', borderRadius: 4 }}>🏗 {bodyStructures.length}</span>}
                        </div>
                      )}
                      {bodyStructures.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#c9d1d9', display: 'grid', gap: 2 }}>
                          {bodyStructures.map((structure) => (
                            <div key={structure.id}>
                              🏗 {structure.name} · <span style={{ color: structure.complete ? '#22c55e' : '#e67e22' }}>{structure.complete ? 'готово' : `${structure.progress.toFixed(0)}%`}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
