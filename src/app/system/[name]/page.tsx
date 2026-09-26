'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
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

import { buildOrreryLayout, habitableZoneLs, toStructures } from '@/lib/systemOrrery';
import SystemOrrery3D from '@/components/SystemMap/SystemOrrery3D';
import { STAR_CLASS_LABELS, type StarClass } from '@/lib/galaxySystems';

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

/**
 * Стили страницы системы приведены к общему стилю сайта (DESIGN.md):
 * плоские панели без теней и тонировок, радиус не больше 4 px, заголовки —
 * моноширинные, в верхнем регистре, с трекингом 2 px, цвета — только из
 * палитры CSS-переменных. Раньше страница жила на своих hex-кодах и радиусах
 * 6–12 px и заметно выбивалась из остального интерфейса.
 */
const pageStyle: React.CSSProperties = {
  maxWidth: 1280,
  margin: '24px auto',
  padding: 24,
  borderRadius: 4,
};

const titleStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  color: 'var(--text)',
  letterSpacing: 2,
  textTransform: 'uppercase',
  margin: '0 0 6px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--orange)',
  letterSpacing: 2,
  textTransform: 'uppercase',
  margin: '0 0 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--muted)',
  letterSpacing: 2,
  textTransform: 'uppercase',
  marginBottom: 4,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const panelStyle: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: 18,
  marginBottom: 20,
};

const innerPanelStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '10px 12px',
};

/** Кнопка-ссылка в шапке: единый вид для внешних сервисов и разделов сайта. */
function linkButtonStyle(tone: string): React.CSSProperties {
  return {
    padding: '8px 14px',
    background: 'transparent',
    border: `1px solid ${tone}`,
    color: tone,
    borderRadius: 2,
    textDecoration: 'none',
    fontSize: 12,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  };
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
  // Фокус карты синхронизирован со ссылкой: `?body=…` можно отправить коллеге,
  // и он откроет ту же систему с тем же выделенным телом.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('body');
    if (requested) setMapFocus(requested);
  }, [systemName]);

  // Факты о звёздах системы: класс, температура, обитаемая зона. Раньше это
  // приходилось смотреть в сторонних сервисах, а карта показывала только тела.
  const starFacts = useMemo(() => orreryLayout.stars.map((star) => ({
    name: star.name,
    short: star.name.replace(`${systemName} `, ''),
    cls: star.subType,
    tempK: star.tempK,
    radiusM: star.radiusM,
    distanceLs: star.distanceLs,
    zone: habitableZoneLs(star),
  })), [orreryLayout.stars, systemName]);

  const changeMapFocus = useCallback((target: string) => {
    setMapFocus(target);
    const url = new URL(window.location.href);
    if (target) url.searchParams.set('body', target);
    else url.searchParams.delete('body');
    window.history.replaceState(null, '', url.toString());
  }, []);

  if (loading) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40, textAlign: 'center' }}>
        <div style={{ color: 'var(--orange)', fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 2 }}>
          Загрузка системы...
        </div>
      </main>
    );
  }

  if ((!system || !system.found) && galaxy) {
    const starLabel = STAR_CLASS_LABELS[galaxy.star_type] || galaxy.star_type;
    return (
      <main className="card" style={pageStyle}>
        <div style={{ marginBottom: 20 }}>
          <Link href="/map" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>← Назад к карте</Link>
        </div>
        <h1 style={titleStyle}>{galaxy.name}</h1>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          Система есть в каталоге Spansh. Стройки на маршруте колонии здесь нет — это не статус «запланировано».
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          <div>
            <div style={labelStyle}>Главная звезда</div>
            <div style={{ color: 'var(--text)' }}>{starLabel}</div>
            {galaxy.main_star && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{galaxy.main_star}</div>}
          </div>
          <div>
            <div style={labelStyle}>Координаты</div>
            <div style={{ color: 'var(--text)', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
              {galaxy.x.toFixed(2)}, {galaxy.y.toFixed(2)}, {galaxy.z.toFixed(2)}
            </div>
          </div>
          <div>
            <div style={labelStyle}>До Sol / Sgr A*</div>
            <div style={{ color: 'var(--text)' }}>
              {galaxy.distance_from_sols != null ? `${Number(galaxy.distance_from_sols).toFixed(1)} св.лет` : '—'}
              {' · '}
              {galaxy.distance_from_sgra != null ? `${Number(galaxy.distance_from_sgra).toFixed(1)} св.лет` : '—'}
            </div>
          </div>
          {galaxy.needs_permit && (
            <div style={{ color: 'var(--red)' }}>Нужен permit</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(galaxy.name)}`} target="_blank" rel="noopener noreferrer" style={linkButtonStyle('var(--cyan)')}>EDSM <IconExternalLink size={10} /></a>
          <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(galaxy.name)}`} target="_blank" rel="noopener noreferrer" style={linkButtonStyle('var(--orange)')}>Raven <IconExternalLink size={10} /></a>
          <a href={`https://spansh.co.uk/system/${encodeURIComponent(galaxy.id64)}`} target="_blank" rel="noopener noreferrer" style={linkButtonStyle('var(--orange)')}>Spansh <IconExternalLink size={10} /></a>
        </div>
        {bodies.length > 0 && (
          <SystemOrrery3D
            systemName={galaxy.name}
            bodies={bodies}
            layout={orreryLayout}
            structures={[]}
            focusTarget={mapFocus}
            onFocusChange={changeMapFocus}
            height={520}
          />
        )}
        {orreryLayout.bodies.length > 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>В локальных сканах {orreryLayout.bodies.length} тел.</p>
        )}
      </main>
    );
  }

  if (!system || !system.found) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40 }}>
        <h1 style={{ color: 'var(--red)' }}><IconXCircle size={20} color="var(--red)" /> Система не найдена</h1>
        <p style={{ color: 'var(--muted)' }}>{system?.error || 'Не удалось загрузить данные системы'}</p>
        <Link href="/map" style={{ color: 'var(--cyan)', textDecoration: 'none' }}>← Вернуться к карте</Link>
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
    <main className="card" style={pageStyle}>
      <div style={{ marginBottom: 20 }}>
        <Link href="/map" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>← Назад к карте</Link>
      </div>

      <h1 style={titleStyle}>{systemName}</h1>

      {/* Ссылки на внешние источники и разделы сайта — один стиль кнопок HUD. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <a
          href={`https://ravencolonial.com/#sys=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={linkButtonStyle('var(--orange)')}
        >
          <IconPlane size={12} /> RavenColonial <IconExternalLink size={10} />
        </a>
        <Link href={`/architect?system=${encodeURIComponent(systemName)}`} style={linkButtonStyle('var(--orange)')}>
          <IconConstruction size={12} /> Архитектор системы
        </Link>
        <Link
          href={`/atlas?tab=market&system=${encodeURIComponent(systemName)}`}
          style={linkButtonStyle('var(--green)')}
        >
          <IconPackage size={12} /> Рынки рядом
        </Link>
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={linkButtonStyle('var(--cyan)')}
        >
          <IconGlobe size={12} /> EDSM <IconExternalLink size={10} />
        </a>
      </div>

      {system.error && (
        <div style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 3, color: 'var(--orange)', background: 'transparent', border: '1px solid var(--line)', fontSize: 12 }}>
          {system.error}
        </div>
      )}

      {/* Статус строительства */}
      <div style={panelStyle}>
        <h2 style={sectionTitleStyle}><IconChart size={18} /> Статус строительства</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div>
            <div style={labelStyle}>Прогресс</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: system.progress === 100 ? 'var(--green)' : 'var(--orange)' }}>
              {system.progress == null ? '—' : `${formatPercent(system.progress)}%`}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Статус</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: system.status === 'done' ? 'var(--green)' : system.status === 'building' ? 'var(--orange)' : 'var(--cyan)' }}>
              {system.status === 'done' ? <><IconCheckCircle size={16} /> Завершён</> : system.status === 'building' ? <><IconConstruction size={16} /> Строительство</> : <><IconCheck size={16} /> Запланирован</>}
            </div>
          </div>
          {hasImportedCargo && (
            <div>
              <div style={labelStyle}>Груз доставлен</div>
              <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 600 }}>
                {formatCargo(hasSystemCargoTotals ? system.totalProvided : importedCargo)} / {formatCargo(system.totalRequired)} т
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                Осталось: {formatCargo(system.totalRemaining)} т
              </div>
            </div>
          )}
          {system.siteName && (
            <div>
              <div style={labelStyle}>Сайт</div>
              <div style={{ fontSize: 16, color: 'var(--text)' }}>{system.siteName}</div>
            </div>
          )}
          {system.architectName && (
            <div>
              <div style={labelStyle}>Архитектор</div>
              <div style={{ fontSize: 16, color: 'var(--text)' }}>{system.architectName}</div>
            </div>
          )}
          {system.updated_at && (
            <div>
              <div style={labelStyle}>Обновлено</div>
              <div style={{ fontSize: 14, color: 'var(--muted)' }}>{new Date(system.updated_at).toLocaleString('ru-RU')}</div>
            </div>
          )}
        </div>
      </div>

      {/* Сводка по звёздам и обитаемым зонам: цифры, которые нужны при выборе
          площадки, — без похода в EDSM и Spansh. */}
      {(starFacts.length > 0 || galaxy) && (
        <div style={panelStyle}>
          <h2 style={sectionTitleStyle}><IconGlobe size={18} /> Система и обитаемые зоны</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {starFacts.map((star) => (
              <div key={star.name} style={innerPanelStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ color: 'var(--orange)', fontWeight: 700, fontSize: 14 }}>★ {star.short}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>{star.cls || 'класс неизвестен'}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6, fontSize: 11.5, color: 'var(--muted)' }}>
                  {star.tempK > 0 && <span>{Math.round(star.tempK).toLocaleString('ru-RU')} K</span>}
                  {star.radiusM > 0 && <span>{Math.round(star.radiusM / 1000).toLocaleString('ru-RU')} км</span>}
                  {star.distanceLs > 0 && <span>{Math.round(star.distanceLs).toLocaleString('ru-RU')} св. с от входа</span>}
                </div>
                {star.zone[0] > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 6, lineHeight: 1.5 }}>
                    Обитаемая зона: {Math.round(star.zone[0]).toLocaleString('ru-RU')}–{Math.round(star.zone[1]).toLocaleString('ru-RU')} св. с
                    <br />
                    <span style={{ color: 'var(--muted)' }}>
                      ({(star.zone[0] / 499.00478).toFixed(2)}–{(star.zone[1] / 499.00478).toFixed(2)} а.е.) — здесь стоит искать землеподобные планеты
                    </span>
                  </div>
                )}
              </div>
            ))}
            {galaxy && (
              <div style={innerPanelStyle}>
                <div style={labelStyle}>В галактике</div>
                <div style={{ color: 'var(--text)', fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
                  {galaxy.x.toFixed(2)}, {galaxy.y.toFixed(2)}, {galaxy.z.toFixed(2)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6, fontSize: 11.5, color: 'var(--muted)' }}>
                  {galaxy.distance_from_sols != null && <span>до Sol: {Number(galaxy.distance_from_sols).toFixed(1)} св. лет</span>}
                  {galaxy.distance_from_sgra != null && <span>до Sgr A*: {Number(galaxy.distance_from_sgra).toFixed(1)} св. лет</span>}
                </div>
                {galaxy.needs_permit && <div style={{ color: 'var(--red)', fontSize: 11.5, marginTop: 4 }}>нужен permit</div>}
                {galaxy.main_star && <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>каталог: {galaxy.main_star}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3D-карта системы: three.js, тот же движок, что и в Colonial Helper */}
      <SystemOrrery3D
        systemName={systemName}
        bodies={bodies}
        layout={orreryLayout}
        structures={orreryStructures}
        focusTarget={mapFocus}
        onFocusChange={changeMapFocus}
        height={640}
      />

      {/* Проекты / Постройки */}
      {system.projects.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={sectionTitleStyle}><IconConstruction size={18} /> Постройки ({system.projects.length})</h2>
          <div style={{ display: 'grid', gap: 12 }}>
            {system.projects.map((project) => {
              const hasProjectCargoTotals = typeof project.totalRequired === 'number'
                && typeof project.totalProvided === 'number';
              const hasApproximateRows = project.resources.some((resource) => !hasExactAmounts(resource));

              return (
                <div key={project.buildId} style={{ ...panelStyle, marginBottom: 0, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{project.buildName}</span>
                    <span style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: project.complete ? 'var(--green)' : 'var(--orange)',
                      padding: '4px 10px',
                      background: 'transparent',
                      borderRadius: 4,
                    }}>
                      {project.complete ? <><IconCheckCircle size={16} /> Завершён</> : `${formatPercent(project.progress)}%`}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
                    {project.buildType && (
                      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                        <span style={{ color: 'var(--text)' }}>Тип:</span> {project.buildType}
                      </div>
                    )}
                    {project.bodyName && (
                      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                        <span style={{ color: 'var(--text)' }}>Тело:</span> {project.bodyName}
                      </div>
                    )}
                    {project.buildId && (
                      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                        <span style={{ color: 'var(--text)' }}>ID:</span> {project.buildId}
                      </div>
                    )}
                    {project.bodyName && (
                      <div style={{ fontSize: 13 }}>
                        <button
                          onClick={() => setMapFocus(project.bodyName ?? '')}
                          style={{ ...linkButtonStyle('var(--cyan)'), padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}
                        >
                          показать на карте
                        </button>
                      </div>
                    )}
                  </div>

                  {hasProjectCargoTotals && (
                    <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 3, background: 'transparent', color: 'var(--text)', fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <IconPackage size={13} color="var(--cyan)" />
                      <span>Доставлено:</span>
                      <strong style={{ color: 'var(--text)' }}>{formatCargo(project.totalProvided)} / {formatCargo(project.totalRequired)} т</strong>
                      <span style={{ color: 'var(--muted)' }}>· Осталось: {formatCargo(project.totalRemaining)} т</span>
                    </div>
                  )}

                  {project.resources.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8, fontWeight: 600 }}><IconPackage size={11} /> Ресурсы проекта</div>
                      <div style={{ display: 'grid', gap: 6 }}>
                        {project.resources.map((resource) => {
                          const exact = hasExactAmounts(resource);
                          const percent = exact && resource.required > 0
                            ? Math.min(100, (resource.provided / resource.required) * 100)
                            : 0;

                          return (
                            <div key={resource.key} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--line)', borderRadius: 3, padding: '8px 12px' }}>
                              <span style={{ color: 'var(--text)', fontSize: 13, minWidth: 140 }}>{resource.name}</span>
                              {exact ? (
                                <div style={{ flex: 1, background: 'var(--line)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                                  <div style={{
                                    width: `${percent}%`,
                                    background: resource.remaining === 0 ? 'var(--green)' : 'var(--cyan)',
                                    height: '100%',
                                    borderRadius: 4,
                                  }} />
                                </div>
                              ) : (
                                <span style={{ flex: 1, color: 'var(--muted)', fontSize: 11 }}>Нет точных данных о доставке</span>
                              )}
                              <span style={{ color: 'var(--muted)', fontSize: 12, minWidth: 130, textAlign: 'right' }}>
                                {exact
                                  ? `${formatCargo(resource.provided)} / ${formatCargo(resource.required)} т`
                                  : `Осталось: ${formatCargo(resource.remaining)} т`}
                              </span>
                              {resource.remaining === 0 && <span style={{ color: 'var(--green)', fontSize: 11, fontWeight: 600 }}><IconCheck size={12} color="var(--green)" /></span>}
                            </div>
                          );
                        })}
                      </div>
                      {hasApproximateRows && (
                        <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11 }}>
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
          <h2 style={sectionTitleStyle}><IconPackage size={18} /> Общие ресурсы системы</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
            {system.resources.map((resource) => {
              const exact = hasExactAmounts(resource);
              return (
                <div key={resource.key} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 3, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: 'var(--text)', fontSize: 14 }}>{resource.name}</span>
                  <span style={{ color: resource.remaining === 0 ? 'var(--green)' : 'var(--orange)', fontSize: 13, fontWeight: 600, textAlign: 'right' }}>
                    {exact
                      ? `${formatCargo(resource.provided)} / ${formatCargo(resource.required)} т`
                      : `Осталось: ${formatCargo(resource.remaining)} т`}
                  </span>
                </div>
              );
            })}
          </div>
          {resourceRowsAreApproximate && (
            <p style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10, marginBottom: 0 }}>
              Для общего списка RavenColonial публикует остаток по товару, а не историческое распределение доставок по каждой позиции.
            </p>
          )}
        </div>
      )}

      {/* Тела системы перечислены в списке справа от карты: там же поиск,
          фильтры и прогресс строек, чего сетка плиток не давала. */}
    </main>
  );
}
