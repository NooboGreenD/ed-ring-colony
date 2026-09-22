'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import UtcClock from '@/components/UtcClock';

/**
 * Статус в верхней части сайта.
 *
 * В обычном режиме — зелёная точка, «System Online» и UTC-часы (как было).
 * Пока админ из «Мониторинга» вручную пересобирает проект, вся витрина
 * переключается на «System Update» с анимированными часиками в стиле HUD,
 * чтобы посетитель понимал: сайт не упал, идёт плановая сборка новой версии.
 *
 * Источник — публичный /api/status: только активен ли апдейт, стадия и процент.
 * Никаких путей, ревизий, логов и имён контейнеров этот компонент не видит.
 */

export interface UpdateView {
  active: boolean;
  state: string | null;
  stage: string | null;
  stageLabel: string | null;
  percent: number;
  startedAt: string | null;
  updatedAt: string | null;
}

const IDLE: UpdateView = {
  active: false,
  state: 'idle',
  stage: null,
  stageLabel: null,
  percent: 0,
  startedAt: null,
  updatedAt: null,
};

const POLL_IDLE_MS = 5_000;
const POLL_ACTIVE_MS = 1_500;
const DONE_NOTE_MS = 12_000;

interface StatusPayload {
  system?: string;
  update?: Partial<UpdateView>;
}

function elapsed(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} мин ${String(seconds % 60).padStart(2, '0')} с` : `${seconds} с`;
}

/**
 * «До перезапуска ≈ N c» на финальной стадии. Это ровно то, что хочет знать
 * посетитель: сборка уже почти готова, сейчас сервис сменит контейнер.
 * Оценка линейная по пройденным 15 % шкалы, поэтому она консервативная и
 * исчезает, как только апдейт вышел на «done».
 */
function restartHint(percent: number, startedAt: string | null): string | null {
  if (!startedAt || percent < 80 || percent >= 100) return null;
  const passedMs = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(passedMs) || passedMs <= 0) return null;
  const remaining = Math.round((passedMs / Math.max(percent, 1)) * (100 - percent) / 1000);
  if (remaining < 3 || remaining > 600) return null;
  return `до перезапуска ≈ ${remaining} с`;
}

/** Часики в стиле проекта: ободок HUD, бегущая секундная стрелка и орбитальная точка. */
function UpdateClock() {
  return (
    <span className="update-clock" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" strokeLinecap="round">
        <circle className="update-clock-ring" cx="12" cy="12" r="9.5" strokeWidth="1" strokeDasharray="3 4" />
        <circle cx="12" cy="12" r="9.5" strokeWidth="1.4" opacity="0.45" />
        <g className="update-clock-hand-slow">
          <path d="M12 12V7.4" strokeWidth="1.6" />
        </g>
        <g className="update-clock-hand-fast">
          <path d="M12 12V5.2" strokeWidth="1" />
        </g>
        <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
        <g className="update-clock-orbit">
          <circle cx="12" cy="2.4" r="1.2" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </span>
  );
}

export default function SiteStatusBar() {
  const [update, setUpdate] = useState<UpdateView>(IDLE);
  const [reconnecting, setReconnecting] = useState(false);
  const [finished, setFinished] = useState(false);
  const [clock, setClock] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const wasActive = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as StatusPayload;
      if (!mounted.current) return;
      const next: UpdateView = { ...IDLE, ...(data.update || {}) };
      if (wasActive.current && !next.active) {
        setFinished(true);
        window.setTimeout(() => { if (mounted.current) setFinished(false); }, DONE_NOTE_MS);
      }
      wasActive.current = next.active;
      setUpdate(next);
      setReconnecting(false);
    } catch {
      if (!mounted.current) return;
      // Сборка может на секунду-другую забрать сайт: не гасим «System Update»,
      // а честно показываем, что ждём возвращения сервиса.
      if (wasActive.current) setReconnecting(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer = 0;
    const tick = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(tick, POLL_ACTIVE_MS);
        return;
      }
      void load().finally(() => {
        timer = window.setTimeout(tick, wasActive.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
      });
    };
    tick();
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Счётчик идёт только во время обновления — дёргать состояние каждую секунду
  // в спокойном режиме незачем.
  useEffect(() => {
    if (!update.active) { setClock(null); setHint(null); return; }
    const tick = () => {
      setClock(elapsed(update.startedAt));
      setHint(restartHint(Math.max(0, Math.min(100, Math.round(update.percent || 0))), update.startedAt));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [update.active, update.startedAt, update.percent]);

  // Помечаем документ: на время пересборки можно приглушить «живые» виджеты.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (update.active) document.documentElement.setAttribute('data-site-updating', '1');
    else document.documentElement.removeAttribute('data-site-updating');
  }, [update.active]);

  if (update.active) {
    const percent = Math.max(0, Math.min(100, Math.round(update.percent || 0)));
    const label = reconnecting ? 'Сервис перегружается' : (update.stageLabel || 'Обновление проекта');
    return (
      <>
        <span className="status status-update" role="status" aria-live="polite" title={`${label} · ${percent}%`}>
          <UpdateClock />
          System Update
          <span className="status-update-percent">{percent}%</span>
          {clock && <span className="status-update-elapsed">с {clock}</span>}
          {hint && <span className="status-update-hint">{hint}</span>}
        </span>
        <span className="update-strip" aria-hidden="true">
          <span className="update-strip-fill" style={{ width: `${percent}%` }} />
        </span>
      </>
    );
  }

  return (
    <>
      <span className="status" role="status">
        <span className="dot" />
        System Online
        {finished && <span className="status-update-done">обновление завершено</span>}
        {!finished && <UtcClock />}
      </span>
    </>
  );
}
