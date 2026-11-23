'use client';

/**
 * Админ-панель: управление эскадрильями.
 * Позволяет администратору просматривать все эскадрильи и переназначать их лидеров.
 */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { authFetch } from '@/lib/supabaseClient';
import { IconUsers, IconCrown, IconTrash } from '@/components/Icons';

interface SquadronMember {
  id: number;
  squadron_id: number;
  user_id: string;
  role: string | null;
  rank_id: number | null;
  callsign: string | null;
  joined_at: string | null;
  cmdr_name: string | null;
  avatar_url: string | null;
}

interface SquadronRow {
  id: number;
  name: string;
  tag: string | null;
  description: string | null;
  status: string | null;
  created_by: string | null;
  member_count: number;
  created_at: string | null;
}

export default function SquadronsAdmin() {
  const { t, locale } = useI18n();
  const [squadrons, setSquadrons] = useState<SquadronRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reassigning, setReassigning] = useState<{ squadronId: number; loading: boolean } | null>(null);
  const [selectedSquadron, setSelectedSquadron] = useState<SquadronRow | null>(null);
  const [members, setMembers] = useState<SquadronMember[]>([]);
  const [newLeaderId, setNewLeaderId] = useState('');

  const fetchSquadrons = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch('/api/squadrons?limit=500', { cache: 'no-store' });
      if (!res.ok) throw new Error('Не удалось загрузить эскадрильи');
      const data = await res.json();
      setSquadrons((data.squadrons || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        tag: s.tag,
        description: s.description,
        status: s.status,
        created_by: s.created_by,
        member_count: s.member_count ?? 0,
        created_at: s.created_at,
      })));
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки эскадрилий');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSquadrons();
  }, [fetchSquadrons]);

  const loadMembers = async (squadron: SquadronRow) => {
    setSelectedSquadron(squadron);
    setNewLeaderId('');
    try {
      const res = await authFetch(`/api/squadrons/${squadron.id}/members`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Не удалось загрузить участников');
      const data = await res.json();
      setMembers(data.members || []);
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки участников');
    }
  };

  const reassignLeader = async () => {
    if (!selectedSquadron || !newLeaderId) return;
    setReassigning({ squadronId: selectedSquadron.id, loading: true });
    setError('');
    try {
      const res = await fetch(`/api/admin/squadrons/${selectedSquadron.id}/leader`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newLeaderUserId: newLeaderId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Не удалось переназначить лидера');
      setNotice(`Лидер эскадрильи «${selectedSquadron.name}» изменён`);
      setReassigning(null);
      setSelectedSquadron(null);
      setMembers([]);
      setNewLeaderId('');
      void fetchSquadrons();
    } catch (e: any) {
      setError(e.message || 'Ошибка переназначения лидера');
      setReassigning(null);
    }
  };

  const currentLeader = selectedSquadron ? members.find((m) => m.user_id === selectedSquadron.created_by) : null;

  return (
    <section className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <IconCrown size={24} color="currentColor" />
        <div>
          <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('admin.communities') || 'Эскадрильи'}
          </span>
          <h2 style={{ margin: '4px 0 0', color: '#eeeeee', fontSize: 18 }}>
            {t('admin.squadronManagement') || 'Управление эскадрильями'}
          </h2>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: 10, borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={{ background: 'rgba(46,204,113,0.1)', border: '1px solid rgba(46,204,113,0.3)', color: '#86c87c', padding: 10, borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
          {notice}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{t('common.loading') || 'Загрузка…'}</div>
      ) : squadrons.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          <IconUsers size={32} color="currentColor" />
          <p style={{ marginTop: 12 }}>{t('admin.noSquadrons') || 'Эскадрильи не найдены'}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
          {squadrons.map((s) => (
            <div
              key={s.id}
              style={{
                background: '#25282b',
                border: `1px solid ${s.created_by ? '#323538' : '#e74c3c'}`,
                borderRadius: 6,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderBottom: '1px solid #323538' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  <IconUsers size={20} color="#61a9d8" />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#eeeeee', fontFamily: 'ui-monospace, monospace' }}>{s.name}</div>
                    {s.tag && (
                      <span style={{ fontSize: 10, color: '#9ca3af', background: '#1e2124', padding: '1px 6px', borderRadius: 3, fontFamily: 'ui-monospace, monospace' }}>[ {s.tag} ]</span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#61a9d8', fontFamily: 'ui-monospace, monospace' }}>
                  {t('admin.membersCount', { count: s.member_count }) || `${s.member_count} участников`}
                </div>
              </div>

              <div style={{ padding: 12, display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, fontSize: 12, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
                <div>
                  <div style={{ color: '#61a9d8', fontSize: 10, textTransform: 'uppercase', marginBottom: 2 }}>{t('admin.leader') || 'Лидер'}</div>
                  <div style={{ color: '#eeeeee', fontWeight: 600 }}>{currentLeader?.cmdr_name || 'Не назначен'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#61a9d8', fontSize: 10, textTransform: 'uppercase', marginBottom: 2 }}>{t('admin.created') || 'Создано'}</div>
                  <div>{s.created_at ? new Date(s.created_at).toLocaleDateString(locale) : '—'}</div>
                </div>
              </div>

              <div style={{ padding: '10px 14px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => void loadMembers(s)}
                  disabled={reassigning?.squadronId === s.id && reassigning.loading}
                  style={{
                    padding: '6px 12px',
                    fontSize: 11,
                    fontFamily: 'ui-monospace, monospace',
                    background: 'transparent',
                    border: '1px solid #323538',
                    borderRadius: 4,
                    color: '#eeeeee',
                    cursor: 'pointer',
                  }}
                >
                  {t('admin.manageMembers') || 'Участники'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Модалка управления участниками и сменой лидера */}
      {selectedSquadron && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }}>
          <div style={{
            background: '#1a1c1e', border: '1px solid #323538', borderRadius: 8,
            padding: 24, minWidth: 420, maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#eeeeee', fontSize: 16, fontFamily: 'ui-monospace, monospace' }}>
                {selectedSquadron.name} {selectedSquadron.tag && ` [${selectedSquadron.tag}]`}
              </h3>
              <button
                type="button"
                onClick={() => { setSelectedSquadron(null); setMembers([]); setNewLeaderId(''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5, padding: 4 }}
              >
                <IconTrash size={16} color="#9ca3af" />
              </button>
            </div>

            <div style={{ marginBottom: 16, color: '#9ca3af', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
              {t('admin.selectNewLeader') || 'Выберите нового лидера эскадрильи:'}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, marginBottom: 16 }}>
              {members.map((m) => {
                const isCurrent = m.user_id === selectedSquadron!.created_by;
                const isSelected = m.user_id === newLeaderId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setNewLeaderId(m.user_id)}
                    disabled={reassigning?.squadronId === selectedSquadron.id && reassigning.loading}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                      background: isSelected ? '#e67e2222' : (isCurrent ? '#2ecc7111' : '#25282b'),
                      border: `1px solid ${isSelected ? '#e67e22' : (isCurrent ? '#2ecc71' : '#323538')}`,
                      borderRadius: 4,
                      color: '#eeeeee',
                      cursor: 'pointer',
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{m.cmdr_name || 'Неизвестный пилот'}</div>
                      <div style={{ fontSize: 10, color: '#61a9d8' }}>{m.user_id}</div>
                      {m.callsign && <span style={{ fontSize: 10, color: '#9ca3af' }}>» {m.callsign} «</span>}
                    </div>
                    {isCurrent && (
                      <span style={{ fontSize: 10, color: '#2ecc71', background: '#2ecc7111', padding: '1px 6px', borderRadius: 3 }}>{t('admin.currentLeader') || 'Текущий лидер'}</span>
                    )}
                    {isSelected && <IconCrown size={14} color="#e67e22" />}
                  </button>
                );
              })}
              {members.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>{t('admin.noMembers') || 'Участники не найдены'}</div>
              )}
            </div>

            {reassigning?.squadronId === selectedSquadron.id && reassigning.loading && (
              <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 12, marginBottom: 12 }}>{t('common.loading') || 'Загрузка…'}</div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setSelectedSquadron(null); setMembers([]); setNewLeaderId(''); }}
                disabled={reassigning?.squadronId === selectedSquadron.id && reassigning.loading}
                style={{
                  padding: '8px 16px', fontSize: 12, fontFamily: 'ui-monospace, monospace',
                  background: 'transparent', border: '1px solid #323538', borderRadius: 4,
                  color: '#9ca3af', cursor: 'pointer',
                }}
              >
                {t('admin.cancel') || 'Отмена'}
              </button>
              <button
                type="button"
                onClick={reassignLeader}
                disabled={!newLeaderId || reassigning?.squadronId === selectedSquadron.id && reassigning.loading || newLeaderId === selectedSquadron.created_by}
                style={{
                  padding: '8px 16px', fontSize: 12, fontFamily: 'ui-monospace, monospace',
                  background: '#e67e22', border: 'none', borderRadius: 4,
                  color: '#1e2022', fontWeight: 700, cursor: 'pointer',
                }}
              >
                {t('admin.reassignLeader') || 'Назначить лидером'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
