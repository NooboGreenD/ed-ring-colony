/**
 * Общий канал прогресса поисковиков Atlas.
 *
 * Все поисковики (миры, маршрут A→B, галактическое кольцо, рынок) публикуют
 * здесь свой прогресс, а 3D-карта и панель Atlas его читают. Раньше прогресс
 * жил только в виде полоски внутри формы конкретного поисковика, и по карте
 * нельзя было понять, что именно и где сканируется.
 *
 * Канал — модульное состояние + событие окна. Так поисковику не нужно
 * протаскивать колбэк через полстраницы, а карта показывает процесс, даже если
 * её слой отрисован в другом компоненте.
 */

export type AtlasSearchKind = 'world' | 'route' | 'ring' | 'market';

/** Тип точки на карте: влияет на цвет и размер маркера. */
export type AtlasSearchPointKind =
  | 'found'        // найденный кандидат (мир/звезда)
  | 'system'       // реальная известная система
  | 'anchor'       // опорная точка поиска (например, сегмент кольца)
  | 'triangulated' // расчётная точка (триангуляция)
  | 'station'      // станция с рынком
  | 'no-market'    // система без рынка
  | 'scanned'      // просканированная система без результата
  | 'hub-found'    // найден кандидат на строительный хаб
  | 'hub-missing'  // опора без подходящего хаба (требует разведки)
  | 'key-system';  // пользовательская ключевая точка маршрута

export interface AtlasSearchPoint {
  id?: string;
  name?: string;
  x: number;
  y: number;
  z: number;
  kind?: AtlasSearchPointKind;
  label?: string;
}

export interface AtlasSearchCounters {
  [label: string]: string | number;
}

export interface AtlasSearchCorridor {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  radius?: number;
}

export interface AtlasSearchRing {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

export interface AtlasSearchCube {
  cx: number;
  cy: number;
  cz: number;
  half: number;
}

export interface AtlasSearchProgress {
  /** Идёт ли поиск: оверлей и кадр прогресса на карте видны только при true. */
  active: boolean;
  kind: AtlasSearchKind;
  title: string;
  stage: string;
  percent: number;
  message: string;
  elapsedMs: number;
  counters: AtlasSearchCounters;
  /** Точки, которые появляются на карте по мере поступления. */
  points: AtlasSearchPoint[];
  /** Текущая точка сканирования (пульсирующий маркер). */
  beam: { x: number; y: number; z: number; label?: string } | null;
  ring: AtlasSearchRing | null;
  corridor: AtlasSearchCorridor | null;
  cube: AtlasSearchCube | null;
  /** Растущий маршрут (линия-превью). */
  path: AtlasSearchPoint[];
  /** Итоговая строка после завершения («Сохранено в кэш: 12 300 систем»). */
  summary: string;
  /**
   * Поиск завершён, но результат ещё показывается на карте. Оверлей живёт
   * 30 секунд после финиша: пользователь должен увидеть итог, а не пустую
   * карту в тот же миг, когда сервер ответил.
   */
  finished: boolean;
}

const EVENT_NAME = 'atlas-search-progress';
const RESULT_EVENT_NAME = 'atlas-search-result';

export const EMPTY_ATLAS_SEARCH_PROGRESS: AtlasSearchProgress = {
  active: false,
  kind: 'world',
  title: '',
  stage: 'idle',
  percent: 0,
  message: '',
  elapsedMs: 0,
  counters: {},
  points: [],
  beam: null,
  ring: null,
  corridor: null,
  cube: null,
  path: [],
  summary: '',
  finished: false,
};

/** Максимум точек, которые держим для отрисовки: карта не должна тонуть. */
const MAX_POINTS = 4000;

let current: AtlasSearchProgress = EMPTY_ATLAS_SEARCH_PROGRESS;

/** Слияние с текущим состоянием: поисковик может слать только изменения. */
export function publishAtlasSearchProgress(patch: Partial<AtlasSearchProgress>): AtlasSearchProgress {
  const points = patch.points ? patch.points.slice(-MAX_POINTS) : current.points;
  const path = patch.path ? patch.path.slice(-MAX_POINTS) : current.path;
  current = {
    ...current,
    ...patch,
    points,
    path,
    counters: patch.counters ? { ...current.counters, ...patch.counters } : current.counters,
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AtlasSearchProgress>(EVENT_NAME, { detail: current }));
  }
  return current;
}

/** Сколько результат поиска остаётся на карте после завершения. */
const RESULT_LINGER_MS = 30_000;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * «Закреплённый» итог поиска.
 *
 * Оверлей прогресса живёт только 30 секунд после финиша, а найденное кольцо
 * или маршрут должны оставаться на карте, пока пользователь их не уберёт:
 * иначе карта гасла ровно в тот момент, когда результат был готов. Итог
 * хранится отдельно от живого прогресса, поэтому новый поиск не мешает
 * смотреть на предыдущий, а карта рисует его без анимаций.
 */
let pinned: AtlasSearchProgress | null = null;

function dispatchResult(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AtlasSearchProgress | null>(RESULT_EVENT_NAME, { detail: pinned }));
  }
}

/** Зафиксирует итог поиска на карте (вызывается автоматически при завершении). */
export function pinAtlasSearchProgress(progress: AtlasSearchProgress = current): AtlasSearchProgress | null {
  pinned = { ...progress, finished: true };
  dispatchResult();
  return pinned;
}

/** Убрать закреплённый результат с карты. */
export function clearAtlasSearchResult(): void {
  if (pinned == null) return;
  pinned = null;
  dispatchResult();
}

export function readAtlasSearchResult(): AtlasSearchProgress | null {
  return pinned;
}

export function subscribeAtlasSearchResult(listener: (result: AtlasSearchProgress | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<AtlasSearchProgress | null>).detail);
  window.addEventListener(RESULT_EVENT_NAME, handler);
  return () => window.removeEventListener(RESULT_EVENT_NAME, handler);
}

function clearLingerTimer(): void {
  if (lingerTimer != null) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
}

/** Старт нового поиска: состояние полностью заменяется, счётчики сбрасываются. */
export function startAtlasSearchProgress(init: Pick<AtlasSearchProgress, 'kind'> & Partial<AtlasSearchProgress>): AtlasSearchProgress {
  clearLingerTimer();
  current = { ...EMPTY_ATLAS_SEARCH_PROGRESS, active: true, ...init, counters: init.counters || {} };
  // Новый поиск начинается «с чистого листа»: старый закреплённый итог
  // убираем, чтобы на карте не смешивались два результата.
  if (pinned != null) {
    pinned = null;
    dispatchResult();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AtlasSearchProgress>(EVENT_NAME, { detail: current }));
  }
  return current;
}

/**
 * Поиск завершён (успешно или с ошибкой). Оверлей и точки остаются на карте
 * ещё 30 секунд: сначала пользователь видит итог, и только потом карта
 * возвращается в обычный вид. Сам итог закрепляется и живёт на карте дальше.
 */
export function finishAtlasSearchProgress(patch: Partial<AtlasSearchProgress> = {}): AtlasSearchProgress {
  const state = publishAtlasSearchProgress({ percent: 100, ...patch, active: true, finished: true });
  pinAtlasSearchProgress(state);
  clearLingerTimer();
  if (typeof window !== 'undefined') {
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      publishAtlasSearchProgress({ active: false });
    }, RESULT_LINGER_MS);
  }
  return state;
}

export function resetAtlasSearchProgress(): void {
  clearLingerTimer();
  current = EMPTY_ATLAS_SEARCH_PROGRESS;
  pinned = null;
  dispatchResult();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AtlasSearchProgress>(EVENT_NAME, { detail: current }));
  }
}

export function readAtlasSearchProgress(): AtlasSearchProgress {
  return current;
}

export function subscribeAtlasSearchProgress(listener: (progress: AtlasSearchProgress) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<AtlasSearchProgress>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

/**
 * Добавляет точки к уже опубликованным, не дублируя их по имени/координатам.
 * Пакетный режим приходит из потоковых ответов, где один сегмент может отдать
 * сотни систем.
 */
export function appendAtlasSearchPoints(points: AtlasSearchPoint[]): AtlasSearchPoint[] {
  const merged = [...current.points];
  const seen = new Set(merged.map((point) => pointKey(point)));
  for (const point of points) {
    const key = pointKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(point);
  }
  return merged.length > MAX_POINTS ? merged.slice(-MAX_POINTS) : merged;
}

export function pointKey(point: AtlasSearchPoint): string {
  if (point.id) return point.id;
  const rounded = `${point.x.toFixed(2)}|${point.y.toFixed(2)}|${point.z.toFixed(2)}`;
  return `${(point.name || '').trim().toLowerCase()}|${point.kind || 'system'}|${rounded}`;
}

/** Утилита: склеить список точек с уже показанными и опубликовать их. */
export function publishAtlasSearchPoints(points: AtlasSearchPoint[], patch: Partial<AtlasSearchProgress> = {}): void {
  publishAtlasSearchProgress({ ...patch, points: appendAtlasSearchPoints(points) });
}
