/**
 * Публичный вход движка карты системы.
 *
 * Импортируется сайтом:
 * `import { createOrreryViewer, buildOrreryView } from '@/lib/orrery3d'`.
 *
 * Приложение Colonial Helper тянет только пакет данных (`build_view_payload`
 * в `uploader/system_view.py`), а сцену рисует холстом Tk
 * (`uploader/tk_orrery.py`) — ни React, ни three.js, ни WebGL ему не нужны.
 */

export * from './types';
export * from './palette';
export * from './payload';
export * from './camera';
export * from './motion';
export * from './scene';
export * from './viewer';
