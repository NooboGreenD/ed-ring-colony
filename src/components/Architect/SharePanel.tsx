'use client';

/**
 * Панель сохранения и публикации плана.
 *
 * Тестовый режим: план по-прежнему живёт в localStorage как черновик, а здесь
 * его можно положить на сервер (`system_plans`), дать ему видимость и получить
 * ссылку вида `/architect?plan=<id>`, которой делятся с эскадрильей.
 *
 *   private  — только автор, в списках не виден;
 *   unlisted — открывается по прямой ссылке, в списке системы не показывается;
 *   public   — виден в списке системы всем.
 *
 * Сводные числа (тоннаж, оценка, очки) сервер считает сам по сохранённому
 * плану, поэтому подделать «красивый» план через запрос не получится.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PLAN_VISIBILITIES,
  VISIBILITY_HINTS_RU,
  VISIBILITY_LABELS_RU,
  isPlanVisibility,
  sharePath,
  type PlanView,
  type PlanVisibility,
} from '@/lib/architect/store';
import { formatTons, serializePlan } from '@/lib/architect/planner';
import type { ArchitectPlan } from '@/lib/architect/types';
import {
  cardStyle,
  chipActive,
  chipStyle,
  errorText,
  ghostButton,
  goodText,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
} from '@/components/Architect/panelStyles';

interface SharePanelProps {
  plan: ArchitectPlan;
  systemName: string;
  /** id сохранённого плана, если он уже на сервере. */
  remoteId: string | null;
  onSaved: (view: PlanView) => void;
  onOpen: (planId: string) => void;
  onDeleted: () => void;
  onNotice: (message: string) => void;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export default function SharePanel({
  plan,
  systemName,
  remoteId,
  onSaved,
  onOpen,
  onDeleted,
  onNotice,
}: SharePanelProps) {
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<PlanVisibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [list, setList] = useState<PlanView[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  /** JSON сохранённого плана: сравнение с текущим показывает «есть правки». */
  const [savedSignature, setSavedSignature] = useState('');

  const dirty = useMemo(
    () => Boolean(remoteId) && savedSignature !== serializePlan(plan),
    [remoteId, savedSignature, plan],
  );

  const shareUrl = useMemo(() => {
    if (!remoteId) return '';
    if (typeof window === 'undefined') return sharePath(remoteId);
    return `${window.location.origin}${sharePath(remoteId)}`;
  }, [remoteId]);

  const refreshList = useCallback(async (system: string) => {
    if (!system) return;
    setListLoading(true);
    try {
      const response = await fetch(`/api/architect/plans?system=${encodeURIComponent(system)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        // Список — вещь второстепенная: ошибка не должна мешать планированию.
        setList([]);
        return;
      }
      const plans = Array.isArray(data?.plans) ? (data.plans as PlanView[]) : [];
      setList(plans);
      const mine = plans.find((item) => item.id === remoteId);
      if (mine) {
        setVisibility(isPlanVisibility(mine.visibility) ? mine.visibility : 'private');
        setTitle(mine.title || '');
      }
    } catch {
      setList([]);
    } finally {
      setListLoading(false);
    }
  }, [remoteId]);

  useEffect(() => {
    void refreshList(systemName);
  }, [systemName, refreshList]);

  // Открыли чужой план по ссылке — показываем его как выбранный.
  useEffect(() => {
    if (!remoteId) return;
    const current = list.find((item) => item.id === remoteId);
    if (current) {
      setVisibility(isPlanVisibility(current.visibility) ? current.visibility : 'private');
      setTitle(current.title || '');
    }
  }, [remoteId, list]);

  const save = useCallback(async () => {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const response = remoteId
        ? await fetch(`/api/architect/plans/${encodeURIComponent(remoteId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plan, title, visibility }),
        })
        : await fetch('/api/architect/plans', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ system: systemName, plan, title, visibility }),
        });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) {
          setError('Планы сохраняются после входа в аккаунт — черновик при этом остаётся в браузере.');
        } else {
          setError(String(data?.error || `Ошибка сервера (${response.status})`));
        }
        return;
      }
      const view = data?.plan as PlanView | undefined;
      if (view && typeof view.id === 'string') {
        setSavedSignature(serializePlan(plan));
        setVisibility(isPlanVisibility(view.visibility) ? view.visibility : 'private');
        setTitle(view.title || '');
        onSaved(view);
        onNotice(visibility === 'private'
          ? 'План сохранён на сервере (виден только вам)'
          : 'План сохранён на сервере');
      } else {
        setError('Сервер не вернул сохранённый план');
      }
      void refreshList(systemName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить план');
    } finally {
      setBusy(false);
    }
  }, [plan, remoteId, systemName, title, visibility, onSaved, onNotice, refreshList]);

  const remove = useCallback(async () => {
    if (!remoteId) return;
    if (!window.confirm('Удалить план с сервера? Черновик в браузере останется.')) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/architect/plans/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(String(data?.error || `Не удалось удалить (${response.status})`));
        return;
      }
      onDeleted();
      void refreshList(systemName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить план');
    } finally {
      setBusy(false);
    }
  }, [remoteId, onDeleted, refreshList, systemName]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      onNotice('Браузер не дал доступ к буферу обмена — скопируйте ссылку вручную');
    }
  }, [shareUrl, onNotice]);

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>Сохранение и публикация</h3>
        <span style={mutedText}>
          {remoteId ? `план ${remoteId.slice(0, 8)}…` : 'на сервере ещё не сохранён'}
        </span>
      </div>

      <div style={{ ...rowStyle, marginTop: 10 }}>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Название плана, например «Первая очередь»"
          style={{ ...inputStyle, flex: '1 1 220px' }}
        />
      </div>

      <div style={{ ...rowStyle, marginTop: 8 }}>
        {PLAN_VISIBILITIES.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setVisibility(item)}
            style={{ ...chipStyle, ...(item === visibility ? chipActive : {}) }}
          >
            {VISIBILITY_LABELS_RU[item]}
          </button>
        ))}
      </div>
      <div style={{ ...mutedText, marginTop: 6 }}>{VISIBILITY_HINTS_RU[visibility]}</div>

      <div style={{ ...rowStyle, marginTop: 10 }}>
        <button type="button" onClick={() => void save()} disabled={busy} style={primaryButton}>
          {busy ? 'Сохранение…' : remoteId ? 'Сохранить изменения' : 'Сохранить на сервере'}
        </button>
        {remoteId && (
          <>
            <button type="button" onClick={() => void copyLink()} disabled={!shareUrl} style={ghostButton}>
              Скопировать ссылку
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy} style={{ ...ghostButton, color: 'var(--red)' }}>
              Удалить
            </button>
          </>
        )}
      </div>

      {dirty && <div style={{ ...mutedText, marginTop: 8, color: 'var(--orange)' }}>В плане есть несохранённые правки.</div>}
      {copied && <div style={{ ...goodText, marginTop: 8 }}>Ссылка скопирована.</div>}
      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}

      {shareUrl && (
        <div style={{ ...mutedText, marginTop: 8, wordBreak: 'break-all' }}>
          Ссылка: <span style={{ color: 'var(--cyan)' }}>{shareUrl}</span>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={rowStyle}>
          <span style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
            Планы системы {systemName}
          </span>
          <button type="button" onClick={() => void refreshList(systemName)} style={ghostButton}>Обновить список</button>
        </div>
        {listLoading && <div style={mutedText}>Загрузка…</div>}
        {!listLoading && list.length === 0 && (
          <div style={{ ...mutedText, marginTop: 6 }}>
            Сохранённых планов в этой системе пока нет — свои приватные и «по ссылке» здесь увидите только вы.
          </div>
        )}
        {list.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {list.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between',
                  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--line)', borderRadius: 3,
                  padding: '6px 8px', background: 'var(--bg)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)' }}>
                    {item.title || 'Без названия'}
                    {item.own ? <span style={mutedText}> · ваш</span> : <span style={mutedText}> · {item.authorName}</span>}
                    {item.stale ? <span style={{ color: 'var(--orange)', fontSize: 11 }}> · каталог обновился</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {VISIBILITY_LABELS_RU[item.visibility]} · {item.siteCount} постр. · {formatTons(item.haulTons)}
                    {' · '}обновлён {formatDate(item.updatedAt)}
                  </div>
                </div>
                <button type="button" onClick={() => onOpen(item.id)} style={ghostButton}>Открыть</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
