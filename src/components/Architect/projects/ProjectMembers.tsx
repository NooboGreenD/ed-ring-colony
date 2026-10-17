'use client';

/**
 * Участники проекта: роли, обязанности, вклад и управление составом.
 *
 *   * ведущие проекта (создатель, модераторы) приглашают пилотов по позывному
 *     и убирают участников;
 *   * только создатель назначает и снимает модераторов и передаёт проект;
 *   * любой участник может выйти и подписать свою обязанность.
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cardStyle,
  errorText,
  ghostButton,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
  tableStyle,
  tdStyle,
  thStyle,
} from '@/components/Architect/panelStyles';
import {
  PROJECT_LIMITS,
  ROLE_LABELS,
  canChangeRole,
  canEditDuty,
  canRemoveMember,
  type ProjectMemberView,
  type ProjectRole,
} from '@/lib/architect/projects';
import {
  RoleBadge,
  apiJson,
  compactTons,
  formatAgo,
  formatDate,
  formatPercent,
  type ProjectDetailResponse,
} from '@/components/Architect/projects/projectUi';
import type { LeadersResponse } from '@/components/Architect/projects/ProjectView';

interface Props {
  base: string;
  detail: ProjectDetailResponse;
  leaders: LeadersResponse | null;
  onChanged: (what?: { leaders?: boolean }) => Promise<void> | void;
  onNotice: (message: string) => void;
  onLeft: () => void;
}

interface Candidate {
  id: string;
  name: string;
  squadron: string | null;
  member: boolean;
}

export default function ProjectMembers({ base, detail, leaders, onChanged, onNotice, onLeft }: Props) {
  const { viewer } = detail;
  const actor = { userId: viewer.userId, role: viewer.role, isAdmin: viewer.isAdmin };
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [role, setRole] = useState<ProjectRole>('member');
  const [duty, setDuty] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const contribution = useMemo(() => {
    const map = new Map<string, { siteTons: number; share: number; lastAt: string | null; rank: number }>();
    for (const pilot of leaders?.pilots ?? []) {
      map.set(pilot.key, { siteTons: pilot.siteTons, share: pilot.share, lastAt: pilot.lastAt, rank: pilot.rank });
    }
    return map;
  }, [leaders]);

  useEffect(() => {
    if (!viewer.permissions.manageMembers) return;
    if (timer.current) clearTimeout(timer.current);
    const search = query.trim();
    if (search.length < 2) {
      setCandidates([]);
      return;
    }
    timer.current = setTimeout(() => {
      void apiJson<{ candidates: Candidate[] }>(`${base}/members?search=${encodeURIComponent(search)}`).then((result) => {
        setCandidates(Array.isArray(result.data?.candidates) ? result.data!.candidates : []);
      });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, base, viewer.permissions.manageMembers]);

  const invite = async (candidate?: Candidate) => {
    const body: Record<string, unknown> = { role, duty };
    if (candidate) body.userId = candidate.id;
    else if (query.trim()) body.cmdr = query.trim();
    else {
      setError('Введите позывной');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiJson<{ member: { name: string } }>(`${base}/members`, { method: 'POST', json: body });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setQuery('');
    setDuty('');
    setCandidates([]);
    onNotice(`${result.data?.member.name ?? 'Пилот'} добавлен в проект`);
    await onChanged({ leaders: true });
  };

  const update = async (member: ProjectMemberView, body: Record<string, unknown>, message: string) => {
    setBusy(true);
    setError('');
    const result = await apiJson(`${base}/members`, { method: 'PATCH', json: { userId: member.userId, ...body } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice(message);
    await onChanged();
  };

  const remove = async (member: ProjectMemberView) => {
    const self = member.userId === viewer.userId;
    const question = self ? 'Покинуть проект? Вернуть вас сможет только создатель или модератор.' : `Убрать ${member.name} из проекта?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError('');
    const result = await apiJson(`${base}/members?userId=${encodeURIComponent(member.userId)}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (self) {
      onLeft();
      return;
    }
    onNotice(`${member.name} больше не участвует в проекте`);
    await onChanged({ leaders: true });
  };

  const transfer = async (member: ProjectMemberView) => {
    if (!window.confirm(`Передать проект пилоту ${member.name}? Вы станете модератором и не сможете вернуть проект сами.`)) return;
    await update(member, { role: 'owner' }, `Проект передан: ${member.name}`);
  };

  const editDuty = async (member: ProjectMemberView) => {
    const next = window.prompt(`Обязанность ${member.name} (до ${PROJECT_LIMITS.duty} символов):`, member.duty);
    if (next === null) return;
    await update(member, { duty: next }, 'Обязанность сохранена');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {viewer.permissions.manageMembers && (
        <section style={cardStyle} aria-label="Пригласить пилота">
          <h2 style={sectionTitle}>Добавить участника</h2>
          <p style={{ ...mutedText, margin: '6px 0 10px' }}>
            Пилот должен быть зарегистрирован на сайте. Участники видят прогресс и лидеров; модераторы ведут системы, состав и авианосцы.
          </p>
          <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
            <div style={{ position: 'relative', flex: '1 1 240px' }}>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void invite(); }}
                placeholder="Позывной командира"
                aria-label="Позывной командира"
                style={{ ...inputStyle, width: '100%' }}
              />
              {candidates.length > 0 && (
                <div role="listbox" style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 3, marginTop: 2 }}>
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      disabled={candidate.member || busy}
                      onClick={() => void invite(candidate)}
                      style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, padding: '6px 10px', background: 'transparent', border: 'none', color: candidate.member ? 'var(--muted)' : 'var(--text)', cursor: candidate.member ? 'default' : 'pointer', textAlign: 'left', fontSize: 13 }}
                    >
                      <span>{candidate.name}{candidate.squadron ? ` · ${candidate.squadron}` : ''}</span>
                      <span style={mutedText}>{candidate.member ? 'уже в проекте' : 'добавить'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <select value={role} onChange={(event) => setRole(event.target.value as ProjectRole)} style={inputStyle} aria-label="Роль">
              <option value="member">Участник</option>
              {viewer.permissions.manageModerators && <option value="moderator">Модератор</option>}
            </select>
            <input value={duty} onChange={(event) => setDuty(event.target.value)} maxLength={PROJECT_LIMITS.duty} placeholder="Обязанность (необязательно)" style={{ ...inputStyle, flex: '1 1 200px' }} />
            <button type="button" style={primaryButton} disabled={busy} onClick={() => void invite()}>Добавить</button>
          </div>
          <div style={{ ...mutedText, marginTop: 6 }}>{detail.members.length}/{detail.limits.members} участников</div>
        </section>
      )}

      {error && <p style={errorText}>{error}</p>}

      <section style={cardStyle} aria-label="Состав проекта">
        <h2 style={{ ...sectionTitle, marginBottom: 8 }}>Состав проекта</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Пилот</th>
                <th style={thStyle}>Роль</th>
                <th style={thStyle}>Обязанность</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Сдано</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Доля</th>
                <th style={thStyle}>Последняя поставка</th>
                <th style={thStyle}>В проекте с</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {detail.members.map((member) => {
                const stats = contribution.get(member.userId);
                const target = { userId: member.userId, role: member.role };
                const promote = canChangeRole(actor, target, member.role === 'moderator' ? 'member' : 'moderator');
                const transferable = canChangeRole(actor, target, 'owner');
                const removable = canRemoveMember(actor, target);
                const dutyEditable = canEditDuty(actor, target);
                return (
                  <tr key={member.userId} style={{ background: member.isYou ? 'rgba(230, 126, 34, 0.08)' : undefined }}>
                    <td style={tdStyle}>
                      <Link href={`/cmdr/${encodeURIComponent(member.name)}`} style={{ color: 'var(--text)' }}>{member.name}</Link>
                      {member.isYou && <span style={{ color: 'var(--orange)' }}> · вы</span>}
                      {member.squadron && <div style={{ ...mutedText, fontSize: 11 }}>{member.squadron}</div>}
                    </td>
                    <td style={tdStyle}><RoleBadge role={member.role} /></td>
                    <td style={tdStyle}>
                      {member.duty || <span style={mutedText}>—</span>}
                      {dutyEditable && (
                        <button type="button" onClick={() => void editDuty(member)} style={{ background: 'none', border: 'none', color: 'var(--cyan)', cursor: 'pointer', fontSize: 11, marginLeft: 6 }}>
                          изменить
                        </button>
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{stats ? `${compactTons(stats.siteTons)} т` : '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{stats ? formatPercent(stats.share * 100) : '—'}</td>
                    <td style={{ ...tdStyle, color: 'var(--muted)' }}>{stats?.lastAt ? formatAgo(stats.lastAt) : '—'}</td>
                    <td style={{ ...tdStyle, color: 'var(--muted)' }}>{formatDate(member.joinedAt)}{member.addedByName ? ` · пригласил ${member.addedByName}` : ''}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {member.role !== 'owner' && promote.ok && (
                        <button type="button" style={{ ...ghostButton, padding: '3px 8px' }} disabled={busy}
                          onClick={() => void update(member, { role: member.role === 'moderator' ? 'member' : 'moderator' },
                            member.role === 'moderator' ? `${member.name} больше не модератор` : `${member.name} теперь модератор`)}>
                          {member.role === 'moderator' ? 'Снять модератора' : 'Сделать модератором'}
                        </button>
                      )}
                      {member.role !== 'owner' && transferable.ok && viewer.role === 'owner' && (
                        <button type="button" style={{ ...ghostButton, padding: '3px 8px', marginLeft: 4 }} disabled={busy} onClick={() => void transfer(member)}>
                          Передать проект
                        </button>
                      )}
                      {removable.ok && (
                        <button type="button" style={{ ...ghostButton, padding: '3px 8px', marginLeft: 4, borderColor: 'var(--red)', color: 'var(--red)' }} disabled={busy} onClick={() => void remove(member)}>
                          {member.isYou ? 'Выйти' : 'Убрать'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ ...mutedText, marginTop: 8 }}>
          {ROLE_LABELS.owner} — один, назначает модераторов и может передать проект. {ROLE_LABELS.moderator} ведёт системы, состав и авианосцы.
          {ROLE_LABELS.member} смотрит прогресс и лидеров и может привязать свой авианосец.
        </p>
      </section>
    </div>
  );
}
