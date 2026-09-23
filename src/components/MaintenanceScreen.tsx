'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Заглушка «Ведутся технические работы».
 *
 * Показывается прокси (src/proxy.ts) вместо сайта, пока идёт резервное
 * копирование базы. Анимация — вращающаяся кольцевая колония (станфордский
 * тор) на звёздном небе: чистый CSS/SVG, без библиотек и без трёхмерного
 * движка, чтобы страница оставалась мгновенной и работала даже тогда, когда
 * база занята дампом.
 *
 * Прогресс берётся из публичного /api/status, а готовность — из
 * /api/maintenance: когда признак снят, страница перезагружается сама.
 */

const POLL_MS = 5_000;

interface Progress {
  active: boolean;
  kind: string | null;
  stageLabel: string | null;
  percent: number;
}

interface MaintenanceInfo {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
}

/**
 * Детерминированный ГПСЧ: звёзды обязаны совпадать между серверной и
 * клиентской отрисовкой, иначе гидрация перерисует небо.
 */
function pseudoRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  top: number;
  left: number;
  size: number;
  opacity: number;
  delay: number;
  duration: number;
}

function makeStars(count: number, seed = 20260927): Star[] {
  const random = pseudoRandom(seed);
  return Array.from({ length: count }, () => ({
    top: Math.round(random() * 1000) / 10,
    left: Math.round(random() * 1000) / 10,
    size: Math.round((0.6 + random() * 1.8) * 10) / 10,
    opacity: Math.round((0.25 + random() * 0.7) * 100) / 100,
    delay: Math.round(random() * 60) / 10,
    duration: Math.round((2.4 + random() * 4) * 10) / 10,
  }));
}

function elapsedLabel(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
  if (minutes < 1) return 'начали только что';
  if (minutes < 60) return `идёт ${minutes} мин`;
  return `идёт ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

const CSS = `
.edrc-maint {
  position: fixed; inset: 0; z-index: 9999; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: clamp(16px, 3vh, 34px); padding: 24px; text-align: center;
  background:
    radial-gradient(900px 620px at 50% 12%, rgba(46, 92, 158, 0.35) 0%, rgba(9, 14, 26, 0) 70%),
    radial-gradient(700px 500px at 80% 90%, rgba(230, 126, 34, 0.16) 0%, rgba(9, 14, 26, 0) 70%),
    linear-gradient(180deg, #05070d 0%, #070b16 55%, #04060c 100%);
  color: #e8eefc;
  font-family: inherit;
}
.edrc-maint-stars { position: absolute; inset: 0; pointer-events: none; }
.edrc-maint-star {
  position: absolute; border-radius: 50%; background: #dfe9ff;
  animation: edrc-twinkle var(--dur, 4s) ease-in-out infinite;
}
.edrc-maint-glow {
  position: absolute; left: 50%; top: 42%; width: 520px; height: 520px;
  transform: translate(-50%, -50%); pointer-events: none;
  background: radial-gradient(circle, rgba(230, 126, 34, 0.22) 0%, rgba(230, 126, 34, 0) 62%);
  filter: blur(6px);
}
.edrc-maint-scene { position: relative; width: clamp(240px, 42vmin, 360px); aspect-ratio: 1; perspective: 900px; }
.edrc-maint-plane {
  position: absolute; inset: 0; transform-style: preserve-3d;
  animation: edrc-spin 34s linear infinite;
}
.edrc-maint-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: clamp(10px, 2.4vmin, 16px) solid rgba(255, 176, 92, 0.42);
  box-shadow: 0 0 46px rgba(255, 150, 50, 0.22), inset 0 0 34px rgba(255, 150, 50, 0.18);
}
.edrc-maint-ring::after {
  content: ''; position: absolute; inset: -1px; border-radius: 50%;
  background: repeating-conic-gradient(from 0deg,
    rgba(255, 216, 158, 0.95) 0deg 1.8deg,
    rgba(255, 216, 158, 0.05) 1.8deg 8deg);
  -webkit-mask: radial-gradient(farthest-side, transparent 0 calc(100% - 18px), #000 calc(100% - 18px) calc(100% - 2px), transparent calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent 0 calc(100% - 18px), #000 calc(100% - 18px) calc(100% - 2px), transparent calc(100% - 2px));
  animation: edrc-lights 90s linear infinite;
}
.edrc-maint-ring-inner {
  position: absolute; inset: 16%; border-radius: 50%;
  border: 2px solid rgba(160, 205, 255, 0.28);
  box-shadow: 0 0 18px rgba(120, 180, 255, 0.16);
}
.edrc-maint-spoke {
  position: absolute; left: 50%; top: 50%; width: 2px; height: 50%;
  margin-left: -1px; transform-origin: 50% 0;
  background: linear-gradient(180deg, rgba(255, 200, 130, 0.55) 0%, rgba(255, 200, 130, 0.06) 100%);
}
.edrc-maint-hub {
  position: absolute; left: 50%; top: 50%; width: clamp(46px, 9vmin, 68px); aspect-ratio: 1;
  margin: calc(clamp(46px, 9vmin, 68px) / -2) 0 0 calc(clamp(46px, 9vmin, 68px) / -2);
  border-radius: 50%;
  background: radial-gradient(circle at 34% 28%, #ffe2b4 0%, #e67e22 46%, #6d3710 100%);
  box-shadow: 0 0 34px rgba(230, 126, 34, 0.55), 0 0 90px rgba(230, 126, 34, 0.22);
  animation: edrc-pulse 6s ease-in-out infinite;
}
.edrc-maint-text { position: relative; max-width: 620px; }
.edrc-maint-kicker {
  margin: 0 0 10px; font-size: 11px; letter-spacing: 0.28em; text-transform: uppercase;
  color: #e67e22;
}
.edrc-maint-title {
  margin: 0 0 12px; font-size: clamp(24px, 4.4vmin, 40px); font-weight: 700;
  letter-spacing: 0.02em; color: #f4f7ff;
}
.edrc-maint-note { margin: 0 auto; max-width: 520px; font-size: 14px; line-height: 1.6; color: #a8b6d0; }
.edrc-maint-status {
  margin-top: 18px; font-size: 12.5px; color: #cfd9ee;
  display: flex; flex-direction: column; gap: 8px; align-items: center;
}
.edrc-maint-bar {
  width: min(320px, 72vw); height: 4px; border-radius: 999px; overflow: hidden;
  background: rgba(140, 165, 205, 0.18);
}
.edrc-maint-bar-fill {
  display: block; height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #e67e22 0%, #ffd28a 100%);
  transition: width 900ms ease;
}
.edrc-maint-hint { margin: 4px 0 0; font-size: 11.5px; color: #7f8ca6; }
.edrc-maint-brand {
  position: absolute; bottom: 18px; left: 0; right: 0; text-align: center;
  font-size: 10.5px; letter-spacing: 0.22em; text-transform: uppercase; color: #5d6a84;
}
@keyframes edrc-spin {
  from { transform: rotateX(72deg) rotateZ(0deg); }
  to   { transform: rotateX(72deg) rotateZ(360deg); }
}
@keyframes edrc-lights {
  from { transform: rotate(0deg); }
  to   { transform: rotate(-360deg); }
}
@keyframes edrc-twinkle {
  0%, 100% { opacity: var(--op, 0.5); transform: scale(1); }
  50%      { opacity: 1; transform: scale(1.35); }
}
@keyframes edrc-pulse {
  0%, 100% { filter: brightness(1); }
  50%      { filter: brightness(1.18); }
}
@media (prefers-reduced-motion: reduce) {
  .edrc-maint-plane, .edrc-maint-ring::after, .edrc-maint-star, .edrc-maint-hub { animation: none; }
  .edrc-maint-plane { transform: rotateX(72deg); }
}
`;

export default function MaintenanceScreen() {
  const stars = useMemo(() => makeStars(140), []);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);
  const [elapsed, setElapsed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const [maintenance, status] = await Promise.all([
          fetch('/api/maintenance', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        if (cancelled) return;
        if (maintenance && typeof maintenance === 'object') {
          const flag = maintenance as MaintenanceInfo;
          setInfo(flag);
          setElapsed(elapsedLabel(flag.startedAt ?? null));
          // Копия готова (или признак снят досрочно) — возвращаем посетителя
          // на сайт без ручного обновления страницы.
          if (flag.active === false) {
            window.location.reload();
            return;
          }
        }
        if (status?.update && typeof status.update === 'object') {
          const update = status.update as Progress;
          setProgress({
            active: update.active === true,
            kind: update.kind ?? null,
            stageLabel: update.stageLabel ?? null,
            percent: Number.isFinite(update.percent) ? Math.max(0, Math.min(100, Math.round(update.percent))) : 0,
          });
        }
      } catch {
        // Заглушка обязана оставаться на экране даже без сети.
      }
      timer = setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const percent = progress?.active ? progress.percent : 0;
  const stage = progress?.active
    ? progress.stageLabel || (progress.kind === 'backup' ? 'Резервное копирование базы данных' : 'Технические работы')
    : info?.reason || 'Резервное копирование базы данных';

  return (
    <div className="edrc-maint" role="status" aria-live="polite">
      <style>{CSS}</style>

      <div className="edrc-maint-stars" aria-hidden="true">
        {stars.map((star, index) => (
          <span
            key={index}
            className="edrc-maint-star"
            style={{
              top: `${star.top}%`,
              left: `${star.left}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              opacity: star.opacity,
              // CSS-переменные для keyframes: без них у всех звёзд одна фаза.
              ['--op' as string]: star.opacity,
              ['--dur' as string]: `${star.duration}s`,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </div>

      <div className="edrc-maint-glow" aria-hidden="true" />

      <div className="edrc-maint-scene" aria-hidden="true">
        <div className="edrc-maint-plane">
          <div className="edrc-maint-ring" />
          <div className="edrc-maint-ring-inner" />
          {[0, 60, 120, 180, 240, 300].map((angle) => (
            <div key={angle} className="edrc-maint-spoke" style={{ transform: `rotate(${angle}deg)` }} />
          ))}
        </div>
        <div className="edrc-maint-hub" />
      </div>

      <div className="edrc-maint-text">
        <p className="edrc-maint-kicker">Служба колонии · The Galaxy Ring Project</p>
        <h1 className="edrc-maint-title">Ведутся технические работы</h1>
        <p className="edrc-maint-note">
          Кольцевая станция переведена в режим обслуживания: выполняется резервное копирование базы данных.
          Данные командиров, эскадрилий и проектов в безопасности — вернёмся в строй через несколько минут.
        </p>

        <div className="edrc-maint-status">
          <span className="edrc-maint-bar" aria-hidden="true">
            <span className="edrc-maint-bar-fill" style={{ width: `${percent}%` }} />
          </span>
          <span>
            {stage}
            {progress?.active ? ` · ${percent}%` : ''}
            {elapsed ? ` · ${elapsed}` : ''}
          </span>
          <p className="edrc-maint-hint">Страница обновится автоматически, когда работы завершатся.</p>
        </div>
      </div>

      <div className="edrc-maint-brand">ED Ring Colony</div>
    </div>
  );
}
