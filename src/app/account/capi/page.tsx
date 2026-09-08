'use client';

import { useState, useEffect } from 'react';
import { IconError, IconSync } from '@/components/Icons';
import { getAccessToken } from '@/lib/supabaseClient';

interface CapiProfileData {
  cmdr_name: string | null;
  credits: number | null;
  combat_rank: number | null;
  trade_rank: number | null;
  explore_rank: number | null;
  empire_rank: number | null;
  federation_rank: number | null;
  current_ship: string | null;
  current_system: string | null;
  last_updated: string;
}

const RANK_NAMES = ['Harmless','Mostly Harmless','Novice','Competent','Expert','Master','Dangerous','Deadly','Elite'];
const EMPIRE_RANKS = ['None','Outsider','Serf','Master','Squire','Knight','Lord','Baron','Viscount','Count','Earl','Marquis','Duke','Prince','King'];
const FED_RANKS = ['None','Recruit','Cadet','Midshipman','Petty Officer','Chief Petty Officer','Warrant Officer','Ensign','Lieutenant','Lt. Commander','Post Commander','Post Captain','Rear Admiral','Vice Admiral','Admiral'];

export default function CapiPage() {
  const [profile, setProfile] = useState<CapiProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { fetchProfile(); }, []);

  async function fetchProfile() {
    const token = getAccessToken();
    const res = await fetch('/api/capi/profile', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      setProfile(data.profile);
    }
    setLoading(false);
  }

  async function handleSync() {
    setSyncing(true); setError(null);
    const token = getAccessToken();
    const res = await fetch('/api/capi/sync', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json();
    if (res.ok) fetchProfile();
    else setError(data.error || 'Sync failed');
    setSyncing(false);
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--muted)' }}>Загрузка...</div>;

  return (
    <div style={{ padding: '24px 20px', maxWidth: 800 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 20 }}>
        FRONTIER CAPI
      </h2>

      {!profile ? (
        <div className="card">
          <p style={{ color: 'var(--muted)', marginBottom: 16 }}>Подключите аккаунт Frontier для синхронизации данных CMDR.</p>
          <a href="/api/capi/auth" className="btn btn-orange">Подключить Frontier Account</a>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div className="capi-status-connected">
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                Подключено
              </div>
              <button className="btn btn-cyan" onClick={handleSync} disabled={syncing}>
                <IconSync size={14} /> {syncing ? 'Синхр...' : 'Синхронизировать'}
              </button>
            </div>
            <p style={{ fontFamily: 'ui-monospace', fontSize: 12, color: 'var(--muted)' }}>
              CMDR: <span style={{ color: 'var(--orange)' }}>{profile.cmdr_name || '—'}</span>
              {' | '}
              Обновлено: {profile.last_updated ? new Date(profile.last_updated).toLocaleString('ru-RU') : '—'}
            </p>
          </div>

          {error && (
            <div className="journal-error-box" style={{ marginBottom: 20 }}>
              <IconError size={16} color="#e74c3c" /> {error}
            </div>
          )}

          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 16 }}>
              Ранги
            </h3>
            <div className="capi-rank-grid">
              {[
                { name: 'Combat', value: RANK_NAMES[profile.combat_rank || 0] },
                { name: 'Trade', value: RANK_NAMES[profile.trade_rank || 0] },
                { name: 'Explore', value: RANK_NAMES[profile.explore_rank || 0] },
                { name: 'Empire', value: EMPIRE_RANKS[profile.empire_rank || 0] },
                { name: 'Federation', value: FED_RANKS[profile.federation_rank || 0] },
              ].map((r) => (
                <div className="capi-rank-box" key={r.name}>
                  <div className="capi-rank-name">{r.name}</div>
                  <div className="capi-rank-value">{r.value || '—'}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 16 }}>
              Текущее состояние
            </h3>
            <div className="stat-grid">
              <div className="stat-box">
                <div className="num" style={{ fontSize: 16 }}>{profile.current_system || '—'}</div>
                <div className="lbl">Система</div>
              </div>
              <div className="stat-box">
                <div className="num" style={{ fontSize: 16 }}>{profile.current_ship || '—'}</div>
                <div className="lbl">Корабль</div>
              </div>
              <div className="stat-box">
                <div className="num">{profile.credits?.toLocaleString('ru-RU') || '—'}</div>
                <div className="lbl">CR</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
