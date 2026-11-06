'use client';

/**
 * Панель администрирования системы в «Архитекторе».
 *
 * Правила жизни системы (см. миграцию `system_architects`):
 *
 *   * пока архитектор системы НЕ назначен — план сохраняет и правит любой
 *     командир (черновки у каждого свои);
 *   * после назначения архитектора создавать и изменять планы системы может
 *     только он (плюс админ, для разбора споров);
 *   * назначить/сменить архитектора может только админ — здесь же, по
 *     позывному командира; сам архитектор может отказаться от системы.
 *
 * Панель ничего не решает в браузере: все проверки повторяются на API и в
 * RLS-политиках, она лишь честно показывает текущее состояние и даёт кнопки
 * тем, кому они положены. Текущее состояние сообщаем наверх (`onState`),
 * чтобы рабочее место могло подсветить «план для вас закрыт».
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GovernanceInfo } from '@/lib/architect/governance';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  cardStyle,
  errorText,
  ghostButton,
  goodText,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
} from '@/components/Architect/panelStyles';

interface GovernancePanelProps {
  systemName: string;
  /** Краткое системное сообщение рабочему месту (успех действий). */
  onNotice: (message: string) => void;
  /** Текущее состояние назначения — рабочему месту, чтобы подсветить замок. */
  onState?: (governance: GovernanceInfo | null) => void;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export default function GovernancePanel({ systemName, onNotice, onState }: GovernancePanelProps) {
  const { t } = useI18n();
  const [governance, setGovernance] = useState<GovernanceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [assignInput, setAssignInput] = useState('');
  const [candidates, setCandidates] = useState<{ id: string; name: string }[]>([]);
  /** Пока идёт автоподбор — показываем список подсказок. */
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const report = useCallback((value: GovernanceInfo | null) => {
    setGovernance(value);
    onState?.(value);
  }, [onState]);

  const load = useCallback(async (system: string) => {
    const target = system.trim();
    if (!target) {
      report(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/architect/governance?system=${encodeURIComponent(target)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        report(null);
        return;
      }
      report(data as GovernanceInfo);
    } catch {
      // Состояние архитектора — дополнение к планировщику: без него он работает.
      report(null);
    } finally {
      setLoading(false);
    }
  }, [report]);

  useEffect(() => {
    setDone('');
    setAssignInput('');
    setCandidates([]);
    void load(systemName);
  }, [systemName, load]);

  // Подсказки позывных для админа: маленькая пауза, чтобы не дёргать API на каждую букву.
  useEffect(() => {
    if (!governance?.viewer?.isAdmin) return;
    const query = assignInput.trim();
    if (query.length < 2) {
      setCandidates([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/architect/governance?search=${encodeURIComponent(query)}`, { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        setCandidates(response.ok && Array.isArray(data?.candidates) ? data.candidates : []);
      } catch {
        setCandidates([]);
      }
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [assignInput, governance?.viewer?.isAdmin]);

  const assign = useCallback(async (self = false) => {
    const architect = assignInput.trim();
    if ((!architect && !self) || busy) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      const response = await fetch('/api/architect/governance', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: systemName, architect, self }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(String(data?.error || t('gov.assignFailedStatus', { status: response.status })));
        return;
      }
      setAssignInput('');
      setCandidates([]);
      setDone(t('gov.assignedDone', { name: data?.architect?.name ?? architect }));
      onNotice(t('gov.systemAssigned', { name: systemName }));
      void load(systemName);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gov.assignFailed'));
    } finally {
      setBusy(false);
    }
  }, [assignInput, busy, systemName, load, onNotice, t]);

  const unassign = useCallback(async () => {
    if (busy) return;
    const isOwn = Boolean(governance?.viewer?.isArchitect);
    const question = isOwn
      ? t('gov.confirmResignOwn', { name: systemName })
      : t('gov.confirmUnassign', { name: systemName });
    if (!window.confirm(question)) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      const response = await fetch('/api/architect/governance', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: systemName }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(String(data?.error || t('gov.unassignFailedStatus', { status: response.status })));
        return;
      }
      setDone(data?.resigned ? t('gov.resigned') : t('gov.unassigned'));
      onNotice(t('gov.systemFree', { name: systemName }));
      void load(systemName);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('gov.unassignFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, governance, systemName, load, onNotice]);

  if (!systemName.trim()) return null;

  const architect = governance?.architect ?? null;
  const viewer = governance?.viewer ?? { userId: null, isAdmin: false, isArchitect: false };
  const viewerLocked = Boolean(architect) && !viewer.isArchitect && !viewer.isAdmin;

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('gov.title')}</h3>
        {loading && <span style={mutedText}>{t('gov.checking')}</span>}
      </div>

      {!architect && !loading && (
        <div style={{ ...mutedText, marginTop: 8 }}>
          {t('gov.noArchitect')}
        </div>
      )}

      {architect && (
        <div style={{ marginTop: 8 }}>
          <div style={rowStyle}>
            <span style={{ color: 'var(--orange)', fontSize: 14, fontWeight: 600 }}>★ {architect.name}</span>
            <span style={mutedText}>{t('gov.architectOfSystem')}</span>
            {viewer.isArchitect && <span style={{ ...mutedText, color: 'var(--green)' }}>{t('gov.itsYou')}</span>}
          </div>
          <div style={{ ...mutedText, marginTop: 4 }}>
            {architect.assignedByName ? t('gov.assignedBy', { name: architect.assignedByName }) : t('gov.assignedByAdmin')}
            {' · '}{formatDate(architect.assignedAt)}
          </div>
          <div style={{ ...mutedText, marginTop: 4 }}>
            {t('gov.onlyArchitect')}
          </div>
          {viewerLocked && (
            <div style={{ ...mutedText, marginTop: 6, color: 'var(--cyan)' }}>
              {t('gov.readOnly')}
            </div>
          )}
        </div>
      )}

      {(viewer.isArchitect || viewer.isAdmin) && architect && (
        <div style={{ ...rowStyle, marginTop: 10 }}>
          <button type="button" onClick={() => void unassign()} disabled={busy} style={{ ...ghostButton, color: 'var(--red)' }}>
            {viewer.isArchitect ? t('gov.resign') : t('gov.unassign')}
          </button>
        </div>
      )}

      {viewer.isAdmin && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
            {architect ? t('gov.changeArchitect') : t('gov.assignArchitect')}
          </div>
          <div style={{ ...rowStyle, marginTop: 6 }}>
            <input
              value={assignInput}
              onChange={(event) => setAssignInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void assign(); }}
              aria-label={t('gov.newArchitectAria')}
              placeholder={t('gov.callsignPlaceholder')}
              style={{ ...inputStyle, flex: '1 1 200px' }}
            />
            <button
              type="button"
              onClick={() => void assign()}
              disabled={busy || assignInput.trim().length < 2}
              style={primaryButton}
            >
              {busy ? '…' : architect ? t('gov.change') : t('gov.assign')}
            </button>
            <button
              type="button"
              onClick={() => void assign(true)}
              disabled={busy || viewer.isArchitect}
              style={ghostButton}
              title={t('gov.assignSelfTitle')}
            >
              {t('gov.assignSelf')}
            </button>
          </div>
          {candidates.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {candidates.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { setAssignInput(item.name); setCandidates([]); }}
                  style={ghostButton}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {done && <div style={{ ...goodText, marginTop: 8 }}>{done}</div>}
      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}
    </section>
  );
}
