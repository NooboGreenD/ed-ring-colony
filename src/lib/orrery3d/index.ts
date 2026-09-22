/**
 * Публичный вход движка карты системы.
 *
 * Импортируется двумя способами:
 * * сайт — `import { createOrreryViewer, buildOrreryView } from '@/lib/orrery3d'`;
 * * автономный HTML Colonial Helper — сборка `orrery-viewer.js`
 *   (`scripts/build-orrery-viewer.mjs`) экспортирует те же имена в `window.Orrery3D`.
 */

export * from './types';
export * from './palette';
export * from './payload';
export * from './camera';
export * from './motion';
export * from './scene';
export * from './viewer';
export * from './standalone';
