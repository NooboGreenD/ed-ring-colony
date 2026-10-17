'use client';

/**
 * Настройки проекта: название, описание, статус, цвет, срок и начало
 * отсчёта вклада (ведущие проекта); передача и удаление (создатель); выход
 * из проекта (участник).
 */

import { useState } from 'react';
import {
  cardStyle,
  errorText,
  ghostButton,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
} from '@/components/Architect/panelStyles';
import {
  PROJECT_COLORS,
  PROJECT_LIMITS,
  PROJECT_STATUSES,
  STATUS_LABELS,
  type ProjectStatus,
} from '@/lib/architect/projects';
import { apiJson, type ProjectDetailResponse } from '@/components/Architect/projects/projectUi';

interface Props {
  base: string;
  detail: ProjectDetailResponse;
  onChanged: (what?: { leaders?: boolean }) => Promise<void> | void;
  onNotice: (message: string) => void;
  onGone: () => void;
}

function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : '';
}

export default function ProjectSettings({ base, detail, onChanged, onNotice, onGone }: Props) {
  const { project, viewer } = detail;
  const perms = viewer.permissions;
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [color, setColor] = useState(project.color);
  const [targetDate, setTargetDate] = useState(toDateInput(project.targetDate));
  const [trackingSince, setTrackingSince] = useState(toDateInput(project.trackingSince));
  const [heir, setHeir] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const dirty = name !== project.name
    || description !== project.description
    || status !== project.status
    || color !== project.color
    || targetDate !== toDateInput(project.targetDate)
    || trackingSince !== toDateInput(project.trackingSince);

  const save = async () => {
    setBusy(true);
    setError('');
    const trackingChanged = trackingSince !== toDateInput(project.trackingSince);
    const result = await apiJson(base, {
      method: 'PATCH',
      json: {
        name,
        description,
        status,
        color,
        targetDate: targetDate || null,
        trackingSince: trackingSince ? `${trackingSince}T00:00:00Z` : null,
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice('Настройки проекта сохранены');
    await onChanged({ leaders: trackingChanged });
  };

  const transfer = async () => {
    const member = detail.members.find((entry) => entry.userId === heir);
    if (!member) return;
    if (!window.confirm(`Передать проект пилоту ${member.name}? Вы станете модератором.`)) return;
    setBusy(true);
    setError('');
    const result = await apiJson(`${base}/members`, { method: 'PATCH', json: { userId: member.userId, role: 'owner' } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice(`Проект передан: ${member.name}`);
    await onChanged();
  };

  const remove = async () => {
    if (confirmName.trim() !== project.name) {
      setError('Для удаления введите название проекта точно');
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiJson(base, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onGone();
  };

  const leave = async () => {
    if (!window.confirm('Покинуть проект? Вернуть вас сможет только создатель или модератор.')) return;
    setBusy(true);
    const result = await apiJson(`${base}/members?userId=${encodeURIComponent(viewer.userId)}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onGone();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
      {error && <p style={errorText}>{error}</p>}
      {perms.editProject ? (
        <section style={cardStyle} aria-label="Параметры проекта">
          <h2 style={sectionTitle}>Параметры проекта</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginTop: 10 }}>
            <label style={mutedText}>
              Название
              <input value={name} maxLength={PROJECT_LIMITS.name} onChange={(event) => setName(event.target.value)} style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
            </label>
            <label style={mutedText}>
              Статус
              <select value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)} style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
                {PROJECT_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
              </select>
            </label>
            <label style={mutedText}>
              Срок проекта
              <input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
            </label>
            <label style={mutedText} title="Поставки раньше этой даты не идут в лидеров проекта (например, если в систему возили груз под прежнюю стройку)">
              Считать вклад пилотов с
              <input type="date" value={trackingSince} onChange={(event) => setTrackingSince(event.target.value)} style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
            </label>
            <label style={{ ...mutedText, gridColumn: '1 / -1' }}>
              Описание и цели
              <textarea value={description} maxLength={PROJECT_LIMITS.description} rows={5} onChange={(event) => setDescription(event.target.value)} style={{ ...inputStyle, width: '100%', marginTop: 4, resize: 'vertical' }} />
            </label>
            <div style={{ ...mutedText, gridColumn: '1 / -1' }}>
              Цвет метки
              <div style={{ ...rowStyle, marginTop: 4 }}>
                {PROJECT_COLORS.map((tone) => (
                  <button
                    key={tone}
                    type="button"
                    aria-label={`Цвет ${tone}`}
                    aria-pressed={color === tone}
                    onClick={() => setColor(tone)}
                    style={{ width: 22, height: 22, borderRadius: 3, background: tone, cursor: 'pointer', borderWidth: 2, borderStyle: 'solid', borderColor: color === tone ? 'var(--text)' : 'transparent' }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div style={{ ...rowStyle, marginTop: 12 }}>
            <button type="button" style={primaryButton} disabled={busy || !dirty || !name.trim()} onClick={() => void save()}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </button>
            {dirty && <span style={mutedText}>есть несохранённые изменения</span>}
          </div>
        </section>
      ) : (
        <section style={cardStyle}>
          <h2 style={sectionTitle}>Параметры проекта</h2>
          <p style={{ ...mutedText, margin: '8px 0 0' }}>Менять проект могут создатель и модераторы.</p>
        </section>
      )}

      {perms.transfer && viewer.role === 'owner' && (
        <section style={cardStyle} aria-label="Передать проект">
          <h2 style={sectionTitle}>Передать проект</h2>
          <p style={{ ...mutedText, margin: '6px 0 10px' }}>Новый создатель получит все права, вы останетесь модератором.</p>
          <div style={rowStyle}>
            <select value={heir} onChange={(event) => setHeir(event.target.value)} style={inputStyle} aria-label="Новый создатель">
              <option value="">— выберите участника —</option>
              {detail.members.filter((member) => member.role !== 'owner').map((member) => (
                <option key={member.userId} value={member.userId}>{member.name}</option>
              ))}
            </select>
            <button type="button" style={ghostButton} disabled={busy || !heir} onClick={() => void transfer()}>Передать</button>
          </div>
        </section>
      )}

      {perms.leave && (
        <section style={cardStyle} aria-label="Покинуть проект">
          <h2 style={sectionTitle}>Покинуть проект</h2>
          <p style={{ ...mutedText, margin: '6px 0 10px' }}>Ваш вклад останется в статистике проекта.</p>
          <button type="button" style={{ ...ghostButton, borderColor: 'var(--red)', color: 'var(--red)' }} disabled={busy} onClick={() => void leave()}>Покинуть проект</button>
        </section>
      )}

      {perms.deleteProject && (
        <section style={{ ...cardStyle, borderColor: 'var(--red)' }} aria-label="Удалить проект">
          <h2 style={{ ...sectionTitle, color: 'var(--red)' }}>Удалить проект</h2>
          <p style={{ ...mutedText, margin: '6px 0 10px' }}>
            Удаляются проект, состав, системы и привязки авианосцев. Поставки пилотов, планы и авианосцы остаются на сайте.
          </p>
          <div style={rowStyle}>
            <input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={`Введите «${project.name}»`} aria-label="Подтверждение удаления" style={{ ...inputStyle, flex: '1 1 240px' }} />
            <button type="button" style={{ ...ghostButton, borderColor: 'var(--red)', color: 'var(--red)' }} disabled={busy || confirmName.trim() !== project.name} onClick={() => void remove()}>
              Удалить навсегда
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
