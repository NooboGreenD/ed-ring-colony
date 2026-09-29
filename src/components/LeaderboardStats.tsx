"use client";

/**
 * Дополнительные блоки лидерборда:
 *
 *   * «Самые застроенные системы» — топ-10 систем по тоннажу грузов, который
 *     наши пилоты завезли на стройку за выбранный период, плюс живой прогресс
 *     системы из кэша Raven Colonial;
 *   * «Топ архитекторов» — маленький топ-10: кто сколько планов опубликовал,
 *     сколько построек в них и за какие системы командир закреплён как
 *     назначенный архитектор.
 *
 * Данные — `/api/leaderboard/stats`; период блока систем совпадает с
 * периодом основного лидерборда (неделя/месяц/всё время), архитекторы —
 * за всё время: план и назначение «зашиты» в систему надолго.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import PilotIdentity from '@/components/Cosmetics/PilotIdentity';
import { IconBuilding, IconStats } from '@/components/Icons';

export type StatsPeriod = 'all' | 'week' | 'month';

export interface BuiltSystemEntry {
  rank: number;
  system_name: string;
  total_amount: number;
  deliveries_count: number;
  pilots: number;
  progress: number | null;
  status: 'planned' | 'building' | 'done' | null;
}

export interface TopArchitectEntry {
  rank: number;
  user_id: string;
  cmdr_name: string;
  plans_count: number;
  sites_count: number;
  haul_tons: number;
  assigned_systems: number;
  assigned_names: string[];
}

const STATUS_LABELS: Record<string, string> = {
  planned: 'запланирована',
  building: 'строится',
  done: 'построена',
};

const STATUS_COLORS: Record<string, string> = {
  planned: '#9ca3af',
  building: '#22d3ee',
  done: '#4ade80',
};

function RankCell({ rank }: { rank: number }) {
  const medal =
    rank === 1 ? { border: '#f39c12', bg: 'rgba(243,156,18,0.15)', color: '#f39c12' }
      : rank === 2 ? { border: '#9e9e9e', bg: 'rgba(158,158,158,0.15)', color: '#bdbdbd' }
        : rank === 3 ? { border: '#cd7f32', bg: 'rgba(205,127,50,0.15)', color: '#cd7f32' }
          : null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: medal ? medal.bg : 'transparent',
        border: medal ? `1.5px solid ${medal.border}` : 'none',
        color: medal ? medal.color : '#9ca3af',
        fontSize: 11,
        fontWeight: 700,
        fontFamily: 'ui-monospace, monospace',
        flexShrink: 0,
      }}
    >
      {rank}
    </span>
  );
}

const card: React.CSSProperties = {
  border: '1px solid #323538',
  background: '#1a1c1e',
  borderRadius: 6,
  padding: '18px 20px',
  minWidth: 0,
};

const heading: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  margin: 0,
  fontSize: 16,
  color: '#eeeeee',
  fontWeight: 600,
  letterSpacing: 0.5,
};

const caption: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  color: '#6b7280',
};

function BuiltSystemsBlock({ systems }: { systems: BuiltSystemEntry[] }) {
  return (
    <section style={card}>
      <h3 style={heading}>
        <IconBuilding size={20} color="#e67e22" />
        Самые застроенные системы
      </h3>
      <p style={caption}>По тоннажу грузов, завезённых пилотами на стройку за период.</p>
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {systems.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>Поставок за этот период не было.</p>
        )}
        {systems.map((entry) => (
          <div
            key={entry.rank + entry.system_name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 4,
              borderBottom: '1px solid #25282b',
            }}
          >
            <RankCell rank={entry.rank} />
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <Link
                  href={`/system/${encodeURIComponent(entry.system_name)}`}
                  style={{ color: '#e67e22', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
                >
                  {entry.system_name}
                </Link>
                {entry.status && (
                  <span style={{ fontSize: 11, color: STATUS_COLORS[entry.status] || '#9ca3af' }}>
                    {STATUS_LABELS[entry.status]}
                    {entry.progress != null ? ` · ${entry.progress}%` : ''}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                {entry.pilots} пил. · {entry.deliveries_count} рейс.
              </div>
              {entry.progress != null && (
                <div style={{ marginTop: 5, height: 4, borderRadius: 2, background: '#25282b', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, entry.progress))}%`,
                      height: '100%',
                      background: entry.status === 'done' ? '#4ade80' : '#e67e22',
                      transition: 'width 0.4s',
                    }}
                  />
                </div>
              )}
            </div>
            <div
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 13,
                color: '#e67e22',
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              {entry.total_amount.toLocaleString('ru')} т
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TopArchitectsBlock({ architects }: { architects: TopArchitectEntry[] }) {
  return (
    <section style={card}>
      <h3 style={heading}>
        <IconStats size={20} color="#22d3ee" />
        Топ архитекторов
      </h3>
      <p style={caption}>Закреплённые системы и опубликованные планы застройки.</p>
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {architects.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>
            Публичных планов пока нет — сохраните план системы в «Архитекторе» и откройте его всем.
          </p>
        )}
        {architects.map((entry) => (
          <div
            key={entry.rank + entry.user_id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 4,
              borderBottom: '1px solid #25282b',
            }}
          >
            <RankCell rank={entry.rank} />
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <PilotIdentity userId={entry.user_id} cmdrName={entry.cmdr_name} showAvatar={false} fontSize={13} style={{ color: '#22d3ee' }} />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                {entry.plans_count > 0
                  ? `планов: ${entry.plans_count} · построек: ${entry.sites_count} · ${entry.haul_tons.toLocaleString('ru')} т`
                  : 'без публичных планов'}
              </div>
              <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {entry.assigned_systems > 0 && (
                  <span
                    title={entry.assigned_systems - entry.assigned_names.length > 0
                      ? `и ещё ${entry.assigned_systems - entry.assigned_names.length}`
                      : entry.assigned_names.join(', ')}
                    style={{
                      fontSize: 11,
                      color: '#f39c12',
                      border: '1px solid rgba(243,156,18,0.5)',
                      borderRadius: 3,
                      padding: '1px 7px',
                    }}
                  >
                    ★ архитектор: {entry.assigned_names.join(', ')}
                    {entry.assigned_systems > entry.assigned_names.length ? '…' : ''}
                  </span>
                )}
              </div>
            </div>
            <div
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                color: '#22d3ee',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {entry.assigned_systems > 0 ? `${entry.assigned_systems} сист.` : `${entry.sites_count} постр.`}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function LeaderboardStats({ period }: { period: StatsPeriod }) {
  const [systems, setSystems] = useState<BuiltSystemEntry[]>([]);
  const [architects, setArchitects] = useState<TopArchitectEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetch(`/api/leaderboard/stats?period=${period}`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(String(data?.error || `HTTP ${response.status}`));
        return data;
      })
      .then((data) => {
        if (!alive) return;
        setSystems(Array.isArray(data?.builtSystems) ? data.builtSystems : []);
        setArchitects(Array.isArray(data?.topArchitects) ? data.topArchitects : []);
      })
      .catch((err) => {
        if (!alive) return;
        setSystems([]);
        setArchitects([]);
        setError(err instanceof Error ? err.message : 'Не удалось загрузить статистику');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [period]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 16,
        marginTop: 16,
      }}
    >
      {error ? (
        <div style={{ ...card, gridColumn: '1 / -1', color: '#f87171', fontSize: 12 }}>
          Статистика недоступна: {error}
        </div>
      ) : (
        <>
          {loading && systems.length === 0 && architects.length === 0 && (
            <div style={{ ...card, gridColumn: '1 / -1', color: '#9ca3af', fontSize: 12 }}>Загрузка статистики…</div>
          )}
          <BuiltSystemsBlock systems={systems} />
          <TopArchitectsBlock architects={architects} />
        </>
      )}
    </div>
  );
}
