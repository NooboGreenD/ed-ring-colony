'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  IconXCircle,
  IconPlane,
  IconExternalLink,
  IconChart,
  IconCheckCircle,
  IconConstruction,
  IconPackage,
  IconCheck,
  IconGlobe,
} from '@/components/Icons';

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

export default function SystemPage() {
  const { name } = useParams();
  const systemName = decodeURIComponent(name as string);
  const [system, setSystem] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/systems/progress?name=${encodeURIComponent(systemName)}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setSystem(data))
      .catch(() => setSystem(null))
      .finally(() => setLoading(false));
  }, [systemName]);

  if (loading) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40, textAlign: 'center' }}>
        <div style={{ color: '#e67e22', fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 2 }}>
          Загрузка системы...
        </div>
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

  return (
    <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 32 }}>
      <div style={{ marginBottom: 24 }}>
        <Link href="/map" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: 13 }}>← Назад к карте</Link>
      </div>

      <h1 style={{ fontSize: 28, color: '#eeeeee', marginBottom: 8 }}>{systemName}</h1>

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
            borderRadius: 6,
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
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px',
            background: 'rgba(59,130,246,0.15)',
            border: '1px solid rgba(59,130,246,0.4)',
            color: '#3b82f6',
            borderRadius: 6,
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
      <div style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 10, padding: 20, marginBottom: 24 }}>
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
          {hasSystemCargoTotals && (
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Груз доставлен</div>
              <div style={{ fontSize: 16, color: '#eeeeee', fontWeight: 600 }}>
                {formatCargo(system.totalProvided)} / {formatCargo(system.totalRequired)} т
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

      {/* Тела системы (если есть) */}
      {system.bodies && system.bodies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}>🪐 Тела системы</h2>
          <div style={{ display: 'grid', gap: 8 }}>
            {system.bodies.map((body: any, index: number) => (
              <div key={index} style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#eeeeee', fontSize: 14 }}>{body.name}</span>
                <span style={{ color: '#9ca3af', fontSize: 13 }}>
                  {body.type}{body.distance ? ` · ${body.distance.toFixed(0)} LS` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
