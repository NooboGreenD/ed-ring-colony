"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { LeaderboardEntry } from '@/types/atlas';
import { ACHIEVEMENT_TRACKS, rankProgress, tierColor, tierBg, tierBorder } from '@/lib/achievements';
import { IconLeaderboard } from '@/components/Icons';

function MiniMedal({ trackId, tier }: { trackId: string; tier: number }) {
  if (tier <= 0) return null;
  const track = ACHIEVEMENT_TRACKS.find(t => t.id === trackId);
  if (!track) return null;
  const color = tierColor(tier);
  return (
    <span title={`${track.title} — Тир ${tier}`} style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 22,
      height: 22,
      borderRadius: '50%',
      background: tierBg(tier),
      border: `1.5px solid ${tierBorder(tier)}`,
      color,
      fontSize: 11,
      fontWeight: 700,
      fontFamily: 'ui-monospace, monospace',
    }}>
      {tier}
    </span>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(243,156,18,0.15)', border: '1.5px solid #f39c12',
        color: '#f39c12', fontSize: 12, fontWeight: 700, fontFamily: 'ui-monospace, monospace',
      }}>1</span>
    );
  }
  if (rank === 2) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(158,158,158,0.15)', border: '1.5px solid #9e9e9e',
        color: '#bdbdbd', fontSize: 12, fontWeight: 700, fontFamily: 'ui-monospace, monospace',
      }}>2</span>
    );
  }
  if (rank === 3) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '50%',
        background: 'rgba(205,127,50,0.15)', border: '1.5px solid #cd7f32',
        color: '#cd7f32', fontSize: 12, fontWeight: 700, fontFamily: 'ui-monospace, monospace',
      }}>3</span>
    );
  }
  return (
    <span style={{
      fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#9ca3af', fontWeight: 600,
    }}>{rank}</span>
  );
}

export function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [period, setPeriod] = useState<'all' | 'week' | 'month'>('all');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/leaderboard?period=${period}&limit=50`)
      .then((r) => r.json())
      .then((d) => setEntries(d.leaderboard || []))
      .finally(() => setLoading(false));
  }, [period]);

  function getMedals(entry: LeaderboardEntry) {
    const medals: { id: string; tier: number }[] = [];
    for (const t of ACHIEVEMENT_TRACKS) {
      let val = 0;
      if (t.id === 'cargo') val = entry.total_amount;
      else if (t.id === 'hubs') val = entry.hubs_visited;
      else if (t.id === 'ops') val = entry.deliveries_count;
      else if (entry.commodities) val = entry.commodities.reduce((s, r) => s + (t.match(r.commodity) ? r.amount : 0), 0);
      const p = rankProgress(t, val);
      if (p.earned > 0) medals.push({ id: t.id, tier: p.earned });
    }
    return medals;
  }

  const periodLabels: Record<string, string> = { all: 'Всё время', week: 'Неделя', month: 'Месяц' };

  return (
    <div className="card" style={{ border: '1px solid #323538', background: '#1a1c1e', borderRadius: 6, padding: '20px 24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <IconLeaderboard size={22} color="#e67e22" />
        <h2 style={{ margin: 0, fontSize: 18, color: '#eeeeee', fontWeight: 600, letterSpacing: 0.5 }}>
          Лидерборд пилотов
        </h2>
      </div>

      {/* Period tabs */}
      <div className="tabs" style={{ marginBottom: 18 }}>
        {(['all', 'week', 'month'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={period === p ? 'tab tab-active' : 'tab'}
            onClick={() => setPeriod(p)}
          >
            {periodLabels[p]}
          </button>
        ))}
      </div>

      {loading && (
        <p style={{ color: '#9ca3af', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>Загрузка…</p>
      )}

      <div className="table-scroll">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#9ca3af', textAlign: 'left', borderBottom: '1px solid #323538' }}>
              <th style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>#</th>
              <th style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>CMDR</th>
              <th style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>Тоннаж</th>
              <th style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>Рейсов</th>
              <th style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>Хабов</th>
              <th style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>Медали</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const medals = getMedals(e);
              return (
                <tr
                  key={e.user_id}
                  style={{ borderBottom: '1px solid #25282b', color: '#eeeeee', transition: 'background 0.15s' }}
                  onMouseEnter={(ev) => { ev.currentTarget.style.background = '#25282b'; }}
                  onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '10px 8px' }}><RankBadge rank={e.rank} /></td>
                  <td style={{ padding: '10px 8px' }}>
                    <Link
                      href={`/cmdr/${encodeURIComponent(e.cmdr_name)}`}
                      style={{ color: '#e67e22', textDecoration: 'none', fontWeight: 500 }}
                      title="Перейти к досье пилота"
                    >
                      {e.cmdr_name}
                    </Link>
                  </td>
                  <td style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace', color: '#e67e22', fontWeight: 600 }}>{e.total_amount.toLocaleString('ru')}</td>
                  <td style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace' }}>{e.deliveries_count}</td>
                  <td style={{ padding: '10px 8px', fontFamily: 'ui-monospace, monospace' }}>{e.hubs_visited}</td>
                  <td style={{ padding: '10px 8px' }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {medals.map(m => (
                        <MiniMedal key={m.id} trackId={m.id} tier={m.tier} />
                      ))}
                      {medals.length === 0 && <span style={{ color: '#475569', fontSize: 11 }}>—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {entries.length === 0 && !loading && (
        <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 24, fontSize: 13 }}>Пока нет данных</p>
      )}
    </div>
  );
}
