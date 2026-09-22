/**
 * Автономный запуск карты внутри готового HTML.
 *
 * Этим путём пользуется Colonial Helper: Python генерирует страницу с
 * контейнером `[data-orrery-viewer]` и JSON-пакетом в
 * `<script type="application/json" data-orrery-payload>`, а собранный
 * `orrery-viewer.js` поднимает движок без React и без сборщика на стороне
 * Python. Тот же код можно вставить в любой статический отчёт.
 *
 * Сам по себе модуль ничего не делает: побочный эффект «поднять карту на
 * странице» живёт в `auto.ts`, который попадает только в сборку для
 * автономного HTML.
 */

import { createOrreryViewer, type OrreryViewer, type OrreryViewerOptions } from './viewer';
import type { OrreryViewPayload } from './types';

const AUTOMOUNT_FLAG = '__orreryViewerMounted';

/** Прочитать пакет: сначала из inline-JSON, потом из `window.__ORRERY_VIEW__`. */
export function readEmbeddedPayload(doc: Document | null = typeof document === 'undefined' ? null : document): OrreryViewPayload | null {
  if (!doc) return null;
  const inline = doc.querySelector('script[data-orrery-payload]');
  if (inline?.textContent) {
    try {
      return JSON.parse(inline.textContent) as OrreryViewPayload;
    } catch {
      // Битый JSON — не повод падать: ниже попробуем глобальную переменную.
    }
  }
  const globalPayload = (globalThis as unknown as { __ORRERY_VIEW__?: OrreryViewPayload }).__ORRERY_VIEW__;
  return globalPayload ?? null;
}

/**
 * Поднять оврей на всех `[data-orrery-viewer]` контейнерах страницы.
 *
 * Возвращает список созданных вьюеров — страница может донастроить их
 * (например, связать с фильтром списка слева).
 */
export function mountOrreryViewers(
  doc: Document | null = typeof document === 'undefined' ? null : document,
  options: OrreryViewerOptions = {},
): OrreryViewer[] {
  if (!doc) return [];
  const payload = readEmbeddedPayload(doc);
  if (!payload) return [];
  const containers = Array.from(doc.querySelectorAll<HTMLElement>('[data-orrery-viewer]'));
  const created: OrreryViewer[] = [];
  for (const container of containers) {
    if ((container as unknown as Record<string, unknown>)[AUTOMOUNT_FLAG]) continue;
    const viewer = createOrreryViewer(container, payload, options);
    (container as unknown as Record<string, unknown>)[AUTOMOUNT_FLAG] = viewer;
    created.push(viewer);
  }
  return created;
}
