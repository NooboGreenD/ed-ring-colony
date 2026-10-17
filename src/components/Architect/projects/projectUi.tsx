'use client';

/**
 * Общие кирпичи страниц «Проекты систем»: форматирование, полосы прогресса,
 * плитки показателей, бейджи и обёртка над fetch. Стиль — DESIGN.md: плоско,
 * моноширинные подписи, радиус не больше 4px.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { CarrierView } from '@/lib/fleetCarriers';
import {
  ROLE_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  type ProjectMemberView,
  type ProjectPermissions,
  type ProjectRole,
  type ProjectStatus,
  type ProjectSystemView,
  type SystemStage,
} from '@/lib/architect/projects';
import { barTrack, mutedText } from '@/components/Architect/panelStyles';

// ── Типы ответов API ───────────────────────────────────────────────────────

export interface ProjectCarrierLink {
  carrierId: string;
  systemId: string | null;
  systemName: string | null;
  purpose: string;
  shareCargo: boolean;
  addedById: string | null;
  addedByName: string | null;
  createdAt: string | null;
  canManage: boolean;
  canShare: boolean;
  carrier: (CarrierView & { sharedCargo?: boolean }) | null;
}

export interface ProjectDetailResponse {
  project: {
    id: string;
    name: string;
    description: string;
    status: ProjectStatus;
    color: string;
    targetDate: string | null;
    trackingSince: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  viewer: { userId: string; role: ProjectRole | null; isAdmin: boolean; permissions: ProjectPermissions };
  members: ProjectMemberView[];
  systems: ProjectSystemView[];
  carriers: ProjectCarrierLink[];
  limits: { systems: number; members: number; carriers: number; ownedProjects: number };
}

// ── Палитра ────────────────────────────────────────────────────────────────

/** Цвета рядов инфографики: те же, что у долей в PlanInsights. */
export const SERIES_TONES = [
  'var(--orange)', 'var(--cyan)', 'var(--green)', '#b197fc', '#f39c12',
  '#20c997', '#4dabf7', '#e74c3c', '#f06595', '#8d6e63', '#ced4da', '#94d82d',
];
export const OTHER_TONE = '#5c6166';

export function toneAt(index: number): string {
  return SERIES_TONES[index % SERIES_TONES.length];
}

export const STAGE_TONES: Record<SystemStage, string> = {
  planned: 'var(--muted)',
  claimed: 'var(--cyan)',
  building: 'var(--orange)',
  done: 'var(--green)',
  on_hold: '#8d6e63',
};

export const STATUS_TONES: Record<ProjectStatus, string> = {
  planning: 'var(--cyan)',
  active: 'var(--orange)',
  paused: '#8d6e63',
  completed: 'var(--green)',
  archived: 'var(--muted)',
};

export const ROLE_TONES: Record<ProjectRole, string> = {
  owner: 'var(--orange)',
  moderator: 'var(--cyan)',
  member: 'var(--muted)',
};

// ── Форматирование ─────────────────────────────────────────────────────────

const tonsFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export function formatTons(value: number | null | undefined, suffix = ' т'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${tonsFormat.format(Math.round(value))}${suffix}`;
}

export function compactTons(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(digits));
  return `${rounded.toLocaleString('ru-RU')} %`;
}

export function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return withTime
    ? date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', ...(value.length === 10 ? { timeZone: 'UTC' } : {}) });
}

export function formatAgo(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return 'нет данных';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return 'нет данных';
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Дней до срока: отрицательное — просрочено. */
export function daysUntil(date: string | null | undefined, now: number = Date.now()): number | null {
  if (!date) return null;
  const ms = Date.parse(`${date.slice(0, 10)}T23:59:59Z`);
  return Number.isFinite(ms) ? Math.ceil((ms - now) / 86_400_000) : null;
}

// ── Запросы ────────────────────────────────────────────────────────────────

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string;
}

export async function apiJson<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<ApiResult<T>> {
  try {
    const { json, ...rest } = init ?? {};
    const response = await fetch(url, {
      cache: 'no-store',
      ...rest,
      headers: json !== undefined ? { 'content-type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const data = await response.json().catch(() => null);
    const error = response.ok ? '' : String((data as { error?: unknown } | null)?.error ?? `Ошибка ${response.status}`);
    return { ok: response.ok, status: response.status, data: response.ok ? data as T : null, error };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : 'Сеть недоступна' };
  }
}

// ── Компоненты ─────────────────────────────────────────────────────────────

const mono: CSSProperties = { fontFamily: 'ui-monospace, monospace' };

export function ProgressBar({
  value,
  tone = 'var(--orange)',
  height = 8,
  title,
}: {
  value: number | null | undefined;
  tone?: string;
  height?: number;
  title?: string;
}) {
  const width = value == null || !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(width)}
      title={title}
      style={{ ...barTrack, height }}
    >
      <div style={{ width: `${width}%`, height: '100%', background: value == null ? 'transparent' : tone, transition: 'width 0.3s' }} />
    </div>
  );
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  tone: string;
}

/** Полоса из долей: кто/что сколько дал. Пустые доли не рисуются. */
export function StackedBar({ segments, total, height = 10, title }: { segments: Segment[]; total?: number; height?: number; title?: string }) {
  const sum = total ?? segments.reduce((acc, segment) => acc + Math.max(0, segment.value), 0);
  return (
    <div title={title} style={{ ...barTrack, height, display: 'flex' }}>
      {sum > 0 && segments.filter((segment) => segment.value > 0).map((segment) => (
        <div
          key={segment.key}
          title={`${segment.label}: ${formatTons(segment.value)} (${formatPercent((segment.value / sum) * 100)})`}
          style={{ width: `${(segment.value / sum) * 100}%`, background: segment.tone, height: '100%' }}
        />
      ))}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ key: string; label: string; tone: string; value?: number }> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
      {items.map((item) => (
        <span key={item.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)' }}>
          <span style={{ width: 8, height: 8, background: item.tone, display: 'inline-block' }} />
          <span style={{ color: 'var(--text)' }}>{item.label}</span>
          {item.value != null && <span style={mono}>{compactTons(item.value)}</span>}
        </span>
      ))}
    </div>
  );
}

export function Kpi({ label, value, hint, tone = 'var(--text)' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 10, ...mono }}>{label}</div>
      <div style={{ fontSize: 20, color: tone, marginTop: 4, ...mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {hint && <div style={{ ...mutedText, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'var(--muted)', title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        border: `1px solid ${tone}`, color: tone, borderRadius: 3,
        padding: '1px 6px', fontSize: 11, ...mono, whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function RoleBadge({ role }: { role: ProjectRole | null }) {
  if (!role) return <Badge tone="var(--muted)">администратор</Badge>;
  return <Badge tone={ROLE_TONES[role]}>{ROLE_LABELS[role].toLowerCase()}</Badge>;
}

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status].toLowerCase()}</Badge>;
}

export function StageBadge({ stage }: { stage: SystemStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage].toLowerCase()}</Badge>;
}

export function ColorDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: 2, background: color, display: 'inline-block', flex: '0 0 auto' }} />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ border: '1px dashed var(--line)', borderRadius: 4, padding: 16, ...mutedText, textAlign: 'center' }}>
      {children}
    </div>
  );
}
