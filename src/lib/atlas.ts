/**
 * Чистые помощники раздела Atlas.
 *
 * Здесь нет ни React, ни обращений к сети — только форматирование, фильтрация
 * и генерация CSV. Благодаря этому модуль исполняется в `node --test`
 * (scripts/tests/atlas-ui.test.mjs) и в браузере одинаково.
 */

import { systemKey } from './systemIdentity.ts';

export interface AtlasCandidateLike {
  id: string;
  system_name: string;
  world_type: string;
  body_name?: string | null;
  distance_from_ref?: number | null;
  distance_to_arrival?: number | null;
  estimated_value?: number | null;
  x: number;
  y: number;
  z: number;
}

export type AtlasCandidateSort = 'distance' | 'value' | 'type' | 'name';

export interface AtlasCandidateFilter {
  /** Текстовый запрос по системе, телу и типу мира. */
  query?: string;
  /** Ограничение по типам миров; пустой массив = без ограничений. */
  worldTypes?: string[];
  /** Только избранные системы/тела. */
  favoritesOnly?: boolean;
  /** Уже добавленные в избранное ключи (см. favoriteKey). */
  favoriteKeys?: Set<string>;
}

/* ── Форматирование ───────────────────────────────────────────────── */

/** «1 234,5 св.л.» — единый формат дистанций в интерфейсе. */
export function formatDistanceLy(value?: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} св.л.`;
}

/** Дистанция до точки выхода у звезды, в световых секундах. */
export function formatArrivalLs(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '';
  return `${Math.round(value).toLocaleString('ru-RU')} св.с.`;
}

/** Оценка сканирования в кредитах; 0 и undefined показываем как «—». */
export function formatCredits(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return `${Math.round(value).toLocaleString('ru-RU')} CR`;
}

/** Дата вида «12.03.2026, 18:40»; некорректную строку не ломает. */
export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** «5 минут назад» для истории поисков. */
export function relativeTime(value?: string | null, now: Date = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return 'только что';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return formatDateTime(value);
}

/** Координаты в формате карты: «-12.4, 0.0, 25899.9». */
export function formatCoordinates(point: { x: number; y: number; z: number }, digits = 1): string {
  return `${point.x.toFixed(digits)}, ${point.y.toFixed(digits)}, ${point.z.toFixed(digits)}`;
}

/** Нормализованный ключ системы: регистр и лишние пробелы не важны (общий `systemKey`). */
export function normalizeSystemKey(name: string): string {
  return systemKey(name);
}

/** Ключ избранного: у одной системы может быть несколько типов миров. */
export function favoriteKey(systemName: string, worldType: string): string {
  return `${normalizeSystemKey(systemName)}|${worldType}`;
}

/** Короткая подпись типа мира для списков и фильтров. */
export function worldTypeLabel(worldType: string): string {
  const labels: Record<string, string> = {
    earth_like: 'Earth-like',
    water_world: 'Water',
    ammonia: 'Ammonia',
    terraformable: 'Terraformable',
    neutron_star: 'Neutron',
    black_hole: 'Black Hole',
    white_dwarf: 'White Dwarf',
    wolf_rayet: 'Wolf-Rayet',
    herbig_ae_be: 'Herbig',
    t_tauri: 'T Tauri',
    proto_star: 'Proto',
    carbon_star: 'Carbon',
    supergiant: 'Supergiant',
    giant: 'Giant',
    rocky_atmosphere: 'Rocky + Atm',
    rocky_bio: 'Rocky + Bio',
  };
  return labels[worldType] || worldType.replace(/_/g, ' ');
}

/* ── Список кандидатов ────────────────────────────────────────────── */

export function candidateMatchesQuery(candidate: AtlasCandidateLike, query: string): boolean {
  const q = normalizeSystemKey(query);
  if (!q) return true;
  return (
    normalizeSystemKey(candidate.system_name).includes(q)
    || normalizeSystemKey(candidate.body_name || '').includes(q)
    || worldTypeLabel(candidate.world_type).toLowerCase().includes(q)
  );
}

export function filterCandidates<T extends AtlasCandidateLike>(
  candidates: T[],
  filter: AtlasCandidateFilter = {},
): T[] {
  const { query = '', worldTypes = [], favoritesOnly = false, favoriteKeys } = filter;
  return candidates.filter((candidate) => {
    if (worldTypes.length > 0 && !worldTypes.includes(candidate.world_type)) return false;
    if (favoritesOnly) {
      if (!favoriteKeys || !favoriteKeys.has(favoriteKey(candidate.system_name, candidate.world_type))) {
        return false;
      }
    }
    return candidateMatchesQuery(candidate, query);
  });
}

export function sortCandidates<T extends AtlasCandidateLike>(candidates: T[], sort: AtlasCandidateSort): T[] {
  const rows = [...candidates];
  switch (sort) {
    case 'value':
      return rows.sort((a, b) => (b.estimated_value || 0) - (a.estimated_value || 0));
    case 'type':
      return rows.sort((a, b) => worldTypeLabel(a.world_type).localeCompare(worldTypeLabel(b.world_type))
        || (a.distance_from_ref || 0) - (b.distance_from_ref || 0));
    case 'name':
      return rows.sort((a, b) => a.system_name.localeCompare(b.system_name));
    case 'distance':
    default:
      return rows.sort((a, b) => (a.distance_from_ref || 0) - (b.distance_from_ref || 0));
  }
}

/** Подсчёт кандидатов по типам миров (для фильтр-пилюль). */
export function countByWorldType<T extends AtlasCandidateLike>(candidates: T[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.world_type, (counts.get(candidate.world_type) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || worldTypeLabel(a.type).localeCompare(worldTypeLabel(b.type)));
}

/* ── CSV ─────────────────────────────────────────────────────────── */

/** Экранирование значения CSV: кавычки удваиваются, `;` оборачивается в кавычки. */
export function escapeCsvValue(value: unknown): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Экспорт строк в CSV для Excel.
 *
 * Ключевые детали, из-за которых прошлая версия открывалась одной строкой:
 * BOM (`\uFEFF`), CRLF-переносы и разделитель `;` для русской локали Excel.
 */
export function buildCsv(rows: unknown[][]): string {
  const lines = rows.map((row) => row.map(escapeCsvValue).join(';'));
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Имя файла без путей, кавычек и служебных символов. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned.slice(0, 120) || 'atlas';
}

/** Скачивание CSV. Вне браузера (SSR, тесты) молча ничего не делает. */
export function downloadCsv(fileName: string, rows: unknown[][]): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sanitizeFileName(fileName)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Копирование текста в буфер; возвращает признак успеха для тоста. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Строки CSV с точками маршрута (общий формат для обоих поисковиков). */
export function routeToCsvRows(
  points: { name: string; x: number; y: number; z: number; source?: string }[],
): unknown[][] {
  const rows: unknown[][] = [['Порядок', 'Система', 'X', 'Y', 'Z', 'Тип', 'Прыжок от предыдущей, св.л.']];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    const jump = previous ? Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) : null;
    rows.push([
      index + 1,
      point.name,
      point.x.toFixed(6),
      point.y.toFixed(6),
      point.z.toFixed(6),
      point.source === 'triangulated' ? 'Триангуляция' : point.source === 'synthetic' ? 'Расчётная точка' : 'EDSM',
      jump == null ? '' : jump.toFixed(2),
    ]);
  });
  return rows;
}
