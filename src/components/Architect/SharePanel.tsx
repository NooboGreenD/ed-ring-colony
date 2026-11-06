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

import { useI18n } from '@/lib/i18n/I18nContext';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PLAN_VISIBILITIES,
  VISIBILITY_HINT_KEYS,
  VISIBILITY_LABEL_KEYS,
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
  /**
   * У системы есть назначенный архитектор, и это не текущий пользователь:
   * сохранение на сервере закрыто (сервер всё равно ответит 403, но честнее
   * показать замок заранее). null — сохраняем как обычно.
   */
  lockReason?: string | null;
  onSaved: (view: PlanView) => void;
  onOpen: (planId: string) => void;
  onDeleted: () => void;
  onNotice: (message: string) => void;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

export default function SharePanel({
  plan,
  systemName,
  remoteId,
  lockReason = null,
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** JSON сохранённого плана: сравнение с текущим показывает «есть правки». */
  const { t, locale } = useI18n();
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
          setError(t('shr.loginRequired'));
        } else {
          setError(String(data?.error || t('shr.serverError', { status: response.status })));
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
          ? t('shr.savedPrivate')
          : t('shr.saved'));
      } else {
        setError(t('shr.noPlanReturned'));
      }
      void refreshList(systemName);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shr.saveFailed'));
    } finally {
      setBusy(false);
    }
  }, [plan, remoteId, systemName, title, visibility, onSaved, onNotice, refreshList, t]);

  const remove = useCallback(async () => {
    if (!remoteId) return;
    if (!window.confirm(t('shr.confirmRemove'))) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/architect/plans/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(String(data?.error || t('shr.deleteFailedStatus', { status: response.status })));
        return;
      }
      onDeleted();
      void refreshList(systemName);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shr.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }, [remoteId, onDeleted, refreshList, systemName, t]);

  const removeFromList = useCallback(async (item: PlanView) => {
    if (!item.own || deletingId) return;
    if (!window.confirm(t('shr.confirmRemoveSaved', { title: item.title || t('shr.untitled') }))) return;
    setDeletingId(item.id);
    setError('');
    try {
      const response = await fetch(`/api/architect/plans/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(String(data?.error || t('shr.deleteFailedStatus', { status: response.status })));
        return;
      }
      setList((current) => current.filter((planItem) => planItem.id !== item.id));
      if (item.id === remoteId) onDeleted();
      onNotice(t('shr.savedPlanDeleted'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shr.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, remoteId, onDeleted, onNotice, t]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      onNotice(t('shr.clipboardDenied'));
    }
  }, [shareUrl, onNotice, t]);

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('shr.sectionTitle')}</h3>
        <span style={mutedText}>
          {remoteId ? t('shr.planId', { id: remoteId.slice(0, 8) }) : t('shr.notSavedYet')}
        </span>
      </div>

      <div style={{ ...rowStyle, marginTop: 10 }}>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('shr.titlePlaceholder')}
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
            {t(VISIBILITY_LABEL_KEYS[item])}
          </button>
        ))}
      </div>
      <div style={{ ...mutedText, marginTop: 6 }}>{t(VISIBILITY_HINT_KEYS[visibility])}</div>

      {lockReason && (
        <div style={{ ...mutedText, marginTop: 8, color: 'var(--cyan)' }}>
          🔒 {lockReason} {t('shr.lockNote')}
        </div>
      )}

      <div style={{ ...rowStyle, marginTop: 10 }}>
        <button type="button" onClick={() => void save()} disabled={busy || Boolean(lockReason)} style={primaryButton}>
          {busy ? t('shr.saving') : remoteId ? t('shr.saveChanges') : t('shr.saveToServer')}
        </button>
        {remoteId && (
          <>
            <button type="button" onClick={() => void copyLink()} disabled={!shareUrl} style={ghostButton}>
              {t('shr.copyLink')}
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy} style={{ ...ghostButton, color: 'var(--red)' }}>
              {t('shr.delete')}
            </button>
          </>
        )}
      </div>

      {dirty && <div style={{ ...mutedText, marginTop: 8, color: 'var(--orange)' }}>{t('shr.dirty')}</div>}
      {copied && <div style={{ ...goodText, marginTop: 8 }}>{t('shr.copied')}</div>}
      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}

      {shareUrl && (
        <div style={{ ...mutedText, marginTop: 8, wordBreak: 'break-all' }}>
          {t('shr.shareLink')} <span style={{ color: 'var(--cyan)' }}>{shareUrl}</span>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={rowStyle}>
          <span style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
            {t('shr.systemPlans', { name: systemName })}
          </span>
          <button type="button" onClick={() => void refreshList(systemName)} style={ghostButton}>{t('shr.refreshList')}</button>
        </div>
        {listLoading && <div style={mutedText}>{t('shr.loading')}</div>}
        {!listLoading && list.length === 0 && (
          <div style={{ ...mutedText, marginTop: 6 }}>
            {t('shr.emptyList')}
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
                    {item.title || t('shr.untitled')}
                    {item.own ? <span style={mutedText}>{t('shr.yours')}</span> : <span style={mutedText}> · {item.authorName}</span>}
                    {item.stale ? <span style={{ color: 'var(--orange)', fontSize: 11 }}>{t('shr.staleCatalog')}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {t(VISIBILITY_LABEL_KEYS[item.visibility])} · {t('shr.sitesCount', { count: item.siteCount })} · {formatTons(item.haulTons)}
                    {' · '}{t('shr.updated', { date: formatDate(item.updatedAt, locale) })}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => onOpen(item.id)} style={ghostButton}>{t('shr.open')}</button>
                  {item.own && (
                    <button
                      type="button"
                      onClick={() => void removeFromList(item)}
                      disabled={Boolean(deletingId)}
                      style={{ ...ghostButton, color: 'var(--red)' }}
                      aria-label={t('shr.removeAria', { title: item.title || t('shr.untitled') })}
                    >
                      {deletingId === item.id ? t('shr.deleting') : t('shr.delete')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
