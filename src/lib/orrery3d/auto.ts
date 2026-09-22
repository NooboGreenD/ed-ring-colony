/**
 * Точка входа сборки `uploader/assets/orrery-viewer.js`.
 *
 * Всё, что есть в движке, плюс один побочный эффект: поднять карту на
 * странице, в которой лежит контейнер `[data-orrery-viewer]` и JSON-пакет.
 * Именно этот файл подключает автономный HTML, который генерирует
 * Colonial Helper, — react в сборку не попадает.
 */

export * from './index';

import { mountOrreryViewers } from './standalone';

function boot() {
  try {
    mountOrreryViewers();
  } catch (error) {
    // Страница обязана остаться читаемой, даже если WebGL/JSON сломались:
    // карточки тел и строек рисует Python, карта — всего лишь украшение.
    // eslint-disable-next-line no-console
    console.error('Не удалось поднять 3D-карту системы:', error);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
