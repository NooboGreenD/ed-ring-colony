import type { AtlasSearchRing } from './atlasSearchProgress';

/** Отдельный канал: превью не запускает поиск и не стирает его закреплённый итог. */
let preview: AtlasSearchRing | null = null;
const listeners = new Set<() => void>();
export const readAtlasRingPreview = () => preview;
export const readServerRingPreview = () => null;
export function publishAtlasRingPreview(ring: AtlasSearchRing | null): void {
  preview = ring;
  listeners.forEach(listener => listener());
}
export function subscribeAtlasRingPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
